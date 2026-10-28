<meta charset="utf-8">

# Cafeteria POS — design and delivery plan

Status: **v4, ready to hand to a fresh build session.** Nothing is built yet. This
file is self-contained: it is meant to be copied into a new, empty project folder
and read by a session that has no other context. Section 16 lists what is
*unverified*; section 17 what is still undecided.

## 0. Handover for a new session

**Read this first.**

- **What this is.** A hosted, multi-tenant, offline-capable POS for school
  cafeterias, sold/operated by a **caterer** who serves several schools. It is a
  standalone product: this folder is the whole project, and nothing outside it
  is assumed.
- **Owner/operator:** a single developer (the user) who will host the server
  themself. Expect one person to build, run and support this.
- **Resolved decisions** (do not re-ask): tenant = a caterer with many outlets
  (section 4); multiple counters per outlet; cash + UPI only; per-counter-per-day
  receipt numbering is acceptable (section 7.7); the user hosts the server.
  Also decided by the user: Zomato and Swiggy orders for resident students are a
  requirement; the app is online-first-with-offline-mode.
- **Still open** (ask the user only when you reach the phase that needs it):
  section 17.
- **Build order:** section 19. Start with phase 1 (foundation + tenant isolation)
  and do not skip ahead; phases 1 and 4 (sync) decide whether the product works.
- **First concrete steps for the new session:**
  1. Confirm the folder is a fresh repo (`git init` if not), with its own
     `package.json`; choose `pnpm` or `npm` and say which.
  2. Scaffold: `apps/api` (Fastify + zod), `apps/counter` (Vite + React PWA),
     `packages/shared` (event types, money helpers, zod schemas), `db/migrations`.
  3. `docker-compose.yml` for Postgres; a script that creates the non-owner,
     `NOBYPASSRLS` application role; migration `0001` for tenancy tables with RLS.
  4. A two-tenant test harness (tenants A and B) *before* any feature, so every
     later table gets an isolation test from day one.
  5. Write a short `CLAUDE.md`/README capturing the rules below.
- **Working rules the user has stated** (carry them over):
  - Fix the schema where it was first written and reseed, **while no real tenant
    exists**; stop doing that, and switch to additive migrations only, at the
    first real tenant (section 18). Ask before crossing that line.
  - Money is integer paise. Never floats.
  - Every route that takes an id needs a permission check *and* a scope check
    (whose record), and declares its scope rule; a test enumerates routes.
  - Behaviour people depend on (auth, isolation, sync, money) is verified with a
    real browser/real Postgres and a mutation check that the test fails when the
    guard is removed — not just green unit tests. Say plainly what was and was
    not verified.
  - Install tooling and large caches on the D: drive, not C: (Windows machine).
  - Keep documents in the repository (a `docs/` folder); do not publish them to
    hosted services. Do not paste project data into outside services.
  - Use targeted reads/greps and filtered command output; background slow jobs.
  - Do not spawn parallel subagents or remote/cloud runs unless asked.
- **Environment:** Windows 11, PowerShell/Git Bash, VS Code. Printers and
  tablets are not yet chosen (Q7).

Contents

1. Summary
2. Decisions so far
3. Scope
4. Tenancy model
5. Users and permissions
6. Architecture
7. Offline-first design (the hard part)
8. Data model
9. Order and payment lifecycles
10. Counter workflow (screens)
11. Zomato / Swiggy integration
12. UPI and cash
13. Receipt printing and hardware
14. Reports and day close
15. Security, privacy, audit
16. Unverified assumptions
17. Open questions
18. Operations
19. Delivery phases
20. Risks

---

## 1. Summary

A point-of-sale service for school cafeterias, run by a caterer that serves several schools.

- **Hosted, multi-tenant:** one deployment serves many caterers; each sees only its own data. (Today's expected tenant is one caterer with an outlet in each school.)
- **Offline-first counters:** a counter is a browser app (installable PWA) holding its own local database. It sells, takes cash/UPI and prints with **no internet at all**, then syncs when connectivity returns.
- **Several counters per cafeteria**, each with its own shift and drawer.
- **Zomato / Swiggy orders** (resident students) arrive at the cloud and are pushed to counters; a manual-entry mode works without partner access.
- Receipts on an **80 mm ESC/POS thermal printer** per counter.

## 2. Decisions so far

| # | Decision | Source |
|---|----------|--------|
| D1 | Multiple counters per cafeteria | you |
| D2 | Zomato + Swiggy for resident students | you |
| D3 | Cash and UPI only; no wallet in v1 | you |
| D4 | Generic 80 mm thermal printer | you / me |
| D5 | Independent project, own repo/folder and database; no school-ERP code or data | you |
| D6 | **Hosted online app with offline mode, multiple cafeterias** | you |
| D7 | PostgreSQL with row-level security as the tenant wall | me (consequence of D6) |
| D8 | Append-only sale events + custom sync, not a general replication product | me |
| D9 | Receipt numbers are per-device series, not one global sequence | me; **accepted by you** |
| D10 | Tenant = a caterer; outlet = the cafeteria in one school; the school is a customer, not a tenant | you (caterer) / me (shape) |
| D11 | You host and operate the server | you |

Superseded from v2: the central LAN server (old D6) and the LAN-printer-from-server
design. Hosting makes both impossible, and section 13 replaces them.

## 3. Scope

**In v1**
- Tenant onboarding: create a cafeteria, its outlet(s), counters, users, devices.
- Menu: categories, items, per-channel prices, availability.
- Offline-capable counter sale: cart, cash/UPI/split, change, receipt, void.
- Sync engine with explicit conflict rules; visible sync status on every counter.
- Shift open/close with cash reconciliation; day close; reports; CSV.
- Online order queue (manual provider first), outbox for provider status pushes.
- Two tenant roles plus a platform super-admin.
- Nightly backup, audit trail.

**Out of v1**
- Wallet, ERP/fee-ledger integration, inventory/purchasing, kitchen display.
- Subscription billing and payment collection from cafeterias (tenants are created by you; billing designed in phase 11).
- Dynamic per-order UPI QR (phase 10).
- Peer-to-peer sync between counters on the same LAN while the internet is down (see section 7.9).

## 4. Tenancy model

```
platform
 └─ tenant            (the paying organisation: a school, or a catering company)
     └─ outlet        (one cafeteria; has timezone, GSTIN, UPI VPA, business days)
         ├─ counter   (a till position; has a printer config)
         ├─ device    (an enrolled tablet/PC bound to one counter)
         └─ user      (cashier / manager; may be limited to certain outlets)
```

- A tenant may have several outlets (a school with two canteens; a caterer serving three schools).
- **Everything tenant-scoped carries `tenant_id`**, and every such table has row-level security reading `app.current_tenant_id()`.
- **The one invariant:** it must be impossible to obtain a database handle that is not tenant-stamped. Concretely: the app connects as a non-owner role with `NOBYPASSRLS`; tables are `FORCE ROW LEVEL SECURITY`; the stamp is set with `set_config(..., is_local => true)` inside a transaction so it dies with the transaction and cannot leak through the connection pool. A test per table proves tenant A cannot read or write tenant B.
- Tenant for an *inbound webhook* is resolved from the provider credential, never from the payload.
- A platform super-admin console (you) sits outside tenant scope, uses a separate role, and every action in it is audited.

## 5. Users and permissions

| Capability | Cashier | Manager | Platform admin |
|---|---|---|---|
| Log in with PIN on an enrolled device | yes | yes | — (separate login) |
| Open/close own shift | yes | yes | no |
| Create sale, take payment, print receipt | yes | yes | no |
| Reprint receipt (marked DUPLICATE) | yes | yes | no |
| Void an *open* sale | yes | yes | no |
| Void a *paid* sale / refund | no | yes, with reason | no |
| Accept / reject / ready online order | yes | yes | no |
| Edit menu, prices | stock toggle only | yes | no |
| All reports for the outlet, close day | no | yes | no |
| Enrol/revoke devices, manage users, provider settings | no | yes | no |
| Create tenants/outlets, impersonate for support | no | no | yes (audited) |

Every route that takes an id checks both *permission* (what) and *scope* (whose
record: same tenant, same outlet, and for a cashier the shift they own). Each
route declares its scope rule, and a test enumerates all routes and fails if one
has no declaration.

## 6. Architecture

```
 Counter (PWA)                                      Cloud
 ┌──────────────────────────┐                ┌───────────────────────────┐
 │ UI (React)               │                │ Fastify API               │
 │ Local DB (IndexedDB)     │ ── push ─────► │  /sync/push  /sync/pull   │
 │  menu snapshot, users,   │ ◄── pull ───── │  auth, devices, reports   │
 │  open shift, sales,      │ ◄── SSE ────── │  webhook receivers        │
 │  outbox                  │                │ PostgreSQL (RLS)          │
 │ Service worker (app code)│                │ Provider adapters+outbox  │
 │ Print driver (section 13)│                │ Object store for backups  │
 └──────────────────────────┘                └──────────▲────────────────┘
                                                        │ webhooks
                                              Zomato / Swiggy (partner access)
```

| Layer | Choice | Note |
|---|---|---|
| Language | TypeScript, Node 22 | one language client and server; shared types package |
| API | Fastify + zod | versioned (`/v1`), see 7.8 |
| Cloud DB | PostgreSQL, RLS | section 4 |
| Client DB | IndexedDB via a thin wrapper (Dexie or similar) | chosen at build time |
| Client app | Vite + React PWA, service worker caches app shell | installable, full-screen on tablets |
| Realtime | SSE for online orders and menu-change nudges; polling as fallback | |
| Money | integer paise everywhere | no floats |
| Time | UTC `timestamptz`; business day computed in the outlet's timezone | |
| Tests | Vitest; server tests against real Postgres; client sync tests with fault injection | |
| Hosting | **your own server** (D11; provider/region open, Q4) — a single small VM + managed or self-run Postgres is enough at this scale | |

**Why a custom sync, not a replication product (D8).** Almost all writes are
*append-only facts* (a sale happened, a payment was taken). Facts don't conflict;
they just need to arrive exactly once. The only mutable data (menu, prices,
users, settings) flows one way, cloud → device. That makes a small purpose-built
sync both simpler and easier to prove correct than adopting a general
multi-writer replication engine. (CouchDB/PouchDB, PowerSync, ElectricSQL and
similar exist; I haven't evaluated their current state, and could be persuaded if
you'd rather buy than build.)

## 7. Offline-first design

### 7.1 What works offline
Login (cached), open shift, sell, take cash/UPI, print, void own open sale, close
shift, view own shift's sales. **What needs the internet:** receiving online
orders, pushing status to providers, manager reports, menu/price changes arriving,
device enrolment, refunds of already-synced sales (7.6).

### 7.2 Device enrolment
A manager enrols a device with a one-time code; the device receives a long-lived,
revocable device credential and is bound to one outlet and counter. Unenrolled
browsers cannot sell. Revocation takes effect at the device's next successful
contact, and the device also self-locks after **N days offline** (default 7,
configurable) until it syncs — bounding the damage of a lost tablet.

### 7.3 Offline sign-in
The pulled snapshot includes, for this outlet's users only, a salted slow-hash
PIN verifier and role. The device checks the PIN locally. Failed attempts are
rate-limited locally and the verifier set refreshes at every sync. A PIN change or
deactivation made in the cloud reaches the device at next contact — an
acknowledged window, bounded by 7.2.

### 7.4 Pull: reference data (cloud → device)
Menu, prices, channel prices, users/verifiers, outlet settings, printer config.
Every change bumps a per-tenant monotonic `version`. The device sends its cursor;
the server returns everything newer (inserts, updates, tombstones). Pull is
idempotent and resumable. Each sale records the `menu_version` it was rung up
under, so a disputed price can be traced.

### 7.5 Push: events (device → cloud)
The device never edits "sale rows" remotely; it appends **events** to a local
**outbox**, each with a client-generated UUID (v7, time-sortable), the device id,
a per-device sequence number, a schema version, the device's local timestamp, and
a payload:

- `sale.created` (with lines, snapshotted names and prices)
- `payment.taken`
- `sale.voided`
- `shift.opened`, `shift.closed` (with the counted cash)
- `print.reprinted`, `online_order.status_changed`

`/sync/push` accepts a batch; the server processes each event **in a transaction,
idempotently on the event UUID**, and returns a per-event result: `applied`,
`duplicate` (already had it — treated as success), or `rejected` with a reason.
The device deletes an outbox entry only on `applied` or `duplicate`. A crash, a
dropped response, or a retry therefore cannot lose or double-post anything.
Per-device sequence numbers let the server detect gaps (a missing event) and
refuse to apply later ones out of order for the same entity.

### 7.6 Conflict rules (explicit, because "last write wins" is not an answer)

| Situation | Rule |
|---|---|
| Item price/name edited in cloud while a device sold offline at the old price | The sale stands at the price it was rung up at. Facts are not rewritten. |
| Item deactivated/out of stock in cloud, device sold it offline | Sale accepted. It's flagged in the report ("sold while unavailable") — never rejected, because the food was already handed over and paid for. |
| Two devices offline both sell the last portion | Both accepted; stock is only a toggle in v1, not a count. |
| Cashier voids an *open* sale offline | Local event; applied on sync. |
| Manager voids/refunds a *paid, already-synced* sale | **Online only.** Requires the cloud's current state; offline refunds are not offered. |
| Manager voids a paid sale that is *not yet synced* | Allowed on the same device; the pair of events syncs in order. |
| Events arrive after the business day was closed | Accepted into a **late-arrival adjustment** attributed to the original day, flagged, and surfaced on the next day's close screen. The closed day's frozen totals are not edited. |
| Device clock is wrong | Server stores `received_at` and the device's claimed time; skew over 5 minutes is flagged. Ordering within a day uses device sequence, not wall-clock. |
| Same user active on two devices | Allowed; shifts are per device. |
| Device revoked while holding unsynced events | Events are still accepted if their enrolment was valid when created (the credential covers the period up to revocation time as known to the server); the manager is alerted. |

### 7.7 Receipt numbers without a global sequence (D9)
A gap-free, globally sequential number cannot be issued offline. Instead each
receipt is numbered **`<counter-code>-<yyyymmdd>-<n>`**, e.g. `C2-20261030-0147`,
where `n` is a gap-free counter held *on the device* per business day. Gap-free
**per device per day** is verifiable: the server checks that `n` runs 1…k with no
holes. A global running total for the day is computed at read time. If your
accounting needs one unbroken series across counters, that is incompatible with
offline operation. The user accepted the per-counter series (D9).

### 7.8 Version skew
A tablet may stay offline through a server upgrade and a new app release.
Rules: events carry a schema version; the server supports the **current and
previous** event schema versions (N-1) and upgrades old ones on ingest; the
service worker shows "update ready", and a sale is never interrupted by an
update. A device on an unsupported version can still *push* its outbox (that path
is kept stable and tiny) but cannot start new sales until updated.

### 7.9 What offline cannot give you
- **Counters don't see each other while the internet is down.** Each keeps
  selling independently; the total reconciles when they reconnect. Peer sync over the LAN was deliberately left out of v1; it would cost real effort and the facts-only model means it is rarely needed.
- **Unsynced data lives on one device.** If it is lost or its browser storage is cleared before syncing, those sales are gone. Mitigations: sync as often as connectivity allows, a persistent "N unsynced sales — last sync 14:02" banner, a shift slip printed at shift close with totals to check against, request persistent browser storage, and a forced sync (or explicit warning) before shift close. Browser-storage eviction policies differ by platform (iOS Safari is stricter); I recommend Android/Chrome or Windows/Chrome-or-Edge counters (unverified in detail, section 16).
- **Local data is not strongly protected.** Browser storage on a device is readable by someone with that device's profile. We therefore store no student PII, only sales, menu, and PIN verifiers.

### 7.10 Testing the sync (non-negotiable)
Fault-injection tests: drop the response after the server applied; duplicate
batches; reorder; kill the app mid-batch; skewed clock; stale schema version;
close the day with a device holding unsynced events; revoke a device mid-outbox;
two devices selling concurrently. Property: *after any sequence of faults and
eventual connectivity, cloud totals equal the sum of what cashiers actually did,
exactly once.* A mutation check proves the tests fail if idempotency is removed.

## 8. Data model

Naming: `snake_case`, singular, `id uuid`, amounts `*_paise bigint`. Every table
below has `tenant_id` with RLS unless noted.

**Tenancy and access:** `tenant`, `outlet(tenant_id, name, timezone, gstin, upi_vpa)`, `counter(outlet_id, code, printer_config)`, `device(outlet_id, counter_id, credential_hash, enrolled_at, last_seen_at, revoked_at, app_version)`, `user(name, pin_verifier, role, active)`, `user_outlet(user_id, outlet_id)`.

**Reference (versioned for pull):** `category`, `item`, `item_price(item_id, channel, price_paise, gst_rate_bp)`, `item_channel_map(item_id, channel, external_id)`; each row has `version bigint` from a per-tenant sequence and `deleted_at` for tombstones.

**Trading:**
- `business_day(outlet_id, date, closed_at, closed_by)`
- `shift(outlet_id, device_id, user_id, opened_at, closed_at, opening_cash_paise, counted_cash_paise, expected_cash_paise, variance_paise)`
- `sale(id = client uuid, outlet_id, business_day_id, shift_id, device_id, channel, status, receipt_no, device_seq, menu_version, subtotal_paise, tax_paise, total_paise, created_at_device, received_at, void_reason, flags text[])`
- `sale_line(sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise)`
- `payment(sale_id, method[cash|upi|aggregator], amount_paise, tendered_paise, change_paise, upi_ref)`
- `refund(sale_id, amount_paise, method, reason, approved_by)`
- `sync_event(id = client uuid, device_id, device_seq, kind, schema_version, payload jsonb, received_at, result)` — the idempotency ledger; `UNIQUE(device_id, device_seq)`

**Online orders:** `online_order(sale_id, provider, external_order_id, status, accept_by, customer_label, delivery_note, raw_payload)` with `UNIQUE(tenant_id, provider, external_order_id)`; `online_order_event`; `integration_outbox`; `provider_credential(tenant_id, outlet_id, provider, secret_ref)`; `settlement_import`, `settlement_line`.

**Audit:** `audit(at, actor_kind, actor_id, action, entity, entity_id, detail)` — append-only; the application role has `INSERT, SELECT` only.

### Invariants (each gets a test)
1. Tenant A can never read or write tenant B's rows, on any table, through any route (RLS test per table).
2. A sale event is applied at most once and at least once: totals equal what cashiers did.
3. A paid sale's payments sum to its total (cash may exceed by `change_paise`).
4. Paid sales are never deleted or edited; they are voided or refunded.
5. Receipt `n` is gap-free and unique per device per business day.
6. A closed day's frozen totals never change; late events become flagged adjustments.
7. `(tenant, provider, external_order_id)` is unique: a re-delivered webhook cannot create a second order.
8. `audit` cannot be updated or deleted by the application role.

## 9. Order and payment lifecycles

**Counter sale:** `open → paid → (manager) refunded | void`, and `open → void`. The receipt number is assigned at payment, so abandoned carts leave no gaps. Abandoned open sales are auto-voided at shift close.

**Online order:** `received → accepted → preparing → ready → handed_over`, with `rejected`, `cancelled`, and `expired` (unaccepted by `accept_by`). Each adapter maps our states to the provider's.

**Shift:** `open → closed`. The cashier enters the counted cash *before* seeing the expected figure (blind count), to avoid anchoring.

## 10. Counter workflow

1. **Sync bar** (always visible): online/offline, unsynced count, last sync time.
2. Login: user tile + PIN pad; 5 failures → 5-minute lock.
3. Open shift: opening cash.
4. **Sell:** category tabs, big item tiles (out-of-stock greyed), cart, total, *Pay*.
5. **Pay:** cash keypad with change due; UPI shows the outlet's QR and amount; split allowed.
6. Done: receipt prints, drawer opens (cash), back to Sell.
7. **Online orders:** badge + sound on new order; cards sorted by `accept_by`; one-tap *Accept / Ready / Handed over*; reject needs a reason. Shows "needs internet" when offline.
8. Today: shift's sales, reprint, void (if permitted).
9. Close shift: blind count → variance; forced-sync prompt; shift slip printed.
10. Manager area (online): menu, prices, users, devices, providers, reports, close day.

Usable at 1024×768; no scrolling needed to take a payment; destructive actions confirm.

## 11. Zomato / Swiggy integration

**Assumption:** each cafeteria is (or will be) a listed outlet on the platforms, and
resident students order for delivery within campus. If you instead mean an internal
hostel-ordering channel, this section changes (Q1).

**Constraint:** neither platform, to my knowledge, offers a self-serve public API;
order feeds and menu sync go to approved partners or certified integrators under
an agreement, with credentials per outlet. I have **not** verified current
programmes, eligibility for a school outlet, endpoints, or payloads (section 16).
In a multi-tenant product this compounds: each cafeteria needs its own onboarding
and credentials, or you go through a single middleware integrator that fronts both
platforms.

**Design that survives the uncertainty:** an adapter boundary.

```ts
interface OrderProvider {
  id: 'zomato' | 'swiggy' | 'manual';
  parseInbound(raw: unknown): NormalisedOrder;
  accept(orderId: string, prepMinutes: number): Promise<void>;
  reject(orderId: string, reason: string): Promise<void>;
  markReady(orderId: string): Promise<void>;
  setItemAvailability(externalItemId: string, inStock: boolean): Promise<void>;
  setOutletOpen(open: boolean): Promise<void>;
}
```

- **Inbound** (webhook or poll): verify signature → resolve tenant/outlet from the provider credential → store `raw_payload` → upsert `online_order` on the unique key → map lines via `item_channel_map` → create a `sale` with `channel = provider` → push to that outlet's counters over SSE. Unmapped items don't drop the order; they appear flagged for the manager.
- **Outbound** via `integration_outbox` with retry/backoff; a provider outage never blocks the kitchen.
- **Payment:** `method = aggregator`; the platform pays the school later minus commission, so these are *gross* sales. A **settlement import** (CSV/Excel) matches payouts to orders and flags missing, extra and mismatched lines.
- **Menu/stock:** manager marks out-of-stock once; it propagates to each platform where an API exists, else is a documented manual step.
- **Manual provider:** a cashier keys in an order read off the platform's own app. Same queue, same books. **This is the realistic day-one mode** and needs no partner approval.
- **Hostel delivery:** `customer_label` ("Block B, Room 214") and `delivery_note` are on the order card and handover slip. Stored minimum only; no student roster.
- **Time limits:** countdown to `accept_by`, alert, and louder escalation in the final 30 seconds. Online orders need internet by nature, so an offline cafeteria simply receives none; the banner says so.

## 12. UPI and cash

**Cash:** drawer kick on cash payment; change on screen; shift reconciliation.

**UPI v1: static QR + manual confirmation.** The screen shows the outlet's QR built
from its configured VPA with the exact amount in the `upi://pay` link; the cashier
confirms the credit on the school's receiving app/soundbox and may record the last
4 digits of the reference. Works fully offline from our side and needs no gateway.
**Weakness:** a customer can show a fake success screen; confirmation must be on
the *receiving* device. **Later (phase 10):** a gateway issues a per-order QR and
webhooks success — automatic and reconcilable, but needs internet, a gateway
account per cafeteria, and fees.

## 13. Receipt printing and hardware

**Hosting changes the print problem.** A cloud server cannot reach a printer on a
cafeteria LAN, and a browser cannot open a raw TCP connection to a LAN printer.
The counter device must print itself. Options:

| Option | Raw ESC/POS + drawer kick | Notes |
|---|---|---|
| A. Browser print (`window.print`) to an installed printer driver, 80 mm CSS | no drawer, formatting limited | works anywhere, zero setup; **ship this first** |
| B. WebUSB / WebSerial to a USB printer (Chrome/Edge desktop, Android) | yes | browser-support dependent; per-device permission prompt |
| C. Web Bluetooth to a BLE printer (Android Chrome) | yes | not on iOS; pairing is per device |
| D. Tiny local **print relay** app on a counter PC (receives jobs from the PWA over localhost/LAN, sends to printer on TCP 9100 or USB) | yes | most reliable; one more thing to install |

**Recommendation:** start with A so every counter prints on day one; add B for
USB printers on Windows/Android Chrome counters; offer D only for sites needing
LAN printers or shared printers. Hardware: **80 mm thermal, ESC/POS, USB (and
Ethernet if you may want D), RJ11 cash-drawer port, auto-cutter.** Commonly
sold in India: TVS RP3160 Gold, Epson TM-T82 series, Rongta RP326/RP332,
Xprinter XP-N160II — I recommend the class of device, not a model, and haven't
verified pricing or local stock. Because B/C/D support varies by browser and OS,
**printing must be tested on the actual counter hardware** before rollout.

- Receipts are rendered on the device from the sale record (so printing works offline). Print jobs and failures are tracked locally; a failed print never fails the sale; *Reprint* prints "DUPLICATE" and logs an audit event.
- **Devanagari:** thermal printers' built-in code pages rarely render Hindi, so Hindi means bitmap printing (works, slower). English-only avoids it (Q6).
- Content: cafeteria name, GSTIN if applicable, date/time, receipt no., counter, cashier, lines, tax, total, payment and change, footer. Online orders also print a handover slip.

| Per counter | Notes |
|---|---|
| Tablet or PC (10"+ touch) | Android/Chrome or Windows/Chrome-Edge recommended |
| Thermal printer + optional cash drawer | as above |
| UPS for router and counter | power cuts are the commonest failure |
| Reliable Wi-Fi/4G fallback | a cheap 4G hotspot as backup keeps sync and online orders alive |

## 14. Reports and day close

**Day close (manager, online):** blocks while any shift is open, any sale is open,
or any enrolled device has unsynced events *known to the server* (a device shows
its last-seen age and unsynced count at last contact); shows cash variance per
counter, UPI total, online gross, voids/refunds, late-arrival adjustments from the
previous day; freezes totals. Because a device can be silently offline, close
shows "last heard from: 2 h ago" per device so the manager decides knowingly.

**Reports (tenant- and outlet-scoped):** sales by day/counter/cashier/channel/
category/item, hourly heat, voids and refunds with reasons, cash variance by
cashier, sold-while-unavailable, online accepted/rejected/expired, settlement
mismatches, sync health. CSV export. Today's figures are labelled provisional.
**Platform admin:** per-tenant usage and health, never raw sales without audit.

## 15. Security, privacy, audit

- **Isolation:** section 4. The most important property of a multi-tenant product; tested on every table and every route.
- **Auth:** manager web login with strong password + optional TOTP; counter PIN on enrolled devices; device credential hashed server-side; lockouts and rate limiting.
- **Authz:** permission *and* scope on every id-taking route (section 5), enforced by a declared-scope test.
- **Transport:** TLS everywhere; webhook endpoints verify provider signatures, enforce replay protection (timestamp + dedupe), and are rate-limited; tenant derived from credentials.
- **Data minimisation:** no student roster or ERP data; only the labels the platforms send. Local device storage holds menu, sales, PIN verifiers.
- **Hosting data:** sales data of many cafeterias lives on your server. That is a deliberate product decision (D6) with obligations: where it is hosted, retention, tenant export/deletion on request, breach handling. Indian data-protection obligations may apply; **confirm with a lawyer**, I have not assessed them.
- **Secrets:** provider credentials and VPAs in a secret store, never in the repo or logs.
- **Audit:** append-only, tenant-visible to managers; platform-admin actions logged separately.
- **Development hygiene:** during development, no project data is pasted into outside services and no documents are published to hosted services. Deploying the product to the user's own server is the product's runtime and is decided (D11).

## 16. Unverified assumptions

1. Zomato's/Swiggy's current partner programmes, eligibility for school outlets, API shape, and whether per-tenant onboarding or a middleware integrator is required.
2. Whether campus-restricted delivery listings are permitted.
3. Browser/OS support and behaviour for WebUSB, WebSerial, Web Bluetooth, IndexedDB persistence and eviction on your actual tablets.
4. Specific printer models' variants, pricing, availability.
5. GST treatment of cafeteria sales and aggregator commission; whether per-device receipt series satisfies the school's/auditor's requirements.
6. Indian data-protection and hosting obligations for a multi-school service.
7. Suitability of buying a sync product versus the custom sync in D8.

## 17. Open questions

*Resolved:* tenants are a caterer (D10); per-counter receipt series accepted (D9); you host (D11).

1. **Zomato/Swiggy (needed before phase 9):** are the outlets listed on the platforms, delivering to hostel students, or is it an internal ordering channel? Any partner contact yet? Per-outlet onboarding or one integrator for all?
2. Roughly how many outlets and counters in year one? (Sizes hosting; a single VM is plenty for dozens.)
3. **GST (needed before phase 3):** GSTIN and tax lines on receipts, or none? Is the caterer registered; do school and caterer invoice each other separately?
4. **Hosting (needed before phase 11):** which provider/region, and who handles OS patching, TLS and backups storage?
5. Does the caterer need consolidated reports across all its schools (assumed yes) and does each school's management need its own read-only view of its outlet?
6. Receipts English-only or Hindi too? (needed before phase 5)
7. Counter hardware: Android tablets, Windows PCs, or mixed? Existing printers?
8. Do tenants pay you (subscription), and when must billing exist?
9. How long may a counter run offline before locking (default 7 days)?
10. Aggregator prices differ from counter prices? Daily-changing menus?
11. Is an accountant/read-only role needed?

## 18. Operations

- **Environments:** local dev with Docker Postgres and seed tenants (two, so isolation tests are meaningful); staging; production.
- **Deploy:** containerised API + Postgres; migrations numbered `0001…`, additive only once any tenant holds real data (the dev-only "edit in place and reseed" shortcut ends at first real tenant — decide the cut-over explicitly).
- **Backups:** automated nightly dump + point-in-time recovery, stored in a separate location; a scheduled restore test (an untested backup is a hope). Per-tenant export for offboarding.
- **Monitoring:** API errors, sync rejection rate, per-device last-seen, outbox backlog, webhook failures, DB health; alert when a device unsynced > X hours.
- **Support:** audited impersonation, a "device health" view, a runbook for lost device, bad clock, stuck outbox, and stale app version.

| Failure | Behaviour |
|---|---|
| Counter offline | keeps selling; banner shows unsynced count; syncs on reconnect |
| Response lost after server applied | retry returns `duplicate`; no double post |
| Printer fails | sale completes; reprint available |
| Device lost/stolen | revoke in console; it self-locks after N offline days |
| Device storage cleared with unsynced sales | those sales are lost — hence frequent sync, shift slip, forced sync at shift close |
| Server outage | counters continue offline; online orders pause; outbox drains after |
| Provider webhook duplicates | unique key + idempotency |

## 19. Delivery phases

Rough single-developer estimates, not commitments. Roughly double the v2 plan:
offline sync and multi-tenancy are most of the new work.

| # | Phase | Outcome | Effort |
|---|---|---|---|
| 1 | Foundation | Project scaffold, Docker Postgres, migrations, **tenant isolation (RLS) with a two-tenant test harness**, auth, device enrolment, scope-declaration scaffolding | 5–7 d |
| 2 | Menu admin + onboarding | Tenants/outlets/counters/users, categories, items, channel prices, versioned pull | 4–5 d |
| 3 | Offline counter sale | PWA shell, local DB, cart, cash/UPI/split, local receipt numbering, local outbox, offline PIN | 7–9 d |
| 4 | **Sync engine** | push/pull, idempotent ingest, gaps, conflict rules, N-1 schema, fault-injection suite | 7–10 d |
| 5 | Printing | browser print first; WebUSB for USB; relay only if needed; reprint | 3–5 d |
| 6 | Shifts, day close | blind count, forced sync, day freeze, late-arrival adjustments | 4–5 d |
| 7 | Online orders (manual provider) | queue, lifecycle, SSE, outbox, settlement import | 5–7 d |
| 8 | Reports | section 14, CSV | 3–4 d |
| 9 | Aggregator adapters | real Zomato/Swiggy — **gated on partner access** | 5–10 d, unknown |
| 10 | Dynamic UPI (optional) | gateway QR + webhook | 3–5 d |
| 11 | Platform admin, billing, hardening | super-admin console, usage, backups/restore drill, rate limits, runbook | 6–9 d |

You have a usable offline till after phase 6, a full operation after 8, and live
aggregators only after 9. Phases 1 and 4 are where the product succeeds or fails.

### Verification per phase
- **Tenant isolation, scope and permission gates:** tests against a real Postgres and the running server, using two tenants and each role; every gate gets a mutation check (remove the check, confirm the test fails).
- **Money, numbering, lifecycle, day freeze:** API and unit tests, one per invariant in section 8.
- **Sync:** the fault-injection suite in 7.10; also tested with real browsers toggled offline/online.
- **Webhooks:** duplicates, reordering, bad signatures, unknown items.
- **UI:** checked in a real browser at tablet size before a phase is called done; I will state which phases got that and which only got type/lint checks.
- **Printing and offline storage:** need real counter hardware; reported as *unverified on hardware* until then.

## 20. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cross-tenant data leak | Existential for a SaaS | RLS wall, non-owner DB role, per-table and per-route tests, scope declarations |
| Sync bug double-posts or loses sales | Wrong books | Idempotent event ledger, per-device sequence, fault-injection suite |
| Unsynced data lost with the device | Lost sales | Frequent sync, banner, shift slip, forced sync at close, offline lockout |
| Aggregator access delayed/refused, per-tenant | Phase 9 stalls | Manual provider ships in phase 7 |
| Aggregator API changes | Orders silently stop | Adapter boundary, raw payload retention, last-event monitoring |
| Accounting/auditor later rejects per-device receipt series | Rework | Accepted by user (D9); revisit if GST advice (Q3) says otherwise |
| Browser printing / storage differs on real tablets | Rollout trouble | Hardware pilot at one cafeteria before the second |
| Stale app versions after upgrades | Rejected events | N-1 schema support, stable push path, update prompt |
| Fake UPI success screens | Revenue loss | Confirm on receiving device; dynamic UPI later |
| Data-protection/hosting obligations | Legal exposure | Legal review before first real tenant |
| Scope creep (wallet, ERP, inventory) | Delay | Explicitly out of v1 |
