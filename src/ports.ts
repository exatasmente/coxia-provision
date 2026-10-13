// The ports the guarded provider talks to. Each one is a seam to the Coxia core (docs/provider-interface.md lists the channels they need), so this package has
// no dependency on it and a test can stand in for it.

export const GUARD_ERROR_CODES = ['forbidden', 'budget-exceeded', 'passkey-required', 'host-unavailable'] as const;
export type GuardErrorCode = (typeof GUARD_ERROR_CODES)[number];

export const isGuardErrorCode = (v: unknown): v is GuardErrorCode => typeof v === 'string' && (GUARD_ERROR_CODES as readonly string[]).includes(v);

/** What a port or the guard refuses with. The codes are the core's own (`src/shared/contract.ts`). */
export class GuardError extends Error {
  code: GuardErrorCode;

  constructor(code: GuardErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GuardError';
    this.code = code;
  }
}

/** What allowed an action: the person's "yes", or an autonomy grant. */
export type AllowedBy = 'person' | `grant:${string}`;

export interface SpendRequest {
  kind: 'spend';
  /** The budget category; infrastructure for a server. */
  category: string;
  accountId: string;
  amount: number;
  currency: string;
  recurrence: 'once' | 'monthly' | 'yearly';
  /** Plain words for the person who is asked, and for the ledger. Never a credential. */
  summary: string;
}

export type Refusal = { ok: false; code: GuardErrorCode; reason: string };
export type SpendDecision = { ok: true; allowedBy: AllowedBy; ticket: string } | Refusal;

export interface ActualSpend {
  /** What the vendor says it charges. Zero closes the ticket with nothing spent (the purchase failed). */
  amount: number;
  currency: string;
}

export interface SpendGate {
  /** Checks the budget, then a grant or the person's "yes". Waits for the person when it must. Resolves with a refusal, rejects only when it cannot decide. */
  authorize(req: SpendRequest): Promise<SpendDecision>;
  /** Records what was spent against the ticket. Called once per ticket. */
  settle(ticket: string, actual: ActualSpend): Promise<void>;
}

export interface SecretResolver {
  /** The value behind a secret reference. Called by the adapter (and by the redactor, to know what to hide) and nowhere else; the value is never kept. */
  resolve(ref: string): Promise<string>;
}

export interface AccountInfo {
  id: string;
  provider: string;
  /** References into the secrets store, never values. */
  secretRefs: string[];
}

export interface AccountCheck {
  /** Resolves with the registered account of the provider, rejects with `forbidden` when there is none. */
  assert(provider: string): Promise<AccountInfo>;
}

export interface DestroyRequest {
  accountId: string;
  serverId: string;
  summary: string;
}

export type DestroyDecision = { ok: true; allowedBy: AllowedBy; ticket: string } | Refusal;

export interface DestroyGuard {
  /** A grant that covers destroying, or the person's passkey. */
  confirm(req: DestroyRequest): Promise<DestroyDecision>;
  /** Closes the ticket once the destroy ran (`done`) or failed (`failed`). */
  close(ticket: string, outcome: 'done' | 'failed'): Promise<void>;
}

export interface AuditEntry {
  at: string;
  op: 'create-server' | 'resize-server' | 'destroy-server';
  provider: string;
  accountId: string;
  target: string;
  result: 'done' | 'refused' | 'failed';
  code?: string;
  allowedBy?: AllowedBy;
  amount?: number;
  currency?: string;
  /** Set when the effect ran but the ledger could not be told; the money is spent and the person should know. */
  settleError?: string;
  summary: string;
}

export type AuditSink = (entry: AuditEntry) => void | Promise<void>;
