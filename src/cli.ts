#!/usr/bin/env node
// coxia-provision move: the command line of the move (docs/move.md). It wires the real collaborators (the admin door of the Coxia on this computer, the guarded provider, ssh)
// into `runMove` and prints what the person needs. Progress goes to stderr, the result to stdout.

import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reconnectingDoor } from './adminDoor.ts';
import { coreAccountCheck, coreDestroyGuard, coreSpendGate, fileAuditSink } from './corePorts.ts';
import { guardProvider } from './guarded.ts';
import { createHostingerProvider } from './hostinger/provider.ts';
import { abortMove, loadJournal, MoveError, MoveFailed, resumeMove, runMove } from './move.ts';
import type { MoveDeps, MoveSettings, MoveSummary } from './move.ts';
import type { SecretResolver } from './ports.ts';
import type { VpsProvider } from './provider.ts';
import { createSshRunner, ensureAdminKey, realExec } from './ssh.ts';

const USAGE = `usage: coxia-provision move --provider hostinger --plan <id> --region <id> --server-ref <ref> [options]
       coxia-provision move --resume <move id> [options]
       coxia-provision move --abort <move id> [options]

  --token-file <file>        the provider API token, a file readable by you only (0600); or set HOSTINGER_API_TOKEN
  --admin-socket <path>      the admin door of the Coxia on this computer (or COXIA_ADMIN_SOCKET)
  --recovery-copy-file <f>   write the VPS master key (the recovery copy) to this new file, 0600, instead of showing it once
  --destroy-on-failure       on failure end the machine through the guarded destroy (default: keep it for a retry)
  --server-ref <ref>         the coxia-server ref to install; a full commit id is the most fixed choice
  --coxia-ref <tag>          the Coxia core release the server builds
  --image <name>             the machine image (default "Ubuntu 24.04")
  --timezone <tz>            IANA timezone of the machine (default Etc/UTC)
  --admin-user <name>        the sudo user of the machine (default admin)
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface Built {
  deps: MoveDeps;
  close(): void;
}

export interface BuildInput {
  provider: string;
  tokenFile: string | undefined;
  adminSocket: string;
  moveId: string;
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

class UsageError extends Error {}

/** A token read from a file only the person can read, or from the environment. The value is never kept past the call and never put in an error. */
export function tokenResolver(opts: { tokenFile: string | undefined; env: NodeJS.ProcessEnv }): SecretResolver {
  return {
    resolve: async () => {
      if (opts.tokenFile) {
        const st = await lstat(opts.tokenFile).catch(() => undefined);
        if (!st) throw new UsageError('the token file does not exist');
        if (!st.isFile()) throw new UsageError('the token file must be a regular file, not a link');
        if (st.mode & 0o077) throw new UsageError('the token file is readable by others: chmod 600 it');
        const token = (await readFile(opts.tokenFile, 'utf8')).trim();
        if (!token) throw new UsageError('the token file is empty');
        return token;
      }
      const token = opts.env.HOSTINGER_API_TOKEN?.trim();
      if (!token) throw new UsageError('no provider token: give --token-file or set HOSTINGER_API_TOKEN');
      return token;
    },
  };
}

export function stateRoot(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'coxia-provision', 'moves');
}

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readProvisionScript = (): Promise<string> => readFile(path.join(packageRoot, 'deploy', 'provision.sh'), 'utf8');

async function realBuild(input: BuildInput): Promise<Built> {
  if (input.provider !== 'hostinger') throw new UsageError(`unknown provider ${input.provider}; only hostinger is supported`);
  const core = reconnectingDoor(input.adminSocket);
  const secrets = tokenResolver({ tokenFile: input.tokenFile, env: input.env });
  const raw: VpsProvider = createHostingerProvider({ secrets, tokenRef: 'provider.token' });
  const movesDir = stateRoot(input.env);
  const requestId = (kind: 'spend' | 'destroy'): string => `move-${input.moveId}-${kind}`;
  const provider = guardProvider(raw, {
    name: input.provider,
    gate: coreSpendGate({ core, requestId }),
    destroyGuard: coreDestroyGuard({ core, requestId }),
    accounts: coreAccountCheck(core),
    secrets,
    audit: fileAuditSink(path.join(movesDir, 'audit.log')),
  });
  const deps: MoveDeps = {
    core,
    provider,
    movesDir,
    sshFor: (t) => createSshRunner(t),
    ensureKey: (dir, comment) => ensureAdminKey(dir, comment),
    pack: async (folder, tarball) => {
      const r = await realExec('tar', ['czf', tarball, '-C', folder, '.']);
      if (r.exitCode !== 0) throw new MoveError(`tar failed (${r.stderr.trim().slice(0, 200)})`);
    },
    presentRecoveryCopy: async (key) => {
      input.io.stdout(`\nRECOVERY COPY of the new machine's master key. It is shown once and kept nowhere. Put it in a password manager now.\nWithout it, the secrets moved to the machine cannot be recovered if the machine's own copy is lost.\n\n${key}\n\n`);
      return 'shown once on the terminal';
    },
    log: (line) => input.io.stderr(`${line}\n`),
  };
  return { deps, close: () => core.close() };
}

export function formatSummary(s: MoveSummary): string {
  const lines = [
    `Move ${s.moveId} done: workspace ${s.workspace} now runs on the VPS.`,
    '',
    'For the desktop (Instances screen):',
    `  ssh target:        ${s.ssh.user}@${s.ssh.host}`,
    `  workspace:         ${s.workspace}`,
    `  key file:          ${s.keyFile}`,
    `  known hosts file:  ${s.knownHostsFile}`,
    '  host keys:         compare with the provider console before you trust them',
    ...s.hostKeys.map((k) => `    ${k.type} ${k.fingerprint}`),
    '',
    `Server id: ${s.serverId}`,
    `Recovery copy: ${s.recoveryCopy}`,
  ];
  if (s.notMovedSecrets.length) lines.push('', 'Secrets that were not moved (enter them again on the VPS):', ...s.notMovedSecrets.map((n) => `  ${n.ref} (${n.type})`));
  return `${lines.join('\n')}\n`;
}

export async function main(argv: readonly string[], opts: { env?: NodeJS.ProcessEnv; io?: CliIo; build?: (input: BuildInput) => Promise<Built>; provisionScript?: () => Promise<string> } = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const io = opts.io ?? { stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) };
  try {
    if (argv[0] !== 'move') throw new UsageError('the only command is `move`');
    const { values: v } = parseArgs({
      args: [...argv.slice(1)],
      strict: true,
      options: {
        provider: { type: 'string' },
        plan: { type: 'string' },
        region: { type: 'string' },
        'server-ref': { type: 'string' },
        'coxia-ref': { type: 'string' },
        image: { type: 'string' },
        timezone: { type: 'string' },
        'admin-user': { type: 'string' },
        'token-file': { type: 'string' },
        'admin-socket': { type: 'string' },
        'recovery-copy-file': { type: 'string' },
        'destroy-on-failure': { type: 'boolean' },
        resume: { type: 'string' },
        abort: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (v.help) {
      io.stdout(USAGE);
      return 0;
    }
    const adminSocket = v['admin-socket'] ?? env.COXIA_ADMIN_SOCKET;
    if (!adminSocket) throw new UsageError('--admin-socket (or COXIA_ADMIN_SOCKET) is required: the move asks the Coxia on this computer for the budget, the step-down and the export');
    const existing = v.resume ?? v.abort;
    if (v.resume && v.abort) throw new UsageError('--resume and --abort do not go together');

    let provider = v.provider;
    let plan = v.plan;
    let region = v.region;
    let image = v.image;
    if (existing) {
      const j = await loadJournal({ movesDir: stateRoot(env) }, existing);
      provider = j.provider;
      plan = j.plan;
      region = j.region;
      image = j.image;
    }
    if (!provider || !plan || !region) throw new UsageError('--provider, --plan and --region are required');
    if (!existing && !v['server-ref']) throw new UsageError('--server-ref is required: say which coxia-server to install');

    // The id is chosen here so the core's request keys carry it: a second move never reuses the first one's ticket.
    const moveId = existing ?? `mv-${randomBytes(5).toString('hex')}`;
    const build = opts.build ?? realBuild;
    const built = await build({ provider, tokenFile: v['token-file'], adminSocket, moveId, io, env });
    built.deps.newId = () => moveId;
    try {
      const settings: MoveSettings = {
        provider,
        plan,
        region,
        ...(image ? { image } : {}),
        serverRef: v['server-ref'] ?? 'unused-on-resume',
        ...(v['coxia-ref'] ? { coxiaRef: v['coxia-ref'] } : {}),
        ...(v.timezone ? { timezone: v.timezone } : {}),
        ...(v['admin-user'] ? { adminUser: v['admin-user'] } : {}),
        ...(v['destroy-on-failure'] ? { destroyOnFailure: true } : {}),
        ...(v['recovery-copy-file'] ? { recoveryCopyFile: path.resolve(v['recovery-copy-file']) } : {}),
        provisionScript: await (opts.provisionScript ?? readProvisionScript)(),
      };
      if (v.abort) {
        const r = await abortMove(built.deps, settings, v.abort);
        io.stdout(`Move ${v.abort} aborted. The local instance owns the workspace: ${String(r.rolledBack)}.\n`);
        return r.rolledBack === 'failed' ? 1 : 0;
      }
      const summary = v.resume ? await resumeMove(built.deps, settings, v.resume) : await runMove(built.deps, settings);
      io.stdout(formatSummary(summary));
      return 0;
    } finally {
      built.close();
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (e as { code?: string }).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      io.stderr(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof MoveFailed) {
      const owner = e.rolledBack === true ? 'The local instance owns the workspace again (ownership:claim admin).' : e.rolledBack === 'failed' ? 'The local instance could NOT take the workspace back: run ownership:claim with {"admin": true} on the admin door.' : 'The local instance never stepped down: it still owns the workspace.';
      io.stderr(`\nMove ${e.moveId} failed at ${e.step}: ${e.message}\n${owner}\n${e.serverKept ? `The VPS was kept. Retry with: coxia-provision move --resume ${e.moveId}` : 'No machine is left running for this move.'}\n`);
      return 1;
    }
    io.stderr(`${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
