# The VPS provider interface

How coxia-provision talks to a hosting vendor, and what it needs from the Coxia core to do so safely. The first real adapter is Hostinger (`docs/providers/hostinger.md`); this is the
interface, the contract every adapter must pass, and the fake the tests use.

## Layers

| Piece | File | Job |
|---|---|---|
| `VpsProvider` | `src/provider.ts` | What an adapter implements. Vendor-specific, knows nothing of money rules. |
| Ports | `src/ports.ts` | `SpendGate`, `DestroyGuard`, `AccountCheck`, `SecretResolver`, `AuditSink`: the seams to the core. |
| `guardProvider` | `src/guarded.ts` | The only surface the rest of the package uses: account check, price, spend gate, destroy guard, audit, redaction. |
| Redactor | `src/redact.ts` | Rebuilds every error without the credential, in message, stack and cause chain. |
| Fake | `src/fakeProvider.ts` | In-memory provider, deterministic ids, prices and clock. |
| Contract | `test/contract.ts` | `runProviderContract(name, factory)`; run by `test/fake-provider.test.ts`, and by each adapter's own test. |

## The interface

```ts
interface VpsProvider {
  readonly capabilities: Capabilities;
  createServer(input: { name; region; size; image; sshKeys: string[]; bootstrap?: Bootstrap; labels? }): Promise<Server>;
  listServers(): Promise<Server[]>;
  getServer(id): Promise<Server>;                  // not-found
  resizeServer(id, size): Promise<Server>;         // unsupported, not-found, invalid-input
  destroyServer(id): Promise<void>;                // idempotent: a missing server resolves; see destroy capability
  holdsData(id): Promise<boolean>;                 // true when in doubt; not-found
  listRegions(): Promise<Region[]>;
  listSizes(): Promise<Size[]>;                    // monthly price (and per region)
  priceOf(size, region): Promise<Price>;           // per month, plus upfront and termMonths; invalid-input
  billing({ from, to }): Promise<{ items; total; currency }>;
}
```

Errors are `ProviderError` with a stable `code`: `not-found`, `quota`, `invalid-input`, `provider-unavailable`, `rate-limited`, `unauthorized`, `unsupported`. The guard adds `GuardError` with the
core's own codes: `forbidden`, `budget-exceeded`, `passkey-required`, `host-unavailable`. Both are recognised by `name`.

## Capabilities

A vendor does not always do what the interface names. Each adapter declares what it can, and a call outside it fails with `unsupported` (or `invalid-input` for a bootstrap of the wrong
kind); it never pretends.

| Field | Values | Meaning |
|---|---|---|
| `destroy` | `api` / `end-of-term` / `none` | `api`: `destroyServer` deletes now. `end-of-term`: it only stops the renewal; the server keeps running, billed and holding its data, until `Server.endsAt`. `none`: `unsupported`. |
| `resize` | boolean | False: `resizeServer` throws `unsupported`. |
| `bootstrap` | `cloud-init` / `script` | The one `Bootstrap` kind the adapter takes (`{kind:'cloud-init', userData}` or `{kind:'script', script}`). Another kind is `invalid-input`. |
| `billing` | `invoices` / `subscriptions` | `subscriptions`: `billing()` lists subscriptions with their price and term, every item and the total `estimated`. |
| `snapshots` | number | Snapshots a server can have. |
| `labels` | boolean | False: non-empty `labels` on create are `invalid-input`. |

`destroyServer` stays one method, also for `end-of-term`, so that the destroy guard, the audit and the passkey rule have one path and cannot be skipped by calling "the other method". The
honesty is in the capability, in `Server.endsAt` and in the guard's summary and audit text ("end server ... at the end of its term"), which says the server runs until then.

The guard checks the capability itself and refuses before it asks anyone: a bootstrap or labels the provider cannot take, a resize or a destroy it does not have.

## Price and the spend

`priceOf` returns `Price`: `amount` per month, and for a vendor that bills a term at once also `upfront` (the charge now) and `termMonths`. The gate is asked for `upfront` with recurrence
`once` (else for `amount`, `monthly`), and settles with `Server.upfront` (else `monthly`). `Server.status` can be `pending-payment`: bought, payment not confirmed, no machine yet; that is a
result, not an error.

An adapter receives a `SecretResolver` and a secret reference, resolves the token on each call and keeps it nowhere. An adapter must not put the token in a message, and the
contract checks it; the guard checks again, because an SDK's error is not the adapter's to vouch for.

## What the guard does

- Every call first asks `AccountCheck.assert(providerName)`. No registered account: `forbidden`, and nothing reaches the vendor.
- **Create** prices the server with `priceOf`, asks `SpendGate.authorize` for that monthly amount, and runs only on `ok`. After the vendor answers it calls `settle` with the price the
  vendor reports (`server.monthly`), which may differ from the quote. If the vendor fails, `settle` is called with amount 0 so the ticket closes with nothing spent.
- **Resize** is a purchase only for the rise: the gate is asked for `new - old`. A fall or no change does not ask.
- **Destroy** calls `holdsData`. A server that holds data asks `DestroyGuard.confirm` (a grant, else the passkey); a refusal stops it. A server that does not, or is already gone, goes
  without asking. If `holdsData` fails for any reason other than `not-found`, nothing is destroyed.
- A port that cannot decide (rejects) is a refusal (`host-unavailable`). A purchase is never retried by the guard.
- A `settle` that fails after the server exists does not turn into an error (a retry would buy a second server); the audit entry carries `settleError`.
- One audit entry per create, resize and destroy, refused or not: `{at, op, provider, accountId, target, result, code?, allowedBy?, amount?, currency?, settleError?, summary}`.
  Every string in it passes through the redactor.
- Every thrown error is rebuilt by the redactor: message, stack and the whole chain of causes lose the resolved token (also percent-encoded, base64, base64url and JSON-escaped), and any
  other property the SDK hung on the error (headers, response body) is dropped.

## What the ports need from the core

The core has no channel through which an external client can ask "may I spend X?" and later record the spend. Existing: `budget:get`, `budget:ledger`, `budget:set`, `autonomy:*`,
`accounts:*`. The internals exist (`checkSpend`, `authorizeSpend`, `recordSpend`, `assertAccount`, `requireSensitive`), so the change is to expose them.

### Recommended: `effects:request` and `effects:settle`

Chosen over `budget:authorize-spend` / `budget:record-spend` because the decision is the same for every external effect (`spend` now, the destroy next, `dns`/`deploy`/`email` later): one
request, one grant lookup (`authorize(kind)`), one ticket. The `budget:` pair would be spend-only and would need a second pair for the destroy.

#### `effects:request`

Args (one object):

| Field | Type | Notes |
|---|---|---|
| `requestId` | string, `[A-Za-z0-9_-]{8,64}` | Idempotency key chosen by the client. The same id with the same args returns the same answer; with other args it is `conflict`. |
| `kind` | `EffectKind` | `spend` for a purchase; `destroy` for destroying a server that holds data (a new member of `EFFECT_KINDS`; `stepUpOfEffect('destroy')` is `infrastructure`; its grant `threshold` is a count per hour like the other non-amount kinds). |
| `accountId` | string | An id in the account registry. |
| `summary` | string, up to 200 | Shown to the person and written to the ledger and audit. No credential. |
| `amount` | number, finite, >= 0 | Required for `spend`. In the budget's currency. |
| `currency` | string | Required with `amount`. Must equal the budget's currency. |
| `category` | string | Default `infrastructure`. |
| `recurrence` | `once` \| `monthly` \| `yearly` | Default `once`. A server is `monthly`. |
| `target` | string | Optional, up to 120: what the effect acts on (server id). |

Result:

```ts
| { state: 'allowed'; allowedBy: 'person' | `grant:${string}`; ticket: string; expiresAt: string }
| { state: 'pending'; proposalId: string }   // the person has been asked; call again with the same requestId
```

Behaviour: `spend` first runs `checkSpend({category, amount}, {audit: true})`, so the budget refuses before anyone is asked (a person's "yes" does not override a limit; `budget:set` does).
Then `authorizeSpend` (grant, with its threshold) or, with no grant, a proposal for the person. `destroy` uses `authorize('destroy')` or a proposal that needs a fresh passkey assertion of
kind `infrastructure`. `ticket` is single-use and bound to the args. The port adapter polls `effects:request` with the same `requestId` while the state is `pending`, up to its own timeout,
and turns a timeout into a `forbidden` refusal.

Errors: `budget-exceeded` (message with the limit and what is left; the `scope` goes in the audit), `forbidden` (unknown account, the person said no, the proposal expired, or the caller is a
paired browser or the persona), `passkey-required` (kind `destroy`, no grant, and no passkey device enrolled to ask), `invalid-input` (bad field, currency not the budget's, negative amount),
`conflict` (`requestId` reused with other args), `not-owner` (as every channel when the lease is lost), `internal`.

#### `effects:settle`

Args: `{ ticket: string, actual: { amount: number, currency: string, kind?: 'estimated' | 'reconciled', reference?: string } }`. `kind` defaults to `estimated` (a list price at purchase is not a
charge; a later reconciliation replaces it through the ledger's `reconciles`). `reference` is the vendor's id for the thing, never a credential.

Result: `{ entryId: string | null, overrun: boolean }`. `entryId` is the ledger line made by `recordSpend` (`category`, `vendor` = the account's provider, `recurrence`, `reason` = the request's
`summary`, `allowedBy` from the ticket); `null` when `amount` is 0, which only closes the ticket (the purchase failed, or a destroy finished) and writes an audit line. `overrun` is true when
`amount` is above what was requested: it is recorded anyway, because the money is spent, and audited as an overrun; settle never refuses for that.

Errors: `not-found` (unknown or expired ticket), `conflict` (already settled), `invalid-input` (negative or non-finite amount, currency not the budget's), `forbidden` (caller not allowed), `internal`.

Both channels: desktop and local admin socket only; denied to a paired browser and to the persona; listed in `CHANNELS`; the result types in `src/shared`.

### Also needed: `accounts:assert`

Args: `{ provider: string }`. Result: `{ id: string, provider: string, secretRefs: string[] }`, the registered account (`assertAccount`, case-insensitive). Error: `forbidden` when there is none.
`accounts:list` would work but carries every account and the resolve state of every reference.

### Not a channel: the secret value

`SecretResolver` must not be a channel: the core's rule is that only `resolve()` in its own process returns a value. coxia-provision runs next to the core and reads the same store
(`secrets.json`, 0600) through a local reader, or gets the token in its environment from the supervisor. That is for the maintainer to decide when the first adapter lands; the ports do not
change either way.

## Mapping the ports

| Port | Calls |
|---|---|
| `AccountCheck.assert` | `accounts:assert` |
| `SpendGate.authorize` | `effects:request` with `kind: 'spend'`, polling while `pending`; error codes become the refusal's `code` |
| `SpendGate.settle` | `effects:settle` |
| `DestroyGuard.confirm` | `effects:request` with `kind: 'destroy'` |
| `DestroyGuard.close` | `effects:settle` with `amount: 0` |
| `AuditSink` | coxia-provision's own log; the core audits its side in `effects:*` |

## Writing an adapter

1. Implement `VpsProvider` and declare `capabilities`; take a `SecretResolver` and a reference, never a token.
2. Map every vendor failure to a `ProviderError` code; do not copy a vendor message that can echo a header.
3. `holdsData` answers `true` when the vendor cannot say.
4. Add a test file that calls `runProviderContract('<vendor>', factory)` against a local fake of the vendor's API (no network beyond 127.0.0.1), with a `rejected` subject built from a bad
   credential. `failNext` is optional and, when given, also checks every error code for leaks (`failCodes` lists the codes it can produce). The contract adapts to the capabilities.
