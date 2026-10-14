# Hostinger VPS adapter

`src/hostinger/provider.ts` (`createHostingerProvider`) and `src/hostinger/http.ts`. The chosen plan is **KVM 2**; the adapter is not tied to it (`size` is the catalog item id of any
VPS plan).

Hostinger is a purchase API, not a cloud API. Creating a server buys a subscription paid up front for a term; the API has no delete and no resize. The adapter says so through its
capabilities and fails with `unsupported` where the vendor cannot do what the interface names (`docs/provider-interface.md`).

## Source of the facts

Everything below was read from the official OpenAPI document, not from the research summary: `https://developers.hostinger.com/openapi/openapi.json`, `info.version` **1.64.0**
(`Last-Modified` 2026-10-12), fetched **2026-10-14**. Server URL `https://developers.hostinger.com`. Auth is HTTP bearer. Where the document is silent or unclear, this page says
**ambiguous** and the adapter takes the cautious reading.

## Endpoints used

| Use | Call | Fields read or sent |
|---|---|---|
| Plans and prices | `GET /api/billing/v1/catalog?category=VPS` | per item `id`, `name`, `metadata` (free-form); per price `id`, `currency`, `price` and `first_period_price` (cents), `period`, `period_unit` (`day`/`week`/`month`/`year`/`none`) |
| Regions | `GET /api/vps/v1/data-centers` | `id` (integer), `city`, `location`, `name` |
| Images | `GET /api/vps/v1/templates` | `id` (integer), `name` |
| Script upload | `POST /api/vps/v1/post-install-scripts` | sends `name`, `content`; reads `id` |
| Script cleanup | `DELETE /api/vps/v1/post-install-scripts/{id}` | after a purchase that surely did not happen |
| **Purchase** | `POST /api/vps/v1/virtual-machines` | sends `item_id` (the catalog **price** id), `setup.{template_id, data_center_id, hostname, post_install_script_id, install_monarx:false, enable_backups:false, public_key:{name,key}}`; `200` gives `order` and `virtual_machine`, `202` gives `{id, subscription_id, status:"payment_initiated", message}` |
| Servers | `GET /api/vps/v1/virtual-machines`, `GET .../{id}` | `id`, `subscription_id`, `data_center_id`, `plan`, `hostname`, `state`, `ipv4[].address`, `template.name`, `created_at` |
| Subscriptions | `GET /api/billing/v1/subscriptions` | `id`, `name`, `status`, `billing_period`, `billing_period_unit`, `currency_code`, `total_price`, `renewal_price` (cents), `is_auto_renewed`, `created_at`, `expires_at`, `next_billing_at` |
| **End of term** | `DELETE /api/billing/v1/subscriptions/{id}/auto-renewal/disable` | the subscription then runs to `expires_at` |

Rate limit: 90 requests a minute (overview), `429` with `Retry-After`, and `RateLimit` headers. Errors carry `message` and `correlation_id` (the overview says `error`; the adapter reads
either).

## Capabilities

```ts
{ destroy: 'end-of-term', resize: false, bootstrap: 'script', billing: 'subscriptions', snapshots: 1, labels: false }
```

| Capability | Why |
|---|---|
| `destroy: 'end-of-term'` | No endpoint deletes or cancels a VPS. The only way out is auto-renewal off; `recreate` reinstalls and wipes the machine and is not used. |
| `resize: false` | No resize endpoint. `resizeServer` throws `unsupported` without a request. |
| `bootstrap: 'script'` | No cloud-init. A post-install script (at most 48 KB) runs once as `/post_install`, its output in `/post_install.log`. A `cloud-init` bootstrap is `invalid-input`. |
| `billing: 'subscriptions'` | No invoice, balance or usage endpoint. `billing()` lists subscriptions, every item and the total `estimated`. |
| `snapshots: 1` | One snapshot per VM (creating one overwrites it). Declared only; the adapter does not call the snapshot endpoints yet. |
| `labels: false` | A VM has no tags. Non-empty `labels` on create are `invalid-input`. |

## How the interface maps

- **`createServer` is a purchase.** `size` is a catalog item id (`hostingercom-vps-kvm2` is the id the document gives as its example), `region` a data center id, `image` a template id
  or its exact name (case-insensitive), `name` the hostname. Exactly one SSH key (the purchase takes one inline `public_key`; more is `invalid-input`, not a partial setup). Everything the
  adapter can know is checked and read before the first write: name, key, labels, bootstrap kind, the 48 KB limit, plan, region, template.
- **Price.** `priceOf` returns `{amount, currency, upfront, termMonths}`. The term is the provider option `termMonths` (default: the shortest the catalog offers for the plan) and the
  currency the option `currency` (default USD if offered). `amount` is the **renewal** price per month (`price` / months), what a budget must assume after the first term; `upfront` is
  `first_period_price`, what the purchase charges now and what the spend gate is asked for (recurrence `once`). A promotional first period therefore shows as `upfront` below one term of
  `amount`. Periods in days or weeks are not offered. **Ambiguous:** the document says `price` is "in cents" and gives a one-month example; whether it is per period or per month for a
  12-month item is not stated. The adapter reads it per period.
- **What the order really charged.** On `200` the server's `upfront` is the order `total` (VAT included) in the order's currency, which may differ from the catalog's `first_period_price`.
- **`202` / payment pending.** Not an error: a server in `pending-payment` with id `pending:<subscription id>`, no machine, nothing set up. The person finishes the setup in the panel
  (`POST .../{id}/setup` exists for a machine in the `initial` state and is not used). `getServer` on that id follows the subscription to the machine once it exists. `listServers` lists
  machines only, so a pending purchase is not in it. The uploaded script is kept for the panel setup.
- **Unknown outcome.** The purchase body has **no client reference or idempotency field**, and no idempotency header is documented. So the purchase is sent once and never retried
  (not on a 5xx, a timeout, a dropped connection or a `429`). After an unknown outcome the error says the order may have gone through and to look for the hostname in the panel before
  buying again, and the script is kept. After a definite refusal (`401`, `422`, `429`) the uploaded script is deleted.
- **Defaults turned off.** `install_monarx` and `enable_backups` are sent as `false`; the document defaults backups to `true` and does not say whether they are charged.
- **`holdsData`.** No detachable volumes, so a machine that exists holds data. `false` only for state `initial` (bought, never set up) and for a pending payment (no machine). `creating`
  counts as holding data: a post-install script may already be writing. Anything else, `true`.
- **`getServer` / `destroyServer` on a missing machine.** The document lists only `200`, `401` and `500` for `GET .../virtual-machines/{id}`; the adapter assumes `404` for a missing
  one, as the rest of the API does. **Unverified.**
- **Server fields.** `region` is the data center id, `size` the catalog item whose name equals the VM's `plan` (else the plan name), `monthly` the subscription's `renewal_price` per month
  (else the catalog's), `endsAt` the subscription's `expires_at` once renewal is off.
- **Plan specs.** `metadata` of a catalog item is "free-form"; its keys are not in the document. The adapter reads `cpus`/`vcpus`, `memory`/`ram`, `disk`/`storage` if present and else falls
  back to the advertised KVM 1/2/4/8 sizes. **Unverified against a real catalog.** Memory and disk units are not stated either (the VM resource says megabytes).
- **Billing.** Items are the subscriptions of the account's servers (not domains or hosting) in the adapter's currency, overlapping the period, `amount` = `total_price`, from
  `created_at` to `expires_at` (else `next_billing_at`, else created plus the term), `estimated: true`. It is the list price, not an invoice. **Ambiguous:** `total_price` is "total price in
  cents" with no statement of what it covers; the adapter reads it as the amount paid for the term. Renewals that happened are not shown.

## HTTP behaviour

One small client over `fetch` (`src/hostinger/http.ts`), with injectable base URL and `fetch`.

- The token is read through the secret resolver on every request and kept nowhere. Redirects are never followed with it.
- `GET` and the auto-renewal `DELETE` (idempotent): `429` is retried up to 3 times after `Retry-After` (seconds or a date; without it 1, 2, 4 s; a wait over 30 s is not taken, the call fails
  `rate-limited` with `retryAfterSec`); a 5xx or a dropped connection is retried once. Every other call is sent once.
- Reads run one after the other, not in parallel: 90 a minute is a tight budget and a failure then belongs to one request. A `createServer` costs 5 requests (catalog, data centers, templates, script, purchase), a `listServers` 3.
- Status to code: `401`/`403` unauthorized, `404` not-found, `400`/`422` invalid-input, `429` rate-limited, everything else (including `409`, which the document says may carry
  `Retry-After`) provider-unavailable. There is no `quota` mapping: the document has no status for a limit. A `403` is read as a token without the permission; the document does not list it for
  these calls.
- An error message is the call, the status, the vendor's `message` cut to 200 characters and the `correlation_id`, passed through the redactor with the token. The guard redacts again.

## Manual steps for the person

1. Open a Hostinger account and add a **payment method in the panel** (hPanel). The API cannot add one, and the purchase charges the account's **default** one (no `payment_method_id` is
   sent). Pix on the Brazilian site has no automatic renewal.
2. Create an API token in the panel (Account, API). A token has the permissions of its owner and may expire. Put it in the Coxia secrets store and register the Hostinger account with that
   reference.
3. Expect to finish the setup in the panel when a purchase answers `202`.
4. Know that **auto-renewal is on** after a purchase. Renewal is a later charge made by Hostinger, outside the spend gate. Coxia does not turn it off at purchase; whether it should is a
   decision for the maintainer.

## How Coxia ends a server

`destroyServer` is "end at the term", and the guard says so in its summary and audit text. It turns auto-renewal off; the machine keeps running, billed and holding its data, until the
subscription's `expires_at`, which `Server.endsAt` then reports. It is idempotent (a subscription already not renewing sends nothing; a machine that is gone resolves). The guard still
treats it as a destroy: a server that holds data needs the grant or the passkey first.

What it cannot do: free the money (a refund is a matter for Hostinger support; the research found a 30-day guarantee, not read in full), stop the machine early, or wipe it. To wipe a
machine now, `recreate` exists in the API and the panel; the adapter does not call it because it destroys data without ending the subscription.

## Tests

`test/hostinger-server.ts` is a fake of the API on 127.0.0.1 with the shapes of 1.64.0 (made-up ids and prices). `test/hostinger-contract.test.ts` runs the shared contract against it, with the
capability-aware checks. `test/hostinger.test.ts` covers the purchase with a script, the 48 KB limit, a pending payment, end of term, the `429` retry, no retry of a purchase, an unauthorized
token and a token echoed by the server. `test/hostinger-http.test.ts` covers the client. None reaches beyond 127.0.0.1.

## Not verified

No request was made to the live API (it needs a token); the shapes are those of the document. Open: a real catalog's `metadata` keys and price semantics for long terms; the status of a
missing machine; what `total_price` covers; whether the default backups are charged; the post-install limit in bytes; the order of a `202` followed by the machine appearing; which `state`
a machine bought in the panel shows during setup.
