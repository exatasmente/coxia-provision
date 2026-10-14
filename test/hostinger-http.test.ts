import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { createHttpClient, retryAfterSec } from '../src/hostinger/http.ts';
import type { HttpClient } from '../src/hostinger/http.ts';
import { isProviderError } from '../src/provider.ts';
import { memorySecrets } from './helpers.ts';

// Made at run time: a literal token, even a fake one, trips secret scanners.
const TOKEN = `tok-hostinger-${randomBytes(8).toString('hex')}`;

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;
const open: Server[] = [];

async function harness(handler: Handler, extra: { maxRetryWaitSec?: number } = {}): Promise<{ client: HttpClient; hits: { method: string; url: string; auth: string | undefined }[]; slept: number[] }> {
  const hits: { method: string; url: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res, hits.length);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  const slept: number[] = [];
  const client = createHttpClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secrets: memorySecrets({ tok: TOKEN }),
    tokenRef: 'tok',
    sleep: async (ms) => void slept.push(ms),
    ...extra,
  });
  return { client, hits, slept };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Error);
    return e;
  }
  return assert.fail('expected a throw');
}

afterEach(async () => {
  for (const s of open.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('hostinger http client', () => {
  test('sends the bearer token and returns the parsed body', async () => {
    const h = await harness((_q, res) => json(res, 200, [{ id: 1 }]));
    const r = await h.client.request('GET', '/api/vps/v1/virtual-machines', { idempotent: true, query: { page: 2 } });
    assert.deepEqual(r, { status: 200, body: [{ id: 1 }] });
    assert.equal(h.hits[0]!.auth, `Bearer ${TOKEN}`);
    assert.equal(h.hits[0]!.url, '/api/vps/v1/virtual-machines?page=2');
  });

  test('a 429 is retried after Retry-After, at most 3 times', async () => {
    const h = await harness((_q, res, n) => (n <= 2 ? json(res, 429, { message: 'slow down' }, { 'retry-after': '7' }) : json(res, 200, [])));
    await h.client.request('GET', '/x', { idempotent: true });
    assert.equal(h.hits.length, 3);
    assert.deepEqual(h.slept, [7000, 7000]);

    const g = await harness((_q, res) => json(res, 429, { message: 'slow down' }, { 'retry-after': '3' }));
    const e = await thrown(g.client.request('GET', '/x', { idempotent: true }));
    assert.ok(isProviderError(e));
    assert.equal(e.code, 'rate-limited');
    assert.equal(e.retryAfterSec, 3);
    assert.equal(g.hits.length, 4, 'the call and 3 retries');
  });

  test('a Retry-After longer than the cap is not waited for', async () => {
    const h = await harness((_q, res) => json(res, 429, {}, { 'retry-after': '600' }), { maxRetryWaitSec: 30 });
    const e = await thrown(h.client.request('GET', '/x', { idempotent: true }));
    assert.equal((e as { code?: string }).code, 'rate-limited');
    assert.equal((e as { retryAfterSec?: number }).retryAfterSec, 600);
    assert.equal(h.hits.length, 1);
    assert.deepEqual(h.slept, []);
  });

  test('a 5xx on an idempotent call is retried once, then fails', async () => {
    const ok = await harness((_q, res, n) => (n === 1 ? json(res, 502, { message: 'bad gateway' }) : json(res, 200, {})));
    await ok.client.request('GET', '/x', { idempotent: true });
    assert.equal(ok.hits.length, 2);

    const bad = await harness((_q, res) => json(res, 500, { message: 'boom' }));
    const e = await thrown(bad.client.request('GET', '/x', { idempotent: true }));
    assert.equal((e as { code?: string }).code, 'provider-unavailable');
    assert.equal(bad.hits.length, 2);
  });

  test('a call that is not idempotent is never retried, on a 5xx, a 429 or a lost connection', async () => {
    for (const status of [500, 502, 429]) {
      const h = await harness((_q, res) => json(res, status, { message: 'no' }, status === 429 ? { 'retry-after': '1' } : {}));
      const e = await thrown(h.client.request('POST', '/api/vps/v1/virtual-machines', { idempotent: false, body: { item_id: 'x' } }));
      assert.ok(isProviderError(e));
      assert.equal(h.hits.length, 1, `one POST for ${status}`);
      if (status >= 500) assert.match(e.message, /unknown/);
    }
    const dropped = await harness((q) => q.socket.destroy());
    const e = await thrown(dropped.client.request('POST', '/x', { idempotent: false, body: {} }));
    assert.equal((e as { code?: string }).code, 'provider-unavailable');
    assert.equal(dropped.hits.length, 1);
    assert.match(e.message, /unknown/);
  });

  test('statuses become codes', async () => {
    const want: [number, string][] = [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not-found'], [422, 'invalid-input'], [409, 'provider-unavailable']];
    for (const [status, code] of want) {
      const h = await harness((_q, res) => json(res, status, { message: 'x', correlation_id: 'abc-123' }));
      const e = await thrown(h.client.request('GET', '/x', { idempotent: true }));
      assert.equal((e as { code?: string }).code, code, String(status));
      assert.match(e.message, /abc-123/);
    }
  });

  test('a token echoed by the server never reaches the error', async () => {
    const h = await harness((_q, res) => json(res, 422, { message: `bad header Bearer ${TOKEN} and ${encodeURIComponent(TOKEN)}`, correlation_id: TOKEN }));
    const e = await thrown(h.client.request('GET', '/x', { idempotent: true }));
    assert.ok(!e.message.includes(TOKEN));
    assert.ok(!e.stack?.includes(TOKEN));
    assert.ok(e.message.includes('[redacted]'));
  });

  test('an unreadable token is unauthorized and nothing is sent', async () => {
    const h = await harness((_q, res) => json(res, 200, {}));
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:1', secrets: memorySecrets({}), tokenRef: 'missing' });
    const e = await thrown(client.request('GET', '/x', { idempotent: true }));
    assert.equal((e as { code?: string }).code, 'unauthorized');
    assert.equal(h.hits.length, 0);
  });

  test('Retry-After reads seconds and dates', () => {
    assert.equal(retryAfterSec('42'), 42);
    assert.equal(retryAfterSec(null), undefined);
    assert.equal(retryAfterSec('soon'), undefined);
    assert.equal(retryAfterSec(new Date(10_000).toUTCString(), 4_000), 6);
  });
});
