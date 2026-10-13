# Choosing the first VPS provider and the uptime monitor

Status: research for issue #1. Every source below was read on **2026-10-13**
(that is its access date unless a line says otherwise).

**No account was opened, no server was created and no money was spent.** The
research used public documentation, public price lists and unauthenticated
public API endpoints only. The recommendation is a proposal; the person decides.

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

| | Akamai / Linode | Magalu Cloud | Vultr | Hetzner Cloud | DigitalOcean | AWS Lightsail | Oracle Cloud |
|---|---|---|---|---|---|---|---|
| South America region | `br-gru` Sao Paulo (verified) | `br-se1` Sudeste and `br-ne1` Nordeste, both in Brazil (verified) | `sao` Sao Paulo and `scl` Santiago (verified) | None (verified) | None (verified) | Sao Paulo `sa-east-1` (verified, announced 2026-06-12) | Sao Paulo and Vinhedo (second-hand; unverified on Oracle's own region page) |
| Target size and price | `g6-standard-4`, 4 vCPU shared, 8 GB, 160 GB: **US$ 67.20** in `br-gru` (US$ 48.00 elsewhere); dedicated `g6-dedicated-4` US$ 100.80 | `BV` 4 vCPU shared / 8 GB / 40 GB: **R$ 169.99**; `DP` dedicated 4 / 8 / 40: R$ 563.00 (prices valid 2026-10-02, taxes included) | `vhp-4c-8gb-amd` 4 / 8 / 180 GB: list price **US$ 48.00**; `vc2-4c-8gb` US$ 40.00; Sao Paulo price **unverified** (a third-party tracker shows about US$ 72) | n/a in South America. For reference, 4 vCPU / 8 GB is the CPX32 class at roughly EUR 35 (secondary sources disagree; unverified) | `s-4vcpu-8gb` basic **US$ 48.00** (no Sao Paulo) | No 4 vCPU at 8 GB. 2 vCPU / 8 GB is US$ 44; 4 vCPU / 16 GB is US$ 84 (as listed; Sao Paulo price unverified) | E4 flex: 2 OCPU (= 4 vCPU) + 8 GB = about **US$ 45** by the public price list, plus boot volume; regional price unverified |
| Create with SSH key and cloud-init | `POST /v4/linode/instances`, `authorized_keys` and `metadata.user_data` (base64 cloud-config), needs the Metadata capability (listed for `br-gru`) | `POST /v1/instances`, `ssh_key_name`, `user_data` (base64) | `POST /v2/instances`, `sshkey_id`, `user_data` (base64); from Vultr's public docs, not re-read from the API reference (blocked) | `POST /v1/servers`, `ssh_keys`, `user_data` (cloud-init, 32 KiB) | `POST /v2/droplets`, `ssh_keys`, `user_data` | `CreateInstances`, `keyPairName`, `userData` (a launch script; cloud-init not named in the official page) | Yes via instance metadata `user_data` and `ssh_authorized_keys`; unverified in this pass |
| Resize | `POST .../resize` (cold, disk must fit) | `POST .../retype` (cold; disk can only grow) | Plan upgrade through the instance update; upgrade only; unverified in detail | `change_type` (server off; disk can only grow) | `resize` action (disk resize is one-way) | No in-place resize: snapshot, then create a bigger instance | Shape change on the instance; unverified in detail |
| Billing API | `GET /v4/account`, `/account/invoices`, `/account/payments`, `/account/transfer`; `balance_uninvoiced` is the live estimate | Consumption API in FOCUS v1.0, daily, D-1; price-list API | `GET /v2/billing/history`, `/billing/pending-charges`, `/billing/invoices/{id}`, `GET /v2/account` (second-hand search summary) | **None** in the API spec (verified); usage is in the console, invoices at the account site | `GET /v2/customers/my/balance`, `/billing_history`, `/invoices`, `/billing/{urn}/insights/{start}/{end}` (verified) | Through AWS Cost Explorer and Budgets, account level, not per Lightsail | Usage API and Budgets API (unverified detail) |
| Spending cap or alert | No cap. No billing alert found (unverified). | None found in docs (unverified) | Account limits: maximum instances and maximum instance cost, raised on request (verified in docs); no alert found | Console cost alerts by email; "a convenience feature rather than a spending limit" (verified); API for them not found | Spend alerts by email at percentage thresholds, per product or team (verified); no cap | AWS Budgets alerts and actions; no hard cap (unverified) | Budgets with actual and forecast email alerts, "soft limits" (verified); no cap |
| Payment from Brazil | Cards (Visa, Mastercard, Amex, UnionPay), Google Pay, PayPal; wire by support; no Pix or boleto found | Credit card is required to activate (Visa, Mastercard, Elo; **international cards not accepted**); Pix and boleto on request through support; prices and invoices in BRL | Cards, PayPal, crypto, Alipay, UnionPay; no Pix or boleto found | Not confirmed in this pass (unverified); no Pix or boleto found | Cards, PayPal, Google Pay, Apple Pay, bank account; no Pix or boleto found | Cards; Pix only as a fallback for Brazil-entity customers whose card payment failed (verified) | Not confirmed (unverified) |
| Partner or reseller API | Parent and child accounts: `GET /v4/account/child-accounts`, `POST .../token` (proxy user token) (verified) | None found (unverified) | Not found in this pass (unverified) | None found | Not found in this pass (unverified) | AWS Organizations can create accounts by program; not examined (unverified) | Not examined |

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

- Best billing API (verified, `billing:read` scope): `GET /v2/customers/my/balance`,
  `/billing_history`, `/invoices`, `/invoices/{uuid}`, `/billing/{urn}/insights/{start}/{end}`.
  Spend alerts by email replaced billing alerts; no cap.
- No Sao Paulo or other South American region (regional-availability page lists
  NYC, SFO, AMS, SGP, LON, FRA, TOR, BLR, SYD, ATL).
- Price: Droplet 4 vCPU / 8 GB basic is US$ 48.00 per month on the pricing page.
- Create takes `user_data` and `ssh_keys`; resize is a droplet action. Rate
  limits were **not** confirmed (unverified).
- Payment: cards, PayPal, Google Pay, Apple Pay, bank account, crypto wallet.
- Sources: <https://docs.digitalocean.com/reference/api/reference/billing/>,
  <https://docs.digitalocean.com/platform/billing/>,
  <https://www.digitalocean.com/pricing/droplets>,
  <https://docs.digitalocean.com/platform/regional-availability/>,
  <https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/droplets/droplets_create.yml>
  (2026-10-13).

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

**Provider: Akamai / Linode (Cloud Manager), region `br-gru`, plan `g6-standard-4`
(4 vCPU shared, 8 GB, 160 GB), US$ 67.20 per month, US$ 0.101 per hour.**

Why:

- It is the only option where every adapter-critical fact was verified from a
  machine-readable source: the live region list, the live price list with the
  Sao Paulo price, and the full OpenAPI document with create, resize, delete,
  billing, volumes and backups.
- It satisfies the partner criterion with a real API (child accounts and proxy
  tokens), which none of the others showed.
- Hourly billing capped at the monthly price, one bearer token, clear rate limits.
- International cards and PayPal work.

Costs to accept: the 40 percent Sao Paulo uplift (US$ 19.20 per month over the
US$ 48 elsewhere); no Pix or boleto; no billing alert or cap found, so the budget
enforcement lives in Coxia, using `balance_uninvoiced` plus the type prices.

**Provider runner-up: Magalu Cloud, `br-se1`, `BV` 4 vCPU / 8 GB / 40 GB,
R$ 169.99 per month.** Choose it first if the person has a Brazilian card and wants
BRL, a Brazilian invoice, and Pix or boleto. It loses the first slot because the
public documentation does not show rate limits, a spend alert or a partner API,
because international cards are refused (so it cannot be the default for other
users) and because the 40 GB disk is small for runner work.

Not chosen: Hetzner and DigitalOcean have no South American region (Hetzner also
has no billing API). Vultr is a plausible third if its Sao Paulo price turns out
near the list price. Lightsail has no 4 / 8 bundle and no in-place resize. Oracle
is cheap on paper but payment and signing are unverified and heavier.

**Monitor: Better Stack (Uptime) free plan**, with an HTTP monitor on the Coxia
`/healthz` and a heartbeat for the runner, email alerts on. Reason: probes from
outside, heartbeats, email and an API in one free plan, with a documented bearer
API. **Runner-up: UptimeRobot** (50 monitors, clearer commercial-use wording);
add **Healthchecks.io** if a pure dead-man ping is wanted.

## What the adapter must handle (Linode)

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
   Pix or boleto (Magalu Cloud), or an international card (Linode)? That decides
   the first provider.
2. Is the 40 percent Sao Paulo uplift on Linode worth the latency, or is a US
   region acceptable (US$ 48, roughly 100 to 140 ms round trip; unmeasured)?
3. Is 4 vCPU / 8 GB the right start, or begin at 2 vCPU / 4 GB (US$ 33.60 in
   `br-gru`) with `small` only and resize later?
4. Is a shared-CPU plan acceptable for faster-whisper `medium`, or should it be
   the dedicated plan (US$ 100.80)? A short benchmark on a real machine would
   answer it.
5. Do you accept that no provider here offers a hard spending cap, so the budget
   limit is Coxia's, plus a provider alert where one exists?
6. Are you comfortable keeping the monitor on Better Stack's personal-use free
   plan, or do you prefer UptimeRobot's wording for commercial use?
7. Do you want Coxia ever to create accounts for other people (the partner
   route)? If not, the partner API stays out of scope for the first provider.

## What was not verified

- Vultr: Sao Paulo price; official API reference text (fetch blocked).
- Hetzner: payment methods; the current euro price of the 4 / 8 class.
- DigitalOcean: API rate limits; whether spend alerts have an API.
- Linode: any billing alert; partner eligibility terms; Pix or boleto.
- Magalu Cloud: Consumption API paths, rate limits, spend alerts, partner API.
- Lightsail: Sao Paulo prices; cloud-init specifics; partner route.
- Oracle: regions on Oracle's own pages, payment methods for Brazil, API detail.
- Monitors: UptimeRobot v3 base URL and auth form and email-on-free detail;
  HetrixTools entirely (page blocked); Healthchecks.io commercial terms.
- The 4 / 8 sizing is an estimate; no transcription benchmark was run.
