// The Hostinger VPS adapter. Written against the public OpenAPI document 1.64.0 (https://developers.hostinger.com/openapi/openapi.json, read 2026-10-14); the paths and fields
// used are listed in docs/providers/hostinger.md. Hostinger is a purchase API, not a cloud API: creating a server buys a subscription (paid up front for a term), there is
// no delete and no resize, and no invoices. The capabilities say so, and what is missing fails with `unsupported`.

import type { SecretResolver } from '../ports.ts';
import { ProviderError } from '../provider.ts';
import type { Billing, BillingItem, Capabilities, CreateServerInput, Money, Price, Region, Server, ServerStatus, Size, VpsProvider } from '../provider.ts';
import { createHttpClient } from './http.ts';
import type { HttpClient } from './http.ts';

export const HOSTINGER_BASE_URL = 'https://developers.hostinger.com';
/** "Maximum script size is 48KB" (POST /api/vps/v1/post-install-scripts). The document does not say whether KB is 1000 or 1024 bytes; the larger is checked here and the API's own 422 is the last word, before any money moves. */
export const MAX_SCRIPT_BYTES = 48 * 1024;
export const PENDING_PREFIX = 'pending:';

export const HOSTINGER_CAPABILITIES: Capabilities = { destroy: 'end-of-term', resize: false, bootstrap: 'script', billing: 'subscriptions', snapshots: 1, labels: false };

export interface HostingerOptions {
  secrets: SecretResolver;
  /** The reference of the API token in the secrets store. */
  tokenRef: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Months of the term to buy. Default: the shortest term the catalog offers for the plan. A term the plan does not offer is `invalid-input`. */
  termMonths?: number;
  /** ISO 4217. Default: USD when the catalog offers it, else the first currency it lists. */
  currency?: string;
  now?: () => Date;
}

// Plans as Hostinger advertises them (research of 2026-10-13); only a fallback for catalog metadata, whose fields the OpenAPI document leaves free-form.
const KNOWN_PLANS: Record<string, { vcpus: number; memoryMb: number; diskGb: number }> = {
  '1': { vcpus: 1, memoryMb: 4096, diskGb: 50 },
  '2': { vcpus: 2, memoryMb: 8192, diskGb: 100 },
  '4': { vcpus: 4, memoryMb: 16384, diskGb: 200 },
  '8': { vcpus: 8, memoryMb: 32768, diskGb: 400 },
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const unexpected = (what: string): ProviderError => new ProviderError('provider-unavailable', `Hostinger answered ${what} in a shape this adapter does not know`);
const list = (v: unknown, what: string): Rec[] => {
  if (!Array.isArray(v)) throw unexpected(what);
  return v.filter(isRec);
};
const cents = (n: number): number => Math.round(n) / 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface CatalogPrice {
  id: string;
  currency: string;
  months: number;
  /** Per period, in cents (the renewal price). */
  price: number;
  /** The first period, in cents. */
  first: number;
}
interface CatalogPlan {
  id: string;
  name: string;
  spec: { vcpus: number; memoryMb: number; diskGb: number };
  prices: CatalogPrice[];
}
interface Sub {
  id: string;
  name: string;
  status: string;
  months: number | undefined;
  currency: string;
  totalCents: number;
  renewalCents: number;
  autoRenew: boolean;
  createdAt: string;
  expiresAt: string | undefined;
  nextBillingAt: string | undefined;
}
interface Vm {
  id: number;
  subscriptionId: string | undefined;
  dataCenterId: number | undefined;
  plan: string | undefined;
  hostname: string;
  state: string;
  ipv4: string | undefined;
  template: string | undefined;
  createdAt: string;
}

const monthsOf = (n: number | undefined, unit: string | undefined): number | undefined => {
  if (!n || n < 1) return undefined;
  if (unit === 'month') return n;
  if (unit === 'year') return n * 12;
  return undefined;
};

function parseVm(r: Rec): Vm {
  const id = num(r.id);
  if (id === undefined) throw unexpected('a virtual machine');
  const v4 = Array.isArray(r.ipv4) ? r.ipv4.find(isRec) : undefined;
  const t = isRec(r.template) ? str(r.template.name) : undefined;
  return {
    id,
    subscriptionId: str(r.subscription_id),
    dataCenterId: num(r.data_center_id),
    plan: str(r.plan),
    hostname: str(r.hostname) ?? '',
    state: str(r.state) ?? 'error',
    ipv4: v4 ? str(v4.address) : undefined,
    template: t,
    createdAt: str(r.created_at) ?? '',
  };
}

function parseSub(r: Rec): Sub {
  const id = str(r.id);
  if (id === undefined) throw unexpected('a subscription');
  return {
    id,
    name: str(r.name) ?? id,
    status: str(r.status) ?? '',
    months: monthsOf(num(r.billing_period), str(r.billing_period_unit)),
    currency: str(r.currency_code) ?? '',
    totalCents: num(r.total_price) ?? 0,
    renewalCents: num(r.renewal_price) ?? 0,
    autoRenew: r.is_auto_renewed === true,
    createdAt: str(r.created_at) ?? '',
    expiresAt: str(r.expires_at),
    nextBillingAt: str(r.next_billing_at),
  };
}

function parsePlan(r: Rec): CatalogPlan | undefined {
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name) return undefined;
  const prices: CatalogPrice[] = [];
  for (const p of Array.isArray(r.prices) ? r.prices.filter(isRec) : []) {
    const pid = str(p.id);
    const months = monthsOf(num(p.period), str(p.period_unit));
    const price = num(p.price);
    const currency = str(p.currency);
    // A day or week period has no month count; the adapter sells whole months only.
    if (pid && months && price !== undefined && currency) prices.push({ id: pid, currency, months, price, first: num(p.first_period_price) ?? price });
  }
  const meta = isRec(r.metadata) ? r.metadata : {};
  const metaNum = (...keys: string[]): number | undefined => keys.map((k) => num(meta[k]) ?? num(Number(meta[k]))).find((n) => n !== undefined && n > 0);
  const known = KNOWN_PLANS[/kvm\s*(\d+)/i.exec(name)?.[1] ?? ''] ?? { vcpus: 0, memoryMb: 0, diskGb: 0 };
  return {
    id,
    name,
    prices,
    spec: { vcpus: metaNum('cpus', 'vcpus', 'cpu') ?? known.vcpus, memoryMb: metaNum('memory', 'ram') ?? known.memoryMb, diskGb: metaNum('disk', 'storage') ?? known.diskGb },
  };
}

const statusOf = (state: string): ServerStatus => {
  if (state === 'running') return 'running';
  if (state === 'stopped' || state === 'stopping' || state === 'suspended' || state === 'suspending') return 'stopped';
  if (state === 'destroying' || state === 'destroyed') return 'destroying';
  return 'provisioning';
};

export interface HostingerProvider extends VpsProvider {
  /** The term and currency this adapter buys, resolved against the catalog for a plan. */
  readonly terms: { termMonths: number | undefined; currency: string | undefined };
}

export function createHostingerProvider(opts: HostingerOptions): HostingerProvider {
  const http: HttpClient = createHttpClient({
    baseUrl: opts.baseUrl ?? HOSTINGER_BASE_URL,
    secrets: opts.secrets,
    tokenRef: opts.tokenRef,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const now = opts.now ?? (() => new Date());
  // Reads run one after the other: the API allows 90 requests a minute, and a failure then belongs to one request, not to a race.
  const get = async (path: string, query?: Record<string, string>): Promise<unknown> => (await http.request('GET', path, { idempotent: true, ...(query ? { query } : {}) })).body;

  const catalog = async (): Promise<CatalogPlan[]> =>
    list(await get('/api/billing/v1/catalog', { category: 'VPS' }), 'the catalog')
      .map(parsePlan)
      .filter((p): p is CatalogPlan => p !== undefined);
  const dataCenters = async (): Promise<Region[]> =>
    list(await get('/api/vps/v1/data-centers'), 'the data centers').flatMap((d) => {
      const id = num(d.id);
      if (id === undefined) return [];
      const where = [str(d.city), str(d.location)].filter(Boolean).join(', ');
      return [{ id: String(id), name: where || str(d.name) || `data center ${id}` }];
    });
  const templates = async (): Promise<{ id: number; name: string }[]> =>
    list(await get('/api/vps/v1/templates'), 'the templates').flatMap((t) => (num(t.id) !== undefined && str(t.name) ? [{ id: num(t.id)!, name: str(t.name)! }] : []));
  const machines = async (): Promise<Vm[]> => list(await get('/api/vps/v1/virtual-machines'), 'the virtual machines').map(parseVm);
  const subscriptions = async (): Promise<Sub[]> => list(await get('/api/billing/v1/subscriptions'), 'the subscriptions').map(parseSub);

  function pickPrice(plan: CatalogPlan): CatalogPrice {
    const currencies = [...new Set(plan.prices.map((p) => p.currency))];
    const currency = opts.currency ?? (currencies.includes('USD') ? 'USD' : currencies[0]);
    const inCurrency = plan.prices.filter((p) => p.currency === currency);
    if (!inCurrency.length) throw new ProviderError('invalid-input', `${plan.name} is not sold in ${currency ?? 'any currency'}`);
    if (opts.termMonths !== undefined) {
      const hit = inCurrency.find((p) => p.months === opts.termMonths);
      if (!hit) throw new ProviderError('invalid-input', `${plan.name} has no ${opts.termMonths}-month term; it offers ${[...new Set(inCurrency.map((p) => p.months))].sort((a, b) => a - b).join(', ')}`);
      return hit;
    }
    return inCurrency.reduce((a, b) => (b.months < a.months ? b : a));
  }

  const priceFor = (plan: CatalogPlan): Price => {
    const p = pickPrice(plan);
    // `amount` is the renewal price per month, what budgeting must assume after the first term; `upfront` is what the purchase charges, which can be a promotional first period.
    return { amount: round2(cents(p.price) / p.months), currency: p.currency, upfront: cents(p.first), termMonths: p.months };
  };

  const planOf = (plans: CatalogPlan[], size: string): CatalogPlan => {
    const plan = plans.find((p) => p.id === size);
    if (!plan || !plan.prices.length) throw new ProviderError('invalid-input', `unknown size ${size}`);
    return plan;
  };

  function monthlyOf(vm: Vm, subs: Sub[], plans: CatalogPlan[]): Money {
    const sub = vm.subscriptionId ? subs.find((s) => s.id === vm.subscriptionId) : undefined;
    if (sub?.months && sub.currency) return { amount: round2(cents(sub.renewalCents) / sub.months), currency: sub.currency };
    const plan = plans.find((p) => p.name.toLowerCase() === vm.plan?.toLowerCase());
    if (plan?.prices.length) {
      const { amount, currency } = priceFor(plan);
      return { amount, currency };
    }
    throw new ProviderError('provider-unavailable', `the price of virtual machine ${vm.id} (${vm.plan ?? 'no plan'}) is in neither its subscription nor the catalog`);
  }

  function toServer(vm: Vm, subs: Sub[], plans: CatalogPlan[]): Server {
    const sub = vm.subscriptionId ? subs.find((s) => s.id === vm.subscriptionId) : undefined;
    const plan = plans.find((p) => p.name.toLowerCase() === vm.plan?.toLowerCase());
    return {
      id: String(vm.id),
      name: vm.hostname,
      region: vm.dataCenterId === undefined ? '' : String(vm.dataCenterId),
      size: plan?.id ?? vm.plan ?? '',
      image: vm.template ?? '',
      status: statusOf(vm.state),
      ...(vm.ipv4 ? { ipv4: vm.ipv4 } : {}),
      labels: {},
      createdAt: vm.createdAt,
      monthly: monthlyOf(vm, subs, plans),
      // Auto-renew off is the only way to end a VPS; `expires_at` is then the day it goes.
      ...(sub && !sub.autoRenew && sub.expiresAt ? { endsAt: sub.expiresAt } : {}),
    };
  }

  const vmId = (id: string): number => {
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new ProviderError('not-found', `server ${id} does not exist`);
    return Number(id);
  };

  async function vmById(id: string): Promise<Vm> {
    const body = await get(`/api/vps/v1/virtual-machines/${vmId(id)}`);
    if (!isRec(body)) throw unexpected('a virtual machine');
    const vm = parseVm(body);
    if (vm.state === 'destroyed') throw new ProviderError('not-found', `server ${id} does not exist`);
    return vm;
  }

  const pendingServer = (subscriptionId: string, over: Partial<Server>, plans: CatalogPlan[], sub?: Sub): Server => ({
    id: `${PENDING_PREFIX}${subscriptionId}`,
    name: sub?.name ?? '',
    region: '',
    size: '',
    image: '',
    status: 'pending-payment',
    labels: {},
    createdAt: now().toISOString(),
    monthly: sub?.months && sub.currency ? { amount: round2(cents(sub.renewalCents) / sub.months), currency: sub.currency } : { amount: 0, currency: plans[0] ? pickPrice(plans[0]).currency : 'USD' },
    ...over,
  });

  /** Where the subscription of a server is, whether the id is a machine or a purchase still waiting for its payment. */
  async function subscriptionOf(id: string): Promise<{ sub: Sub | undefined; gone: boolean }> {
    if (id.startsWith(PENDING_PREFIX)) {
      const subId = id.slice(PENDING_PREFIX.length);
      const sub = (await subscriptions()).find((s) => s.id === subId);
      // A payment that never completed leaves no subscription, and then there is nothing to end.
      return { sub, gone: sub === undefined };
    }
    let vm: Vm;
    try {
      vm = await vmById(id);
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'not-found') return { sub: undefined, gone: true };
      throw e;
    }
    if (!vm.subscriptionId) throw new ProviderError('provider-unavailable', `server ${id} has no subscription to end`);
    return { sub: (await subscriptions()).find((s) => s.id === vm.subscriptionId), gone: false };
  }

  async function getServer(id: string): Promise<Server> {
    if (id.startsWith(PENDING_PREFIX)) {
      const subId = id.slice(PENDING_PREFIX.length);
      const vms = await machines();
      const subs = await subscriptions();
      const plans = await catalog();
      const vm = vms.find((v) => v.subscriptionId === subId && v.state !== 'destroyed');
      if (vm) return toServer(vm, subs, plans);
      const sub = subs.find((s) => s.id === subId);
      if (!sub) throw new ProviderError('not-found', `server ${id} does not exist`);
      return pendingServer(subId, {}, plans, sub);
    }
    const vm = await vmById(id);
    const subs = await subscriptions();
    const plans = await catalog();
    return toServer(vm, subs, plans);
  }

  return {
    capabilities: HOSTINGER_CAPABILITIES,
    terms: { termMonths: opts.termMonths, currency: opts.currency },

    async listRegions() {
      return dataCenters();
    },

    async listSizes() {
      const out: Size[] = [];
      for (const plan of await catalog()) {
        if (!plan.prices.length) continue;
        let price: Price;
        try {
          price = priceFor(plan);
        } catch (e) {
          // A plan with no term of the chosen length is not on offer, which is not an error of the listing.
          if (e instanceof ProviderError && e.code === 'invalid-input') continue;
          throw e;
        }
        out.push({ id: plan.id, ...plan.spec, monthly: { amount: price.amount, currency: price.currency } });
      }
      return out;
    },

    async priceOf(size, region) {
      const plans = await catalog();
      const regions = await dataCenters();
      if (!regions.some((r) => r.id === region)) throw new ProviderError('invalid-input', `unknown region ${region}`);
      return priceFor(planOf(plans, size));
    },

    async createServer(input: CreateServerInput) {
      // Everything that can be refused is refused before the first write; after the purchase there is no undo.
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name)) throw new ProviderError('invalid-input', 'the name must be lowercase letters, digits and dashes');
      if (input.sshKeys.length !== 1 || !/^(ssh|ecdsa|sk)-\S+ \S+/.test(input.sshKeys[0]!)) throw new ProviderError('invalid-input', 'exactly one valid ssh public key is required: Hostinger takes one inline key at purchase');
      if (Object.keys(input.labels ?? {}).length) throw new ProviderError('invalid-input', 'Hostinger cannot label servers');
      const boot = input.bootstrap;
      if (boot && boot.kind !== 'script') throw new ProviderError('invalid-input', `Hostinger takes a script bootstrap, not ${boot.kind}`);
      if (boot && Buffer.byteLength(boot.script, 'utf8') > MAX_SCRIPT_BYTES) throw new ProviderError('invalid-input', `the post-install script is over ${MAX_SCRIPT_BYTES / 1024} KB`);

      const plans = await catalog();
      const regions = await dataCenters();
      const imgs = await templates();
      if (!regions.some((r) => r.id === input.region)) throw new ProviderError('invalid-input', `unknown region ${input.region}`);
      const plan = planOf(plans, input.size);
      const chosen = pickPrice(plan);
      const price = priceFor(plan);
      const template = imgs.find((t) => String(t.id) === input.image) ?? imgs.find((t) => t.name.toLowerCase() === input.image.toLowerCase());
      if (!template) throw new ProviderError('invalid-input', `unknown image ${input.image}`);

      let scriptId: number | undefined;
      if (boot) {
        const made = await http.request('POST', '/api/vps/v1/post-install-scripts', { idempotent: false, body: { name: `coxia-${input.name}`, content: boot.script } });
        scriptId = isRec(made.body) ? num(made.body.id) : undefined;
        if (scriptId === undefined) throw unexpected('the new post-install script');
      }

      let reply;
      try {
        // No `payment_method_id`: the account's default is charged. The API has no client reference or idempotency key for a purchase, so this call is sent once and never retried.
        reply = await http.request('POST', '/api/vps/v1/virtual-machines', {
          idempotent: false,
          body: {
            item_id: chosen.id,
            setup: {
              template_id: template.id,
              data_center_id: Number(input.region),
              hostname: input.name,
              ...(scriptId === undefined ? {} : { post_install_script_id: scriptId }),
              // Both default to a paid or running extra in the document; neither was asked for.
              install_monarx: false,
              enable_backups: false,
              public_key: { name: `coxia-${input.name}`, key: input.sshKeys[0] },
            },
          },
        });
      } catch (e) {
        const unknownOutcome = e instanceof ProviderError && e.code === 'provider-unavailable';
        // The script is cleaned up only when the purchase surely did not happen; after an unknown outcome the server may need it.
        if (scriptId !== undefined && !unknownOutcome) await http.request('DELETE', `/api/vps/v1/post-install-scripts/${scriptId}`, { idempotent: true }).catch(() => undefined);
        if (unknownOutcome) throw new ProviderError('provider-unavailable', `${(e as Error).message}. The order may have gone through: look for the hostname ${input.name} in the panel before buying again`, { cause: e });
        throw e;
      }

      const body = isRec(reply.body) ? reply.body : {};
      if (reply.status === 202) {
        // Payment is still being processed and the machine was not set up: the person finishes it in the panel. Not an error.
        const subId = str(body.subscription_id) ?? `order-${num(body.id) ?? 'unknown'}`;
        return pendingServer(subId, { name: input.name, region: input.region, size: input.size, image: template.name, monthly: { amount: price.amount, currency: price.currency }, upfront: { amount: price.upfront ?? price.amount, currency: price.currency } }, plans);
      }
      const vmBody = isRec(body.virtual_machine) ? body.virtual_machine : undefined;
      const order = isRec(body.order) ? body.order : {};
      if (!vmBody) throw unexpected('a purchase without a virtual machine');
      const server = toServerFromPurchase(parseVm(vmBody), input, template.name, price);
      // What the order really charged, VAT included, when it says; else the catalog's first-period price.
      const total = num(order.total);
      const currency = str(order.currency);
      const charged: Money = total !== undefined && currency ? { amount: cents(total), currency } : { amount: price.upfront ?? price.amount, currency: price.currency };
      return { ...server, upfront: charged };
    },

    async listServers() {
      const vms = await machines();
      const subs = await subscriptions();
      const plans = await catalog();
      return vms.filter((v) => v.state !== 'destroyed').map((v) => toServer(v, subs, plans));
    },

    getServer,

    async resizeServer() {
      throw new ProviderError('unsupported', 'Hostinger has no way to resize a VPS; recreate wipes it');
    },

    async destroyServer(id) {
      const { sub, gone } = await subscriptionOf(id);
      if (gone) return;
      if (!sub) throw new ProviderError('provider-unavailable', `the subscription of server ${id} was not found, so its renewal cannot be turned off`);
      if (!sub.autoRenew) return;
      await http.request('DELETE', `/api/billing/v1/subscriptions/${encodeURIComponent(sub.id)}/auto-renewal/disable`, { idempotent: true });
    },

    async holdsData(id) {
      // No detachable volumes: a machine that exists holds data, unless it was bought and never set up, when there is nothing on it. A payment still pending has no machine.
      if (id.startsWith(PENDING_PREFIX)) {
        await getServer(id);
        return false;
      }
      return (await vmById(id)).state !== 'initial';
    },

    async billing(period) {
      const from = Date.parse(period.from);
      const to = Date.parse(period.to);
      if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new ProviderError('invalid-input', 'the period must be two ISO times, the first not after the second');
      const vms = await machines();
      const subs = await subscriptions();
      const currency = opts.currency ?? subs.find((s) => s.currency)?.currency ?? 'USD';
      const items: BillingItem[] = [];
      for (const vm of vms) {
        const sub = subs.find((s) => s.id === vm.subscriptionId);
        // Subscriptions of other products (domains, hosting) are not this server's cost; subscriptions in another currency cannot be summed with these.
        if (!sub || sub.currency !== currency) continue;
        const start = Date.parse(sub.createdAt);
        const end = Date.parse(sub.expiresAt ?? sub.nextBillingAt ?? '') || (sub.months && !Number.isNaN(start) ? new Date(start).setUTCMonth(new Date(start).getUTCMonth() + sub.months) : start);
        if (Number.isNaN(start) || start > to || end < from) continue;
        items.push({
          serverId: String(vm.id),
          description: `${sub.name}${sub.months ? `, ${sub.months}-month term` : ''}, ${sub.status || 'status unknown'}`,
          amount: cents(sub.totalCents),
          currency,
          from: new Date(start).toISOString(),
          to: new Date(end).toISOString(),
          estimated: true,
        });
      }
      const billing: Billing = { items, total: Math.round(items.reduce((sum, i) => sum + Math.round(i.amount * 100), 0)) / 100, currency, estimated: true };
      return billing;
    },
  };

  function toServerFromPurchase(vm: Vm, input: CreateServerInput, image: string, price: Price): Server {
    return {
      id: String(vm.id),
      name: vm.hostname || input.name,
      region: vm.dataCenterId === undefined ? input.region : String(vm.dataCenterId),
      size: input.size,
      image: vm.template ?? image,
      status: statusOf(vm.state),
      ...(vm.ipv4 ? { ipv4: vm.ipv4 } : {}),
      labels: {},
      createdAt: vm.createdAt || now().toISOString(),
      monthly: { amount: price.amount, currency: price.currency },
    };
  }
}
