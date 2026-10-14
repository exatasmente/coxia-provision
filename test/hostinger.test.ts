import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { createHostingerProvider, MAX_SCRIPT_BYTES } from '../src/hostinger/provider.ts';
import type { HostingerOptions } from '../src/hostinger/provider.ts';
import { guardProvider } from '../src/guarded.ts';
import type { SpendRequest } from '../src/ports.ts';
import { isProviderError } from '../src/provider.ts';
import type { CreateServerInput } from '../src/provider.ts';
import { startFakeHostinger } from './hostinger-server.ts';
import { memorySecrets } from './helpers.ts';

// Made at run time: a literal token, even a fake one, trips secret scanners.
const TOKEN = `tok-hostinger-${randomBytes(8).toString('hex')}`;
const WRONG = `tok-wrong-${randomBytes(8).toString('hex')}`;
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests test@example.com';
const fake = await startFakeHostinger(TOKEN);
after(() => fake.close());

const slept: number[] = [];
const secrets = memorySecrets({ good: TOKEN, bad: WRONG });
const make = (over: Partial<HostingerOptions> = {}) => createHostingerProvider({ secrets, tokenRef: 'good', baseUrl: fake.url, sleep: async (ms) => void slept.push(ms), ...over });
const input = (over: Partial<CreateServerInput> = {}): CreateServerInput => ({ name: 'core-1', region: '9', size: 'vps-kvm2', image: 'Ubuntu 24.04 LTS', sshKeys: [KEY], bootstrap: { kind: 'script', script: '#!/bin/sh\necho hi\n' }, ...over });

beforeEach(() => {
  fake.vms.length = 0;
  fake.subs.length = 0;
  fake.scripts = [];
  fake.requests.length = 0;
  fake.mode = 'ok';
  fake.failNext(200, 0);
  slept.length = 0;
});

const writes = () => fake.requests.filter((r) => r.method !== 'GET');
const purchases = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/vps/v1/virtual-machines');
async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Error);
    return e;
  }
  return assert.fail('expected a throw');
}
const chain = (e: unknown): string => {
  const parts: string[] = [];
  for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) parts.push(cur.name, cur.message, cur.stack ?? '', JSON.stringify(cur, Object.getOwnPropertyNames(cur)));
  return parts.join('\n');
};

describe('purchase', () => {
  test('uploads the script, buys the chosen plan and term with the key, and reports what the order charged', async () => {
    const server = await make().createServer(input());
    const post = purchases()[0]!;
    const script = fake.scripts[0]!;
    assert.equal(script.content, '#!/bin/sh\necho hi\n');
    assert.deepEqual(post.body, {
      item_id: 'vps-kvm2-usd-1m',
      setup: { template_id: 1002, data_center_id: 9, hostname: 'core-1', post_install_script_id: script.id, install_monarx: false, enable_backups: false, public_key: { name: 'coxia-core-1', key: KEY } },
    });
    assert.ok(post.auth === `Bearer ${TOKEN}`);
    assert.deepEqual(post.body && 'payment_method_id' in (post.body as object), false, 'the default payment method is used');
    assert.equal(server.status, 'running');
    assert.equal(server.name, 'core-1');
    assert.equal(server.size, 'vps-kvm2');
    assert.equal(server.region, '9');
    assert.deepEqual(server.monthly, { amount: 14.99, currency: 'USD' });
    // 899 cents first period, plus the 10% the fake adds for tax: the order total, not the list price.
    assert.deepEqual(server.upfront, { amount: 9.89, currency: 'USD' });
    assert.equal(writes().filter((r) => r.method === 'POST').length, 2, 'one script, one purchase');
  });

  test('a purchase without a bootstrap uploads no script', async () => {
    await make().createServer(input({ bootstrap: undefined }));
    assert.equal(fake.scripts.length, 0);
    assert.equal((purchases()[0]!.body as any).setup.post_install_script_id, undefined);
  });

  test('the script is held to 48 KB, in bytes, before anything is written', async () => {
    const p = make();
    const over = '#'.repeat(MAX_SCRIPT_BYTES + 1);
    const e = await thrown(p.createServer(input({ bootstrap: { kind: 'script', script: over } })));
    assert.ok(isProviderError(e) && e.code === 'invalid-input');
    assert.match(e.message, /48 KB/);
    // Two bytes a character: 24 577 of them are over though the string is under the limit in characters.
    const wide = await thrown(p.createServer(input({ bootstrap: { kind: 'script', script: 'é'.repeat(MAX_SCRIPT_BYTES / 2 + 1) } })));
    assert.equal((wide as { code?: string }).code, 'invalid-input');
    assert.deepEqual(writes(), []);
    await p.createServer(input({ bootstrap: { kind: 'script', script: '#'.repeat(MAX_SCRIPT_BYTES) } }));
    assert.equal(fake.scripts[0]!.content.length, MAX_SCRIPT_BYTES);
  });

  test('what the vendor would refuse is refused before a script is uploaded or money moves', async () => {
    const p = make();
    const bad: Partial<CreateServerInput>[] = [
      { sshKeys: [] },
      { sshKeys: [KEY, KEY] },
      { sshKeys: ['not a key'] },
      { labels: { role: 'core' } },
      { bootstrap: { kind: 'cloud-init', userData: '#cloud-config\n' } },
      { image: 'Plan 9' },
      { size: 'hosting-web' },
      { size: 'vps-kvm9' },
      { region: '404' },
      { name: 'Not A Hostname' },
    ];
    for (const over of bad) {
      const e = await thrown(p.createServer(input(over)));
      assert.ok(isProviderError(e) && e.code === 'invalid-input', JSON.stringify(over));
    }
    assert.deepEqual(writes(), []);
  });

  test('payment pending (202) is a server in pending-payment, not an error, and its script stays for the panel setup', async () => {
    fake.mode = 'pending';
    const p = make();
    const server = await p.createServer(input());
    assert.equal(server.status, 'pending-payment');
    assert.match(server.id, /^pending:sub-/);
    assert.deepEqual(server.upfront, { amount: 8.99, currency: 'USD' });
    assert.equal(fake.scripts.length, 1);
    assert.equal(fake.vms.length, 0);
    assert.deepEqual(await p.listServers(), [], 'there is no machine to list yet');
    assert.equal((await p.getServer(server.id)).status, 'pending-payment');
    assert.equal(await p.holdsData(server.id), false, 'nothing exists to lose');

    fake.completePayment(server.id.slice('pending:'.length));
    const done = await p.getServer(server.id);
    assert.equal(done.status, 'provisioning', 'bought but not set up yet');
    assert.match(done.id, /^\d+$/);
    assert.equal(await p.holdsData(done.id), false, 'in the initial state it was never started');
  });

  test('a pending purchase can be ended: its renewal is turned off', async () => {
    fake.mode = 'pending';
    const p = make();
    const server = await p.createServer(input());
    await p.destroyServer(server.id);
    assert.equal(fake.subs[0]!.is_auto_renewed, false);
  });

  test('a purchase is sent once: a 500 is not retried, says the outcome is unknown and keeps the script', async () => {
    fake.failNext(500, 5, { message: 'oops', correlation_id: 'c-500' }, {}, (m, p) => m === 'POST' && p === '/api/vps/v1/virtual-machines');
    const e = await thrown(make().createServer(input()));
    assert.ok(isProviderError(e) && e.code === 'provider-unavailable');
    assert.match(e.message, /may have gone through/);
    assert.equal(purchases().length, 1);
    assert.equal(fake.scripts.length, 1, 'the order may exist and need its script');
  });

  test('a purchase answered 429 is not retried either', async () => {
    fake.failNext(429, 5, { message: 'slow down' }, { 'retry-after': '1' }, (m, p) => m === 'POST' && p === '/api/vps/v1/virtual-machines');
    const e = await thrown(make().createServer(input()));
    assert.equal((e as { code?: string }).code, 'rate-limited');
    assert.equal(purchases().length, 1);
    assert.deepEqual(slept, []);
  });

  test('a purchase the vendor refuses (422) leaves no script behind', async () => {
    fake.failNext(422, 1, { message: 'The given data was invalid.', errors: {} }, {}, (m, p) => m === 'POST' && p === '/api/vps/v1/virtual-machines');
    const e = await thrown(make().createServer(input()));
    assert.equal((e as { code?: string }).code, 'invalid-input');
    assert.equal(fake.scripts.length, 0);
    assert.equal(fake.subs.length, 0);
  });

  test('a wrong token is unauthorized and buys nothing', async () => {
    const e = await thrown(make({ tokenRef: 'bad' }).createServer(input()));
    assert.ok(isProviderError(e) && e.code === 'unauthorized');
    assert.deepEqual(writes(), []);
    assert.ok(!chain(e).includes(WRONG));
  });
});

describe('price', () => {
  test('defaults to the shortest term, with the renewal price per month and the first period up front', async () => {
    assert.deepEqual(await make().priceOf('vps-kvm2', '9'), { amount: 14.99, currency: 'USD', upfront: 8.99, termMonths: 1 });
  });

  test('a longer term is per-month of the term, and a year-denominated period counts in months', async () => {
    assert.deepEqual(await make({ termMonths: 12 }).priceOf('vps-kvm2', '9'), { amount: 14.99, currency: 'USD', upfront: 107.88, termMonths: 12 });
    assert.deepEqual(await make({ termMonths: 24 }).priceOf('vps-kvm2', '9'), { amount: 13.99, currency: 'USD', upfront: 191.76, termMonths: 24 });
  });

  test('a term or currency the plan does not offer is invalid-input and names what it offers', async () => {
    const e = await thrown(make({ termMonths: 6 }).priceOf('vps-kvm2', '9'));
    assert.equal((e as { code?: string }).code, 'invalid-input');
    assert.match(e.message, /offers 1, 12, 24/);
    assert.deepEqual(await make({ currency: 'BRL' }).priceOf('vps-kvm2', '9'), { amount: 77.99, currency: 'BRL', upfront: 43.99, termMonths: 1 });
    assert.equal(((await thrown(make({ currency: 'EUR' }).priceOf('vps-kvm2', '9'))) as { code?: string }).code, 'invalid-input');
  });

  test('sizes are the VPS plans only, with their specs from the metadata or the advertised plan', async () => {
    const sizes = await make().listSizes();
    assert.deepEqual(sizes.map((s) => s.id), ['vps-kvm1', 'vps-kvm2', 'vps-kvm4']);
    assert.deepEqual(sizes.find((s) => s.id === 'vps-kvm4'), { id: 'vps-kvm4', vcpus: 4, memoryMb: 16384, diskGb: 204800, monthly: { amount: 28.99, currency: 'USD' } });
    assert.equal(sizes.find((s) => s.id === 'vps-kvm2')!.memoryMb, 8192);
    // With a 12-month term KVM 4 has none, so it is not on offer.
    assert.deepEqual((await make({ termMonths: 12 }).listSizes()).map((s) => s.id), ['vps-kvm1', 'vps-kvm2']);
  });

  test('regions are the data centers', async () => {
    assert.deepEqual(await make().listRegions(), [{ id: '9', name: 'Sao Paulo, BR' }, { id: '3', name: 'Paris, FR' }]);
  });

  test('the guard asks the gate for the up-front charge, once', async () => {
    const asked: SpendRequest[] = [];
    const guarded = guardProvider(make(), {
      name: 'hostinger',
      gate: { authorize: async (r) => (asked.push(r), { ok: true, allowedBy: 'person', ticket: 't' }), settle: async () => undefined },
      destroyGuard: { confirm: async () => ({ ok: true, allowedBy: 'person', ticket: 'd' }), close: async () => undefined },
      accounts: { assert: async (provider) => ({ id: 'acct', provider, secretRefs: ['good'] }) },
      secrets,
      audit: () => undefined,
    });
    await guarded.createServer(input());
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]!.amount, asked[0]!.currency, asked[0]!.recurrence], [8.99, 'USD', 'once']);
    assert.match(asked[0]!.summary, /1-month term paid up front/);
  });
});

describe('ending a server', () => {
  test('destroy turns the renewal off and the server stays until the end of its term', async () => {
    const p = make();
    const server = await p.createServer(input());
    assert.equal(p.capabilities.destroy, 'end-of-term');
    assert.equal(await p.holdsData(server.id), true);
    await p.destroyServer(server.id);
    const off = fake.requests.filter((r) => r.method === 'DELETE');
    assert.deepEqual(off.map((r) => r.path), [`/api/billing/v1/subscriptions/${fake.subs[0]!.id}/auto-renewal/disable`]);
    const after = await p.getServer(server.id);
    assert.equal(after.status, 'running');
    assert.equal(after.endsAt, fake.subs[0]!.expires_at);
    assert.ok(after.endsAt);
    assert.equal((await p.listServers())[0]!.endsAt, after.endsAt);
  });

  test('ending twice, or a server that is not there, sends nothing more', async () => {
    const p = make();
    const server = await p.createServer(input());
    await p.destroyServer(server.id);
    await p.destroyServer(server.id);
    await p.destroyServer('424242');
    await p.destroyServer('not-a-number');
    assert.equal(fake.requests.filter((r) => r.method === 'DELETE').length, 1);
  });

  test('resize is unsupported and never reaches the vendor', async () => {
    const p = make();
    const server = await p.createServer(input());
    fake.requests.length = 0;
    const e = await thrown(p.resizeServer(server.id, 'vps-kvm4'));
    assert.ok(isProviderError(e) && e.code === 'unsupported');
    assert.deepEqual(fake.requests, []);
  });

  test('a machine bought and never set up holds nothing, any other holds data', async () => {
    const p = make();
    const server = await p.createServer(input());
    fake.vms[0]!.state = 'initial';
    assert.equal(await p.holdsData(server.id), false);
    for (const state of ['running', 'stopped', 'creating', 'error', 'recreating']) {
      fake.vms[0]!.state = state;
      assert.equal(await p.holdsData(server.id), true, state);
    }
  });
});

describe('billing', () => {
  test('lists the subscriptions of the servers with price and term, estimated, and not what is not ours or out of the period', async () => {
    const p = make();
    const a = await p.createServer(input({ name: 'core-1' }));
    await p.createServer(input({ name: 'core-2', size: 'vps-kvm1' }));
    fake.subs.push({ ...fake.subs[0]!, id: 'sub-domain', name: 'example.com' });
    const bill = await p.billing({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    assert.equal(bill.estimated, true);
    assert.equal(bill.items.length, 2);
    assert.ok(bill.items.every((i) => i.estimated === true && i.currency === 'USD'));
    assert.deepEqual(bill.items.map((i) => [i.serverId === a.id, i.amount]), [[true, 8.99], [false, 6.49]]);
    assert.match(bill.items[0]!.description, /KVM 2, 1-month term, active/);
    assert.equal(bill.total, 15.48);
    assert.deepEqual((await p.billing({ from: '2027-01-01T00:00:00Z', to: '2027-01-31T00:00:00Z' })).items, []);
  });
});

describe('transport', () => {
  test('a 429 on a read waits Retry-After and tries again, at most 3 times', async () => {
    fake.failNext(429, 2, { message: 'slow down' }, { 'retry-after': '2' });
    assert.deepEqual(await make().listRegions().then((r) => r.length), 2);
    assert.deepEqual(slept, [2000, 2000]);
    fake.failNext(429, 9, { message: 'slow down' }, { 'retry-after': '2' });
    const before = fake.requests.length;
    const e = await thrown(make().listRegions());
    assert.equal((e as { code?: string }).code, 'rate-limited');
    assert.equal(fake.requests.length - before, 4);
  });

  test('a token the server echoes back never leaves the adapter, in any error', async () => {
    const echo = { message: `rejected Bearer ${TOKEN} / ${Buffer.from(TOKEN).toString('base64')}`, correlation_id: TOKEN, errors: { x: [TOKEN] } };
    for (const status of [401, 404, 422, 429, 500, 502]) {
      // A 404 on destroy means the server is gone, which resolves by contract.
      for (const call of [() => make().listServers(), () => make().createServer(input()), ...(status === 404 ? [] : [() => make().destroyServer('1')])]) {
        fake.failNext(status, 9, echo, status === 429 ? { 'retry-after': '0' } : {});
        const e = await thrown(call());
        assert.ok(!chain(e).includes(TOKEN), `status ${status}`);
        assert.ok(!chain(e).includes(Buffer.from(TOKEN).toString('base64')));
      }
    }
  });

  test('an unreachable host is provider-unavailable', async () => {
    const e = await thrown(make({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).listServers());
    assert.ok(isProviderError(e) && e.code === 'provider-unavailable');
  });
});
