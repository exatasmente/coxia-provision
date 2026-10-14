// The VPS provider interface: what coxia-provision needs from a hosting vendor, and nothing vendor-specific. An adapter implements `VpsProvider`; the rest of the
// package only ever sees it through `guardProvider` (guarded.ts), which adds the budget, the autonomy grant, the account check and the redaction.

export const PROVIDER_ERROR_CODES = ['not-found', 'quota', 'invalid-input', 'provider-unavailable', 'rate-limited', 'unauthorized', 'unsupported'] as const;
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

/**
 * What a size costs. `amount` is per month, like every `Money` here. A vendor that bills a whole term at once also says what the purchase charges now (`upfront`, in the same
 * currency) and how long the term is, and the spend gate is asked for `upfront`, not for a month.
 */
export interface Price extends Money {
  /** Charged when the server is created. Absent when the vendor bills month by month, and then the first month is `amount`. */
  upfront?: number;
  /** The months `upfront` pays for. */
  termMonths?: number;
}

/** What the adapter can do. A call outside it throws `unsupported` (or, for a bootstrap of the wrong kind, `invalid-input`); it never pretends. */
export interface Capabilities {
  /**
   * `api`: `destroyServer` deletes the server now. `end-of-term`: it only stops the renewal, and the server runs (and holds its data) until `Server.endsAt`.
   * `none`: the vendor has no way, and `destroyServer` throws `unsupported`.
   */
  destroy: 'api' | 'end-of-term' | 'none';
  /** False: `resizeServer` throws `unsupported`. */
  resize: boolean;
  /** The one kind of `Bootstrap` the adapter takes. */
  bootstrap: 'cloud-init' | 'script';
  /** `invoices`: `billing` returns what the vendor billed. `subscriptions`: it returns the subscriptions and their price and term, every item `estimated`. */
  billing: 'invoices' | 'subscriptions';
  /** Snapshots a server can have; 0 when the adapter has none. */
  snapshots: number;
  /** False: the vendor cannot tag a server, and `createServer` refuses non-empty `labels`. */
  labels: boolean;
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

/** `pending-payment`: bought, the vendor has not confirmed the payment, so there is no machine yet and the setup is not done. */
export type ServerStatus = 'pending-payment' | 'provisioning' | 'running' | 'stopped' | 'destroying';

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
  /** What creating it charged, when the vendor bills a term up front (`Price.upfront`). The guard settles the spend with this, else with `monthly`. */
  upfront?: Money;
  /** When the vendor will take the server away, if it has been told to (`destroy: 'end-of-term'`). The server is still there, and billed for, until then. */
  endsAt?: string;
}

/** How a server configures itself on first boot. Which kind a provider takes is `Capabilities.bootstrap`. */
export type Bootstrap = { kind: 'cloud-init'; userData: string } | { kind: 'script'; script: string };

export interface CreateServerInput {
  name: string;
  region: string;
  size: string;
  image: string;
  /** Public keys (`ssh-ed25519 AAAA...`), at least one: a server nobody can log in to is refused. */
  sshKeys: string[];
  /** Absent: the server is created with nothing to run. A kind the provider does not take is refused with `invalid-input`. */
  bootstrap?: Bootstrap;
  labels?: Record<string, string>;
}

export interface BillingItem {
  /** True when the amount is the list price of a subscription and not a charge the vendor reported. */
  estimated?: boolean;
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
  /** True when any item is `estimated`: the total is not reconciled with what the vendor charged. */
  estimated?: boolean;
}

export interface VpsProvider {
  readonly capabilities: Capabilities;
  /** Throws `invalid-input` for a bootstrap of the wrong kind or a non-empty `labels` when `capabilities.labels` is false. */
  createServer(input: CreateServerInput): Promise<Server>;
  listServers(): Promise<Server[]>;
  /** Throws `not-found` for a server that does not exist (any more). */
  getServer(id: string): Promise<Server>;
  /** Throws `unsupported` when `capabilities.resize` is false; else `not-found`, or `invalid-input` for a size the region does not offer. */
  resizeServer(id: string, size: string): Promise<Server>;
  /**
   * Idempotent: a server that is already gone resolves, it does not throw `not-found`. What it does depends on `capabilities.destroy`: with `end-of-term` it stops the renewal and
   * the server stays until `endsAt`; with `none` it throws `unsupported`. The guard treats every kind as a destroy.
   */
  destroyServer(id: string): Promise<void>;
  /** Whether destroying the server loses data (a disk with anything on it, an attached volume). `true` when the adapter cannot tell. Throws `not-found`. */
  holdsData(id: string): Promise<boolean>;
  listRegions(): Promise<Region[]>;
  listSizes(): Promise<Size[]>;
  /** The price of a size in a region: per month, and the upfront charge when the vendor bills a term. Throws `invalid-input` for an unknown size or region. */
  priceOf(size: string, region: string): Promise<Price>;
  /** What the vendor billed in `[from, to]` (ISO times). Throws `invalid-input` when `from` is after `to`. */
  billing(period: { from: string; to: string }): Promise<Billing>;
}
