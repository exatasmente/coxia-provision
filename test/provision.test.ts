import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVISION_PATH } from '../src/cloudInit.ts';
import { ProvisionError, RecoveryCopyRefusedError, fetchRecoveryCopy, parseHostKeys, provisionMachine, type SshResult, type SshRunOptions, type SshRunner } from '../src/provision.ts';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FP = 'SHA256:' + 'A'.repeat(43);
const ok = (stdout = ''): SshResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode: number, stderr = ''): SshResult => ({ exitCode, stdout: '', stderr });

interface Call { argv: string[]; options?: SshRunOptions }

/** A machine that answers like provision.sh does, including the once-only recovery copy. */
function fakeMachine(over: (argv: string[], n: number) => SshResult | undefined = () => undefined) {
  const calls: Call[] = [];
  let handedOver = false;
  let n = 0;
  const runner: SshRunner = {
    async run(argv, options) {
      calls.push({ argv: [...argv], options });
      const custom = over([...argv], n++);
      if (custom) return custom;
      const cmd = argv.join(' ');
      if (cmd === 'cloud-init status --wait') return ok('status: done');
      if (cmd === `sudo -n ${PROVISION_PATH} provision`) return ok('==> done');
      if (cmd === `sudo -n ${PROVISION_PATH} host-keys`) return ok(`ed25519 ${FP}\nrsa SHA256:${'B'.repeat(43)}\n`);
      if (cmd === 'coxia-server status') return ok('supervisor: running');
      if (cmd === `sudo -n ${PROVISION_PATH} recovery-copy`) {
        if (handedOver) return fail(3, 'already handed over');
        handedOver = true;
        return ok(`${KEY}\n`);
      }
      return fail(127, 'unexpected command');
    },
  };
  return { runner, calls, cmds: () => calls.map((c) => c.argv.join(' ')) };
}

const fast = { sleep: async () => {}, retryDelayMs: 0 };

test('the steps run in order and the result is typed', async () => {
  const m = fakeMachine();
  const seen: string[] = [];
  const r = await provisionMachine(m.runner, { ...fast, onStep: (s) => seen.push(s) });
  assert.deepEqual(m.cmds(), [
    'cloud-init status --wait',
    `sudo -n ${PROVISION_PATH} provision`,
    `sudo -n ${PROVISION_PATH} host-keys`,
    'coxia-server status',
    `sudo -n ${PROVISION_PATH} recovery-copy`,
  ]);
  assert.deepEqual(seen, ['wait-cloud-init', 'provision', 'host-keys', 'health', 'recovery-copy']);
  assert.deepEqual(r.steps, seen);
  assert.deepEqual(r.hostKeys, [{ type: 'ed25519', fingerprint: FP }, { type: 'rsa', fingerprint: `SHA256:${'B'.repeat(43)}` }]);
  assert.equal(r.recoveryCopy, KEY);
  assert.equal(r.recoveryCopyStatus, 'delivered');
  assert.equal(r.health, 'supervisor: running');
});

test('the recovery copy is asked for as sensitive output', async () => {
  const m = fakeMachine();
  await provisionMachine(m.runner, fast);
  const rc = m.calls.find((c) => c.argv.includes('recovery-copy'));
  assert.equal(rc?.options?.sensitive, true);
});

test('the recovery copy comes once; a second call is refused', async () => {
  const m = fakeMachine();
  assert.equal(await fetchRecoveryCopy(m.runner), KEY);
  await assert.rejects(() => fetchRecoveryCopy(m.runner), RecoveryCopyRefusedError);
});

test('provisioning again on a handed-over machine succeeds without a key', async () => {
  const m = fakeMachine();
  assert.equal((await provisionMachine(m.runner, fast)).recoveryCopy, KEY);
  const again = await provisionMachine(m.runner, fast);
  assert.equal(again.recoveryCopy, null);
  assert.equal(again.recoveryCopyStatus, 'already-handed-over');
  assert.equal(again.hostKeys.length, 2);
});

test('recoveryCopy skip never asks for the key', async () => {
  const m = fakeMachine();
  const r = await provisionMachine(m.runner, { ...fast, recoveryCopy: 'skip' });
  assert.equal(r.recoveryCopyStatus, 'skipped');
  assert.ok(!m.cmds().some((c) => c.includes('recovery-copy')));
});

test('a failed provision stops the run and never reaches the key', async () => {
  const m = fakeMachine((argv) => (argv.includes('provision') ? fail(1, 'install: checksum of node does not match') : undefined));
  await assert.rejects(
    () => provisionMachine(m.runner, fast),
    (e) => e instanceof ProvisionError && e.step === 'provision' && e.exitCode === 1 && /checksum/.test(e.message),
  );
  assert.ok(!m.cmds().some((c) => c.includes('recovery-copy') || c.includes('host-keys')));
});

test('a failed cloud-init is surfaced', async () => {
  const m = fakeMachine((argv) => (argv[0] === 'cloud-init' ? { exitCode: 1, stdout: 'status: error', stderr: '' } : undefined));
  await assert.rejects(() => provisionMachine(m.runner, fast), (e) => e instanceof ProvisionError && e.step === 'wait-cloud-init');
});

test('a connection that is not up yet is retried, then given up', async () => {
  let down = 3;
  const m = fakeMachine((argv) => (argv[0] === 'cloud-init' && down-- > 0 ? fail(255, 'connection refused') : undefined));
  const r = await provisionMachine(m.runner, fast);
  assert.equal(m.cmds().filter((c) => c.startsWith('cloud-init')).length, 4);
  assert.equal(r.recoveryCopyStatus, 'delivered');

  const never = fakeMachine((argv) => (argv[0] === 'cloud-init' ? fail(255, 'timeout') : undefined));
  await assert.rejects(() => provisionMachine(never.runner, { ...fast, connectAttempts: 3 }), (e) => e instanceof ProvisionError && e.exitCode === 255);
  assert.equal(never.cmds().length, 3);
});

test('the health check retries and then fails without handing over the key', async () => {
  let bad = 2;
  const flaky = fakeMachine((argv) => (argv[0] === 'coxia-server' && bad-- > 0 ? fail(1) : undefined));
  assert.equal((await provisionMachine(flaky.runner, fast)).recoveryCopyStatus, 'delivered');

  const down = fakeMachine((argv) => (argv[0] === 'coxia-server' ? { exitCode: 1, stdout: 'supervisor: not running', stderr: '' } : undefined));
  await assert.rejects(() => provisionMachine(down.runner, { ...fast, healthAttempts: 3 }), (e) => e instanceof ProvisionError && e.step === 'health' && /not running/.test(e.message));
  assert.equal(down.cmds().filter((c) => c === 'coxia-server status').length, 3);
  assert.ok(!down.cmds().some((c) => c.includes('recovery-copy')), 'the single handover is kept for a healthy machine');
});

test('no host key in the answer is an error', async () => {
  const m = fakeMachine((argv) => (argv.includes('host-keys') ? ok('garbage\n') : undefined));
  await assert.rejects(() => provisionMachine(m.runner, fast), (e) => e instanceof ProvisionError && e.step === 'host-keys');
});

test('a malformed or failed recovery answer is an error that does not repeat the output', async () => {
  const odd = fakeMachine((argv) => (argv.includes('recovery-copy') ? ok('not-a-key') : undefined));
  await assert.rejects(() => fetchRecoveryCopy(odd.runner), (e) => e instanceof ProvisionError && !e.message.includes('not-a-key'));
  const broken = fakeMachine((argv) => (argv.includes('recovery-copy') ? fail(4, 'no master key') : undefined));
  await assert.rejects(() => fetchRecoveryCopy(broken.runner), (e) => e instanceof ProvisionError && e.exitCode === 4);
});

test('errors never carry the key', async () => {
  const m = fakeMachine((argv) => (argv.includes('coxia-server') ? { exitCode: 1, stdout: '', stderr: 'down' } : undefined));
  await assert.rejects(() => provisionMachine(m.runner, { ...fast, healthAttempts: 1 }), (e) => !(e as Error).message.includes(KEY));
});

test('parseHostKeys keeps only well-formed lines', () => {
  assert.deepEqual(parseHostKeys(`==> x\ned25519 ${FP}\ndsa SHA256:${'C'.repeat(43)}\necdsa SHA256:short\n`), [{ type: 'ed25519', fingerprint: FP }]);
});
