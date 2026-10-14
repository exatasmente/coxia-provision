// A whole world for the move, all fakes: the provider, the admin door of the core, the machine behind ssh. Nothing real, no network.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconnectingDoor } from '../src/adminDoor.ts';
import type { CoreClient } from '../src/adminDoor.ts';
import { coreAccountCheck, coreDestroyGuard, coreSpendGate, fileAuditSink } from '../src/corePorts.ts';
import { createFakeProvider } from '../src/fakeProvider.ts';
import type { FakeProvider } from '../src/fakeProvider.ts';
import { guardProvider } from '../src/guarded.ts';
import type { GuardedProvider } from '../src/guarded.ts';
import { PROVISION_PATH } from '../src/cloudInit.ts';
import type { MoveDeps, MoveSettings } from '../src/move.ts';
import type { SshResult } from '../src/provision.ts';
import type { MoveSsh, SshTarget } from '../src/ssh.ts';
import { FakeWireError, startFakeDoor } from './admin-door-server.ts';
import type { FakeDoor } from './admin-door-server.ts';
import { memorySecrets } from './helpers.ts';

export const FP = `SHA256:${'A'.repeat(43)}`;
const ok = (stdout = ''): SshResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode: number, stderr = ''): SshResult => ({ exitCode, stdout: '', stderr });

export interface World {
  dir: string;
  movesDir: string;
  door: FakeDoor;
  core: CoreClient;
  fake: FakeProvider;
  guarded: GuardedProvider;
  deps: MoveDeps;
  settings: MoveSettings;
  /** The VPS master key; made at run time. */
  masterKey: string;
  logs: string[];
  presented: string[];
  /** Every ssh command the machine received, in order, as one string each. */
  commands: string[];
  uploads: string[];
  trusts: string[];
  exportedKeys: string[];
  claims: number;
  moveOuts: number;
  destroyRequests: number;
  /** Make a command fail: the first matching command gets this result once (or always with `always`). */
  failCommand(match: (cmd: string) => boolean, result: SshResult, always?: boolean): void;
  failUpload(times: number): void;
  pinned: { type: 'ed25519' | 'ecdsa' | 'rsa'; fingerprint: string }[];
  machineHandedOver: boolean;
  close(): Promise<void>;
}

export async function makeWorld(opts: { recoveryCopyFile?: boolean; destroyOnFailure?: boolean } = {}): Promise<World> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-move-'));
  const movesDir = path.join(dir, 'moves');
  const token = `tok-move-${randomBytes(6).toString('hex')}`;
  const masterKey = randomBytes(32).toString('hex');
  const door = await startFakeDoor({ workspace: 'principal' });
  const core = reconnectingDoor(door.socketPath);
  const secrets = memorySecrets({ 'prov-token': token });
  const fake = createFakeProvider({ secrets, tokenRef: 'prov-token', token });

  const w = { claims: 0, moveOuts: 0, destroyRequests: 0, machineHandedOver: false } as World;
  Object.assign(w, { dir, movesDir, door, core, fake, masterKey, logs: [] as string[], presented: [] as string[], commands: [] as string[], uploads: [] as string[], trusts: [] as string[], exportedKeys: [] as string[], pinned: [{ type: 'ed25519', fingerprint: FP }] });

  let movedOut = false;
  door.handle('ownership:status', () => ({ role: 'owner', self: 'i1' }));
  door.handle('accounts:assert', () => ({ id: 'acct-1', provider: 'fake', secretRefs: ['prov-token'] }));
  door.handle('effects:request', ([a]) => {
    if ((a as { kind: string }).kind === 'destroy') w.destroyRequests++;
    return { state: 'allowed', allowedBy: 'person', ticket: `t-${(a as { kind: string }).kind}`, expiresAt: 'x' };
  });
  door.handle('effects:settle', () => ({ entryId: null, overrun: false }));
  door.handle('ownership:move-out', () => {
    w.moveOuts++;
    movedOut = true;
    return { role: 'client', movedOut: { to: 'x', at: 'y' } };
  });
  door.handle('ownership:claim', () => {
    w.claims++;
    movedOut = false;
    return { role: 'owner' };
  });
  door.handle('move:export', ([a]) => {
    const { targetKey, out } = a as { targetKey: string; out: string };
    if (!movedOut) throw new FakeWireError('forbidden', 'not moved out');
    if (fs.existsSync(out)) throw new FakeWireError('invalid-input', 'out exists');
    w.exportedKeys.push(targetKey);
    fs.mkdirSync(path.join(out, 'workspace'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(out, 'manifest.json'), '{}');
    return { format: 1, workspace: { id: 'principal', name: 'Principal' }, repos: [{ id: 'app' }], secrets: { moved: ['vcs.github'], notMoved: [{ ref: 'llm.local', type: 'command' }] }, files: 3, bytes: 99 };
  });

  const guarded = guardProvider(fake, {
    name: 'fake',
    gate: coreSpendGate({ core, requestId: () => 'move-test0001-spend' }),
    destroyGuard: coreDestroyGuard({ core, requestId: () => 'move-test0001-destroy' }),
    accounts: coreAccountCheck(core),
    secrets,
    audit: fileAuditSink(path.join(dir, 'audit.log')),
  });

  const rules: { match: (c: string) => boolean; result: SshResult; always: boolean; used: boolean }[] = [];
  let uploadFailures = 0;
  const machine = (cmd: string): SshResult => {
    for (const r of rules) {
      if ((r.always || !r.used) && r.match(cmd)) {
        r.used = true;
        return r.result;
      }
    }
    if (cmd === 'cloud-init status --wait') return ok('status: done');
    if (cmd === `sudo -n ${PROVISION_PATH} provision`) return ok('==> done');
    if (cmd === `sudo -n ${PROVISION_PATH} host-keys`) return ok(`ed25519 ${FP}\n`);
    if (cmd === `sudo -n ${PROVISION_PATH} recovery-copy`) {
      if (w.machineHandedOver) return fail(3);
      w.machineHandedOver = true;
      return ok(`${masterKey}\n`);
    }
    if (cmd.startsWith('sudo -n coxia-server import ')) return ok('{"imported":"principal","repos":[],"health":"ok"}\n');
    if (cmd === 'coxia-server status') return ok('running');
    if (cmd.startsWith('coxia-server call principal ownership:status')) return ok('{"role":"owner"}\n');
    if (cmd === 'sudo -n systemctl stop coxia') return ok();
    if (cmd.startsWith('rm -f ')) return ok();
    return fail(127, `unexpected: ${cmd}`);
  };

  const sshFor = (t: SshTarget): MoveSsh => {
    w.trusts.push(t.trust);
    return {
      run: async (argv) => {
        const cmd = argv.join(' ');
        w.commands.push(cmd);
        return machine(cmd);
      },
      upload: async (_local, remote) => {
        if (uploadFailures > 0) {
          uploadFailures--;
          throw new Error('scp failed (connection reset)');
        }
        w.uploads.push(remote);
      },
      pinnedFingerprints: async () => w.pinned,
    };
  };

  const settings: MoveSettings = {
    provider: 'fake',
    plan: 's-small',
    region: 'fsn',
    image: 'ubuntu-24.04',
    serverRef: 'v0.0.0',
    provisionScript: '#!/bin/sh\n',
    ...(opts.recoveryCopyFile ? { recoveryCopyFile: path.join(dir, 'recovery.key') } : {}),
    ...(opts.destroyOnFailure ? { destroyOnFailure: true } : {}),
  };

  const deps: MoveDeps = {
    core,
    provider: guarded,
    sshFor,
    ensureKey: async () => ({ privateKeyFile: path.join(dir, 'k'), publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests coxia-test' }),
    pack: async (_folder, tarball) => void fs.writeFileSync(tarball, 'tar'),
    presentRecoveryCopy: async (key) => (w.presented.push(key), 'printed once on the terminal'),
    movesDir,
    log: (l) => void w.logs.push(l),
    sleep: async () => undefined,
    newId: () => 'mv-0123456789',
    serverWait: { attempts: 3, delayMs: 0 },
    healthWait: { attempts: 2, delayMs: 0 },
    provisionOptions: { sleep: async () => undefined, retryDelayMs: 0, connectAttempts: 2, healthAttempts: 2 },
  };

  Object.assign(w, {
    guarded,
    deps,
    settings,
    failCommand: (match: (c: string) => boolean, result: SshResult, always = false) => void rules.push({ match, result, always, used: false }),
    failUpload: (n: number) => void (uploadFailures = n),
    close: async () => {
      core.close();
      await door.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  return w;
}
