// The small HTTP client under the Hostinger adapter: bearer token read per request, retries only where they cannot buy twice, every failure a `ProviderError` with the token
// taken out. Built on `fetch`; the base URL and `fetch` are injectable so a test talks to a server on 127.0.0.1.

import type { SecretResolver } from '../ports.ts';
import { ProviderError } from '../provider.ts';
import type { ProviderErrorCode } from '../provider.ts';
import { redactor } from '../redact.ts';

export interface HttpOptions {
  /** `https://developers.hostinger.com` in production (the `servers` entry of the OpenAPI document). */
  baseUrl: string;
  secrets: SecretResolver;
  tokenRef: string;
  fetch?: typeof fetch;
  /** Injectable so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** A `Retry-After` longer than this is not waited for: the call fails `rate-limited` and says how long. */
  maxRetryWaitSec?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * True for a call that can be repeated without a second effect (GET, and the DELETE that turns renewal off). Only those are retried: `429` up to 3 times, a 5xx or a dropped
   * connection once. A purchase is never retried, whatever the answer: a 5xx or a timeout does not say whether the order was placed.
   */
  idempotent: boolean;
}

export const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_MESSAGE = 200;

/** Delay in seconds out of a `Retry-After` header (delta-seconds or an HTTP date), or undefined. */
export function retryAfterSec(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

const codeOf = (status: number): ProviderErrorCode => {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 400 || status === 422) return 'invalid-input';
  if (status === 429) return 'rate-limited';
  return 'provider-unavailable';
};

/** What `request` resolves with: the status, and the parsed body when there was one. */
export interface Reply {
  status: number;
  body?: unknown;
}

export interface HttpClient {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RequestOptions): Promise<Reply>;
}

export function createHttpClient(opts: HttpOptions): HttpClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxWait = opts.maxRetryWaitSec ?? 30;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function token(): Promise<string> {
    try {
      const t = await opts.secrets.resolve(opts.tokenRef);
      if (t) return t;
    } catch {
      // The reason may name the store; the caller only needs to know there is no token.
    }
    throw new ProviderError('unauthorized', 'the Hostinger API token could not be read');
  }

  async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, o: RequestOptions): Promise<Reply> {
    const secret = await token();
    const hide = redactor([secret]).text;
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const where = `${method} ${path}`;
    let rateLimited = 0;
    let transient = 0;

    for (;;) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          // Never follow a redirect with the token.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
        });
      } catch (e) {
        if (o.idempotent && transient < 1) {
          transient += 1;
          await sleep(500);
          continue;
        }
        const why = e instanceof Error ? e.name : 'error';
        throw new ProviderError('provider-unavailable', hide(`${where} did not complete (${why})${o.idempotent ? '' : '; whether the request was processed is unknown'}`));
      }

      const text = await res.text().catch(() => '');
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (res.ok) {
        if (text && json === undefined) throw new ProviderError('provider-unavailable', hide(`${where} answered ${res.status} with a body that is not JSON`));
        return json === undefined ? { status: res.status } : { status: res.status, body: json };
      }

      const wait = retryAfterSec(res.headers.get('retry-after'));
      if (res.status === 429 && o.idempotent && rateLimited < MAX_RATE_LIMIT_RETRIES && (wait ?? 0) <= maxWait) {
        await sleep((wait ?? 2 ** rateLimited) * 1000);
        rateLimited += 1;
        continue;
      }
      if (res.status >= 500 && o.idempotent && transient < 1) {
        transient += 1;
        await sleep(500);
        continue;
      }

      const rec = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
      // The API says `message` in its error schemas and `error` in its overview; take either. The text is cut and redacted: a server may echo what it was sent.
      const said = typeof rec.message === 'string' ? rec.message : typeof rec.error === 'string' ? rec.error : '';
      const corr = typeof rec.correlation_id === 'string' ? ` [correlation ${rec.correlation_id.slice(0, 64)}]` : '';
      const sent = o.idempotent ? '' : res.status >= 500 ? '; whether the request was processed is unknown' : '';
      const message = hide(`${where} answered ${res.status}${said ? `: ${said.slice(0, MAX_MESSAGE)}` : ''}${corr}${sent}`);
      throw new ProviderError(codeOf(res.status), message, wait === undefined ? {} : { retryAfterSec: wait });
    }
  }

  return { request };
}
