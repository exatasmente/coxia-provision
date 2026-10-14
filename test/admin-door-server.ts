// A fake admin door: the same framing as the core's (hello, then one answer per request), with the channels a test installs.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Handler = (args: unknown[], channel: string) => unknown | Promise<unknown>;

/** A handler that throws this answers `{ok:false, error}`. */
export class FakeWireError extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

export interface FakeDoor {
  socketPath: string;
  /** Every request received, in order. */
  calls: { channel: string; args: unknown[] }[];
  handle(channel: string, handler: Handler): void;
  /** Closes every connection without answering the next request of this channel. */
  dropOn(channel: string): void;
  close(): Promise<void>;
}

export async function startFakeDoor(opts: { workspace?: string; version?: number } = {}): Promise<FakeDoor> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxp-door-'));
  const socketPath = path.join(dir, 'admin.sock');
  const handlers = new Map<string, Handler>();
  const drops = new Set<string>();
  const sockets = new Set<net.Socket>();
  const calls: FakeDoor['calls'] = [];
  const version = opts.version ?? 1;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buf = '';
    let greeted = false;
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as { hello?: number; id?: number; channel?: string; args?: unknown[] };
        if (!greeted) {
          if (msg.hello !== version) {
            socket.end(`${JSON.stringify({ error: { code: 'contract-mismatch', message: `core speaks ${version}, client ${String(msg.hello)}` } })}\n`);
            return;
          }
          greeted = true;
          socket.write(`${JSON.stringify({ hello: { version, workspace: opts.workspace ?? 'principal' } })}\n`);
          socket.write(`${JSON.stringify({ event: { type: 'noise' } })}\n`);
          continue;
        }
        const channel = msg.channel ?? '';
        const args = msg.args ?? [];
        calls.push({ channel, args });
        if (drops.delete(channel)) {
          for (const s of sockets) s.destroy();
          return;
        }
        const handler = handlers.get(channel);
        void (async () => {
          try {
            if (!handler) throw new FakeWireError('unknown-channel', channel);
            const value = await handler(args, channel);
            socket.write(`${JSON.stringify({ id: msg.id, ok: true, value: value ?? null })}\n`);
          } catch (e) {
            const code = (e as { code?: string }).code ?? 'internal';
            socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code, message: (e as Error).message } })}\n`);
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    calls,
    handle: (c, h) => void handlers.set(c, h),
    dropOn: (c) => void drops.add(c),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
