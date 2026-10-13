// The contract every provider adapter must pass. An adapter's test file calls `runProviderContract` with a factory for its adapter; the fake provider is the reference.
// The suite creates real servers on a real adapter, so it destroys what it made.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { isProviderError, PROVIDER_ERROR_CODES } from '../src/provider.ts';
import type { ProviderErrorCode, Server, Size, VpsProvider } from '../src/provider.ts';

export interface ContractSubject {
  provider: VpsProvider;
  /** The credential the adapter was built with. */
  token: string;
  /** The same adapter built with a credential the vendor rejects. */
  rejected: { provider: VpsProvider; token: string };
  /** An image id the vendor accepts. */
  image: string;
  /** A valid public key. */
  sshKey: string;
  /** A period that covers now. */
  period: { from: string; to: string };
  /** Makes the next call fail as the vendor would for `code`, echoing `leak` in the vendor's own words. Without it the coded-failure checks are skipped. */
  failNext?: (code: ProviderErrorCode, leak: string) => void;
}

export type ContractFactory = () => ContractSubject | Promise<ContractSubject>;

const shown = (e: unknown): string => {
  const parts: string[] = [];
  for (let cur: unknown = e, i = 0; cur !== undefined && i < 10; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message, cur.stack ?? '');
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join('\n');
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('expected the call to throw');
}

async function expectCode(p: Promise<unknown>, code: ProviderErrorCode): Promise<Error> {
  const e = await rejection(p);
  assert.ok(isProviderError(e), `a typed ProviderError, got ${String(e)}`);
  assert.equal(e.code, code);
  return e;
}

export function runProviderContract(name: string, makeProvider: ContractFactory): void {
  describe(`provider contract: ${name}`, () => {
    const made: { subject: ContractSubject; ids: string[] }[] = [];

    async function open(): Promise<{ s: ContractSubject; region: string; small: Size; large: Size; create: (n: string, extra?: Partial<{ size: string; labels: Record<string, string> }>) => Promise<Server> }> {
      const s = await makeProvider();
      const ctx = { subject: s, ids: [] as string[] };
      made.push(ctx);
      const regions = await s.provider.listRegions();
      const region = regions[0]!.id;
      const sizes = (await s.provider.listSizes()).slice().sort((a, b) => a.monthly.amount - b.monthly.amount);
      const small = sizes[0]!;
      const large = sizes.at(-1)!;
      const create = async (n: string, extra: Partial<{ size: string; labels: Record<string, string> }> = {}): Promise<Server> => {
        const server = await s.provider.createServer({ name: n, region, size: extra.size ?? small.id, image: s.image, sshKeys: [s.sshKey], userData: '#cloud-config\n', labels: extra.labels ?? {} });
        ctx.ids.push(server.id);
        return server;
      };
      return { s, region, small, large, create };
    }

    afterEach(async () => {
      for (const { subject, ids } of made.splice(0)) for (const id of ids) await subject.provider.destroyServer(id).catch(() => undefined);
    });

    test('regions and sizes carry a price per month', async () => {
      const { s } = await open();
      const regions = await s.provider.listRegions();
      const sizes = await s.provider.listSizes();
      assert.ok(regions.length > 0 && sizes.length > 0);
      for (const r of regions) assert.ok(r.id && r.name);
      for (const z of sizes) {
        assert.ok(z.id && z.vcpus > 0 && z.memoryMb > 0 && z.diskGb > 0);
        assert.ok(Number.isFinite(z.monthly.amount) && z.monthly.amount >= 0, `a finite monthly price for ${z.id}`);
        assert.match(z.monthly.currency, /^[A-Z]{3}$/);
      }
    });

    test('priceOf agrees with the listing and refuses what does not exist', async () => {
      const { s, region, small } = await open();
      const price = await s.provider.priceOf(small.id, region);
      assert.equal(price.amount, small.regionPrices?.[region]?.amount ?? small.monthly.amount);
      assert.match(price.currency, /^[A-Z]{3}$/);
      await expectCode(s.provider.priceOf('no-such-size', region), 'invalid-input');
      await expectCode(s.provider.priceOf(small.id, 'no-such-region'), 'invalid-input');
    });

    test('a created server is listed and readable, and carries what was asked and its price', async () => {
      const { s, region, small, create } = await open();
      const server = await create('contract-a', { labels: { role: 'core' } });
      assert.ok(server.id);
      assert.equal(server.name, 'contract-a');
      assert.equal(server.region, region);
      assert.equal(server.size, small.id);
      assert.equal(server.labels.role, 'core');
      assert.ok(Number.isFinite(server.monthly.amount));
      assert.ok(Date.parse(server.createdAt) > 0);
      assert.ok((await s.provider.listServers()).some((x) => x.id === server.id));
      const got = await s.provider.getServer(server.id);
      assert.equal(got.id, server.id);
      assert.equal(got.name, server.name);
    });

    test('create refuses input the vendor cannot take', async () => {
      const { s, region, small } = await open();
      const ok = { name: 'contract-bad', region, size: small.id, image: s.image, sshKeys: [s.sshKey] };
      await expectCode(s.provider.createServer({ ...ok, sshKeys: [] }), 'invalid-input');
      await expectCode(s.provider.createServer({ ...ok, size: 'no-such-size' }), 'invalid-input');
      await expectCode(s.provider.createServer({ ...ok, region: 'no-such-region' }), 'invalid-input');
      await expectCode(s.provider.createServer({ ...ok, image: 'no-such-image' }), 'invalid-input');
      assert.equal((await s.provider.listServers()).some((x) => x.name === 'contract-bad'), false);
    });

    test('resize changes the size and the price, and refuses a missing server or an unknown size', async () => {
      const { s, small, large, create } = await open();
      if (large.id === small.id) return;
      const server = await create('contract-r');
      const bigger = await s.provider.resizeServer(server.id, large.id);
      assert.equal(bigger.id, server.id);
      assert.equal(bigger.size, large.id);
      assert.ok(bigger.monthly.amount > server.monthly.amount);
      assert.equal((await s.provider.getServer(server.id)).size, large.id);
      await expectCode(s.provider.resizeServer(server.id, 'no-such-size'), 'invalid-input');
      await expectCode(s.provider.resizeServer('no-such-server', small.id), 'not-found');
    });

    test('a missing server is not-found, for get and holdsData', async () => {
      const { s } = await open();
      await expectCode(s.provider.getServer('no-such-server'), 'not-found');
      await expectCode(s.provider.holdsData('no-such-server'), 'not-found');
    });

    test('holdsData answers a boolean for a server that exists', async () => {
      const { s, create } = await open();
      const server = await create('contract-d');
      assert.equal(typeof (await s.provider.holdsData(server.id)), 'boolean');
    });

    test('destroy removes the server, and destroying it again or one that never existed resolves', async () => {
      const { s, create } = await open();
      const server = await create('contract-x');
      await s.provider.destroyServer(server.id);
      assert.equal((await s.provider.listServers()).some((x) => x.id === server.id), false);
      await expectCode(s.provider.getServer(server.id), 'not-found');
      await s.provider.destroyServer(server.id);
      await s.provider.destroyServer('no-such-server');
    });

    test('billing has a shape that adds up', async () => {
      const { s, create } = await open();
      await create('contract-b');
      const bill = await s.provider.billing(s.period);
      assert.ok(Array.isArray(bill.items));
      assert.match(bill.currency, /^[A-Z]{3}$/);
      let sum = 0;
      for (const item of bill.items) {
        assert.ok(item.description);
        assert.ok(Number.isFinite(item.amount));
        assert.equal(item.currency, bill.currency);
        sum += Math.round(item.amount * 100);
      }
      assert.equal(Math.round(bill.total * 100), sum);
      await expectCode(s.provider.billing({ from: s.period.to, to: s.period.from }), 'invalid-input');
    });

    test('a rejected credential is unauthorized and the error does not hold either credential', async () => {
      const { s } = await open();
      const e = await expectCode(s.rejected.provider.listServers(), 'unauthorized');
      const text = shown(e);
      assert.ok(!text.includes(s.rejected.token) && !text.includes(s.token));
    });

    test('every error code is typed, stable and free of the credential', async (t) => {
      const { s } = await open();
      if (!s.failNext) return t.skip('the subject cannot force a vendor failure');
      const leak = 'leaked-credential-for-the-contract';
      for (const code of PROVIDER_ERROR_CODES.filter((c) => c !== 'unauthorized')) {
        s.failNext(code, leak);
        const e = await expectCode(s.provider.listServers(), code);
        assert.ok(!shown(e).includes(s.token), `${code} must not carry the token`);
      }
    });
  });
}
