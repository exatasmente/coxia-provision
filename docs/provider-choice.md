# Choosing the first VPS provider and the uptime monitor

Status: research for issue #1. Every source below was read on **2026-10-13**
(that is its access date unless a line says otherwise).

**No account was opened, no server was created and no money was spent.** The
research used public documentation, public price lists and unauthenticated
public API endpoints only. The recommendation is a proposal; the person decides.

A second pass on the same day added Hostinger VPS and re-checked DigitalOcean after
the person pointed out that both are cheaper than the first recommendation.

Anything marked **unverified** could not be confirmed from an official source in
this pass and must be checked before the adapter relies on it.

## What the machine has to do

Coxia moves itself to a VPS that it buys and manages through the provider's API.
The person opens the provider account; Coxia acts inside it. The VPS runs:

- the Node core;
- the agent runner (git, a bwrap sandbox, builds and test runs);
- the Python voice sidecar, faster-whisper `small` or `medium` on the CPU.

The person speaks Brazilian Portuguese and lives in Brazil.

### Target size: 4 vCPU / 8 GB RAM / about 80 GB disk

This is an estimate, not a benchmark; nothing was measured.

- Core: a few hundred MB of resident memory.
- Voice: `small` int8 needs roughly 1 GB, `medium` int8 roughly 2 to 3 GB
  (unverified figures, from the usual faster-whisper model sizes). Transcription
  is CPU-bound, so extra vCPUs shorten latency almost linearly.
- Runner: a checkout, `npm install`, a type-check and a test run inside bwrap
  easily peak at 2 to 3 GB and want two or more cores.
- The three do not peak together, but they can overlap (a person talks while a
  run builds). 8 GB leaves headroom for the page cache and a swap-free kernel;
  4 GB would be tight with `medium`.
- A floor of 2 vCPU / 4 GB can serve `small` only. Because the adapter must
  support resize, starting at the floor and growing is a valid strategy, but the
  comparison below prices the 4 / 8 target.

## Criteria

1. API to create a server with an SSH key and cloud-init, and to list, resize and
   destroy servers.
2. Billing API, to reconcile real spend against Coxia's budget.
3. Spending cap or alert on the provider side.
4. Price of the target size.
5. Region near the person (South America, ideally Sao Paulo).
6. Payment that is simple from Brazil: international card, Pix or boleto.
7. Partner or reseller API so accounts and resources can be created by program.

For the monitor:

1. Checks run from outside the provider.
2. Alerts by email.
3. An API to create checks.
4. A free or cheap tier.

## Providers compared

Prices are monthly, 730 h, before tax, for the closest 4 vCPU / 8 GB plan, in the
Sao Paulo region where one exists.

| | Akamai / Linode | Magalu Cloud | Vultr | Hetzner Cloud | DigitalOcean | AWS Lightsail | Oracle Cloud | Hostinger VPS |
|---|---|---|---|---|---|---|---|---|
| South America region | `br-gru` Sao Paulo (verified) | `br-se1` Sudeste and `br-ne1` Nordeste, both in Brazil (verified) | `sao` Sao Paulo and `scl` Santiago (verified) | None (verified) | None in South America (verified); nearest NYC, ATL, TOR; latency to Brazil **unmeasured** | Sao Paulo `sa-east-1` (verified, announced 2026-06-12) | Sao Paulo and Vinhedo (second-hand; unverified on Oracle's own region page) | Brazil listed for VPS on the support page (verified there; the older page text and the 2022 launch post agree). The data-center list in the API needs a token, so availability at checkout is **unverified**. Location is fixed after setup |
| Target size and price | `g6-standard-4`, 4 vCPU shared, 8 GB, 160 GB: **US$ 67.20** in `br-gru` (US$ 48.00 elsewhere); dedicated `g6-dedicated-4` US$ 100.80 | `BV` 4 vCPU shared / 8 GB / 40 GB: **R$ 169.99**; `DP` dedicated 4 / 8 / 40: R$ 563.00 (prices valid 2026-10-02, taxes included) | `vhp-4c-8gb-amd` 4 / 8 / 180 GB: list price **US$ 48.00**; `vc2-4c-8gb` US$ 40.00; Sao Paulo price **unverified** (a third-party tracker shows about US$ 72) | n/a in South America. For reference, 4 vCPU / 8 GB is the CPX32 class at roughly EUR 35 (secondary sources disagree; unverified) | `s-4vcpu-8gb` basic **US$ 48.00**, 4 vCPU shared, 8 GB, 160 GB (no Sao Paulo); 2 vCPU / 4 GB US$ 24.00; General Purpose (dedicated) 2 vCPU / 8 GB US$ 63.00, 4 / 16 US$ 126.00; Premium Intel and AMD Basic prices **unverified** (third-party listings show US$ 32 and US$ 28 for 2 / 4) | No 4 vCPU at 8 GB. 2 vCPU / 8 GB is US$ 44; 4 vCPU / 16 GB is US$ 84 (as listed; Sao Paulo price unverified) | E4 flex: 2 OCPU (= 4 vCPU) + 8 GB = about **US$ 45** by the public price list, plus boot volume; regional price unverified | No 4 / 8 plan. KVM 2: 2 vCPU / 8 GB / 100 GB NVMe, promo **R$ 43,99** or US$ 8.99 per month, renewal R$ 77,99 or US$ 14.99. KVM 4: 4 vCPU / 16 GB / 200 GB, promo R$ 59,99 or US$ 12.99, renewal R$ 149,99 or US$ 28.99. Paid in full up front; price per term **unverified** (see notes) |
| Create with SSH key and cloud-init | `POST /v4/linode/instances`, `authorized_keys` and `metadata.user_data` (base64 cloud-config), needs the Metadata capability (listed for `br-gru`) | `POST /v1/instances`, `ssh_key_name`, `user_data` (base64) | `POST /v2/instances`, `sshkey_id`, `user_data` (base64); from Vultr's public docs, not re-read from the API reference (blocked) | `POST /v1/servers`, `ssh_keys`, `user_data` (cloud-init, 32 KiB) | `POST /v2/droplets`, `ssh_keys`, `user_data` | `CreateInstances`, `keyPairName`, `userData` (a launch script; cloud-init not named in the official page) | Yes via instance metadata `user_data` and `ssh_authorized_keys`; unverified in this pass | `POST /api/vps/v1/virtual-machines` buys and sets up in one call: `item_id`, `setup.public_key` `{name, key}`, `setup.post_install_script_id` (a shell script, 48 KB, not cloud-init). `202` means payment pending and setup must be finished in the panel |
| Resize | `POST .../resize` (cold, disk must fit) | `POST .../retype` (cold; disk can only grow) | Plan upgrade through the instance update; upgrade only; unverified in detail | `change_type` (server off; disk can only grow) | `resize` action (disk resize is one-way) | No in-place resize: snapshot, then create a bigger instance | Shape change on the instance; unverified in detail | None in the API (spec 1.64.0). `recreate` reinstalls and wipes the VM |
| Billing API | `GET /v4/account`, `/account/invoices`, `/account/payments`, `/account/transfer`; `balance_uninvoiced` is the live estimate | Consumption API in FOCUS v1.0, daily, D-1; price-list API | `GET /v2/billing/history`, `/billing/pending-charges`, `/billing/invoices/{id}`, `GET /v2/account` (second-hand search summary) | **None** in the API spec (verified); usage is in the console, invoices at the account site | `GET /v2/customers/my/balance`, `/billing_history`, `/invoices`, `/billing/{urn}/insights/{start}/{end}` (verified) | Through AWS Cost Explorer and Budgets, account level, not per Lightsail | Usage API and Budgets API (unverified detail) | `GET /api/billing/v1/catalog`, `/subscriptions`, `/payment-methods`, `POST /orders`; no invoice, usage or balance endpoint. Adding a payment method is panel only |
| Spending cap or alert | No cap. No billing alert found (unverified). | None found in docs (unverified) | Account limits: maximum instances and maximum instance cost, raised on request (verified in docs); no alert found | Console cost alerts by email; "a convenience feature rather than a spending limit" (verified); API for them not found | Spend alerts by email at percentage thresholds, per product or team (verified); no cap; no API for them found (unverified) | AWS Budgets alerts and actions; no hard cap (unverified) | Budgets with actual and forecast email alerts, "soft limits" (verified); no cap | None found (unverified) |
| Payment from Brazil | Cards (Visa, Mastercard, Amex, UnionPay), Google Pay, PayPal; wire by support; no Pix or boleto found | Credit card is required to activate (Visa, Mastercard, Elo; **international cards not accepted**); Pix and boleto on request through support; prices and invoices in BRL | Cards, PayPal, crypto, Alipay, UnionPay; no Pix or boleto found | Not confirmed in this pass (unverified); no Pix or boleto found | Cards, PayPal, Google Pay, Apple Pay, bank account, crypto wallet; no Pix or boleto (billing page does not mention them) | Cards; Pix only as a fallback for Brazil-entity customers whose card payment failed (verified) | Not confirmed (unverified) | Pix on the Brazilian site only, **no automatic renewal** with Pix; card installments up to 12x; boleto for paying Hostinger not confirmed; whether Pix works for a VPS order is unconfirmed |
| Partner or reseller API | Parent and child accounts: `GET /v4/account/child-accounts`, `POST .../token` (proxy user token) (verified) | None found (unverified) | Not found in this pass (unverified) | None found | Not found in this pass (unverified) | AWS Organizations can create accounts by program; not examined (unverified) | Not examined | None found |
| Destroy by API | `DELETE /v4/linode/instances/{id}` | `DELETE` on the instance | Instance delete (second-hand) | `DELETE /servers/{id}` | `DELETE /v2/droplets/{id}` | `DeleteInstance` | Terminate (unverified) | **No endpoint.** Only auto-renewal off (`DELETE .../auto-renewal/disable`); the subscription then runs to `expires_at`. A cancel request schema exists in the spec with no route (unverified) |
| CPU model | Shared (dedicated at US$ 100.80) | Shared `BV`, dedicated `DP` | Shared or high-performance | Shared | Basic is shared ("bursty"); General Purpose is dedicated | Burstable | Flex shapes | **Credit-based throttling** (notes) |

### Per-option notes

#### Akamai / Linode

- Verified from the live public API: `GET https://api.linode.com/v4/regions` lists
  `br-gru` "Sao Paulo, BR" with Linodes, Backups, Block Storage, Metadata, VPC and
  Cloud Firewall; `GET /v4/linode/types` shows `g6-standard-4` at US$ 0.072/h and
  US$ 48/month globally, US$ 0.101/h and US$ 67.20/month in `br-gru`. The Sao
  Paulo uplift is 40 percent. The 2 vCPU / 4 GB type is US$ 33.60 there.
- Verified from the OpenAPI document
  (`github.com/linode/linode-api-docs`, `openapi.json`, version 4.215.0): create
  requires only `type` and `region`; `metadata.user_data` is "Base64-encoded
  cloud-config data", write-only, set at creation only. The billing paths exist.
  Resize requires that the account have no outstanding balance.
- Rate limit, from the Akamai rate-limit page: 1600 requests per minute for most
  operations and 200 per minute for paginated GET collections, per token, `429`
  when exceeded.
- Billing: invoices are issued after month end; hourly usage is capped at the
  monthly price; powered-off services still accrue charges (billing page).
- Payment: the payment-methods page lists cards, Google Pay and PayPal. Wire,
  check or ACH by contacting support.
- Partner: the "Parent and child accounts for Akamai partners" feature is real in
  the API (child accounts and a proxy token). Eligibility terms were **not read**.
- Sources: <https://api.linode.com/v4/regions>, <https://api.linode.com/v4/linode/types>,
  <https://raw.githubusercontent.com/linode/linode-api-docs/development/openapi.json>,
  <https://techdocs.akamai.com/linode-api/reference/rate-limits>,
  <https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works>,
  <https://techdocs.akamai.com/cloud-computing/docs/manage-payment-methods>
  (all 2026-10-13).

#### Magalu Cloud

- Verified: two Brazilian regions `br-se1` and `br-ne1`; REST API per region
  (`https://api.magalu.cloud/br-se1/compute`); auth by API key in the `x-api-key`
  header; create takes `name`, `machine_type`, `image`, `ssh_key_name`,
  `availability_zone`, `network` and base64 `user_data`; there are list, get,
  delete, start, stop, reboot, rename, `retype` and snapshot operations.
- Price, from the official price page (valid 2026-10-02, BRL, taxes included):
  the shared-CPU `BV` 4 vCPU / 8 GB / 40 GB is R$ 169.99 per 730 h; the dedicated
  `DP` 4 / 8 / 40 is R$ 563.00. Billing is per second. Stopped instances are not
  charged at present; public IPs and instance snapshots are not charged at
  present, but the page warns this can change at any time.
- Billing API: the FinOps section states daily FOCUS v1.0 data through the
  Consumption API (D-1) and a price-list API. The exact endpoint paths of the
  Consumption API were **not read**.
- Payment: BRL with no exchange variation. Card is required; Visa, Mastercard,
  Elo; international cards are refused. Pix and boleto exist but are enabled by
  support or sales on request. For a person with a Brazilian card this is the
  simplest payment of all options; for an international user it is a blocker.
- Resize: allowed with downtime; vCPU and RAM can go up or down, disk can only
  stay or grow.
- Unverified: rate limits, any spending alert or cap, a partner API, how
  "data held" is exposed (block-storage volumes and backups are separate
  resources per the overview page), and the quota process for new accounts.
- Sources: <https://docs.magalu.cloud/docs/computing/virtual-machine/instance-types-and-pricing/pricing>,
  <https://docs.magalu.cloud/docs/devops-tools/apis/virtual-machines>,
  <https://docs.magalu.cloud/docs/devops-tools/apis/auth>,
  <https://docs.magalu.cloud/docs/computing/virtual-machine/how-to/manage-instances/resize-instance>,
  <https://docs.magalu.cloud/docs/finops/bss/overview>,
  <https://docs.magalu.cloud/docs/finops/bss/charge/payment-methods>,
  <https://docs.magalu.cloud/docs/finops/bss/billing-info/focus-invoice>,
  <https://docs.magalu.cloud/docs/infrastructure/regions-and-zones/overview> (2026-10-13).

#### Vultr

- Verified from the public API: `GET https://api.vultr.com/v2/regions` includes
  `sao` (Sao Paulo) and `scl` (Santiago). `GET /v2/plans` lists `vc2-4c-8gb` at
  US$ 40, `vhp-4c-8gb-amd` and `vhp-4c-8gb-intel` at US$ 48, and CPU-optimized 4 / 8
  at US$ 80 to 90, all available in `sao`. The plans endpoint carries one price;
  whether Sao Paulo costs more is **unverified** (a third-party tracker shows
  about US$ 72 for the 4 / 8 high-performance plan).
- The official API reference pages blocked the fetch tool (HTTP 403). Endpoint
  facts for billing and rate limit come from search summaries of
  `vultr.com/api` and `docs.vultr.com`: 30 requests per second per IP, `429` with
  `Retry-After`; billing endpoints `/v2/billing/history`, `/billing/pending-charges`,
  `/billing/invoices/{id}`.
- Verified in docs: "Account limits" define maximum instances and maximum instance
  cost, changed by request. That is the closest thing to a provider-side cap
  among the options, but it is a support flow, not an API.
- Payment: Visa, Mastercard, Amex, Discover, JCB, crypto through a processor,
  Alipay, UnionPay, PayPal (billing FAQ). No Pix or boleto.
- Sources: <https://api.vultr.com/v2/regions>, <https://api.vultr.com/v2/plans>,
  <https://docs.vultr.com/platform/billing/manage-account-limits>,
  <https://docs.vultr.com/platform/billing/faq> (2026-10-13).

#### Hetzner Cloud

- Strongest API and the simplest to write against, but **no South America
  region**: locations are Falkenstein, Nuremberg, Helsinki, Ashburn, Hillsboro and
  Singapore (docs list and search, 2026-10-13). The nearest is Ashburn.
- Verified from `https://docs.hetzner.cloud/cloud.spec.json`: base URL
  `https://api.hetzner.cloud/v1`, bearer token; `POST /servers` with `user_data`
  ("Cloud-Init user data", 32 KiB), `ssh_keys`, `location`, `server_type`;
  `POST /servers/{id}/actions/change_type` (server must be off; `upgrade_disk`
  false keeps it reversible); `change_protection`; `GET /pricing`. Default limit
  3600 requests per hour per project, with `RateLimit-*` headers.
- **No billing, invoice or usage endpoint exists in the spec.** Cost alerts exist
  only in the console, by email, and are "not a spending limit". Reconcile by
  summing `GET /servers` prices from `GET /pricing`.
- Stopped servers are still billed.
- Payment methods could not be confirmed in this pass (unverified).
- Sources: <https://docs.hetzner.cloud/cloud.spec.json>,
  <https://docs.hetzner.com/cloud/billing/faq/>,
  <https://docs.hetzner.com/cloud/servers/faq/>,
  <https://docs.hetzner.com/cloud/general/locations/> (2026-10-13).

#### DigitalOcean

Re-checked in the second pass. It is cheaper than the first recommendation
(US$ 48.00 against US$ 67.20, 28.6 percent less) and its only weakness is the lack
of a South American region.

- **Prices** (pricing page, 2026-10-13): Basic 2 vCPU / 4 GB / 80 GB US$ 24.00 (US$ 0.03571
  per hour); Basic 4 vCPU / 8 GB / 160 GB US$ 48.00 (US$ 0.07143 per hour, 5,000 GiB
  transfer). General Purpose (dedicated CPU) has no 4 / 8: 2 vCPU / 8 GB is US$ 63.00
  with only 25 GB of disk, and 4 vCPU starts at 16 GB for US$ 126.00. The page shows one
  Basic table without naming the CPU tab; the **Premium Intel and Premium AMD Basic
  prices were not shown** (third-party listings give US$ 28 and US$ 32 for 2 / 4; unverified).
  Billing is per second with a 672 h monthly cap; a powered-off Droplet is still billed.
  Basic is shared CPU, described as "ideal for bursty applications"; Premium CPUs are
  Intel or AMD of the latest two generations with NVMe.
- **Regions:** 13 regions, none in South America (regional availability page): NYC1-3,
  SFO2-3, AMS3, SGP1, LON1, FRA1, TOR1, BLR1, SYD1, ATL1, RIC1, MKC1, MEM1. A third-party
  guide claims a Sao Paulo datacenter; the official page contradicts it, so it is ignored.
  **No latency measurement exists**: the only figures found are generic estimates
  (20 to 40 ms added for US traffic through Sao Paulo, unverified). Geography suggests
  NYC1, ATL1 or RIC1 as the closest; measure before choosing.
- **Billing API** (verified, scope `billing:read`): `GET /v2/customers/my/balance` returns
  `account_balance`, `month_to_date_usage`, `month_to_date_balance` and `generated_at`
  (strings, USD); `/billing_history`, `/invoices`, `/invoices/{uuid}` (also `/csv`,
  `/pdf`, `/summary`) and `/v2/billing/{urn}/insights/{start}/{end}`.
- **Alerts:** spend alerts are e-mail only, at percentages of a monthly budget, once per
  threshold per cycle, sent within an hour. The page says it "is not a spending cap".
  The billing API has no alert endpoint and the alert page names no API, so setting
  them by API is **unverified and probably absent**. The `/v2/insights/alert-rules`
  endpoints are for resource metrics, not spend. If a payment fails, provisioning is
  restricted until it is resolved.
- **API:** `POST /v2/droplets` (`ssh_keys`, `user_data`), `DELETE /v2/droplets/{id}`,
  `GET /v2/droplets`, droplet actions for resize, `/v2/account/keys`, backups and
  snapshots paths exist in the OpenAPI document (paths read; request fields carried over
  from the first pass). Rate limit: 5,000 requests per hour and 250 per minute per
  token (official docs per a search result, page not re-read).
- **Payment:** cards, PayPal, Google Pay, Apple Pay, bank account, crypto wallet. No Pix or
  boleto. Brazilian tax handling is not described on the billing page (unverified).
- Sources: <https://www.digitalocean.com/pricing/droplets>,
  <https://docs.digitalocean.com/products/droplets/details/features/>,
  <https://docs.digitalocean.com/products/droplets/details/pricing/>,
  <https://docs.digitalocean.com/platform/regional-availability/>,
  <https://docs.digitalocean.com/platform/billing/>,
  <https://docs.digitalocean.com/platform/billing/spend-alerts/>,
  <https://docs.digitalocean.com/reference/api/reference/billing/>,
  <https://docs.digitalocean.com/reference/api/intro/>,
  <https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml>
  (2026-10-13).

#### Hostinger VPS

Cheapest on paper by a wide margin, but it fails a hard criterion (no destroy by API)
and its CPU model is a risk for faster-whisper.

- **Plans** (Brazilian and US pages, 2026-10-13). Only four KVM plans are listed, no others:

  | Plan | vCPU / RAM / NVMe | Promo per month | Renewal per month |
  |---|---|---|---|
  | KVM 1 | 1 / 4 GB / 50 GB | R$ 29,99 (US$ 6.49) | R$ 59,99 (US$ 11.99) |
  | KVM 2 | 2 / 8 GB / 100 GB | R$ 43,99 (US$ 8.99) | R$ 77,99 (US$ 14.99) |
  | KVM 4 | 4 / 16 GB / 200 GB | R$ 59,99 (US$ 12.99) | R$ 149,99 (US$ 28.99) |
  | KVM 8 | 8 / 32 GB / 400 GB | R$ 119,99 (US$ 25.99) | R$ 259,99 (US$ 49.99) |

  There is no 4 vCPU / 8 GB plan. KVM 2 (2 / 8) is the nearest in RAM and CPU-light
  work; KVM 4 (4 / 16) has the cores and twice the RAM. Third-party BRL figures for KVM 2
  differ (R$ 32,99, 35,09, 38,99), so the BRL numbers move with promotions and exchange.
- **Term:** the pages say every plan is "paid in full" and the monthly figure is the total
  divided by the months contracted, and that the renewal price "applies for 2 years".
  They do **not** say which term the promo needs or give a price per term. Third-party
  reviews put the promo on the **24-month** term (about US$ 8.99), a 12-month term at a
  higher rate (US$ 9.99 reported once) and monthly billing highest. The API catalog
  (`GET /api/billing/v1/catalog`) names items like `hostingercom-vps-kvm2-usd-1m`
  ("billed every month") with `price` and `first_period_price`, so a monthly term
  exists, but the catalog needs a token and **was not read**. Per-term prices are
  therefore **unverified**; read the catalog once the person has a token. Hostinger
  advertises a 30-day money-back guarantee (refund policy page not read).
- **Data centers:** the support page lists, for VPS, Europe (France, Germany, Lithuania,
  UK), Asia (India, Indonesia, Malaysia), North America (Phoenix, Boston) and
  **South America: Brazil**. Locations "can change without notice", the dashboard
  list at setup is final, and the location is fixed after setup. `GET /api/vps/v1/data-centers`
  needs a token, so Sao Paulo at checkout is unverified.
- **API** (OpenAPI 1.64.0 from `developers.hostinger.com/openapi/openapi.json`, read in full
  for VPS and billing; docs at `docs.hostinger.com`). Auth: bearer token generated in
  the panel, with the permissions of its creator, optional expiry. Rate limit: 90
  requests per minute per user, `429` with `Retry-After`, `X-RateLimit-*` headers.
  - **Buy:** yes. `POST /api/vps/v1/virtual-machines` ("Purchase and setup a new virtual
    machine") takes `item_id` from the catalog, optional `payment_method_id` (default
    otherwise), `coupons` and `setup`. `POST /api/billing/v1/orders` only orders; it does
    not provision. A `202` means payment is pending and the VM is not set up: finish in
    the panel. If setup fails, the spec also says to finish it in the panel.
  - **Setup:** `setup` carries `template_id`, `data_center_id`, `post_install_script_id`,
    `password`, `hostname`, `enable_backups`, `install_monarx`, `ns1`, `ns2` and
    `public_key {name, key}`. A VM bought in the panel sits in state `initial` and
    `POST .../virtual-machines/{id}/setup` configures it.
  - **SSH key:** the inline `public_key`; per VM `GET/POST/DELETE .../ssh-keys`. The
    account-level `/public-keys` endpoints are deprecated.
  - **Provisioning script:** `POST /api/vps/v1/post-install-scripts` stores a script
    (max 48 KB) that runs once after install as `/post_install`, output in
    `/post_install.log`. It is a plain script, **not cloud-init** (no cloud-init field
    exists in the spec). Our provisioning can run as that script or over SSH afterwards.
  - **List:** `GET /api/vps/v1/virtual-machines` and `GET .../{id}`. No tag filter was
    found, so Coxia must remember the ids it created.
  - **Upgrade or resize:** no endpoint. Changing plan is done in the panel (the
    subscription is a separate purchase).
  - **Destroy or cancel:** **no endpoint.** `DELETE .../auto-renewal/disable` stops
    renewal and the subscription ends at `expires_at`; `POST .../recreate` wipes and
    reinstalls. The billing spec has a cancel request schema (`cancel_option:
    immediately`) but no route uses it (unverified; may exist outside the public spec).
  - **Billing:** `GET /billing/v1/subscriptions` (status, `total_price`, `renewal_price`,
    `is_auto_renewed`, `expires_at`, `next_billing_at`), `renew`, auto-renewal on and off,
    `GET/POST/DELETE /billing/v1/payment-methods` (list, set default, delete). No
    invoices, balance or usage. New payment methods only in the panel.
  - **Snapshots and backups:** one snapshot per VM (`POST` overwrites it), restore and
    delete; weekly backups listed and restored (`enable_backups`). Also firewall,
    metrics, actions, recovery mode, PTR records.
- **Payment from Brazil:** Pix works only on the Brazilian site and **does not support
  automatic renewal** (each renewal needs a new QR code). Installments (up to 12x on the
  Brazilian site) are credit card only. Boleto for paying Hostinger is not confirmed
  (the articles found are about merchants accepting boleto). Whether Pix applies to a
  VPS order is not stated.
- **Spend:** no cap or alert found. The money is paid up front, so exposure is the
  term length, not a running bill.
- **CPU and fair use:** the vCPU is not described as dedicated and no fair-use policy
  was found. The CPU-limit support article is **inconsistent across languages**. The
  English page (read) describes credits: usage above a baseline spends credits, a full
  balance lasts about 3 hours at 100 percent on all vCPUs, and an empty balance drops
  capacity to 5 to 20 percent of the plan until credits rebuild to 20 percent. The
  Portuguese page (read) says 100 percent CPU is unsupported beyond 180 minutes and the
  capacity then falls to 10 percent per hour. Both agree that sustained load is throttled,
  and a weekly manual "remove limitations" button exists. Long faster-whisper `medium`
  runs and builds are exactly the load that gets throttled. A real benchmark would be
  needed; none was run.
- Sources: <https://www.hostinger.com/br/vps>, <https://www.hostinger.com/vps-hosting>,
  <https://developers.hostinger.com/openapi/openapi.json>,
  <https://docs.hostinger.com/api-reference/overview>,
  <https://www.hostinger.com/support/1583267-where-are-hostinger-servers-located/>,
  <https://www.hostinger.com/support/?p=715>,
  <https://www.hostinger.com/br/support/?p=1659>,
  <https://www.hostinger.com/support/how-to-pay-with-pix-at-hostinger/>,
  <https://www.hostinger.com/support/how-to-pay-in-installments-at-hostinger/>
  (2026-10-13). Third-party price and term reports came from search results only.

#### AWS Lightsail

- Sao Paulo became a Lightsail region on 2026-06-12 (AWS announcement).
- Bundles: 2 vCPU / 8 GB US$ 44, 4 vCPU / 16 GB US$ 84. There is no 4 / 8 bundle,
  so the target costs double what it should. The Sao Paulo prices were not read.
- Resize is not in place: snapshot, then create a larger instance from it.
  Downsizing is not supported by snapshot. This breaks the "resize" criterion in
  spirit.
- `userData` is a launch script; the official page does not name cloud-init.
- Billing is account level through Cost Explorer and Budgets. Pix is only a
  fallback for Brazil-entity customers after a card failure.
- Sources: <https://aws.amazon.com/lightsail/pricing/>,
  <https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_CreateInstances.html>,
  <https://aws.amazon.com/pt/about-aws/whats-new/2026/06/amazon-lightsail-aws-regions/>,
  <https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/manage-payment-brazil.html>
  (search results, 2026-10-13).

#### Oracle Cloud

- Public price list API (`apexapps.oracle.com/.../cetools/api/v1/products/`,
  updated 2026-10-08): E4 flex OCPU US$ 0.025 per hour, memory US$ 0.0015 per GB
  per hour. 2 OCPU (4 vCPU) and 8 GB is about US$ 45 per month before storage.
- Budgets are "soft limits" with email alerts on actual or forecast spend and an
  API; evaluated about every 24 hours. No cap.
- The Always Free Ampere allowance was reported cut from 4 OCPU / 24 GB to 2 OCPU /
  12 GB in June 2026 (secondary report; Oracle's own page still showed the old
  figure). Not relevant to the paid target but a reason to distrust the free tier.
- Unverified: region identifiers on Oracle's own pages, payment methods for
  Brazil, and the API signing scheme (request signing with a key pair is heavier
  than a bearer token).
- Sources: <https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm>,
  <https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/create-alert-rule.htm>
  (2026-10-13).

## Uptime monitors compared

| | Better Stack (Uptime) | UptimeRobot | Healthchecks.io | HetrixTools |
|---|---|---|---|---|
| Free tier | 10 monitors and 10 heartbeats, 1 status page, Slack and email alerts; marked "for personal projects" | 50 monitors, 5 minute interval, HTTP, port, ping and keyword; no heartbeat on Free | 20 checks (heartbeat style) | 15 monitors, 1 minute (secondary source; unverified) |
| Probes from outside the provider | Yes, hosted probes (check frequency 3 minutes on free per a secondary source) | Yes | No outbound probes: the box pings it, and silence raises the alert | Yes (secondary source) |
| Email alerts | Yes, on the free plan (pricing page) | Email is the default contact; not itemised in the plan table (unverified) | Yes (a listed channel; free-plan detail unverified) | Unverified |
| API to create checks | `POST https://incidents.betterstack.com/api/v2/monitors`, `Authorization: Bearer`; heartbeats have their own endpoints | v3 API; Free allows API at 10 requests per minute; v3 paths and auth form not confirmed | `POST https://healthchecks.io/api/v3/checks/`, `X-Api-Key` header, under 100 requests per minute; Free capped at 20 checks | Unverified |
| Paid | Responder US$ 29 (yearly) / 34; 50 more monitors US$ 25 | Solo about US$ 12 to 13 (60 s); Team about US$ 39 to 46 | Business US$ 20 (100 jobs) | From about US$ 9.95 (secondary) |
| Commercial use | Free plan limited to personal projects | Help center says business use is allowed on Free; check the terms before relying | Terms page not read | Unverified |

Notes:

- Better Stack's pricing page gives the free plan as "Free for personal projects".
  Coxia is a tool for one maintainer, which fits, but a product that spins up
  monitors in strangers' accounts only does so inside the person's own account,
  so the restriction applies to the person, not to Coxia.
- UptimeRobot's Free plan has no heartbeat monitor, so it can probe `/healthz`
  from outside but cannot receive a dead-man ping.
- Healthchecks.io fits the second job: Coxia can ping from the box (or from the
  runner) and the service alerts when pings stop, which also catches a box that is
  up but wedged. It is a complement, not a replacement, for an outside probe.
- Sources: <https://betterstack.com/pricing>,
  <https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/>,
  <https://betterstack.com/docs/uptime/api/create-a-new-monitor/>,
  <https://uptimerobot.com/pricing.md>, <https://uptimerobot.com/api/>,
  <https://healthchecks.io/pricing/>, <https://healthchecks.io/docs/api/>,
  HetrixTools via search results only (its pricing page returned HTTP 403)
  (2026-10-13).

## Recommendation

Hard criteria: create, destroy and list by API with an SSH key; run our provisioning
(cloud-init or an equivalent script, or SSH afterwards); acceptable latency from Brazil.

| Option | Month, 4 vCPU / 8 GB class | Create | Destroy | List | Provisioning | Latency from Brazil |
|---|---|---|---|---|---|---|
| Hostinger KVM 2 (2 / 8) | R$ 43,99 promo, R$ 77,99 renewal (US$ 8.99 / 14.99), paid up front | yes, buys by API | **no** | yes | script, not cloud-init | Brazil listed, unverified |
| Vultr `vc2-4c-8gb` | US$ 40.00 list, Sao Paulo price unverified | yes | yes | yes | `user_data` | Sao Paulo, API text second-hand |
| DigitalOcean `s-4vcpu-8gb` | **US$ 48.00** | yes | yes | yes | `user_data` | no Brazil region, unmeasured |
| Linode `g6-standard-4`, `br-gru` | US$ 67.20 | yes | yes | yes | `user_data` | Sao Paulo |

**Provider: DigitalOcean, Basic Droplet `s-4vcpu-8gb` (4 vCPU shared, 8 GB, 160 GB),
US$ 48.00 per month, US$ 0.07143 per hour, in a US or Canadian region (NYC1, ATL1 or
RIC1, chosen after a latency check).** This is the cheapest option that meets the hard
criteria on verified facts: US$ 19.20 per month (28.6 percent) below Linode in Sao
Paulo, hourly billing with no commitment, the best billing API of the set, and the
same create, list, resize and destroy surface as Linode. The earlier pass
rejected it only for the missing region.

It is conditional on one thing nobody measured: round trip from the person's
connection to a US region. The only estimate is roughly 100 to 140 ms. The core and the
runner live on the box, so this latency mostly affects the web UI and audio upload, not
the agents. If the person measures it and finds it unacceptable, the answer is Linode
`br-gru` at US$ 67.20, which is the first runner-up. The person's pushback was right on
price; it was not a reason to ignore latency.

Costs to accept: US latency; shared CPU on Basic (the same class as the Linode plan; a
General Purpose dedicated 4 vCPU needs 16 GB and costs US$ 126.00); no Pix or boleto;
spend alerts by e-mail only with no cap and no API for them found, so budget
enforcement lives in Coxia with `month_to_date_usage` plus the size prices.

**Why not Hostinger, though it is cheaper.**

- It has no destroy or cancel endpoint and no resize, so two of the adapter's
  operations are not possible by program. Coxia can stop renewal (`auto-renewal/disable`),
  but the money is already spent and the server is not deleted.
- It is a commitment, not a running bill. The monthly figure assumes a long term paid up
  front (third parties say 24 months for the headline price); the price per term is
  unverified. Coxia would be buying a prepaid contract by program, which is a different
  risk from hourly billing: a mistake or a bug costs the whole term. That purchase would
  need an explicit "yes" from the person each time.
- Pix cannot renew automatically; only a card can.
- There is no 4 / 8 plan, and the CPU is credit-throttled after sustained load
  (5 to 20 percent of capacity, or 10 percent per hour in the Portuguese text), which
  hits faster-whisper and builds.
- Its advantages are real: the lowest price (R$ 43,99 for 2 vCPU / 8 GB, or R$ 59,99
  for 4 / 16 on the promo), a Brazilian data center on the support page, and
  Brazilian payment. The renewal price is higher: KVM 4 renews at R$ 149,99, which is
  above the DigitalOcean plan.

**Trade-off in one line.** Price falls as commitment rises (Hostinger, long term, up
front), while the ability of a program to buy, resize and destroy falls with it. Coxia's
safety model (propose, confirm, audit, destroy on demand) needs hourly billing and a
real delete; DigitalOcean and Linode give both, Hostinger does not.

**What Coxia's Hostinger adapter could still do, if the person chooses it anyway.**
The person buys the plan in the panel (or Coxia buys it with `POST /virtual-machines`
after a confirmed "yes", using a payment method saved in the panel), and Coxia then:
sets up the VM in state `initial` with the template, data center, SSH key and a
post-install script; lists and reads it; restarts, stops and starts it; takes the one
snapshot; reads the subscription and its renewal price; turns auto-renewal off. It
cannot resize, delete or refund. Teardown and plan changes are a manual step in the
panel, and the adapter must say so. This would be a second-class adapter and is not
the default.

**Runner-up 1: Linode `br-gru`, `g6-standard-4`, US$ 67.20 per month.** The choice if
latency from Brazil matters more than US$ 19.20 per month. Every adapter fact is
verified, and it has the partner API.

**Runner-up 2: Magalu Cloud `br-se1`, `BV` 4 vCPU / 8 GB / 40 GB, R$ 169.99 per month.**
Choose it if the person has a Brazilian card and wants BRL, a Brazilian invoice and
Pix or boleto. Its public documentation does not show rate limits, a spend alert or a
partner API, international cards are refused and the 40 GB disk is small.

**Worth measuring before deciding: Vultr `sao`.** The plans endpoint lists
`vc2-4c-8gb` at US$ 40 and the high-performance 4 / 8 at US$ 48 as available in
Sao Paulo, which would beat both on price and latency. The Sao Paulo price is unverified
(a tracker shows about US$ 72) and the API facts are second-hand, so it is not
recommended yet.

Not chosen: Hetzner has no South American region and no billing API. Lightsail has no
4 / 8 bundle and no in-place resize. Oracle is cheap on paper but payment and signing
are unverified and heavier.

**Monitor: Better Stack (Uptime) free plan**, with an HTTP monitor on the Coxia
`/healthz` and a heartbeat for the runner, email alerts on. Reason: probes from
outside, heartbeats, email and an API in one free plan, with a documented bearer
API. **Runner-up: UptimeRobot** (50 monitors, clearer commercial-use wording);
add **Healthchecks.io** if a pure dead-man ping is wanted.

## What the adapter must handle (DigitalOcean, the recommended provider)

Carried over from the OpenAPI document and the docs; request fields for create and
resize were not re-read in this pass, so check them against the spec before coding.

- **Base URL:** `https://api.digitalocean.com/v2`.
- **Auth:** `Authorization: Bearer <personal access token>`, created by the person with
  scopes for Droplets, SSH keys and `billing:read`. Store with the other secrets; never log.
- **SSH key:** register with `POST /account/keys`, pass its id or fingerprint in
  `ssh_keys` at create. Delete the key when the server is destroyed.
- **Create:** `POST /droplets` with `{name, region, size: "s-4vcpu-8gb", image,
  ssh_keys, user_data: <cloud-config>, tags, backups: false, monitoring}`. `user_data`
  is cloud-init and runs at first boot. Tag every server Coxia makes.
- **List:** `GET /droplets?tag_name=<tag>`; manage only tagged servers.
- **Get:** `GET /droplets/{id}`; poll the action (`GET /droplets/{id}/actions/{action_id}`).
- **Resize:** `POST /droplets/{id}/actions` with `type: "resize"`; the Droplet must be
  powered off, and growing the disk is permanent (a CPU and RAM only resize can be undone).
- **Destroy:** `DELETE /droplets/{id}`; use `destroy_with_associated_resources` only when
  the person confirms. Volumes and snapshots are billed on their own, so a leftover one
  counts as spend.
- **"Server holds data" detection:** the Droplet's volumes, its snapshots
  (`/droplets/{id}/snapshots`) and backups (`/droplets/{id}/backups`). Refuse destroy until
  the data has been handed over (a separate issue).
- **Billing:** `GET /customers/my/balance` (`month_to_date_usage`,
  `month_to_date_balance`, `account_balance`, `generated_at`), `/billing_history`,
  `/invoices`. A powered-off Droplet is still billed. Per-server cost comes from the size
  price (`GET /sizes`), billed per second and capped at 672 h.
- **Spending alert:** e-mail only, set in the panel; no API found. Coxia raises its own
  warning from `month_to_date_usage`.
- **Rate limits:** 5,000 requests per hour and 250 per minute per token; `429` on
  excess. Back off.
- **Currency:** USD only; the person's card converts. Show the exchange effect as unknown.
- **Region facts to re-check at runtime:** `GET /regions` must list the chosen region
  as available, and `GET /sizes` must list `s-4vcpu-8gb` for it; else fail closed.
  The first account may restrict Droplet count until payment history exists
  (unverified).

## What the adapter must handle (Linode, the runner-up)

- **Base URL:** `https://api.linode.com/v4`.
- **Auth:** `Authorization: Bearer <personal access token>`. The token needs
  scopes for Linodes, Volumes and Account (read), set by the person when they
  create it. Store it with the other secrets; never log it.
- **Create:** `POST /linode/instances` with `{label, region: "br-gru",
  type: "g6-standard-4", image, root_pass, authorized_keys: [<public key>],
  metadata: {user_data: <base64 cloud-config>}, backups_enabled: false, tags}`.
  `root_pass` is required with an `image`; generate a random one and discard it.
  `user_data` is write-only and cannot be changed after creation (rebuild or
  clone to change it). Unencoded size must stay under 65535 bytes.
- **List:** `GET /linode/instances` (paginated; filter with the `X-Filter` header
  by `tags`). Tag every server Coxia makes and manage only tagged ones.
- **Get:** `GET /linode/instances/{id}`.
- **Resize:** `POST /linode/instances/{id}/resize` with `{type,
  allow_auto_disk_resize, migration_type}`. Cold resize with downtime; the account
  must have no outstanding balance; the disk allocation must fit the new type.
  Poll the event or the instance status.
- **Destroy:** `DELETE /linode/instances/{id}`. Destructive: it deletes disks and
  backups and detaches volumes.
- **Billing:** `GET /account` (`balance`, `balance_uninvoiced`: the running
  estimate in USD, excluding transfer charges), `GET /account/invoices`,
  `GET /account/payments`, `GET /account/transfer`. Per-server cost comes from the
  type price (`GET /linode/types`, with `region_prices` for `br-gru`), not from an
  itemised API.
- **Spending alert:** none found. Coxia must raise its own warning from
  `balance_uninvoiced`. Unverified: any provider-side billing alert.
- **Rate limits:** 1600 requests per minute for most operations, 200 per minute
  for paginated list GETs; `429` on excess. Back off and keep list polling slow.
- **"Server holds data" detection** before destroy or downsize: list
  `GET /linode/instances/{id}/disks`, `GET /volumes` filtered by `linode_id`,
  `GET /linode/instances/{id}/backups` and the instance field `backups.enabled`;
  also any snapshot. Volumes survive an instance delete but are billed on their
  own, so the adapter must treat a leftover volume as spend. Refuse destroy while
  the data has not been handed over (the handover feature is a separate issue).
- **Currency:** USD only; the person's card does the conversion. Show the
  exchange effect as unknown.
- **Region facts to re-check at runtime:** `GET /regions` must still list
  `br-gru` with the Metadata capability; else fail closed.

## Open questions for the person

1. Do you have a Brazilian credit card and want BRL, a Brazilian invoice and
   Pix or boleto (Magalu Cloud), or an international card (DigitalOcean, Linode)?
2. Is a US region acceptable for the first server (DigitalOcean US$ 48, roughly
   100 to 140 ms round trip, unmeasured), or is the Sao Paulo latency worth the
   US$ 19.20 per month uplift (Linode)? This decides the first provider.
   Measuring the round trip from your connection would settle it.
3. Do you accept Hostinger's trade (lowest price, but a prepaid long term, no destroy,
   no resize, throttled CPU) with a manual panel step for teardown? The default
   answer assumed here is no.
4. Is 4 vCPU / 8 GB the right start, or begin at 2 vCPU / 4 GB (US$ 24.00 on DigitalOcean,
   US$ 33.60 in `br-gru`) with `small` only and resize later?
5. Is a shared-CPU plan acceptable for faster-whisper `medium`, or should it be
   the dedicated plan (US$ 100.80)? A short benchmark on a real machine would
   answer it.
6. Do you accept that no provider here offers a hard spending cap, so the budget
   limit is Coxia's, plus a provider alert where one exists?
7. Are you comfortable keeping the monitor on Better Stack's personal-use free
   plan, or do you prefer UptimeRobot's wording for commercial use?
8. Do you want Coxia ever to create accounts for other people (the partner
   route)? If not, the partner API stays out of scope for the first provider.

## What was not verified

- Vultr: Sao Paulo price; official API reference text (fetch blocked).
- Hetzner: payment methods; the current euro price of the 4 / 8 class.
- DigitalOcean: Premium Intel and AMD Basic prices; whether spend alerts have an API
  (none found); latency to Brazil (nothing measured); rate-limit page not re-read;
  create and resize request fields not re-read this pass; Brazilian tax handling.
- Hostinger: price per term (1, 12, 24 months) in BRL and USD, since the catalog needs a
  token; which term the promo needs; Sao Paulo at checkout; whether Pix or boleto work
  for a VPS order; any hidden cancel route; the real CPU limit (the English and
  Portuguese articles disagree); refund policy text; spend caps; fair-use terms.
- Linode: any billing alert; partner eligibility terms; Pix or boleto.
- Magalu Cloud: Consumption API paths, rate limits, spend alerts, partner API.
- Lightsail: Sao Paulo prices; cloud-init specifics; partner route.
- Oracle: regions on Oracle's own pages, payment methods for Brazil, API detail.
- Monitors: UptimeRobot v3 base URL and auth form and email-on-free detail;
  HetrixTools entirely (page blocked); Healthchecks.io commercial terms.
- The 4 / 8 sizing is an estimate; no transcription benchmark was run.

## Decision (2026-10-14)

The person chose **Hostinger VPS, KVM 2** (2 vCPU / 8 GB / 100 GB) for the first adapter, on price, with the region in Brazil and Pix on the Brazilian site. The monitor is **Better Stack, free plan**.

What that choice means for Coxia, from the findings above:

- The adapter buys and sets up the machine by API, with the person's SSH key and the provisioning script as a post-install script (not cloud-init).
- There is no destroy or resize by API: Coxia ends a server by turning auto-renewal off, and it ends at the close of its paid term. A bigger machine is a new purchase and a move.
- Billing has no invoices API, so spend is recorded from the price of each subscription as estimated, not reconciled.
- The plan is paid up front for its term; the budget is charged the upfront amount.
- The CPU is throttled under sustained load, which the voice sidecar should be watched for.
