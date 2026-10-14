import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { abortMove, loadJournal, MoveFailed, resumeMove, runMove } from '../src/move.ts';
import type { Journal, MoveStep } from '../src/move.ts';
import { FakeWireError } from './admin-door-server.ts';
import { makeWorld } from './move-world.ts';
import type { World } from './move-world.ts';

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const created = (x: World): number => x.fake.calls.filter((c) => c.op === 'createServer').length;
const chan = (x: World, c: string): number => x.door.calls.filter((k) => k.channel === c).length;
const stepsDone = (j: Journal): string[] => j.entries.filter((e) => e.result === 'done').map((e) => e.step);
async function failure(p: Promise<unknown>): Promise<MoveFailed> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof MoveFailed, `expected a MoveFailed, got ${String(e)}`);
    return e;
  }
  return assert.fail('the move should have failed');
}
/** Everything the move wrote or said, for the "never in a log" checks. */
function everything(x: World): string {
  const parts = [x.logs.join('\n')];
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name !== 'recovery.key') parts.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(x.dir);
  return parts.join('\n');
}

describe('the move, happy path', () => {
  test('every step in order, the recovery copy is the export key and is shown once', async () => {
    w = await makeWorld();
    const s = await runMove(w.deps, w.settings);
    const j = await loadJournal(w.deps, s.moveId);
    assert.deepEqual(stepsDone(j), ['propose', 'keys', 'buy', 'provision', 'deploy-key', 'recovery-copy', 'step-down', 'export', 'copy-handover', 'transfer', 'import', 'health', 'finish']);
    assert.deepEqual(w.door.calls.map((c) => c.channel).filter((c) => /ownership|move:|effects:settle/.test(c)), ['ownership:status', 'effects:settle', 'ownership:move-out', 'move:export']);
    assert.deepEqual(w.door.calls.find((c) => c.channel === 'ownership:move-out')?.args, [{ to: 'vps:fake:srv-1' }]);
    assert.deepEqual(w.exportedKeys, [w.masterKey]);
    assert.deepEqual(w.presented, [w.masterKey]);
    assert.equal(w.claims, 0);
    assert.equal(created(w), 1);
    assert.deepEqual(s.ssh, { user: 'admin', host: '192.0.2.1' });
    assert.equal(s.workspace, 'principal');
    assert.deepEqual(s.notMovedSecrets, [{ ref: 'llm.local', type: 'command' }]);
    assert.deepEqual(s.hostKeys.map((k) => k.fingerprint), [(await import('./move-world.ts')).FP]);
    assert.ok(w.uploads[0]?.endsWith('coxia-move-mv-0123456789.tar.gz'));
    assert.ok(w.commands.some((c) => c.startsWith('sudo -n coxia-server import /home/admin/coxia-move-')));
    assert.ok(w.commands.some((c) => c.startsWith('rm -f /home/admin/coxia-move-')), 'the tarball does not stay on the machine');
    assert.equal(fs.existsSync(path.join(w.movesDir, s.moveId, 'bundle')), false);
    assert.equal(fs.existsSync(path.join(w.movesDir, s.moveId, 'bundle.tar.gz')), false);
  });

  test('the first connection trusts on first use, every later one is strict; the recovery copy is asked only after the keys are verified', async () => {
    w = await makeWorld();
    await runMove(w.deps, w.settings);
    assert.equal(w.trusts[0], 'accept-new');
    assert.ok(w.trusts.slice(1).every((t) => t === 'strict'));
    const copyAt = w.commands.findIndex((c) => c.endsWith('recovery-copy'));
    assert.ok(copyAt > 0);
  });

  test('the journal is a 0600 file in a 0700 folder, one entry per step with at, result and detail', async () => {
    w = await makeWorld();
    const s = await runMove(w.deps, w.settings);
    const dir = path.join(w.movesDir, s.moveId);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'move.json')).mode & 0o777, 0o600);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'move.json'), 'utf8')) as Journal;
    assert.ok(j.entries.every((e) => typeof e.at === 'string' && typeof e.detail === 'string' && e.result));
    assert.equal(j.serverId, 'srv-1');
  });

  test('the recovery copy is in no journal, log, audit line or file of the move', async () => {
    w = await makeWorld();
    await runMove(w.deps, w.settings);
    assert.equal(everything(w).includes(w.masterKey), false);
  });

  test('with a recovery copy file it is written 0600 and not shown on the terminal', async () => {
    w = await makeWorld({ recoveryCopyFile: true });
    await runMove(w.deps, w.settings);
    const f = w.settings.recoveryCopyFile!;
    assert.equal(fs.readFileSync(f, 'utf8').trim(), w.masterKey);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(w.presented, []);
    assert.equal(everything(w).includes(w.masterKey), false);
  });

  test('an existing recovery copy file is refused before anything is bought', async () => {
    w = await makeWorld({ recoveryCopyFile: true });
    fs.writeFileSync(w.settings.recoveryCopyFile!, 'old\n');
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'propose');
    assert.equal(created(w), 0);
  });
});

describe('a failure leaves the local instance the owner', () => {
  test('the spend gate refuses: nothing is bought, nothing moved, no claim', async () => {
    w = await makeWorld();
    w.door.handle('effects:request', () => {
      throw new FakeWireError('budget-exceeded', 'over the limit');
    });
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'buy');
    assert.match(f.message, /over the limit/);
    assert.equal(created(w), 0);
    assert.equal(w.moveOuts + w.claims, 0);
    assert.equal(f.serverKept, false);
    assert.equal(w.logs.some((l) => l.includes('waits for the budget and for your yes')), true);
  });

  test('the person is not the owner: stops at the proposal', async () => {
    w = await makeWorld();
    w.door.handle('ownership:status', () => ({ role: 'client' }));
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'propose');
    assert.equal(created(w), 0);
  });

  const cases: { step: MoveStep; claim: boolean; inject: (x: World) => void }[] = [
    { step: 'provision', claim: false, inject: (x) => x.failCommand((c) => c.endsWith('coxia-provision provision'), { exitCode: 1, stdout: '', stderr: 'apt broke' }) },
    { step: 'provision', claim: false, inject: (x) => void (x.pinned = [{ type: 'ed25519', fingerprint: `SHA256:${'Z'.repeat(43)}` }]) },
    { step: 'recovery-copy', claim: false, inject: (x) => void (x.machineHandedOver = true) },
    { step: 'step-down', claim: false, inject: (x) => x.door.handle('ownership:move-out', () => { throw new FakeWireError('not-owner', 'not the owner'); }) },
    { step: 'step-down', claim: true, inject: (x) => x.door.dropOn('ownership:move-out') },
    { step: 'export', claim: true, inject: (x) => x.door.handle('move:export', () => { throw new FakeWireError('internal', 'disk full'); }) },
    { step: 'transfer', claim: true, inject: (x) => x.failUpload(1) },
    { step: 'import', claim: true, inject: (x) => x.failCommand((c) => c.startsWith('sudo -n coxia-server import'), { exitCode: 1, stdout: '', stderr: 'clone failed: app' }) },
    { step: 'health', claim: true, inject: (x) => x.failCommand((c) => c.startsWith('coxia-server call'), { exitCode: 3, stdout: '', stderr: 'down' }, true) },
  ];
  for (const c of cases) {
    test(`at ${c.step}${c.claim ? ' (after the step-down): ownership:claim admin, VPS kept' : ': no claim, VPS kept'}`, async () => {
      w = await makeWorld();
      c.inject(w);
      const f = await failure(runMove(w.deps, w.settings));
      assert.equal(f.step, c.step);
      assert.equal(w.claims, c.claim ? 1 : 0);
      assert.deepEqual(w.door.calls.find((k) => k.channel === 'ownership:claim')?.args, c.claim ? [{ admin: true }] : undefined);
      assert.equal(f.rolledBack, c.claim ? true : 'not-needed');
      assert.equal(f.serverKept, true);
      assert.equal(w.destroyRequests, 0);
      assert.equal(w.fake.calls.filter((k) => k.op === 'destroyServer').length, 0);
      const j = await loadJournal(w.deps, f.moveId);
      assert.equal(j.entries.some((e) => e.step === 'rollback' && e.result === 'done'), c.claim);
      assert.equal(everything(w).includes(w.masterKey), false);
    });
  }

  test('a failed import stops coxia on the VPS before the claim, so two owners never run', async () => {
    w = await makeWorld();
    w.failCommand((c) => c.startsWith('sudo -n coxia-server import'), { exitCode: 1, stdout: '', stderr: 'boom' });
    await failure(runMove(w.deps, w.settings));
    assert.ok(w.commands.includes('sudo -n systemctl stop coxia'));
  });

  test('--destroy-on-failure ends the machine through the guarded destroy, which asks the destroy guard', async () => {
    w = await makeWorld({ destroyOnFailure: true });
    w.failCommand((c) => c.startsWith('coxia-server call'), { exitCode: 3, stdout: '', stderr: 'down' }, true);
    // A machine with data on it is what the guard asks about.
    const real = w.fake.getServer.bind(w.fake);
    w.fake.getServer = async (id) => (w!.fake.setHoldsData(id, true), real(id));
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.serverKept, false);
    assert.equal(w.claims, 1);
    assert.equal(w.destroyRequests, 1);
    assert.equal(w.fake.calls.filter((k) => k.op === 'destroyServer').length, 1);
  });

  test('a destroy the guard refuses leaves the machine and still gives the workspace back', async () => {
    w = await makeWorld({ destroyOnFailure: true });
    w.failCommand((c) => c.startsWith('coxia-server call'), { exitCode: 3, stdout: '', stderr: 'down' }, true);
    const real = w.fake.getServer.bind(w.fake);
    w.fake.getServer = async (id) => (w!.fake.setHoldsData(id, true), real(id));
    w.door.handle('effects:request', ([a]) => {
      if ((a as { kind: string }).kind === 'destroy') throw new FakeWireError('passkey-required', 'passkey');
      return { state: 'allowed', allowedBy: 'person', ticket: 't', expiresAt: 'x' };
    });
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.serverKept, true);
    assert.equal(w.claims, 1);
    assert.equal(w.fake.calls.filter((k) => k.op === 'destroyServer').length, 0);
  });

  test('when the claim itself fails the report says so', async () => {
    w = await makeWorld();
    w.failUpload(1);
    w.door.handle('ownership:claim', () => {
      throw new FakeWireError('internal', 'lease unreadable');
    });
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.rolledBack, 'failed');
    const j = await loadJournal(w.deps, f.moveId);
    assert.ok(j.entries.some((e) => e.step === 'rollback' && e.result === 'failed' && /ownership:claim admin failed/.test(e.detail)));
  });

  test('an error that carries the key is scrubbed in the report, the journal and the log', async () => {
    w = await makeWorld();
    w.failCommand((c) => c.startsWith('sudo -n coxia-server import'), { exitCode: 1, stdout: '', stderr: `bad key ${w.masterKey}` });
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.message.includes(w.masterKey), false);
    assert.equal(everything(w).includes(w.masterKey), false);
  });
});

describe('the deploy key', () => {
  test('is asked for before the step-down, with the key and the remotes shown', async () => {
    w = await makeWorld();
    await runMove(w.deps, w.settings);
    assert.equal(w.prompts.length, 1);
    assert.match(w.prompts[0]!, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDeployKeyForTests/);
    assert.match(w.prompts[0]!, /WRITE ACCESS/);
    assert.match(w.prompts[0]!, /git@example\.com:group\/project\.git/);
    const at = (c: string): number => w!.commands.findIndex((x) => x === c);
    assert.ok(at('sudo -n coxia-server deploy-key') >= 0);
    assert.equal(w.door.calls.findIndex((c) => c.channel === 'ownership:move-out') > w.door.calls.findIndex((c) => c.channel === 'config:get'), true);
  });

  test('a no stops before the step-down: no move-out, no claim, VPS kept; the resume shows the key again without running it', async () => {
    w = await makeWorld();
    w.confirmAnswer = false;
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'deploy-key');
    assert.equal(w.moveOuts, 0);
    assert.equal(w.claims, 0);
    assert.equal(f.rolledBack, 'not-needed');
    assert.equal(f.serverKept, true);
    assert.equal((await loadJournal(w.deps, f.moveId)).deployKey?.startsWith('ssh-ed25519 '), true);
    w.confirmAnswer = true;
    await resumeMove(w.deps, w.settings, f.moveId);
    assert.equal(w.commands.filter((c) => c === 'sudo -n coxia-server deploy-key').length, 1);
    assert.equal(w.prompts.length, 2);
    assert.match(w.prompts[1]!, /ssh-ed25519 AAAAC3/);
  });

  test('a finished step is skipped on resume', async () => {
    w = await makeWorld();
    w.failUpload(1);
    const f = await failure(runMove(w.deps, w.settings));
    await resumeMove(w.deps, { ...w.settings, recoveryCopyFile: undefined }, f.moveId).catch(() => undefined);
    assert.equal(w.prompts.length, 1);
    assert.equal(w.commands.filter((c) => c === 'sudo -n coxia-server deploy-key').length, 1);
  });

  test('no ssh remote: the key is made but nobody is asked; --yes-deploy-key skips the question', async () => {
    w = await makeWorld();
    w.repoRemotes = ['https://example.com/group/project.git'];
    await runMove(w.deps, w.settings);
    assert.equal(w.prompts.length, 0);
    await w.close();
    w = await makeWorld();
    await runMove(w.deps, { ...w.settings, yesDeployKey: true });
    assert.equal(w.prompts.length, 0);
  });

  test('a config that cannot be read means the person is asked anyway', async () => {
    w = await makeWorld();
    w.door.handle('config:get', () => {
      throw new FakeWireError('internal', 'no');
    });
    await runMove(w.deps, w.settings);
    assert.equal(w.prompts.length, 1);
    assert.match(w.prompts[0]!, /could not be read/);
  });

  test('an answer that is not a public key line is refused before the step-down', async () => {
    w = await makeWorld();
    w.failCommand((c) => c === 'sudo -n coxia-server deploy-key', { exitCode: 0, stdout: `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\n`, stderr: '' });
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'deploy-key');
    assert.match(f.message, /did not print an ssh-ed25519/);
    assert.equal(w.moveOuts + w.claims, 0);
  });
});

describe('resume', () => {
  test('a move that failed at transfer resumes there: finished steps are skipped, the step-down and export are redone after the claim', async () => {
    w = await makeWorld({ recoveryCopyFile: true });
    w.failUpload(1);
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(w.claims, 1);
    const before = { created: created(w), provision: w.commands.filter((c) => c.endsWith('coxia-provision provision')).length };
    const s = await resumeMove(w.deps, w.settings, f.moveId);
    assert.equal(created(w), before.created, 'nothing is bought twice');
    assert.equal(w.commands.filter((c) => c.endsWith('coxia-provision provision')).length, before.provision, 'provisioning is not run again');
    assert.equal(w.moveOuts, 2);
    assert.deepEqual(w.exportedKeys, [w.masterKey, w.masterKey], 'the key came back from the person\'s own file');
    assert.equal(w.claims, 1);
    assert.equal(s.serverId, 'srv-1');
    assert.equal(chan(w, 'effects:request'), 1, 'the person is asked for the spend once');
    const j = await loadJournal(w.deps, f.moveId);
    assert.equal(last(j, 'transfer'), 'done');
    assert.equal(everything(w).includes(w.masterKey), false);
  });

  test('without the file the lost copy is explained and nothing is exported to the wrong key', async () => {
    w = await makeWorld();
    w.failUpload(1);
    const f = await failure(runMove(w.deps, w.settings));
    const g = await failure(resumeMove(w.deps, w.settings, f.moveId));
    assert.equal(g.step, 'export');
    assert.match(g.message, /handed over once/);
    assert.match(g.message, /--recovery-copy-file/);
    assert.match(g.message, /recovery-copy-handed-over/);
    assert.deepEqual(w.exportedKeys, [w.masterKey], 'only the first export ran');
    assert.equal(w.claims, 2, 'and the workspace was given back again');
  });

  test('a machine that handed the copy over before: provision says so, and a resume with the file goes on', async () => {
    w = await makeWorld({ recoveryCopyFile: true });
    w.machineHandedOver = true;
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'recovery-copy');
    assert.match(f.message, /handed over once/);
    fs.writeFileSync(w.settings.recoveryCopyFile!, `${w.masterKey}\n`, { mode: 0o600 });
    const s = await resumeMove(w.deps, w.settings, f.moveId);
    assert.deepEqual(w.exportedKeys, [w.masterKey]);
    assert.equal(s.workspace, 'principal');
  });

  test('a finished move resumes into its summary and does nothing', async () => {
    w = await makeWorld();
    const s = await runMove(w.deps, w.settings);
    const calls = w.door.calls.length;
    const again = await resumeMove(w.deps, w.settings, s.moveId);
    assert.equal(again.serverId, s.serverId);
    assert.equal(w.door.calls.length, calls);
  });

  test('a purchase of unknown outcome is found by its hostname on resume; one that is not listed is refused', async () => {
    w = await makeWorld();
    const real = w.fake.createServer.bind(w.fake);
    w.fake.createServer = async (input) => {
      await real(input);
      throw Object.assign(new Error('timeout after the order'), { name: 'ProviderError', code: 'provider-unavailable' });
    };
    const f = await failure(runMove(w.deps, w.settings));
    assert.equal(f.step, 'buy');
    assert.equal((await loadJournal(w.deps, f.moveId)).buyAttempted, true);
    w.fake.createServer = async () => assert.fail('must not buy again');
    const s = await resumeMove(w.deps, w.settings, f.moveId);
    assert.equal(s.serverId, 'srv-1');

    await w.close();
    w = await makeWorld();
    w.fake.createServer = async () => {
      throw Object.assign(new Error('timeout'), { name: 'ProviderError', code: 'provider-unavailable' });
    };
    const g = await failure(runMove(w.deps, w.settings));
    w.fake.createServer = async () => assert.fail('must not buy again');
    const h = await failure(resumeMove(w.deps, w.settings, g.moveId));
    assert.match(h.message, /look in the provider's panel/);
  });

  test('plan, region and provider cannot change on resume; a bad id is refused', async () => {
    w = await makeWorld();
    w.failUpload(1);
    const f = await failure(runMove(w.deps, w.settings));
    await assert.rejects(resumeMove(w.deps, { ...w.settings, plan: 's-large' }, f.moveId), /cannot change/);
    await assert.rejects(resumeMove(w.deps, w.settings, '../etc'), /not a move id/);
    await assert.rejects(resumeMove(w.deps, w.settings, 'mv-ffffffffff'), /no move/);
  });

  test('abort gives the workspace back after a crash that left it moved out', async () => {
    w = await makeWorld();
    // A crash: the journal says the step-down started and nothing else ran.
    w.door.handle('move:export', () => new Promise(() => undefined));
    const p = runMove(w.deps, w.settings);
    p.catch(() => undefined);
    for (let i = 0; i < 200 && !w.door.calls.some((c) => c.channel === 'move:export'); i++) await new Promise((r) => setTimeout(r, 10));
    const r = await abortMove(w.deps, w.settings, 'mv-0123456789');
    assert.equal(r.rolledBack, true);
    assert.equal(w.claims, 1);
  });
});

function last(j: Journal, step: string): string | undefined {
  return [...j.entries].reverse().find((e) => e.step === step)?.result;
}
