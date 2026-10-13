// Takes the values of the credentials out of anything that leaves the guarded provider: messages, stacks, the chain of causes and the audit entries.
// The error is rebuilt, not edited, so a property an SDK hung on it (request headers, a response body) does not travel.

import { isProviderErrorCode, ProviderError } from './provider.ts';
import { GuardError, isGuardErrorCode } from './ports.ts';

export const MASK = '[redacted]';
const MAX_CAUSES = 8;

/** The spellings a value takes on its way into a message: as is, percent-encoded, base64 (as in a Basic header), base64url and JSON-escaped. */
function spellings(secret: string): string[] {
  const buf = Buffer.from(secret, 'utf8');
  return [secret, encodeURIComponent(secret), buf.toString('base64'), buf.toString('base64url'), JSON.stringify(secret).slice(1, -1)];
}

export interface Redactor {
  text(value: string): string;
  /** A clean copy of any thrown value, as a `GuardError` or a `ProviderError`. */
  error(e: unknown): GuardError | ProviderError;
  /** The entry with every string value passed through `text`. */
  entry<T extends object>(value: T): T;
}

export function redactor(secrets: readonly string[]): Redactor {
  const needles = [...new Set(secrets.filter((s) => s.length > 0).flatMap(spellings))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => needles.reduce((acc, n) => acc.split(n).join(MASK), value);

  const copy = (e: unknown, depth: number): GuardError | ProviderError => {
    let out: GuardError | ProviderError;
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      const message = text(e.message);
      if (isGuardErrorCode(code)) out = new GuardError(code, message);
      else if (isProviderErrorCode(code)) {
        const retry = (e as { retryAfterSec?: unknown }).retryAfterSec;
        out = new ProviderError(code, message, typeof retry === 'number' ? { retryAfterSec: retry } : {});
      } else out = new ProviderError('provider-unavailable', message);
      if (e.stack) out.stack = text(e.stack);
      if (e.cause !== undefined && depth < MAX_CAUSES) out.cause = copy(e.cause, depth + 1);
    } else {
      let shown: string;
      try {
        shown = typeof e === 'string' ? e : (JSON.stringify(e) ?? String(e));
      } catch {
        shown = 'unprintable value';
      }
      out = new ProviderError('provider-unavailable', text(shown));
    }
    return out;
  };

  const entry = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? text(v) : v])) as T;

  return { text, error: (e) => copy(e, 0), entry };
}
