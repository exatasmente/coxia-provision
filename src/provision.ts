// The client side of provisioning: runs from the old instance, over an SSH session to the new machine, and drives deploy/provision.sh.
// Commands are fixed argument lists; nothing from the machine's answers is ever run or interpolated into a command.
import { PROVISION_PATH } from './cloudInit.ts';

export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  timeoutMs?: number;
  /** Standard output carries a secret: the runner must not log it. */
  sensitive?: boolean;
}

/** One command on the new machine as the admin user. Exit status 255 means ssh itself could not connect. */
export interface SshRunner {
  run(argv: readonly string[], options?: SshRunOptions): Promise<SshResult>;
}

export type ProvisionStep = 'wait-cloud-init' | 'provision' | 'host-keys' | 'health' | 'recovery-copy';

export class ProvisionError extends Error {
  readonly step: ProvisionStep;
  readonly exitCode: number | null;
  constructor(step: ProvisionStep, message: string, exitCode: number | null = null) {
    super(`${step}: ${message}`);
    this.name = 'ProvisionError';
    this.step = step;
    this.exitCode = exitCode;
  }
}

/** The machine refused a second recovery copy; the first one is the only one. */
export class RecoveryCopyRefusedError extends ProvisionError {
  constructor() {
    super('recovery-copy', 'the recovery copy of the master key was already handed over', 3);
    this.name = 'RecoveryCopyRefusedError';
  }
}

export interface HostKeyFingerprint {
  type: 'ed25519' | 'ecdsa' | 'rsa';
  /** `SHA256:<base64>`, the form `ssh-keygen -l` and the desktop's trust flow compare. */
  fingerprint: string;
}

export type RecoveryCopyStatus = 'delivered' | 'already-handed-over' | 'skipped';

export interface ProvisionResult {
  hostKeys: HostKeyFingerprint[];
  /** What `coxia-server status` printed. */
  health: string;
  /** The master key, 64 hex digits, in memory only. Null unless status is `delivered`. */
  recoveryCopy: string | null;
  recoveryCopyStatus: RecoveryCopyStatus;
  /** The steps that ran, in order. */
  steps: ProvisionStep[];
}

export interface ProvisionOptions {
  /** `fetch` asks for the recovery copy; `skip` leaves it on the machine for a later call. Default `fetch`. */
  recoveryCopy?: 'fetch' | 'skip';
  /** Tries for the first connection and for the health check. Defaults 30 and 12. */
  connectAttempts?: number;
  healthAttempts?: number;
  /** Pause between tries; the default sleeps for real. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress, for the caller's own log. Receives step names only. */
  onStep?: (step: ProvisionStep) => void;
}

const SSH_CONNECT_FAILED = 255;
const PROVISION_TIMEOUT_MS = 45 * 60_000;
const real = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sudo = (...args: string[]) => ['sudo', '-n', PROVISION_PATH, ...args];
const tail = (text: string) => text.trim().split('\n').slice(-5).join(' | ').slice(0, 500);

const HOST_KEY_LINE = /^(ed25519|ecdsa|rsa) (SHA256:[A-Za-z0-9+/]{43})$/;
const MASTER_KEY = /^[0-9a-f]{64}$/;

export function parseHostKeys(stdout: string): HostKeyFingerprint[] {
  const keys: HostKeyFingerprint[] = [];
  for (const line of stdout.split('\n')) {
    const m = HOST_KEY_LINE.exec(line.trim());
    if (m) keys.push({ type: m[1] as HostKeyFingerprint['type'], fingerprint: m[2]! });
  }
  return keys;
}

/** Waits for the first boot to finish; a connection that is not up yet is tried again. */
export async function waitForCloudInit(runner: SshRunner, opts: ProvisionOptions = {}): Promise<void> {
  const attempts = opts.connectAttempts ?? 30;
  const sleep = opts.sleep ?? real;
  for (let i = 1; ; i++) {
    const r = await runner.run(['cloud-init', 'status', '--wait'], { timeoutMs: PROVISION_TIMEOUT_MS });
    if (r.exitCode === 0) return;
    if (r.exitCode === SSH_CONNECT_FAILED && i < attempts) {
      await sleep(opts.retryDelayMs ?? 10_000);
      continue;
    }
    throw new ProvisionError('wait-cloud-init', `cloud-init did not finish cleanly (${tail(r.stdout + ' ' + r.stderr)})`, r.exitCode);
  }
}

/** Asks for the recovery copy. The machine answers once; a second request throws RecoveryCopyRefusedError. */
export async function fetchRecoveryCopy(runner: SshRunner): Promise<string> {
  const r = await runner.run(sudo('recovery-copy'), { sensitive: true });
  // Neither the key nor the raw output is put in an error.
  if (r.exitCode === 3) throw new RecoveryCopyRefusedError();
  if (r.exitCode !== 0) throw new ProvisionError('recovery-copy', `the machine could not hand it over (${tail(r.stderr)})`, r.exitCode);
  const key = r.stdout.trim();
  if (!MASTER_KEY.test(key)) throw new ProvisionError('recovery-copy', 'the answer is not a 64-digit hex key', r.exitCode);
  return key;
}

/**
 * Runs the whole sequence. The recovery copy is the last step: it is asked for only once the instance is up, so a failed provision never
 * burns the single handover, and it is returned in memory. This module writes nothing to disk and the caller must not log it.
 */
export async function provisionMachine(runner: SshRunner, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const steps: ProvisionStep[] = [];
  const begin = (s: ProvisionStep) => {
    steps.push(s);
    opts.onStep?.(s);
  };
  const sleep = opts.sleep ?? real;

  begin('wait-cloud-init');
  await waitForCloudInit(runner, opts);

  // cloud-init already ran it once; running it again is safe and also covers a machine whose first run was cut short.
  begin('provision');
  const p = await runner.run(sudo('provision'), { timeoutMs: PROVISION_TIMEOUT_MS });
  if (p.exitCode !== 0) throw new ProvisionError('provision', `provision.sh failed (${tail(p.stderr || p.stdout)})`, p.exitCode);

  begin('host-keys');
  const k = await runner.run(sudo('host-keys'));
  if (k.exitCode !== 0) throw new ProvisionError('host-keys', `could not read the host keys (${tail(k.stderr)})`, k.exitCode);
  const hostKeys = parseHostKeys(k.stdout);
  if (hostKeys.length === 0) throw new ProvisionError('host-keys', 'no fingerprint in the answer', k.exitCode);

  begin('health');
  const attempts = opts.healthAttempts ?? 12;
  let health = '';
  for (let i = 1; ; i++) {
    const h = await runner.run(['coxia-server', 'status']);
    if (h.exitCode === 0) {
      health = h.stdout.trim();
      break;
    }
    if (i >= attempts) throw new ProvisionError('health', `coxia-server status still failing (${tail(h.stdout + ' ' + h.stderr)})`, h.exitCode);
    await sleep(opts.retryDelayMs ?? 5_000);
  }

  if ((opts.recoveryCopy ?? 'fetch') === 'skip') {
    return { hostKeys, health, recoveryCopy: null, recoveryCopyStatus: 'skipped', steps };
  }
  begin('recovery-copy');
  try {
    return { hostKeys, health, recoveryCopy: await fetchRecoveryCopy(runner), recoveryCopyStatus: 'delivered', steps };
  } catch (e) {
    // A machine provisioned before: everything else is as it should be, and the earlier handover stands.
    if (e instanceof RecoveryCopyRefusedError) return { hostKeys, health, recoveryCopy: null, recoveryCopyStatus: 'already-handed-over', steps };
    throw e;
  }
}
