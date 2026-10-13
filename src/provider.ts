// The VPS provider interface: what coxia-provision needs from a hosting vendor, and nothing vendor-specific. An adapter implements `VpsProvider`; the rest of the
// package only ever sees it through `guardProvider` (guarded.ts), which adds the budget, the autonomy grant, the account check and the redaction.

export const PROVIDER_ERROR_CODES = ['not-found', 'quota', 'invalid-input', 'provider-unavailable', 'rate-limited', 'unauthorized'] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const isProviderErrorCode = (v: unknown): v is ProviderErrorCode => typeof v === 'string' && (PROVIDER_ERROR_CODES as readonly string[]).includes(v);

/** What an adapter throws. Recognised by `name`, as the core's errors are, so a copy made by the redactor is still one. The message never holds a credential. */
export class ProviderError extends Error {
  code: ProviderErrorCode;
  /** On `rate-limited`: when the vendor said to try again, if it said. */
  retryAfterSec?: number;

  constructor(code: ProviderErrorCode, message: string, opts: { cause?: unknown; retryAfterSec?: number } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.code = code;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof Error && e.name === 'ProviderError' && isProviderErrorCode((e as { code?: unknown }).code);

/** An amount of money. A price is per month unless said otherwise. */
export interface Money {
  amount: number;
  /** ISO 4217. */
  currency: string;
}

export interface Region {
  id: string;
  name: string;
}

export interface Size {
  id: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  /** Per month, in the regions with no entry in `regionPrices`. */
  monthly: Money;
  /** Per month, where the region changes the price. `priceOf` is the authority; this only lets a person compare. */
  regionPrices?: Record<string, Money>;
}

export type ServerStatus = 'provisioning' | 'running' | 'stopped' | 'destroying';

export interface Server {
  id: string;
  name: string;
  region: string;
  size: string;
  image: string;
  status: ServerStatus;
  ipv4?: string;
  labels: Record<string, string>;
  createdAt: string;
  /** What this server costs a month right now: the price of its size in its region. */
  monthly: Money;
}

export interface CreateServerInput {
  name: string;
  region: string;
  size: string;
  image: string;
  /** Public keys (`ssh-ed25519 AAAA...`), at least one: a server nobody can log in to is refused. */
  sshKeys: string[];
  /** The cloud-init document. */
  userData?: string;
  labels?: Record<string, string>;
}

export interface BillingItem {
  /** The server the line is for; absent for a line the vendor does not tie to one (a volume, a snapshot). */
  serverId?: string;
  description: string;
  amount: number;
  currency: string;
  /** ISO times of the period the line covers. */
  from: string;
  to: string;
}

export interface Billing {
  items: BillingItem[];
  /** The sum of `items`, to the cent. */
  total: number;
  currency: string;
}

export interface VpsProvider {
  createServer(input: CreateServerInput): Promise<Server>;
  listServers(): Promise<Server[]>;
  /** Throws `not-found` for a server that does not exist (any more). */
  getServer(id: string): Promise<Server>;
  /** Throws `not-found`; `invalid-input` for a size the region does not offer. */
  resizeServer(id: string, size: string): Promise<Server>;
  /** Idempotent: a server that is already gone resolves, it does not throw `not-found`. */
  destroyServer(id: string): Promise<void>;
  /** Whether destroying the server loses data (a disk with anything on it, an attached volume). `true` when the adapter cannot tell. Throws `not-found`. */
  holdsData(id: string): Promise<boolean>;
  listRegions(): Promise<Region[]>;
  listSizes(): Promise<Size[]>;
  /** The price per month of a size in a region. Throws `invalid-input` for an unknown size or region. */
  priceOf(size: string, region: string): Promise<Money>;
  /** What the vendor billed in `[from, to]` (ISO times). Throws `invalid-input` when `from` is after `to`. */
  billing(period: { from: string; to: string }): Promise<Billing>;
}
