// The real SSH side of the move: `ssh` and `scp` spawned with fixed argument lists, the person's own OpenSSH doing the work. No shell on this side, BatchMode (never a prompt),
// IdentitiesOnly (only the move's key), and a known_hosts file of the move's own so the person's ~/.ssh/known_hosts is neither trusted nor touched.
//
// Trust in the machine's host key: the first connection uses `StrictHostKeyChecking=accept-new`, because nothing the provider returns carries the key. That session only
// waits for the machine and runs provisioning, which sends it nothing secret. `provisionMachine` then reads the fingerprints from the machine itself, and `verifyPinnedHostKeys`
// compares them with what the first connection pinned; a mismatch stops the move before the recovery copy or any data is exchanged. From then on the runner is built `strict`.
// Honest limit: an attacker who sat in the middle of the first connection and relayed everything would also be relayed the fingerprints, so the two would agree on the attacker's
// key. The fingerprints are printed at the end so the person can compare them with the provider's console.

import { spawn } from 'node:child_process';
import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HostKeyFingerprint, SshResult, SshRunOptions, SshRunner } from './provision.ts';

export interface Exec {
  (cmd: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<SshResult>;
}

/** `ssh` itself failing to connect is 255; a killed command or a missing binary is reported the same so the caller retries or stops. */
export const EXEC_FAILED = 255;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), opts.timeoutMs) : undefined;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: EXEC_FAILED, stdout, stderr: `${cmd}: ${(e as NodeJS.ErrnoException).code ?? e.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? EXEC_FAILED : (code ?? EXEC_FAILED), stdout, stderr: timedOut ? `${stderr}\n${cmd} timed out` : stderr });
    });
  });

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  /** The private key; only this one is offered. */
  identityFile: string;
  /** The move's own known_hosts. */
  knownHostsFile: string;
  /** `accept-new` for the first contact, `strict` once the fingerprints were verified. */
  trust: 'accept-new' | 'strict';
}

export interface MoveSsh extends SshRunner {
  upload(localFile: string, remotePath: string): Promise<void>;
  /** The fingerprints of the host keys the first connection pinned in the move's known_hosts. */
  pinnedFingerprints(): Promise<HostKeyFingerprint[]>;
}

export class SshSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshSetupError';
  }
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9a-fA-F:]{2,45})$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const REMOTE_PATH = /^[A-Za-z0-9_./-]{1,200}$/;

/** One word for a remote shell: ssh joins its arguments with spaces and the far shell splits them again, so every word is quoted. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function baseOptions(t: SshTarget): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', `StrictHostKeyChecking=${t.trust === 'strict' ? 'yes' : 'accept-new'}`,
    '-o', `UserKnownHostsFile=${t.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-i', t.identityFile,
  ];
}

export function createSshRunner(target: SshTarget, exec: Exec = realExec): MoveSsh {
  if (!HOST.test(target.host)) throw new SshSetupError('the host is not a plain name or address');
  if (!USER.test(target.user)) throw new SshSetupError('the ssh user is not a plain user name');
  const port = target.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshSetupError('the ssh port is not valid');
  const dest = `${target.user}@${target.host}`;

  return {
    run: (argv: readonly string[], options: SshRunOptions = {}) => exec('ssh', [...baseOptions(target), '-p', String(port), '--', dest, ...argv.map(shellQuote)], options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),

    async upload(localFile, remotePath) {
      if (!REMOTE_PATH.test(remotePath)) throw new SshSetupError('the remote path is not plain');
      // -O: the legacy protocol, so the remote side needs no sftp subsystem; a failure is the exit status.
      const r = await exec('scp', ['-q', '-O', ...baseOptions(target), '-P', String(port), '--', localFile, `${dest}:${remotePath}`], { timeoutMs: 30 * 60_000 });
      if (r.exitCode !== 0) throw new SshSetupError(`scp failed (${r.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)})`);
    },

    async pinnedFingerprints() {
      return knownHostsFingerprints(target.knownHostsFile, exec);
    },
  };
}

const KH_LINE = /^\d+ (SHA256:[A-Za-z0-9+/]{43}) .* \((ED25519|ECDSA|RSA)\)$/;

/** What `ssh-keygen -l -f` says about the keys in a known_hosts file. */
export async function knownHostsFingerprints(file: string, exec: Exec = realExec): Promise<HostKeyFingerprint[]> {
  const r = await exec('ssh-keygen', ['-l', '-f', file]);
  if (r.exitCode !== 0) return [];
  const out: HostKeyFingerprint[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = KH_LINE.exec(line.trim());
    if (m) out.push({ type: m[2]!.toLowerCase() as HostKeyFingerprint['type'], fingerprint: m[1]! });
  }
  return out;
}

/** Throws unless the first connection pinned at least one key and every pinned key is one the machine itself reported. */
export function verifyPinnedHostKeys(pinned: readonly HostKeyFingerprint[], reported: readonly HostKeyFingerprint[]): void {
  if (pinned.length === 0) throw new SshSetupError('the first connection pinned no host key to compare');
  for (const p of pinned) {
    if (!reported.some((r) => r.type === p.type && r.fingerprint === p.fingerprint)) {
      throw new SshSetupError(`the host key the connection saw (${p.type} ${p.fingerprint}) is not one the machine reports: the connection may not be going to the machine that was bought`);
    }
  }
}

export interface AdminKey {
  privateKeyFile: string;
  publicKey: string;
}

/** The key pair the move logs in with, made on this computer and kept in the move's folder; only the public half leaves. An existing pair is reused so a resumed move keeps its key. */
export async function ensureAdminKey(dir: string, comment: string, exec: Exec = realExec): Promise<AdminKey> {
  const privateKeyFile = path.join(dir, 'admin_ed25519');
  const exists = await stat(privateKeyFile).then(() => true, () => false);
  if (!exists) {
    const r = await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', privateKeyFile]);
    if (r.exitCode !== 0) throw new SshSetupError(`ssh-keygen could not make the key pair (${r.stderr.trim().slice(0, 200)})`);
  }
  await chmod(privateKeyFile, 0o600);
  const publicKey = (await readFile(`${privateKeyFile}.pub`, 'utf8')).trim();
  if (!/^ssh-ed25519 \S+/.test(publicKey)) throw new SshSetupError('the public key is not an ed25519 key line');
  return { privateKeyFile, publicKey };
}

