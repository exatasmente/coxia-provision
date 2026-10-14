// The move: one workspace from the Coxia on this computer to a VPS bought for it. A list of steps, each journaled, each safe to run again, with every collaborator injected.
//
//   propose      the plan, region and price, and that this instance owns the workspace
//   keys         the admin key pair for the machine (made here, private half never leaves)
//   buy          the guarded provider: the spend gate decides (budget, grant, or the person's yes in the desktop); nothing is bought before it says so
//   provision    wait for the machine, run provisioning, verify the host keys against what the first connection pinned
//   recovery-copy the VPS master key, once, in memory (or also in the person's own file)
//   step-down    ownership:move-out: from here the local instance is a client for good
//   export       move:export with the recovery copy as the target key; the bundle is tarred
//   copy-handover the recovery copy handed to the person, once
//   transfer     scp the tarball to the VPS
//   import       coxia-server import: clones, imports, restarts, waits for health
//   health       coxia-server status and ownership:status on the VPS: the role must be `owner`; this is the handover of ownership
//   finish       what the desktop needs, and the bundle removed from this computer
//
// Any failure leaves the local instance the owner: when the step-down already happened, `ownership:claim {admin:true}` takes it back. The VPS is kept for a retry unless
// `destroyOnFailure` is set, and then it goes through the guarded destroy, which asks the DestroyGuard. The recovery copy lives in memory (and, when the person asked, in
// their own file); it is never written to the journal and every line that leaves this module is scrubbed of it.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AdminDoorError } from './adminDoor.ts';
import type { CoreClient } from './adminDoor.ts';
import { renderCloudInit } from './cloudInit.ts';
import { renderPostInstallScript } from './bootstrap.ts';
import type { GuardedProvider } from './guarded.ts';
import { isProviderError } from './provider.ts';
import type { HostKeyFingerprint, ProvisionOptions } from './provision.ts';
import { fetchRecoveryCopy, provisionMachine, RecoveryCopyRefusedError } from './provision.ts';
import { verifyPinnedHostKeys } from './ssh.ts';
import type { AdminKey, MoveSsh, SshTarget } from './ssh.ts';

export const MOVE_STEPS = ['propose', 'keys', 'buy', 'provision', 'recovery-copy', 'step-down', 'export', 'copy-handover', 'transfer', 'import', 'health', 'finish'] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

/** From here on the local instance has given the workspace up; a rollback resets them so a resumed move does them again. */
const AFTER_STEP_DOWN: readonly MoveStep[] = MOVE_STEPS.slice(MOVE_STEPS.indexOf('step-down'));

export type EntryResult = 'started' | 'done' | 'failed' | 'unknown' | 'skipped' | 'rolled-back';

export interface JournalEntry {
  step: MoveStep | 'rollback' | 'destroy';
  at: string;
  result: EntryResult;
  detail: string;
}

export interface Journal {
  version: 1;
  id: string;
  createdAt: string;
  provider: string;
  plan: string;
  region: string;
  image: string;
  /** The hostname of the machine; the one handle a purchase of unknown outcome can be found by. */
  name: string;
  adminUser: string;
  destroyOnFailure: boolean;
  /** Set before the purchase is sent and cleared when it is surely not made. */
  buyAttempted: boolean;
  serverId?: string;
  ip?: string;
  hostKeys?: HostKeyFingerprint[];
  hostKeysVerified: boolean;
  /** The path of the person's recovery-copy file, once this move wrote it. Never its contents. */
  recoveryCopyFile?: string;
  workspace?: string;
  exported?: { repos: number; files: number; bytes: number; secretsMoved: number; secretsNotMoved: { ref: string; type: string }[] };
  entries: JournalEntry[];
}

export class MoveError extends Error {
  readonly step: MoveStep | undefined;
  constructor(message: string, step?: MoveStep) {
    super(message);
    this.name = 'MoveError';
    this.step = step;
  }
}

/** What a failed move reports: where it stopped, and what was done to leave things as they were. */
export class MoveFailed extends MoveError {
  readonly moveId: string;
  readonly rolledBack: boolean | 'not-needed' | 'failed';
  readonly serverKept: boolean;
  constructor(moveId: string, step: MoveStep, message: string, rolledBack: boolean | 'not-needed' | 'failed', serverKept: boolean) {
    super(message, step);
    this.name = 'MoveFailed';
    this.moveId = moveId;
    this.rolledBack = rolledBack;
    this.serverKept = serverKept;
  }
}

export interface MoveSettings {
  provider: string;
  plan: string;
  region: string;
  /** The template name or id the provider takes. Default `Ubuntu 24.04`. */
  image?: string;
  /** The coxia-server ref to provision (a full commit id is the most fixed choice). */
  serverRef: string;
  coxiaRef?: string;
  timezone?: string;
  adminUser?: string;
  destroyOnFailure?: boolean;
  /** Where the person wants the recovery copy written (0600, must not exist). Absent: it is shown once on the terminal. */
  recoveryCopyFile?: string;
  /** The contents of deploy/provision.sh at `serverRef`. */
  provisionScript: string;
}

export interface MoveDeps {
  core: CoreClient;
  provider: GuardedProvider;
  /** A runner for the machine; built again once the host keys are verified, with `trust: 'strict'`. */
  sshFor(target: SshTarget): MoveSsh;
  ensureKey(dir: string, comment: string): Promise<AdminKey>;
  /** Packs the folder's contents, at the top level, into a gzip tarball. */
  pack(folder: string, tarball: string): Promise<void>;
  /** Shows the recovery copy to the person, once, away from any log; says where it went. */
  presentRecoveryCopy(key: string): Promise<string>;
  /** Where moves are kept: `<state>/coxia-provision/moves`. */
  movesDir: string;
  /** Human progress lines. Scrubbed of the recovery copy before they get here. */
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  provision?: typeof provisionMachine;
  provisionOptions?: ProvisionOptions;
  /** Tries and pause while the machine comes up and while the health is checked. Defaults 90 x 10 s, and 12 x 5 s. */
  serverWait?: { attempts: number; delayMs: number };
  healthWait?: { attempts: number; delayMs: number };
}

export interface MoveSummary {
  moveId: string;
  serverId: string;
  ssh: { user: string; host: string };
  workspace: string;
  hostKeys: HostKeyFingerprint[];
  keyFile: string;
  knownHostsFile: string;
  recoveryCopy: string;
  notMovedSecrets: { ref: string; type: string }[];
}

const MOVE_ID = /^mv-[0-9a-f]{10}$/;
const KEY64 = /^[0-9a-f]{64}$/;
const MARKER = '/var/lib/coxia-provision/recovery-copy-handed-over';
const real = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const LOST_COPY = `The master key of the VPS was handed over once and this run no longer holds it. Either put the copy you saved into the file given with --recovery-copy-file and resume, or, as root on the VPS, delete ${MARKER} on purpose and resume (any holder of the admin key can also read /etc/coxia/master.key there), or abandon this VPS and start a new move.`;

export const moveDir = (deps: Pick<MoveDeps, 'movesDir'>, id: string): string => path.join(deps.movesDir, id);

export async function loadJournal(deps: Pick<MoveDeps, 'movesDir'>, id: string): Promise<Journal> {
  if (!MOVE_ID.test(id)) throw new MoveError('not a move id');
  let raw: string;
  try {
    raw = await readFile(path.join(moveDir(deps, id), 'move.json'), 'utf8');
  } catch {
    throw new MoveError(`no move ${id} under ${deps.movesDir}`);
  }
  const j = JSON.parse(raw) as Journal;
  if (!isRec(j) || j.version !== 1 || j.id !== id || !Array.isArray(j.entries)) throw new MoveError(`the journal of ${id} is not one this version reads`);
  return j;
}

const last = (j: Journal, step: JournalEntry['step']): JournalEntry | undefined => [...j.entries].reverse().find((e) => e.step === step);
const finished = (j: Journal, step: MoveStep): boolean => {
  const r = last(j, step)?.result;
  return r === 'done' || r === 'skipped';
};
/** Whether the local instance may have stepped down and not been given the workspace back. A step-down of unknown outcome counts: claiming back is harmless when nothing moved. */
const movedOut = (j: Journal): boolean => {
  const r = last(j, 'step-down')?.result;
  return r === 'done' || r === 'started' || r === 'unknown';
};

export async function runMove(deps: MoveDeps, settings: MoveSettings): Promise<MoveSummary> {
  const now = deps.now ?? (() => new Date());
  const id = deps.newId?.() ?? `mv-${randomBytes(5).toString('hex')}`;
  if (!MOVE_ID.test(id)) throw new MoveError('not a move id');
  const j: Journal = {
    version: 1,
    id,
    createdAt: now().toISOString(),
    provider: settings.provider,
    plan: settings.plan,
    region: settings.region,
    image: settings.image ?? 'Ubuntu 24.04',
    name: `coxia-${id.slice(3)}`,
    adminUser: settings.adminUser ?? 'admin',
    destroyOnFailure: settings.destroyOnFailure === true,
    buyAttempted: false,
    hostKeysVerified: false,
    entries: [],
  };
  await mkdir(moveDir(deps, id), { recursive: true, mode: 0o700 });
  await chmod(moveDir(deps, id), 0o700);
  return execute(deps, settings, j);
}

export async function resumeMove(deps: MoveDeps, settings: MoveSettings, id: string): Promise<MoveSummary> {
  const j = await loadJournal(deps, id);
  // What was bought is what the journal says; the flags of this run only add to it.
  if (settings.provider !== j.provider || settings.plan !== j.plan || settings.region !== j.region) throw new MoveError('the provider, plan and region of a move cannot change on resume');
  if (settings.destroyOnFailure) j.destroyOnFailure = true;
  return execute(deps, settings, j);
}

/** Gives the workspace back and (with the flag) ends the machine, for a move that was left half done by a crash. */
export async function abortMove(deps: MoveDeps, settings: MoveSettings, id: string): Promise<{ rolledBack: boolean | 'not-needed' | 'failed' }> {
  const j = await loadJournal(deps, id);
  if (settings.destroyOnFailure) j.destroyOnFailure = true;
  const ctx = makeContext(deps, settings, j);
  const rolledBack = await rollback(ctx);
  return { rolledBack };
}

interface Context {
  deps: MoveDeps;
  settings: MoveSettings;
  j: Journal;
  dir: string;
  /** In memory only. */
  recoveryCopy: string | undefined;
  key: AdminKey | undefined;
  /** Every secret this run has held, kept (in memory) so what it says later is still scrubbed of it. */
  known: string[];
  secretsOfThisRun: () => string[];
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

function makeContext(deps: MoveDeps, settings: MoveSettings, j: Journal): Context {
  const ctx: Context = {
    deps,
    settings,
    j,
    dir: moveDir(deps, j.id),
    recoveryCopy: undefined,
    key: undefined,
    known: [],
    secretsOfThisRun: () => ctx.known,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? real,
  };
  return ctx;
}

const scrub = (ctx: Context, text: string): string => ctx.secretsOfThisRun().reduce((acc, s) => acc.split(s).join('[redacted]'), text);
const say = (ctx: Context, line: string): void => ctx.deps.log?.(scrub(ctx, line));

async function save(ctx: Context): Promise<void> {
  const text = `${JSON.stringify(ctx.j, null, 2)}\n`;
  // The one place the journal is written: a copy of the key in it is a bug, and it stops here.
  for (const s of ctx.secretsOfThisRun()) if (text.includes(s)) throw new MoveError('refusing to write the recovery copy into the journal');
  const file = path.join(ctx.dir, 'move.json');
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

async function note(ctx: Context, step: JournalEntry['step'], result: EntryResult, detail: string): Promise<void> {
  ctx.j.entries.push({ step, at: ctx.now().toISOString(), result, detail: scrub(ctx, detail).slice(0, 500) });
  await save(ctx);
}

async function execute(deps: MoveDeps, settings: MoveSettings, j: Journal): Promise<MoveSummary> {
  const ctx = makeContext(deps, settings, j);
  await save(ctx);
  for (const step of MOVE_STEPS) {
    if (finished(j, step)) {
      say(ctx, `${step}: done earlier, skipped`);
      continue;
    }
    await note(ctx, step, 'started', '');
    say(ctx, `${step}...`);
    try {
      const out = await STEPS[step](ctx);
      await note(ctx, step, out.skipped ? 'skipped' : 'done', out.detail);
    } catch (e) {
      const text = scrub(ctx, msg(e));
      // A step-down whose answer was lost may or may not have happened; a refusal by the core did not.
      const unknown = step === 'step-down' && !(e instanceof AdminDoorError && e.answered);
      await note(ctx, step, unknown ? 'unknown' : 'failed', text);
      const rolledBack = await rollback(ctx);
      const kept = j.serverId !== undefined && !(j.destroyOnFailure && last(j, 'destroy')?.result === 'done');
      throw new MoveFailed(j.id, step, text, rolledBack, kept);
    }
  }
  ctx.recoveryCopy = undefined;
  return summaryOf(ctx);
}

function summaryOf(ctx: Context): MoveSummary {
  const { j } = ctx;
  const handover = last(j, 'copy-handover');
  return {
    moveId: j.id,
    serverId: j.serverId!,
    ssh: { user: j.adminUser, host: j.ip! },
    workspace: j.workspace!,
    hostKeys: j.hostKeys ?? [],
    keyFile: path.join(ctx.dir, 'admin_ed25519'),
    knownHostsFile: path.join(ctx.dir, 'known_hosts'),
    recoveryCopy: handover?.result === 'skipped' ? 'not shown: read /etc/coxia/master.key on the VPS as root over ssh (see docs/move.md)' : (handover?.detail ?? ''),
    notMovedSecrets: j.exported?.secretsNotMoved ?? [],
  };
}

async function rollback(ctx: Context): Promise<boolean | 'not-needed' | 'failed'> {
  const { j, deps } = ctx;
  let outcome: boolean | 'not-needed' | 'failed' = 'not-needed';
  if (movedOut(j)) {
    // The VPS may already run its own copy of the workspace; two owners must not run at once, so it is stopped before this one takes the workspace back.
    if (finished(j, 'import') || last(j, 'import')?.result === 'started' || last(j, 'import')?.result === 'failed' || last(j, 'import')?.result === 'unknown') {
      try {
        const ssh = sshFor(ctx);
        const r = await ssh.run(['sudo', '-n', 'systemctl', 'stop', 'coxia']);
        await note(ctx, 'rollback', r.exitCode === 0 ? 'done' : 'failed', r.exitCode === 0 ? 'stopped coxia on the VPS' : `could not stop coxia on the VPS (exit ${r.exitCode}): it may still run a copy`);
      } catch (e) {
        await note(ctx, 'rollback', 'failed', `could not stop coxia on the VPS: ${msg(e)}`);
      }
    }
    try {
      await deps.core.call('ownership:claim', [{ admin: true }]);
      for (const s of AFTER_STEP_DOWN) if (last(j, s) && last(j, s)?.result !== 'rolled-back') await note(ctx, s, 'rolled-back', 'the local instance took the workspace back');
      await note(ctx, 'rollback', 'done', 'ownership:claim admin: the local instance owns the workspace again');
      outcome = true;
    } catch (e) {
      await note(ctx, 'rollback', 'failed', `ownership:claim admin failed: ${msg(e)}. Run it by hand on the admin door.`).catch(() => undefined);
      outcome = 'failed';
    }
  }
  if (j.destroyOnFailure && j.serverId && last(j, 'destroy')?.result !== 'done') {
    try {
      await deps.provider.destroyServer(j.serverId);
      await note(ctx, 'destroy', 'done', `server ${j.serverId} ended through the guarded destroy`);
    } catch (e) {
      await note(ctx, 'destroy', 'failed', `the guarded destroy did not end server ${j.serverId}: ${msg(e)}`);
    }
  }
  return outcome;
}

function sshFor(ctx: Context): MoveSsh {
  const { j } = ctx;
  if (!j.ip) throw new MoveError('the machine has no address yet');
  return ctx.deps.sshFor({
    host: j.ip,
    user: j.adminUser,
    identityFile: path.join(ctx.dir, 'admin_ed25519'),
    knownHostsFile: path.join(ctx.dir, 'known_hosts'),
    trust: j.hostKeysVerified ? 'strict' : 'accept-new',
  });
}

interface StepOut {
  detail: string;
  skipped?: boolean;
}

async function waitRunning(ctx: Context): Promise<void> {
  const { j, deps } = ctx;
  const { attempts, delayMs } = deps.serverWait ?? { attempts: 90, delayMs: 10_000 };
  for (let i = 1; ; i++) {
    const s = await deps.provider.getServer(j.serverId!);
    // A purchase waiting for payment turns into a machine with another id.
    if (s.id !== j.serverId) {
      j.serverId = s.id;
      await save(ctx);
    }
    if (s.status === 'running' && s.ipv4) {
      if (j.ip !== s.ipv4) {
        j.ip = s.ipv4;
        await save(ctx);
      }
      return;
    }
    if (i >= attempts) {
      if (s.status === 'pending-payment') throw new MoveError('the provider has not confirmed the payment, so there is no machine yet: finish it in the provider panel, then resume this move');
      throw new MoveError(`the machine is not running yet (${s.status}); resume this move later`);
    }
    await ctx.sleep(delayMs);
  }
}

function hold(ctx: Context, key: string): string {
  ctx.recoveryCopy = key;
  if (!ctx.known.includes(key)) ctx.known.push(key);
  return key;
}

async function needKey(ctx: Context): Promise<string> {
  if (ctx.recoveryCopy) return ctx.recoveryCopy;
  if (ctx.settings.recoveryCopyFile && (await exists(ctx.settings.recoveryCopyFile))) {
    const text = (await readFile(ctx.settings.recoveryCopyFile, 'utf8')).trim();
    if (!KEY64.test(text)) throw new MoveError('the recovery copy file does not hold a 64-digit hex key');
    return hold(ctx, text);
  }
  try {
    return hold(ctx, await fetchRecoveryCopy(sshFor(ctx)));
  } catch (e) {
    if (e instanceof RecoveryCopyRefusedError) throw new MoveError(LOST_COPY);
    throw e;
  }
}

const STEPS: Record<MoveStep, (ctx: Context) => Promise<StepOut>> = {
  async propose(ctx) {
    const { j, deps, settings } = ctx;
    if (settings.recoveryCopyFile && !finished(j, 'recovery-copy') && (await exists(settings.recoveryCopyFile))) {
      throw new MoveError('the recovery copy file already exists: give a path that does not, so an old key is never taken for this machine\'s');
    }
    const status = await deps.core.call('ownership:status', []);
    if (!isRec(status) || status.role !== 'owner') throw new MoveError('this instance is not the owner of the workspace, so there is nothing to move');
    const price = await deps.provider.priceOf(j.plan, j.region);
    const due = price.upfront ?? price.amount;
    const text = `${j.provider} plan ${j.plan} in ${j.region}: ${due} ${price.currency}${price.upfront !== undefined && price.termMonths ? ` now for ${price.termMonths} months` : ' now'}, then ${price.amount} ${price.currency} a month`;
    say(ctx, `proposal: ${text}. The purchase waits for the budget and for your yes in the desktop.`);
    return { detail: text };
  },

  async keys(ctx) {
    ctx.key = await ctx.deps.ensureKey(ctx.dir, `coxia-provision ${ctx.j.id}`);
    return { detail: 'admin key pair ready' };
  },

  async buy(ctx) {
    const { j, deps, settings } = ctx;
    if (!ctx.key) ctx.key = await deps.ensureKey(ctx.dir, `coxia-provision ${j.id}`);
    if (j.buyAttempted && !j.serverId) {
      // An earlier run may have bought: find the machine by its hostname before anything is bought again.
      const found = (await deps.provider.listServers()).find((s) => s.name === j.name);
      if (!found) throw new MoveError(`an earlier run may have bought ${j.name} and the provider does not list it: look in the provider's panel before starting another move (a purchase waiting for payment is not listed)`);
      j.serverId = found.id;
      await save(ctx);
      return { detail: `adopted server ${found.id}` };
    }
    if (j.serverId) return { detail: `server ${j.serverId} already bought` };
    const shared = { serverRef: settings.serverRef, ...(settings.coxiaRef ? { coxiaRef: settings.coxiaRef } : {}), ...(settings.timezone ? { timezone: settings.timezone } : {}), adminUser: j.adminUser, adminPublicKeys: [ctx.key.publicKey], provisionScript: settings.provisionScript };
    const bootstrap =
      deps.provider.capabilities.bootstrap === 'script'
        ? ({ kind: 'script', script: renderPostInstallScript(shared) } as const)
        : ({ kind: 'cloud-init', userData: renderCloudInit({ ...shared, timezone: settings.timezone ?? 'Etc/UTC' }) } as const);
    j.buyAttempted = true;
    await save(ctx);
    try {
      const server = await deps.provider.createServer({ name: j.name, region: j.region, size: j.plan, image: j.image, sshKeys: [ctx.key.publicKey], bootstrap });
      j.serverId = server.id;
      if (server.ipv4) j.ip = server.ipv4;
      await save(ctx);
      return { detail: `bought server ${server.id} (${server.status})` };
    } catch (e) {
      // Only an unknown outcome keeps the flag: every other error is a refusal before or by the vendor, and nothing was bought.
      if (!(isProviderError(e) && e.code === 'provider-unavailable')) {
        j.buyAttempted = false;
        await save(ctx);
      }
      throw e;
    }
  },

  async provision(ctx) {
    const { j, deps } = ctx;
    await waitRunning(ctx);
    const ssh = sshFor(ctx);
    const run = deps.provision ?? provisionMachine;
    // The recovery copy is asked for apart, after the host keys are checked: nothing secret goes over a session whose far end was only trusted on first use.
    const result = await run(ssh, { ...deps.provisionOptions, recoveryCopy: 'skip' });
    if (!j.hostKeysVerified) {
      verifyPinnedHostKeys(await ssh.pinnedFingerprints(), result.hostKeys);
      j.hostKeysVerified = true;
    }
    j.hostKeys = result.hostKeys;
    await save(ctx);
    return { detail: `provisioned ${j.ip}; host keys verified (${result.hostKeys.map((k) => k.type).join(', ')})` };
  },

  async 'recovery-copy'(ctx) {
    const { j, settings } = ctx;
    const ssh = sshFor(ctx);
    try {
      hold(ctx, await fetchRecoveryCopy(ssh));
    } catch (e) {
      if (!(e instanceof RecoveryCopyRefusedError)) throw e;
      // The machine gave it out before. The person's file, if given, is the one place it can come back from.
      if (!settings.recoveryCopyFile || !(await exists(settings.recoveryCopyFile))) throw new MoveError(LOST_COPY);
      await needKey(ctx);
      return { detail: 'the machine had handed the recovery copy over before; read from the recovery copy file' };
    }
    if (settings.recoveryCopyFile) {
      await writeFile(settings.recoveryCopyFile, `${ctx.recoveryCopy}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(settings.recoveryCopyFile, 0o600);
      j.recoveryCopyFile = settings.recoveryCopyFile;
      await save(ctx);
    }
    return { detail: j.recoveryCopyFile ? 'delivered; written to the recovery copy file' : 'delivered, held in memory only' };
  },

  async 'step-down'(ctx) {
    await ctx.deps.core.call('ownership:move-out', [{ to: `vps:${ctx.j.provider}:${ctx.j.serverId}` }]);
    return { detail: `moved out to vps:${ctx.j.provider}:${ctx.j.serverId}` };
  },

  async export(ctx) {
    const { j, deps } = ctx;
    const key = await needKey(ctx);
    const out = path.join(ctx.dir, 'bundle');
    const tarball = path.join(ctx.dir, 'bundle.tar.gz');
    // The core refuses an `out` that exists; what is here is an earlier try of this move.
    await rm(out, { recursive: true, force: true });
    await rm(tarball, { force: true });
    const manifest = await deps.core.call('move:export', [{ targetKey: key, out }], { timeoutMs: 30 * 60_000 });
    if (!isRec(manifest) || !isRec(manifest.workspace) || typeof manifest.workspace.id !== 'string') throw new MoveError('move:export answered without a manifest');
    const secrets = isRec(manifest.secrets) ? manifest.secrets : {};
    j.workspace = manifest.workspace.id;
    j.exported = {
      repos: Array.isArray(manifest.repos) ? manifest.repos.length : 0,
      files: typeof manifest.files === 'number' ? manifest.files : 0,
      bytes: typeof manifest.bytes === 'number' ? manifest.bytes : 0,
      secretsMoved: Array.isArray(secrets.moved) ? secrets.moved.length : 0,
      secretsNotMoved: Array.isArray(secrets.notMoved) ? secrets.notMoved.filter(isRec).map((n) => ({ ref: String(n.ref), type: String(n.type) })) : [],
    };
    await save(ctx);
    await deps.pack(out, tarball);
    return { detail: `exported workspace ${j.workspace}: ${j.exported.files} files, ${j.exported.secretsMoved} secrets moved, ${j.exported.secretsNotMoved.length} not moved` };
  },

  async 'copy-handover'(ctx) {
    const { j, deps } = ctx;
    if (j.recoveryCopyFile) return { detail: 'the recovery copy is in the file the person asked for' };
    if (!ctx.recoveryCopy) {
      // Not worth undoing the move for: the key is on the VPS and the final report says how to read it.
      return { skipped: true, detail: 'the recovery copy was not shown: this run no longer held it' };
    }
    const where = await deps.presentRecoveryCopy(ctx.recoveryCopy);
    ctx.recoveryCopy = undefined;
    return { detail: where };
  },

  async transfer(ctx) {
    const { j } = ctx;
    await sshFor(ctx).upload(path.join(ctx.dir, 'bundle.tar.gz'), remoteTarball(j));
    return { detail: `uploaded to ${j.adminUser}@${j.ip}` };
  },

  async import(ctx) {
    const { j } = ctx;
    const ssh = sshFor(ctx);
    const remote = remoteTarball(j);
    let r;
    try {
      r = await ssh.run(['sudo', '-n', 'coxia-server', 'import', remote], { timeoutMs: 30 * 60_000 });
    } finally {
      // The tarball holds the workspace; it does not stay on the machine whatever happened.
      await ssh.run(['rm', '-f', remote]).catch(() => undefined);
    }
    if (r.exitCode !== 0) throw new MoveError(`coxia-server import failed (exit ${r.exitCode}): ${r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
    const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new MoveError('coxia-server import printed no result line');
    }
    if (!isRec(parsed) || parsed.imported !== j.workspace || parsed.health !== 'ok') throw new MoveError('coxia-server import did not report the workspace imported with health ok');
    return { detail: `imported ${j.workspace}, health ok` };
  },

  async health(ctx) {
    const { j, deps } = ctx;
    const ssh = sshFor(ctx);
    const { attempts, delayMs } = deps.healthWait ?? { attempts: 12, delayMs: 5_000 };
    for (let i = 1; ; i++) {
      const status = await ssh.run(['coxia-server', 'status']);
      const owner = status.exitCode === 0 ? await ssh.run(['coxia-server', 'call', j.workspace!, 'ownership:status']) : status;
      if (owner.exitCode === 0) {
        let role: unknown;
        try {
          // `coxia-server call` prints the value as indented JSON over several lines.
          role = (JSON.parse(owner.stdout) as { role?: unknown }).role;
        } catch {
          role = undefined;
        }
        if (role === 'owner') return { detail: 'the VPS is healthy and owns the workspace' };
        if (i >= attempts) throw new MoveError(`the VPS answers but its role for ${j.workspace} is ${String(role)}, not owner`);
      } else if (i >= attempts) {
        throw new MoveError(`the VPS is not healthy (exit ${owner.exitCode}): ${(owner.stderr || owner.stdout).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
      }
      await ctx.sleep(delayMs);
    }
  },

  async finish(ctx) {
    await rm(path.join(ctx.dir, 'bundle'), { recursive: true, force: true });
    await rm(path.join(ctx.dir, 'bundle.tar.gz'), { force: true });
    return { detail: 'bundle removed from this computer' };
  },
};

const remoteTarball = (j: Journal): string => `/home/${j.adminUser}/coxia-move-${j.id}.tar.gz`;

