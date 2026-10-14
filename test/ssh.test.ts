import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createSshRunner, ensureAdminKey, knownHostsFingerprints, realExec, shellQuote, SshSetupError, verifyPinnedHostKeys } from '../src/ssh.ts';
import type { Exec, SshTarget } from '../src/ssh.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-ssh-'));
const target = (over: Partial<SshTarget> = {}): SshTarget => ({ host: '192.0.2.10', user: 'admin', identityFile: '/m/key', knownHostsFile: '/m/known_hosts', trust: 'accept-new', ...over });
const hasKeygen = ((): boolean => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== undefined;
  }
})();

describe('ssh runner', () => {
  test('fixed argv: batch mode, one identity, the move known_hosts, quoted command words', async () => {
    const seen: { cmd: string; args: readonly string[] }[] = [];
    const exec: Exec = async (cmd, args) => (seen.push({ cmd, args }), { exitCode: 0, stdout: 'ok', stderr: '' });
    const ssh = createSshRunner(target(), exec);
    await ssh.run(['sudo', '-n', 'coxia-server', 'import', "/home/admin/it's here.tgz"]);
    const { cmd, args } = seen[0]!;
    assert.equal(cmd, 'ssh');
    for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'StrictHostKeyChecking=accept-new', 'UserKnownHostsFile=/m/known_hosts', 'GlobalKnownHostsFile=/dev/null']) assert.ok(args.includes(o), o);
    assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'admin@192.0.2.10', 'sudo', '-n', 'coxia-server', 'import', `'/home/admin/it'\\''s here.tgz'`]);
    assert.equal(shellQuote('plain-word_1'), 'plain-word_1');
    assert.equal(shellQuote(''), "''");
  });

  test('strict after verification, and the upload goes through scp with the same options', async () => {
    const seen: { cmd: string; args: readonly string[] }[] = [];
    const exec: Exec = async (cmd, args) => (seen.push({ cmd, args }), { exitCode: 0, stdout: '', stderr: '' });
    const ssh = createSshRunner(target({ trust: 'strict', port: 2222 }), exec);
    await ssh.upload('/m/bundle.tar.gz', '/home/admin/b.tar.gz');
    const { cmd, args } = seen[0]!;
    assert.equal(cmd, 'scp');
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.deepEqual(args.slice(args.indexOf('-P')), ['-P', '2222', '--', '/m/bundle.tar.gz', 'admin@192.0.2.10:/home/admin/b.tar.gz']);
  });

  test('a failed upload throws; hostile host, user and path are refused before anything runs', async () => {
    const exec: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    await assert.rejects(createSshRunner(target(), exec).upload('/a', '/b'), SshSetupError);
    assert.throws(() => createSshRunner(target({ host: '-oProxyCommand=x' }), exec), SshSetupError);
    assert.throws(() => createSshRunner(target({ host: 'a b' }), exec), SshSetupError);
    assert.throws(() => createSshRunner(target({ user: 'root;x' }), exec), SshSetupError);
    await assert.rejects(createSshRunner(target(), exec).upload('/a', '/b; rm -rf /'), SshSetupError);
  });

  test('verifying the pinned keys against the reported ones', () => {
    const a = { type: 'ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` } as const;
    const b = { type: 'rsa', fingerprint: `SHA256:${'B'.repeat(43)}` } as const;
    verifyPinnedHostKeys([a], [a, b]);
    assert.throws(() => verifyPinnedHostKeys([a], [b]), /not one the machine reports/);
    assert.throws(() => verifyPinnedHostKeys([], [a]), /pinned no host key/);
  });

  test('realExec reports an exit status, a missing binary and a timeout without throwing', async () => {
    assert.equal((await realExec(process.execPath, ['-e', 'process.stdout.write("hi")'])).stdout, 'hi');
    assert.equal((await realExec(process.execPath, ['-e', 'process.exit(3)'])).exitCode, 3);
    assert.equal((await realExec('/nonexistent/binary', [])).exitCode, 255);
    assert.equal((await realExec(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 100 })).exitCode, 255);
  });

  test('ensureAdminKey makes an ed25519 pair at 0600 and reuses it', { skip: !hasKeygen }, async () => {
    const dir = tmp();
    const k = await ensureAdminKey(dir, 'coxia-provision-test');
    assert.match(k.publicKey, /^ssh-ed25519 \S+ coxia-provision-test$/);
    assert.equal(fs.statSync(k.privateKeyFile).mode & 0o777, 0o600);
    assert.equal((await ensureAdminKey(dir, 'other')).publicKey, k.publicKey);
    fs.rmSync(dir, { recursive: true });
  });

  test('knownHostsFingerprints reads what ssh-keygen says about a real known_hosts', { skip: !hasKeygen }, async () => {
    const dir = tmp();
    const k = await ensureAdminKey(dir, 'host');
    const [type, blob] = k.publicKey.split(' ');
    const kh = path.join(dir, 'known_hosts');
    fs.writeFileSync(kh, `192.0.2.10 ${type} ${blob}\n`);
    const got = await knownHostsFingerprints(kh);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.type, 'ed25519');
    assert.match(got[0]!.fingerprint, /^SHA256:/);
    assert.deepEqual(await knownHostsFingerprints(path.join(dir, 'missing')), []);
    fs.rmSync(dir, { recursive: true });
  });
});
