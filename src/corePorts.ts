// The ports of ports.ts over the core's admin door: `accounts:assert`, `effects:request` and `effects:settle` (docs/provider-interface.md, "Mapping the ports").
// A refusal the core words with one of its guard codes becomes a refusal; anything else (a conflict, a lost lease, a broken connection) makes the port unable to decide,
// which the guard turns into `host-unavailable`: nothing is bought or destroyed on a doubt.

import { appendFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { AdminDoorError } from './adminDoor.ts';
import type { CoreClient } from './adminDoor.ts';
import { GuardError, isGuardErrorCode } from './ports.ts';
import type { AccountCheck, AccountInfo, AllowedBy, AuditEntry, AuditSink, DestroyDecision, DestroyGuard, SpendDecision, SpendGate } from './ports.ts';

/** How long the person has to answer a proposal in the core (`PROPOSAL_TTL_MS`); the poll gives up a little after. */
export const PROPOSAL_WAIT_MS = 3_600_000 + 60_000;

export interface CorePortOptions {
  core: CoreClient;
  /** The idempotency key of an `effects:request` (`[A-Za-z0-9_-]{8,64}`): the same key for the same effect, so a resumed move finds the same ticket instead of asking twice. */
  requestId?: (kind: 'spend' | 'destroy') => string;
  /** The currency a destroy ticket is closed with (amount 0); the budget's. */
  currency?: () => string;
  pollMs?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Requested = { state: 'allowed'; allowedBy: AllowedBy; ticket: string; expiresAt: string } | { state: 'pending'; proposalId: string };

const real = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function accountOf(v: unknown): AccountInfo {
  if (!isRec(v) || typeof v.id !== 'string' || typeof v.provider !== 'string' || !Array.isArray(v.secretRefs)) throw new GuardError('host-unavailable', 'accounts:assert answered in a shape this client does not know');
  return { id: v.id, provider: v.provider, secretRefs: v.secretRefs.filter((r): r is string => typeof r === 'string') };
}

export function coreAccountCheck(core: CoreClient): AccountCheck {
  return {
    assert: async (provider) => {
      try {
        return accountOf(await core.call('accounts:assert', [{ provider }]));
      } catch (e) {
        if (e instanceof AdminDoorError && e.answered && isGuardErrorCode(e.code)) throw new GuardError(e.code, e.message);
        throw e;
      }
    },
  };
}

/** Asks, and asks again with the same key while the person has not answered. */
async function requestUntilDecided(opts: CorePortOptions, kind: 'spend' | 'destroy', args: Record<string, unknown>): Promise<{ ok: true; allowedBy: AllowedBy; ticket: string } | { ok: false; code: 'forbidden' | 'budget-exceeded' | 'passkey-required' | 'host-unavailable'; reason: string }> {
  const requestId = opts.requestId?.(kind) ?? `${kind}-${randomBytes(8).toString('hex')}`;
  const sleep = opts.sleep ?? real;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? PROPOSAL_WAIT_MS);
  for (;;) {
    let r: Requested;
    try {
      r = (await opts.core.call('effects:request', [{ requestId, kind, ...args }])) as Requested;
    } catch (e) {
      if (e instanceof AdminDoorError && e.answered && isGuardErrorCode(e.code)) return { ok: false, code: e.code, reason: e.message };
      throw e;
    }
    if (isRec(r) && r.state === 'allowed' && typeof r.ticket === 'string') return { ok: true, allowedBy: r.allowedBy, ticket: r.ticket };
    if (!isRec(r) || r.state !== 'pending') throw new Error('effects:request answered in a shape this client does not know');
    if (now() >= deadline) return { ok: false, code: 'forbidden', reason: 'nobody answered the request in time' };
    await sleep(opts.pollMs ?? 2_000);
  }
}

export function coreSpendGate(opts: CorePortOptions): SpendGate {
  return {
    authorize: async (req): Promise<SpendDecision> =>
      requestUntilDecided(opts, 'spend', { accountId: req.accountId, summary: req.summary, amount: req.amount, currency: req.currency, category: req.category, recurrence: req.recurrence }),
    settle: async (ticket, actual) => {
      await opts.core.call('effects:settle', [{ ticket, actual: { amount: actual.amount, currency: actual.currency } }]);
    },
  };
}

export function coreDestroyGuard(opts: CorePortOptions): DestroyGuard {
  return {
    confirm: async (req): Promise<DestroyDecision> => requestUntilDecided(opts, 'destroy', { accountId: req.accountId, summary: req.summary, target: req.serverId }),
    // Closing a ticket spends nothing, so only the amount matters; a failed destroy closes it the same way.
    close: async (ticket) => {
      await opts.core.call('effects:settle', [{ ticket, actual: { amount: 0, currency: opts.currency?.() ?? 'USD' } }]);
    },
  };
}

/** The log of the move itself: one JSON line per effect, appended to a file kept 0600. The core audits its own side in `effects:*`. */
export function fileAuditSink(file: string): AuditSink {
  return async (entry: AuditEntry) => {
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  };
}
