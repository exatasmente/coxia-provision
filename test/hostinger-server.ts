// A fake of the Hostinger API on 127.0.0.1, with the shapes of OpenAPI 1.64.0 (VPS and billing). It is a test double, not a record of real traffic: the ids, prices and
// names are made up. It enforces what the adapter relies on (bearer token, required purchase fields, the 48 KB script limit) so a wrong request fails here, not in production.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  method: string;
  path: string;
  query: string;
  auth: string | undefined;
  body: unknown;
}

interface Vm {
  id: number;
  subscription_id: string;
  data_center_id: number;
  plan: string;
  hostname: string;
  state: string;
  template: { id: number; name: string };
  ip: string;
  created_at: string;
}
interface Sub {
  id: string;
  name: string;
  status: string;
  billing_period: number;
  billing_period_unit: string;
  currency_code: string;
  total_price: number;
  renewal_price: number;
  is_auto_renewed: boolean;
  created_at: string;
  expires_at: string | null;
  next_billing_at: string | null;
}

const price = (id: string, name: string, period: number, unit: string, p: number, first: number, currency = 'USD') => ({ id, name, currency, price: p, first_period_price: first, period, period_unit: unit });

export const CATALOG = [
  { id: 'vps-kvm1', name: 'KVM 1', category: 'VPS', metadata: null, prices: [price('vps-kvm1-usd-12m', 'KVM 1 (12 months)', 12, 'month', 7200, 6900), price('vps-kvm1-usd-1m', 'KVM 1 (1 month)', 1, 'month', 1199, 649)] },
  { id: 'vps-kvm2', name: 'KVM 2', category: 'VPS', metadata: null, prices: [price('vps-kvm2-usd-12m', 'KVM 2 (12 months)', 12, 'month', 17988, 10788), price('vps-kvm2-usd-1m', 'KVM 2 (1 month)', 1, 'month', 1499, 899), price('vps-kvm2-usd-24m', 'KVM 2 (24 months)', 2, 'year', 33576, 19176), price('vps-kvm2-brl-1m', 'KVM 2 (1 month)', 1, 'month', 7799, 4399, 'BRL')] },
  { id: 'vps-kvm4', name: 'KVM 4', category: 'VPS', metadata: { cpus: 4, memory: 16384, disk: 204800 }, prices: [price('vps-kvm4-usd-1m', 'KVM 4 (1 month)', 1, 'month', 2899, 1299)] },
  { id: 'hosting-web', name: 'Web hosting', category: 'HOSTING', metadata: null, prices: [] },
];
export const DATA_CENTERS = [
  { id: 9, name: 'dc-br', location: 'BR', city: 'Sao Paulo', continent: 'South America' },
  { id: 3, name: 'dc-fr', location: 'FR', city: 'Paris', continent: 'Europe' },
];
export const TEMPLATES = [
  { id: 1002, name: 'Ubuntu 24.04 LTS', description: 'Ubuntu', documentation: null },
  { id: 1003, name: 'Debian 12', description: 'Debian', documentation: null },
];

export interface FakeHostinger {
  url: string;
  token: string;
  requests: Seen[];
  vms: Vm[];
  subs: Sub[];
  scripts: { id: number; name: string; content: string }[];
  /** `ok`: 200 with the machine. `pending`: 202, no machine until `completePayment`. */
  mode: 'ok' | 'pending';
  /** The next `times` requests fail with this status; `body` and `headers` are what the server answers. */
  failNext(status: number, times: number, body?: unknown, headers?: Record<string, string>, match?: (method: string, path: string) => boolean): void;
  /** Makes the machine of a pending purchase appear, as when the payment clears. */
  completePayment(subscriptionId: string): void;
  close(): Promise<void>;
}

export async function startFakeHostinger(token: string): Promise<FakeHostinger> {
  const f = { requests: [] as Seen[], vms: [] as Vm[], subs: [] as Sub[], scripts: [] as { id: number; name: string; content: string }[], mode: 'ok' as 'ok' | 'pending' };
  let failing: { status: number; times: number; body: unknown; headers: Record<string, string>; match: (method: string, path: string) => boolean } | undefined;
  let seq = 1000;
  const T0 = Date.parse('2026-10-14T00:00:00Z');

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const invalid = (res: ServerResponse, errors: Record<string, string[]>): void => send(res, 422, { message: 'The given data was invalid.', errors, correlation_id: 'c-422' });
  const vmJson = (v: Vm) => ({ id: v.id, firewall_group_id: null, subscription_id: v.subscription_id, data_center_id: v.data_center_id, plan: v.plan, hostname: v.hostname, state: v.state, actions_lock: 'unlocked', cpus: 2, memory: 8192, disk: 102400, bandwidth: 8388608, ns1: null, ns2: null, ipv4: [{ id: v.id * 10, address: v.ip, ptr: null }], ipv6: null, template: v.template, created_at: v.created_at });

  function makeSub(planName: string, priceId: string, now: string): Sub {
    const item = CATALOG.find((c) => c.prices.some((p) => p.id === priceId))!;
    const p = item.prices.find((x) => x.id === priceId)!;
    const months = p.period_unit === 'year' ? p.period * 12 : p.period;
    seq += 1;
    const sub: Sub = { id: `sub-${seq}`, name: planName, status: 'active', billing_period: p.period, billing_period_unit: p.period_unit, currency_code: p.currency, total_price: p.first_period_price, renewal_price: p.price, is_auto_renewed: true, created_at: now, expires_at: null, next_billing_at: new Date(Date.parse(now) + months * 30 * 86_400_000).toISOString() };
    f.subs.push(sub);
    return sub;
  }

  function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    f.requests.push({ method, path, query: url.search, auth: req.headers.authorization, body });
    if (failing && failing.times > 0 && failing.match(method, path)) {
      failing.times -= 1;
      return send(res, failing.status, failing.body, failing.headers);
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'Unauthenticated', correlation_id: 'c-401' });
    const rec = (body !== null && typeof body === 'object' ? body : {}) as Record<string, any>;
    const now = new Date(T0).toISOString();

    if (method === 'GET' && path === '/api/billing/v1/catalog') {
      const cat = url.searchParams.get('category');
      return send(res, 200, CATALOG.filter((c) => !cat || c.category === cat));
    }
    if (method === 'GET' && path === '/api/vps/v1/data-centers') return send(res, 200, DATA_CENTERS);
    if (method === 'GET' && path === '/api/vps/v1/templates') return send(res, 200, TEMPLATES);
    if (method === 'GET' && path === '/api/vps/v1/virtual-machines') return send(res, 200, f.vms.map(vmJson));
    if (method === 'GET' && path === '/api/billing/v1/subscriptions') return send(res, 200, f.subs);

    let m = /^\/api\/vps\/v1\/virtual-machines\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      const v = f.vms.find((x) => x.id === Number(m![1]));
      return v ? send(res, 200, vmJson(v)) : send(res, 404, { message: 'Virtual machine not found', correlation_id: 'c-404' });
    }

    if (method === 'POST' && path === '/api/vps/v1/post-install-scripts') {
      if (typeof rec.name !== 'string' || typeof rec.content !== 'string') return invalid(res, { content: ['The content field is required.'] });
      if (Buffer.byteLength(rec.content, 'utf8') > 48 * 1024) return invalid(res, { content: ['The content must not be greater than 48 kilobytes.'] });
      seq += 1;
      const s = { id: seq, name: rec.name, content: rec.content };
      f.scripts.push(s);
      return send(res, 200, { ...s, created_at: now, updated_at: now });
    }
    m = /^\/api\/vps\/v1\/post-install-scripts\/(\d+)$/.exec(path);
    if (method === 'DELETE' && m) {
      f.scripts = f.scripts.filter((s) => s.id !== Number(m![1]));
      return send(res, 200, { message: 'Post-install script deleted' });
    }

    if (method === 'POST' && path === '/api/vps/v1/virtual-machines') {
      const setup = rec.setup ?? {};
      const errors: Record<string, string[]> = {};
      const item = CATALOG.flatMap((c) => c.prices.map((p) => ({ c, p }))).find((x) => x.p.id === rec.item_id);
      if (!item) errors.item_id = ['The selected item id is invalid.'];
      const tpl = TEMPLATES.find((t) => t.id === setup.template_id);
      if (!tpl) errors['setup.template_id'] = ['The selected template id is invalid.'];
      const dc = DATA_CENTERS.find((d) => d.id === setup.data_center_id);
      if (!dc) errors['setup.data_center_id'] = ['The selected data center id is invalid.'];
      if (setup.post_install_script_id !== undefined && !f.scripts.some((s) => s.id === setup.post_install_script_id)) errors['setup.post_install_script_id'] = ['The selected post install script id is invalid.'];
      if (Object.keys(errors).length) return invalid(res, errors);
      const sub = makeSub(item!.c.name, item!.p.id, now);
      if (f.mode === 'pending') return send(res, 202, { id: ++seq, subscription_id: sub.id, status: 'payment_initiated', message: 'Payment is being processed. Finish the setup in hPanel once it clears.' });
      seq += 1;
      const vm: Vm = { id: seq, subscription_id: sub.id, data_center_id: dc!.id, plan: item!.c.name, hostname: setup.hostname ?? `srv-${seq}.example.com`, state: 'running', template: { id: tpl!.id, name: tpl!.name }, ip: `192.0.2.${seq % 250}`, created_at: now };
      f.vms.push(vm);
      return send(res, 200, { order: { id: seq + 1, subscription_id: sub.id, status: 'completed', currency: item!.p.currency, subtotal: item!.p.first_period_price, total: Math.round(item!.p.first_period_price * 1.1), created_at: now, updated_at: now }, virtual_machine: vmJson(vm) });
    }

    m = /^\/api\/billing\/v1\/subscriptions\/([^/]+)\/auto-renewal\/disable$/.exec(path);
    if (method === 'DELETE' && m) {
      const s = f.subs.find((x) => x.id === m![1]);
      if (!s) return send(res, 404, { message: 'Subscription not found', correlation_id: 'c-404' });
      s.is_auto_renewed = false;
      s.status = 'not_renewing';
      s.next_billing_at = null;
      s.expires_at ??= new Date(Date.parse(s.created_at) + s.billing_period * (s.billing_period_unit === 'year' ? 12 : 1) * 30 * 86_400_000).toISOString();
      return send(res, 200, s);
    }
    return send(res, 404, { message: `no route ${method} ${path}`, correlation_id: 'c-route' });
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  return Object.assign(f, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    failNext: (status: number, times: number, body: unknown = { message: 'forced failure', correlation_id: 'c-forced' }, headers: Record<string, string> = {}, match: (method: string, path: string) => boolean = () => true) => {
      failing = { status, times, body, headers, match };
    },
    completePayment: (subscriptionId: string) => {
      const sub = f.subs.find((s) => s.id === subscriptionId)!;
      const item = CATALOG.find((c) => c.name === sub.name)!;
      seq += 1;
      f.vms.push({ id: seq, subscription_id: sub.id, data_center_id: 9, plan: item.name, hostname: `srv-${seq}.example.com`, state: 'initial', template: TEMPLATES[0]!, ip: `192.0.2.${seq % 250}`, created_at: sub.created_at });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as unknown as FakeHostinger;
}
