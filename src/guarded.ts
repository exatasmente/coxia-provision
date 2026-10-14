// The surface the rest of coxia-provision uses: any `VpsProvider` behind the budget, the autonomy grant, the account registry, the destroy guard and the redactor.
// Nothing here knows a vendor. Fail closed: a port that cannot decide is a refusal, and a purchase is never retried.

import type { Billing, Capabilities, CreateServerInput, Money, Price, Region, Server, Size, VpsProvider } from './provider.ts';
import { ProviderError } from './provider.ts';
import { GuardError, isGuardErrorCode } from './ports.ts';
import type { AccountCheck, AccountInfo, AllowedBy, AuditEntry, AuditSink, DestroyGuard, Refusal, SecretResolver, SpendGate } from './ports.ts';
import { redactor } from './redact.ts';
import type { Redactor } from './redact.ts';

export interface GuardedOptions {
  /** The provider's name in the account registry (`hetzner`, ...). */
  name: string;
  gate: SpendGate;
  destroyGuard: DestroyGuard;
  accounts: AccountCheck;
  /** Used only to learn which values to hide. */
  secrets: SecretResolver;
  audit: AuditSink;
  now?: () => Date;
}

export interface GuardedProvider {
  readonly name: string;
  readonly capabilities: Capabilities;
  createServer(input: CreateServerInput): Promise<Server>;
  listServers(): Promise<Server[]>;
  getServer(id: string): Promise<Server>;
  resizeServer(id: string, size: string): Promise<Server>;
  destroyServer(id: string): Promise<void>;
  holdsData(id: string): Promise<boolean>;
  listRegions(): Promise<Region[]>;
  listSizes(): Promise<Size[]>;
  priceOf(size: string, region: string): Promise<Price>;
  billing(period: { from: string; to: string }): Promise<Billing>;
}

const CATEGORY = 'infrastructure';
const cents = (n: number): number => Math.round(n * 100) / 100;
const unsupported = (what: string): ProviderError => new ProviderError('unsupported', `this provider cannot ${what}`);

export function guardProvider(provider: VpsProvider, opts: GuardedOptions): GuardedProvider {
  const { name, gate, destroyGuard, accounts, secrets, audit } = opts;
  const now = opts.now ?? (() => new Date());

  async function hidden(account: AccountInfo | undefined): Promise<Redactor> {
    const values: string[] = [];
    for (const ref of account?.secretRefs ?? []) {
      try {
        values.push(await secrets.resolve(ref));
      } catch {
        // An unresolvable reference has no value to leak.
      }
    }
    return redactor(values);
  }

  async function note(account: AccountInfo | undefined, entry: Omit<AuditEntry, 'at' | 'provider'>): Promise<void> {
    try {
      await audit((await hidden(account)).entry({ at: now().toISOString(), provider: name, ...entry }));
    } catch {
      // The effect has been decided already; a broken sink must not turn a bought server into an error that invites a second purchase.
    }
  }

  /** Every call: the account first, every error through the redactor. */
  async function scoped<T>(fn: (account: AccountInfo) => Promise<T>): Promise<T> {
    let account: AccountInfo | undefined;
    try {
      try {
        account = await accounts.assert(name);
      } catch (e) {
        if (e instanceof Error && isGuardErrorCode((e as { code?: unknown }).code)) throw e;
        throw new GuardError('forbidden', `${name} is not in the account registry`, { cause: e });
      }
      return await fn(account);
    } catch (e) {
      throw (await hidden(account)).error(e);
    }
  }

  const refuse = (r: Refusal): GuardError => new GuardError(r.code, r.reason);

  async function release(ticket: string, currency: string): Promise<void> {
    try {
      await gate.settle(ticket, { amount: 0, currency });
    } catch {
      // Nothing was spent; an unreleased ticket expires on its own side.
    }
  }

  return {
    name,
    capabilities: provider.capabilities,

    createServer: (input) =>
      scoped(async (account) => {
        // Refused before anyone is asked to approve money for something the provider would turn down.
        if (input.bootstrap && input.bootstrap.kind !== provider.capabilities.bootstrap) throw new ProviderError('invalid-input', `this provider takes a ${provider.capabilities.bootstrap} bootstrap, not ${input.bootstrap.kind}`);
        if (!provider.capabilities.labels && Object.keys(input.labels ?? {}).length) throw new ProviderError('invalid-input', 'this provider cannot label servers');
        const price = await provider.priceOf(input.size, input.region);
        // A term billed up front is one charge now; the gate is asked for that, not for a month of it.
        const due = price.upfront ?? price.amount;
        const term = price.upfront !== undefined && price.termMonths ? `, ${price.termMonths}-month term paid up front` : '';
        const summary = `create server ${input.name} (${input.size} in ${input.region}${term})`;
        const base = { accountId: account.id, target: input.name, summary, amount: due, currency: price.currency } as const;
        const decision = await gate.authorize({ kind: 'spend', category: CATEGORY, accountId: account.id, amount: due, currency: price.currency, recurrence: price.upfront !== undefined ? 'once' : 'monthly', summary }).catch((e: unknown) => {
          throw new GuardError('host-unavailable', 'the spend could not be checked', { cause: e });
        });
        if (!decision.ok) {
          await note(account, { op: 'create-server', result: 'refused', code: decision.code, ...base });
          throw refuse(decision);
        }
        let server: Server;
        try {
          server = await provider.createServer(input);
        } catch (e) {
          await release(decision.ticket, price.currency);
          await note(account, { op: 'create-server', result: 'failed', code: (e as { code?: string }).code, allowedBy: decision.allowedBy, ...base });
          throw e;
        }
        const charged = server.upfront ?? server.monthly;
        const settleError = await gate.settle(decision.ticket, { amount: charged.amount, currency: charged.currency }).then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e.message : 'settle failed'),
        );
        await note(account, { op: 'create-server', result: 'done', allowedBy: decision.allowedBy, ...base, amount: charged.amount, currency: charged.currency, target: server.id, ...(settleError ? { settleError } : {}) });
        return server;
      }),

    listServers: () => scoped(() => provider.listServers()),
    getServer: (id) => scoped(() => provider.getServer(id)),
    holdsData: (id) => scoped(() => provider.holdsData(id)),
    listRegions: () => scoped(() => provider.listRegions()),
    listSizes: () => scoped(() => provider.listSizes()),
    priceOf: (size, region) => scoped(() => provider.priceOf(size, region)),
    billing: (period) => scoped(() => provider.billing(period)),

    resizeServer: (id, size) =>
      scoped(async (account) => {
        if (!provider.capabilities.resize) throw unsupported('resize a server');
        const before = await provider.getServer(id);
        const next = await provider.priceOf(size, before.region);
        if (next.currency !== before.monthly.currency) throw new ProviderError('invalid-input', 'the new size is priced in another currency');
        // Only the rise is a purchase; shrinking or keeping the size costs nothing more.
        const delta = cents(next.amount - before.monthly.amount);
        const summary = `resize server ${before.name} from ${before.size} to ${size}`;
        const base = { accountId: account.id, target: id, summary, currency: next.currency } as const;
        let ticket: string | undefined;
        let allowedBy: AllowedBy | undefined;
        if (delta > 0) {
          const decision = await gate.authorize({ kind: 'spend', category: CATEGORY, accountId: account.id, amount: delta, currency: next.currency, recurrence: 'monthly', summary }).catch((e: unknown) => {
            throw new GuardError('host-unavailable', 'the spend could not be checked', { cause: e });
          });
          if (!decision.ok) {
            await note(account, { op: 'resize-server', result: 'refused', code: decision.code, amount: delta, ...base });
            throw refuse(decision);
          }
          ({ ticket, allowedBy } = decision);
        }
        let after: Server;
        try {
          after = await provider.resizeServer(id, size);
        } catch (e) {
          if (ticket) await release(ticket, next.currency);
          await note(account, { op: 'resize-server', result: 'failed', code: (e as { code?: string }).code, amount: delta, ...(allowedBy ? { allowedBy } : {}), ...base });
          throw e;
        }
        const actual = Math.max(0, cents(after.monthly.amount - before.monthly.amount));
        const settleError = ticket
          ? await gate.settle(ticket, { amount: actual, currency: after.monthly.currency }).then(
              () => undefined,
              (e: unknown) => (e instanceof Error ? e.message : 'settle failed'),
            )
          : undefined;
        await note(account, { op: 'resize-server', result: 'done', amount: actual, ...(allowedBy ? { allowedBy } : {}), ...base, ...(settleError ? { settleError } : {}) });
        return after;
      }),

    destroyServer: (id) =>
      scoped(async (account) => {
        if (provider.capabilities.destroy === 'none') throw unsupported('end a server');
        // Said as it is: an end-of-term "destroy" leaves the server running and billed until the term ends.
        const base = { accountId: account.id, target: id, summary: provider.capabilities.destroy === 'end-of-term' ? `end server ${id} at the end of its term (renewal off, the server runs until then)` : `destroy server ${id}` } as const;
        let holds: boolean;
        try {
          holds = await provider.holdsData(id);
        } catch (e) {
          // Gone already: destroy is idempotent. Any other failure leaves the question open, so nothing is destroyed.
          if (e instanceof Error && (e as { code?: unknown }).code === 'not-found') {
            await provider.destroyServer(id);
            await note(account, { op: 'destroy-server', result: 'done', ...base });
            return;
          }
          throw e;
        }
        let ticket: string | undefined;
        let allowedBy: AllowedBy | undefined;
        if (holds) {
          const decision = await destroyGuard.confirm({ accountId: account.id, serverId: id, summary: base.summary }).catch((e: unknown) => {
            throw new GuardError('host-unavailable', 'the destroy could not be checked', { cause: e });
          });
          if (!decision.ok) {
            await note(account, { op: 'destroy-server', result: 'refused', code: decision.code, ...base });
            throw refuse(decision);
          }
          ({ ticket, allowedBy } = decision);
        }
        try {
          await provider.destroyServer(id);
        } catch (e) {
          if (ticket) await destroyGuard.close(ticket, 'failed').catch(() => undefined);
          await note(account, { op: 'destroy-server', result: 'failed', code: (e as { code?: string }).code, ...(allowedBy ? { allowedBy } : {}), ...base });
          throw e;
        }
        if (ticket) await destroyGuard.close(ticket, 'done').catch(() => undefined);
        await note(account, { op: 'destroy-server', result: 'done', ...(allowedBy ? { allowedBy } : {}), ...base });
      }),
  };
}
