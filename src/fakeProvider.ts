// An in-memory provider with deterministic ids, prices and clock. It stands in for a vendor in the tests of this package and of the move. It reads its token through the
// secret resolver on every call, like a real adapter, so the redaction and the unauthorized path are exercised for real.

import type { Billing, BillingItem, CreateServerInput, Money, Region, Server, Size, VpsProvider } from './provider.ts';
import { ProviderError } from './provider.ts';
import type { ProviderErrorCode } from './provider.ts';
import type { SecretResolver } from './ports.ts';

export const FAKE_REGIONS: Region[] = [
  { id: 'fsn', name: 'Falkenstein' },
  { id: 'ash', name: 'Ashburn' },
];

export const FAKE_SIZES: Size[] = [
  { id: 's-small', vcpus: 2, memoryMb: 2048, diskGb: 40, monthly: { amount: 5, currency: 'USD' }, regionPrices: { ash: { amount: 6, currency: 'USD' } } },
  { id: 's-medium', vcpus: 4, memoryMb: 8192, diskGb: 80, monthly: { amount: 12, currency: 'USD' }, regionPrices: { ash: { amount: 14.4, currency: 'USD' } } },
  { id: 's-large', vcpus: 8, memoryMb: 16384, diskGb: 160, monthly: { amount: 24, currency: 'USD' }, regionPrices: { ash: { amount: 28.8, currency: 'USD' } } },
];

export const FAKE_IMAGES = ['ubuntu-24.04', 'debian-12'];
export const FAKE_EPOCH = '2026-01-01T00:00:00.000Z';

export interface FakeOptions {
  secrets: SecretResolver;
  /** The reference the fake reads its token from, and the value it accepts. */
  tokenRef: string;
  token: string;
  now?: () => Date;
  maxServers?: number;
  /** What the vendor really charges for a created or resized server, when it is not the listed price. */
  charge?: (listed: Money) => Money;
}

interface Stored {
  server: Server;
  holdsData: boolean;
  destroyedAt?: string;
}

export interface FakeProvider extends VpsProvider {
  /** Every call that reached the vendor, in order. A refused purchase leaves no `createServer` here. */
  readonly calls: { op: string; args: unknown[] }[];
  /** Makes the next call (of any kind) fail with this code; the message carries `leak`, which stands for a vendor echoing a credential back. */
  failNext(code: ProviderErrorCode, leak?: string): void;
  /** Marks whether destroying the server would lose data. */
  setHoldsData(id: string, value: boolean): void;
}

export function createFakeProvider(opts: FakeOptions): FakeProvider {
  const now = opts.now ?? (() => new Date(FAKE_EPOCH));
  const maxServers = opts.maxServers ?? 10;
  const stored = new Map<string, Stored>();
  const calls: { op: string; args: unknown[] }[] = [];
  let seq = 0;
  let pending: { code: ProviderErrorCode; leak?: string } | undefined;

  const listed = (size: string, region: string): Money => {
    const s = FAKE_SIZES.find((x) => x.id === size);
    if (!s) throw new ProviderError('invalid-input', `unknown size ${size}`);
    if (!FAKE_REGIONS.some((r) => r.id === region)) throw new ProviderError('invalid-input', `unknown region ${region}`);
    return { ...(s.regionPrices?.[region] ?? s.monthly) };
  };
  const charged = (size: string, region: string): Money => (opts.charge ? opts.charge(listed(size, region)) : listed(size, region));

  async function enter(op: string, args: unknown[]): Promise<void> {
    const token = await opts.secrets.resolve(opts.tokenRef);
    if (token !== opts.token) throw new ProviderError('unauthorized', 'the provider rejected the credentials');
    if (pending) {
      const { code, leak } = pending;
      pending = undefined;
      throw new ProviderError(code, `fake ${op} failed${leak ? `: ${leak}` : ''}`, { cause: leak ? new Error(`upstream said ${leak}`) : undefined });
    }
    calls.push({ op, args });
  }

  const live = (id: string): Stored => {
    const s = stored.get(id);
    if (!s || s.destroyedAt) throw new ProviderError('not-found', `server ${id} does not exist`);
    return s;
  };

  const validate = (input: CreateServerInput): void => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name)) throw new ProviderError('invalid-input', 'the name must be lowercase letters, digits and dashes');
    if (!input.sshKeys.length || input.sshKeys.some((k) => !/^ssh-\S+ \S+/.test(k))) throw new ProviderError('invalid-input', 'at least one valid ssh public key is required');
    if (!FAKE_IMAGES.includes(input.image)) throw new ProviderError('invalid-input', `unknown image ${input.image}`);
    listed(input.size, input.region);
  };

  return {
    calls,
    failNext: (code, leak) => {
      pending = leak === undefined ? { code } : { code, leak };
    },
    setHoldsData: (id, value) => {
      live(id).holdsData = value;
    },

    async createServer(input) {
      await enter('createServer', [input]);
      validate(input);
      if ([...stored.values()].filter((s) => !s.destroyedAt).length >= maxServers) throw new ProviderError('quota', 'the server limit of the account is reached');
      seq += 1;
      const server: Server = {
        id: `srv-${seq}`,
        name: input.name,
        region: input.region,
        size: input.size,
        image: input.image,
        status: 'running',
        ipv4: `192.0.2.${seq}`,
        labels: { ...(input.labels ?? {}) },
        createdAt: now().toISOString(),
        monthly: charged(input.size, input.region),
      };
      stored.set(server.id, { server, holdsData: false });
      return structuredClone(server);
    },

    async listServers() {
      await enter('listServers', []);
      return [...stored.values()].filter((s) => !s.destroyedAt).map((s) => structuredClone(s.server));
    },

    async getServer(id) {
      await enter('getServer', [id]);
      return structuredClone(live(id).server);
    },

    async resizeServer(id, size) {
      await enter('resizeServer', [id, size]);
      const s = live(id);
      s.server = { ...s.server, size, monthly: charged(size, s.server.region) };
      return structuredClone(s.server);
    },

    async destroyServer(id) {
      await enter('destroyServer', [id]);
      const s = stored.get(id);
      if (s && !s.destroyedAt) s.destroyedAt = now().toISOString();
    },

    async holdsData(id) {
      await enter('holdsData', [id]);
      return live(id).holdsData;
    },

    async listRegions() {
      await enter('listRegions', []);
      return structuredClone(FAKE_REGIONS);
    },

    async listSizes() {
      await enter('listSizes', []);
      return structuredClone(FAKE_SIZES);
    },

    async priceOf(size, region) {
      await enter('priceOf', [size, region]);
      return listed(size, region);
    },

    async billing(period) {
      await enter('billing', [period]);
      const from = Date.parse(period.from);
      const to = Date.parse(period.to);
      if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new ProviderError('invalid-input', 'the period must be two ISO times, the first not after the second');
      const items: BillingItem[] = [...stored.values()]
        .filter((s) => Date.parse(s.server.createdAt) <= to && (!s.destroyedAt || Date.parse(s.destroyedAt) >= from))
        .map((s) => ({ serverId: s.server.id, description: `${s.server.name} (${s.server.size})`, amount: s.server.monthly.amount, currency: s.server.monthly.currency, from: period.from, to: period.to }));
      const billing: Billing = { items, total: Math.round(items.reduce((sum, i) => sum + i.amount * 100, 0)) / 100, currency: 'USD' };
      return billing;
    },
  };
}
