// A client of the Coxia core's local admin door (docs/headless.md in the Coxia repository): a Unix socket, JSON one object per line, a hello with the contract version first,
// then requests `{id, channel, args}` answered `{id, ok, value | error}`. Events the core pushes are ignored. Whoever can open the socket has the rights of the window; there is no token.

import net from 'node:net';

/** The core's contract version this client speaks (`CONTRACT_VERSION` in the core's `src/shared/contract.ts`); a mismatch is refused by the core at the hello. */
export const CONTRACT_VERSION = 1;
export const ADMIN_LINE_MAX = 8 * 1024 * 1024;

export interface WireError {
  code: string;
  message: string;
}

/**
 * What a call to the core fails with. `answered` is true when the core replied with an error (the channel did not run, or refused), false when the connection broke or timed
 * out: then nobody knows whether the channel ran, and a caller that must know asks again with an idempotent call.
 */
export class AdminDoorError extends Error {
  code: string;
  answered: boolean;
  constructor(code: string, message: string, answered: boolean) {
    super(message);
    this.name = 'AdminDoorError';
    this.code = code;
    this.answered = answered;
  }
}

export interface CoreClient {
  /** The workspace the door belongs to, from the hello. */
  readonly workspace: string;
  call<T = unknown>(channel: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<T>;
  close(): void;
}

export interface ConnectOptions {
  contractVersion?: number;
  /** Default for a call that does not say; the handover pause and an export are slow. Default 10 minutes. */
  callTimeoutMs?: number;
  helloTimeoutMs?: number;
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const wire = (v: unknown): WireError => (isRec(v) && typeof v.code === 'string' ? { code: v.code, message: typeof v.message === 'string' ? v.message : '' } : { code: 'internal', message: 'unreadable error' });

export function connectAdminDoor(socketPath: string, opts: ConnectOptions = {}): Promise<CoreClient> {
  const version = opts.contractVersion ?? CONTRACT_VERSION;
  const defaultTimeout = opts.callTimeoutMs ?? 10 * 60_000;
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = net.connect(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let nextId = 1;
    let workspace: string | undefined;
    let closed = false;
    const waiting = new Map<number, Waiting>();

    const failAll = (e: Error): void => {
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(e);
      }
      waiting.clear();
    };
    const helloTimer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new AdminDoorError('timeout', 'the admin door did not answer the hello', false));
    }, opts.helloTimeoutMs ?? 10_000);

    const client: CoreClient = {
      get workspace() {
        return workspace ?? '';
      },
      call: (channel, args = [], callOpts = {}) =>
        new Promise((resolve, reject) => {
          if (closed) return reject(new AdminDoorError('closed', 'the admin door connection is closed', false));
          const id = nextId++;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new AdminDoorError('timeout', `${channel} did not answer in time`, false));
          }, callOpts.timeoutMs ?? defaultTimeout);
          waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
          socket.write(`${JSON.stringify({ id, channel, args })}\n`);
        }),
      close: () => {
        closed = true;
        socket.destroy();
      },
    };

    const onLine = (line: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRec(msg)) return;
      if (workspace === undefined) {
        clearTimeout(helloTimer);
        if (isRec(msg.hello) && typeof msg.hello.workspace === 'string') {
          workspace = msg.hello.workspace;
          resolveConnect(client);
        } else {
          const e = wire(msg.error);
          socket.destroy();
          rejectConnect(new AdminDoorError(e.code, e.message || 'the admin door refused the hello', true));
        }
        return;
      }
      if (typeof msg.id !== 'number') return; // an event
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok === true) w.resolve(msg.value);
      else {
        const e = wire(msg.error);
        w.reject(new AdminDoorError(e.code, e.message, true));
      }
    };

    socket.on('connect', () => socket.write(`${JSON.stringify({ hello: version })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > ADMIN_LINE_MAX) {
        socket.destroy();
        return;
      }
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
    const end = (why: string): void => {
      closed = true;
      clearTimeout(helloTimer);
      const e = new AdminDoorError('closed', why, false);
      if (workspace === undefined) rejectConnect(e);
      failAll(e);
    };
    socket.on('error', (e) => end(`the admin door connection failed: ${(e as NodeJS.ErrnoException).code ?? 'error'}`));
    socket.on('close', () => end('the admin door closed the connection'));
  });
}
