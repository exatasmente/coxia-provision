import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFakeProvider } from '../src/fakeProvider.ts';
import type { FakeProvider } from '../src/fakeProvider.ts';
import { guardProvider } from '../src/guarded.ts';
import type { GuardedProvider } from '../src/guarded.ts';
import { GuardError } from '../src/ports.ts';
import type { AccountCheck, ActualSpend, AuditEntry, DestroyDecision, DestroyGuard, DestroyRequest, SpendDecision, SpendGate, SpendRequest } from '../src/ports.ts';
import { isProviderError, ProviderError } from '../src/provider.ts';
import type { CreateServerInput, VpsProvider } from '../src/provider.ts';
import { memorySecrets } from './helpers.ts';

const TOKEN = 'tok-guard-7c41e0b9d2a8';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests test@example.com';

const input = (over: Partial<CreateServerInput> = {}): CreateServerInput => ({ name: 'core-1', region: 'fsn', size: 's-small', image: 'ubuntu-24.04', sshKeys: [KEY], userData: '#cloud-config\n', labels: {}, ...over });

function setup(opts: { spend?: (r: SpendRequest) => SpendDecision; destroy?: (r: DestroyRequest) => DestroyDecision; registered?: boolean; charge?: (m: { amount: number; currency: string }) => { amount: number; currency: string }; wrap?: (p: FakeProvider) => VpsProvider; settleFails?: boolean } = {}) {
  const secrets = memorySecrets({ 'prov-token': TOKEN });
  const fake = createFakeProvider({ secrets, tokenRef: 'prov-token', token: TOKEN, ...(opts.charge ? { charge: opts.charge } : {}) });
  const authorized: SpendRequest[] = [];
  const settled: { ticket: string; actual: ActualSpend }[] = [];
  const destroyAsked: DestroyRequest[] = [];
  const closed: { ticket: string; outcome: string }[] = [];
  const audit: AuditEntry[] = [];
  const gate: SpendGate = {
    authorize: async (r) => {
      authorized.push(r);
      return (opts.spend ?? (() => ({ ok: true, allowedBy: 'grant:g1', ticket: 't1' })))(r);
    },
    settle: async (ticket, actual) => {
      if (opts.settleFails) throw new Error('ledger down');
      settled.push({ ticket, actual });
    },
  };
  const destroyGuard: DestroyGuard = {
    confirm: async (r) => {
      destroyAsked.push(r);
      return (opts.destroy ?? (() => ({ ok: false, code: 'passkey-required', reason: 'the passkey is needed' })))(r);
    },
    close: async (ticket, outcome) => void closed.push({ ticket, outcome }),
  };
  const accounts: AccountCheck = {
    assert: async (provider) => {
      if (opts.registered === false) throw new GuardError('forbidden', `${provider} is not registered`);
      return { id: 'acct-1', provider, secretRefs: ['prov-token'] };
    },
  };
  const guarded: GuardedProvider = guardProvider(opts.wrap ? opts.wrap(fake) : fake, { name: 'fake', gate, destroyGuard, accounts, secrets, audit: (e) => void audit.push(e), now: () => new Date('2026-01-01T00:00:00Z') });
  return { fake, guarded, authorized, settled, destroyAsked, closed, audit };
}

const createdOn = (f: FakeProvider): number => f.calls.filter((c) => c.op === 'createServer').length;

async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof Error);
    return e;
  }
  return assert.fail('expected the call to throw');
}

const chain = (e: unknown): string => {
  const parts: string[] = [];
  for (let cur: unknown = e; cur !== undefined; ) {
    if (cur instanceof Error) {
      parts.push(cur.name, cur.message, cur.stack ?? '', JSON.stringify(cur, Object.getOwnPropertyNames(cur)));
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join('\n');
};

describe('purchases', () => {
  test('a purchase over the budget does not run', async () => {
    const t = setup({ spend: () => ({ ok: false, code: 'budget-exceeded', reason: 'infrastructure is over its limit' }) });
    const e = await thrown(t.guarded.createServer(input()));
    assert.ok(e instanceof GuardError);
    assert.equal(e.code, 'budget-exceeded');
    assert.equal(createdOn(t.fake), 0);
    assert.deepEqual(t.settled, []);
    assert.equal(t.audit.length, 1);
    assert.equal(t.audit[0]!.result, 'refused');
    assert.equal(t.audit[0]!.code, 'budget-exceeded');
  });

  test('a refused grant does not run', async () => {
    const t = setup({ spend: () => ({ ok: false, code: 'forbidden', reason: 'the person said no' }) });
    const e = await thrown(t.guarded.createServer(input()));
    assert.equal((e as GuardError).code, 'forbidden');
    assert.equal(createdOn(t.fake), 0);
  });

  test('a gate that cannot decide is a refusal', async () => {
    const t = setup();
    const broken = guardProvider(t.fake, {
      name: 'fake',
      gate: { authorize: async () => Promise.reject(new Error('socket closed')), settle: async () => undefined },
      destroyGuard: { confirm: async () => ({ ok: false, code: 'forbidden', reason: '' }), close: async () => undefined },
      accounts: { assert: async (provider) => ({ id: 'acct-1', provider, secretRefs: [] }) },
      secrets: memorySecrets({}),
      audit: () => undefined,
    });
    const e = await thrown(broken.createServer(input()));
    assert.equal((e as GuardError).code, 'host-unavailable');
    assert.equal(createdOn(t.fake), 0);
  });

  test('the price is asked first, and settle gets the actual price', async () => {
    const t = setup({ charge: (m) => ({ ...m, amount: m.amount + 0.5 }) });
    const server = await t.guarded.createServer(input());
    assert.deepEqual(t.authorized, [{ kind: 'spend', category: 'infrastructure', accountId: 'acct-1', amount: 5, currency: 'USD', recurrence: 'monthly', summary: 'create server core-1 (s-small in fsn)' }]);
    assert.deepEqual(t.settled, [{ ticket: 't1', actual: { amount: 5.5, currency: 'USD' } }]);
    assert.equal(server.monthly.amount, 5.5);
    assert.equal(t.audit.length, 1);
    assert.deepEqual([t.audit[0]!.result, t.audit[0]!.allowedBy, t.audit[0]!.amount, t.audit[0]!.target], ['done', 'grant:g1', 5.5, server.id]);
  });

  test('a purchase that fails releases its ticket with nothing spent', async () => {
    const t = setup();
    const e = await thrown(t.guarded.createServer(input({ sshKeys: [] })));
    assert.ok(isProviderError(e));
    assert.equal(e.code, 'invalid-input');
    assert.deepEqual(t.settled, [{ ticket: 't1', actual: { amount: 0, currency: 'USD' } }]);
    assert.equal(t.audit[0]!.result, 'failed');
  });

  test('a ledger that cannot be told does not hide the server that was bought', async () => {
    const t = setup({ settleFails: true });
    const server = await t.guarded.createServer(input());
    assert.ok(server.id);
    assert.equal(t.audit[0]!.settleError, 'ledger down');
  });

  test('a rise in size is a purchase of the difference, a fall is not', async () => {
    const t = setup();
    const server = await t.guarded.createServer(input());
    t.authorized.length = 0;
    const big = await t.guarded.resizeServer(server.id, 's-large');
    assert.equal(t.authorized[0]!.amount, 19);
    assert.deepEqual(t.settled.at(-1), { ticket: 't1', actual: { amount: 19, currency: 'USD' } });
    assert.equal(big.size, 's-large');
    t.authorized.length = 0;
    await t.guarded.resizeServer(server.id, 's-small');
    assert.equal(t.authorized.length, 0);
  });

  test('a refused rise in size does not run', async () => {
    const t = setup();
    const server = await t.guarded.createServer(input());
    const refusing = guardProvider(t.fake, {
      name: 'fake',
      gate: { authorize: async () => ({ ok: false, code: 'budget-exceeded', reason: 'over' }), settle: async () => undefined },
      destroyGuard: { confirm: async () => ({ ok: false, code: 'forbidden', reason: '' }), close: async () => undefined },
      accounts: { assert: async (provider) => ({ id: 'acct-1', provider, secretRefs: ['prov-token'] }) },
      secrets: memorySecrets({ 'prov-token': TOKEN }),
      audit: () => undefined,
    });
    await thrown(refusing.resizeServer(server.id, 's-large'));
    assert.equal(t.fake.calls.some((c) => c.op === 'resizeServer'), false);
  });
});

describe('destroy', () => {
  test('a server that holds data is not destroyed without the guard yes', async () => {
    const t = setup();
    const server = await t.guarded.createServer(input());
    t.fake.setHoldsData(server.id, true);
    const e = await thrown(t.guarded.destroyServer(server.id));
    assert.equal((e as GuardError).code, 'passkey-required');
    assert.equal(t.fake.calls.some((c) => c.op === 'destroyServer'), false);
    assert.equal(t.audit.at(-1)!.result, 'refused');
    assert.equal((await t.guarded.listServers()).length, 1);
  });

  test('with the yes it is destroyed and the ticket is closed', async () => {
    const t = setup({ destroy: () => ({ ok: true, allowedBy: 'person', ticket: 'd1' }) });
    const server = await t.guarded.createServer(input());
    t.fake.setHoldsData(server.id, true);
    await t.guarded.destroyServer(server.id);
    assert.deepEqual(t.closed, [{ ticket: 'd1', outcome: 'done' }]);
    assert.equal(t.audit.at(-1)!.allowedBy, 'person');
    assert.equal((await t.guarded.listServers()).length, 0);
  });

  test('a server with no data goes without asking, and a missing one resolves', async () => {
    const t = setup();
    const server = await t.guarded.createServer(input());
    await t.guarded.destroyServer(server.id);
    await t.guarded.destroyServer(server.id);
    assert.deepEqual(t.destroyAsked, []);
  });
});

describe('accounts and reads', () => {
  test('an unregistered account is refused before anything reaches the vendor', async () => {
    const t = setup({ registered: false });
    for (const call of [() => t.guarded.createServer(input()), () => t.guarded.listServers(), () => t.guarded.getServer('srv-1'), () => t.guarded.destroyServer('srv-1'), () => t.guarded.billing({ from: '2026-01-01', to: '2026-01-02' }), () => t.guarded.listSizes()]) {
      const e = await thrown(call());
      assert.equal((e as GuardError).code, 'forbidden');
    }
    assert.deepEqual(t.fake.calls, []);
    assert.deepEqual(t.authorized, []);
  });

  test('an account check that fails some other way still refuses', async () => {
    const t = setup();
    const odd = guardProvider(t.fake, {
      name: 'fake',
      gate: { authorize: async () => ({ ok: false, code: 'forbidden', reason: '' }), settle: async () => undefined },
      destroyGuard: { confirm: async () => ({ ok: false, code: 'forbidden', reason: '' }), close: async () => undefined },
      accounts: { assert: async () => Promise.reject(new Error('registry unreadable')) },
      secrets: memorySecrets({}),
      audit: () => undefined,
    });
    assert.equal(((await thrown(odd.listServers())) as GuardError).code, 'forbidden');
    assert.deepEqual(t.fake.calls, []);
  });

  test('reads pass through for a registered account', async () => {
    const t = setup();
    assert.ok((await t.guarded.listSizes()).length > 0);
    assert.equal((await t.guarded.priceOf('s-small', 'ash')).amount, 6);
    assert.equal((await t.guarded.billing({ from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' })).total, 0);
  });
});

describe('secrets', () => {
  test('a token planted in a provider error is in no error, cause or audit entry', async () => {
    const b64 = Buffer.from(TOKEN).toString('base64');
    const leaky = (fake: FakeProvider): VpsProvider => ({
      ...fake,
      createServer: async () => {
        const upstream = Object.assign(new Error(`GET /servers 500 with Authorization: Bearer ${TOKEN}`), { headers: { authorization: `Bearer ${TOKEN}` }, code: 'ECONNRESET' });
        throw new ProviderError('provider-unavailable', `vendor said no to ${TOKEN} (${b64}) and ?token=${encodeURIComponent(TOKEN)}`, { cause: upstream });
      },
    });
    const t = setup({ wrap: leaky });
    const e = await thrown(t.guarded.createServer(input({ name: `n-${TOKEN}`.slice(0, 40) })));
    assert.ok(isProviderError(e));
    assert.equal(e.code, 'provider-unavailable');
    const text = chain(e);
    for (const secret of [TOKEN, b64, encodeURIComponent(TOKEN)]) assert.ok(!text.includes(secret), 'not in the error or its causes');
    assert.ok(text.includes('[redacted]'));
    assert.ok(e.cause instanceof Error);
    assert.ok(!JSON.stringify(t.audit).includes(TOKEN));
    assert.equal(t.audit.length, 1);
    assert.equal(t.audit[0]!.result, 'failed');
  });

  test('a value that is not an error, thrown with the token in it, is cleaned', async () => {
    const t = setup({ wrap: (fake) => ({ ...fake, listServers: async () => Promise.reject({ body: `denied ${TOKEN}` }) }) });
    const e = await thrown(t.guarded.listServers());
    assert.ok(isProviderError(e));
    assert.ok(!chain(e).includes(TOKEN));
  });

  test('the vendor echoing the token in a coded failure is cleaned too', async () => {
    const t = setup();
    t.fake.failNext('rate-limited', `slow down ${TOKEN}`);
    const e = await thrown(t.guarded.listServers());
    assert.equal((e as ProviderError).code, 'rate-limited');
    assert.ok(!chain(e).includes(TOKEN));
  });
});
