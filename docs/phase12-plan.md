<meta charset="utf-8">

# Phase 12: tables, running orders, quick codes

Decisions: PLAN.md D13 (cafes and restaurants), D14 (tables are order slots), D15 (open orders are sums of line
events), D16 (quick codes). UI target: [prototypes/sell-prototype.html](prototypes/sell-prototype.html). Update the
**Progress** table as each step lands.

## What the code does today (why this is not a small change)

- A sale is created whole: `sale.created` carries every line, and `sale` has `total_paise > 0`.
  (db/migrations/0004_trading.sql, packages/shared/src/events.ts)
- `sale_line` is write-once (UPDATE and DELETE are revoked); `sale_guard` freezes money once a sale leaves `open`.
- Ingest refuses an event about another device's sale (`wrong_device`, apps/api/src/ingest.ts `saleOf`).
- The tablet holds the cart in memory and writes the sale only at Save/Pay. There is no editable open order.
- Pull carries reference data only. A device never learns about another device's open orders.

So a running table order needs (a) editable-by-event lines, (b) events from a device other than the creator,
(c) a way for other devices to see open orders. (c) is only needed once an outlet has more than one device.

## Design

**Tables.** `dining_table(outlet_id, code, label, sort_order, active, is_default)`, versioned and pulled like the
menu. One default per outlet (partial unique index). `outlet.table_mode` is `default` or `map`. `sale.table_id` is
nullable. Occupancy is derived from open sales, never stored.

**Quick codes (D16).** `category.code` and `item.code`, text, digits only, width from a tenant setting (default 2).
Unique per tenant among live categories; item code unique within its category among live items. The typed code is
`category.code || item.code`. A manager screen suggests the next free code and warns before an item moves category.

**Events, schema version 2.** The version bump is the first use of N-1 (PLAN 7.8): the server keeps accepting v1
events unchanged.

| Event | Fields | Rule |
|---|---|---|
| `order.opened` | saleId, tableId, createdBy, businessDate, createdAtDevice, menuVersion | creates an `open` sale with no lines |
| `order.line_added` | saleId, lineId, itemId, name, unitPaise, gstRateBp, qty | lineId is a client uuid; a duplicate lineId is a duplicate event |
| `order.line_changed` | saleId, lineId, qty | applies to that line only while the sale is open |
| `order.line_removed` | saleId, lineId | soft-removes (kept, `removed_at`) so reports can show it |
| `order.moved` | saleId, tableId | last move by device sequence wins; informational |
| `payment.taken` (v2) | adds `lines: [{lineId, qty}]`, `totalPaise` | the payer paid for exactly these lines at these quantities; the payment wins |

Totals are recomputed by the server after every line event from the lines and the outlet's settings (the same
`totals()` the tablet uses, in packages/shared). The sale row's money is a cache of that fold, enforced by a CHECK
and a trigger, not trusted from the device. v1 `sale.created` still works (it is `order.opened` plus its lines).

**Payment against a changing order.** The cashier pays for the lines they saw, at the quantities they saw
(`lines: [{lineId, qty}]`). **The payment wins** (decided 2026-11-06): money already in the drawer is never left
without a sale. On ingest (`checkPayment` in packages/shared does the arithmetic):
- every paid line's add must have arrived, else the payment is **deferred** (its price is not known yet) and retried;
- `totalPaise` must equal the server's total for those lines **at the paid quantities**, else rejected
  `payment_total_mismatch`. Since prices come from the immutable add, no honest tablet produces this;
- a paid line that another device removed, or lowered, before the payment arrived is paid as listed anyway; the
  removal or change is recorded `already_paid`;
- live quantity the payment did not cover is **split off** into a new open sale on the same table, flagged
  `late_lines`. That is whole unpaid lines, plus the excess of a paid line that was raised elsewhere, as a new line.
  A paid sale is never edited (invariant 4), and nothing the waiter rang is lost;
- a `line_removed` or `line_changed` that arrives after the payment, for a paid line, is rejected `already_paid` and recorded.

**Seeing open orders from other devices (12b).** `GET /sync/orders` returns the outlet's open orders with lines
(cursor by `updated_version`), and SSE nudges the tablet. The table map reads local copies, so it works offline on
what the device last saw. Until 12b, an outlet with one device (the cafe case) already works end to end, and a
restaurant with several devices sees only its own orders. **Do not pilot a multi-device restaurant before 12b.**

**Invariants added** (each gets a test and a mutant): a table order's total always equals the fold of its live lines;
two devices adding offline to one table both land (union); a paid sale never changes; a retried line event never
duplicates a line; a duplicate open order on one table is flagged, not refused; item and category codes are unique
within their scope under concurrent writes.

## Step 1 notes (what was built, and where it differs from D16 as first written)

- Migrations edited in place: `0003_menu.sql` (codes, `dining_table`, `outlet.table_mode`, triggers), `0004_trading.sql`
  (`sale.table_id`, with a composite foreign key so the table must belong to the sale's own outlet).
- **Code width is fixed at 2 + 2 in v1**, not a tenant setting: prefix matching needs one width, and widening an
  existing menu means renumbering. At most 99 live categories per tenant and 99 live items per category; the 100th
  insert fails with a plain message (`no free category code` / `no free item code`). Widening is a later decision.
- **Category codes are unique per tenant**, not per outlet menu (categories are tenant-wide), which is stricter and simpler.
- Codes are assigned by a `BEFORE INSERT` trigger when omitted, so every existing insert path (manager routes, catalog
  seeding, `scripts/seed.ts`) works unchanged. A soft-deleted category or item frees its code.
- An item moved to another category keeps its code if free there, else takes the next free one.
- Every outlet gets a default table `T1` from an `AFTER INSERT` trigger. The default table can be renamed but not
  deleted, un-defaulted or moved; **choosing a different default is not supported yet.**
- A table is versioned (pulled like the menu once step 2 sends it) and soft-delete only.
- Test impact: `apps/api/test/menu.test.ts` ("pull pages without gaps") bulk-inserted 1,100 categories, which the 99 limit
  now forbids; it now inserts 1,100 items across 12 categories. Same coverage of paging.
- Side finding: `scripts/mutation-checks.mjs` parsed TAP output, which Node 22 printed when not on a terminal and Node 26
  does not, so every mutant would have been reported BROKEN on this machine. It now passes `--test-reporter=tap`. The
  older mutants have not been re-run with the fix.
- Not done in step 1: API routes for tables and codes, the pull carrying them (step 2), any UI.

## Step 2 notes (API)

Decided with the user on 2026-11-06: **managers only** manage tables (own outlets; the platform operator does not), and
a moved item's response carries **only its new code**.

- Table routes in `apps/api/src/routes/outlets.ts`, scope `outlet`, permission `manager`: `GET/POST /outlets/:id/tables`,
  `PATCH/DELETE /outlets/:id/tables/:tableId`, `PUT /outlets/:id/table-mode`. A table is always looked up together with its
  outlet, so another outlet's table id is a 404. A new table is appended after the last; a duplicate code (any case) is 409
  `table code in use`; the default table cannot be removed (409), nor can a table with an open order (409 `table has an
  open order`). The list says which tables have an open order (`hasOpenOrder`).
- Category and item routes (`routes/menu.ts`) return and accept `code` (two digits). A typed code already taken is 409
  `code in use`; a full scope is 409 `no free code` (not a 500). `PATCH /items/:id` with a new `categoryId` returns the item
  with the code it has now.
- Pull (`routes/sync.ts`): category and item rows carry `code`; the outlet row carries `tableMode`; new `dining_table`
  rows for the device's own outlet only, removals as tombstones. The tablet stores unknown row types generically, so
  nothing broke; it does not use them yet (step 5).
- Not built, on purpose: a "next free code" suggestion endpoint (leave `code` out and the server assigns one; the screen
  can show what came back), bulk creation of tables, choosing a different default table.
- Not verified: no manager screen exists yet, so none of this has been exercised from a browser.
- Test lesson: other suites change and lock the seeded staff PINs, so a test that needs a signed-in cashier should create
  its own through `POST /users`.

## Step 3 notes (shared: v2 events and the fold)

- **Schema versions are per event type** (`packages/shared/src/events.ts`): an event's version is the version of its
  own shape. Unchanged types stay at 1; `payment.taken` is accepted as 1 or 2 (a nested discriminated union on
  `schemaVersion`); the order events exist only at 2 (`ORDER_SCHEMA_VERSION`). `EVENT_SCHEMA_VERSION` is still 1 and
  ingest still turns away everything but v1 of the six old types, so **server behaviour is unchanged until step 4**.
  Step 4 replaces ingest's single version check with "is this (type, version) known".
- Additions to the event table above: every `order.line_*` and `order.moved` event carries **`by` (user) and `at`
  (device time)**. `by` is needed for D18 ("user works here") and for the audit of removed lines. `at` orders the
  events between devices. `payment.taken` v2 carries `lines: [{lineId, qty}]` (not bare `lineIds`, because the
  payment wins), and it refuses payments that do not add up to `totalPaise`, and refuses a line listed twice.
- **The fold** (`packages/shared/src/order.ts`, `foldOrder`) is a function of the *set* of events, so delivery order and
  retries cannot change it:
  1. events are identified by (deviceId, seq); copies collapse; one (deviceId, seq) with two payloads throws;
  2. order = device time, then device id, then seq. **The tablet must keep its event time non-decreasing per device**
     (step 5), as it already does for receipt numbers; otherwise its own events could reorder;
  3. an add (and the table in `order.opened`) is a base value: a change (or move) overrides it whatever the clocks say,
     since nobody changes a line they have not seen. Between changes, or between moves, the latest wins;
  4. removal is final, and the first removal is the one recorded; lines are never dropped, only marked removed;
  5. anomalies are reported, not merged: `open_conflict`, `line_conflict` (two different adds with one lineId; the
     earliest is kept; a re-queued identical add is not a conflict), `orphan` (a change or removal whose add has not
     arrived: the server's cue to defer).
- `orderTotals` runs the counter's `totals()` over the live lines. `checkPayment(fold, lines, totalPaise)` returns one of:
  - `defer` (an unseen line);
  - `mismatch`, with the server's figure at the paid quantities;
  - `ok`, with `paid` (at the paid qty, never removed), `late` (whole unpaid lines, plus `partial` excess quantities)
    and `overridden` (paid lines another device had `removed` or `reduced`; step 4 records these `already_paid`).

  It is pure: step 4 does the writing.
- Tests in `packages/shared/test/order.test.ts`: one unit test per rule, plus three properties over 400 seeded
  histories (1 to 3 devices, up to 40 events). The properties: (a) with a shared clock the fold equals a naive replay;
  (b) with clock skew, any shuffle plus random retries (keys reordered) gives the same fold, and every added line
  appears exactly once (union); (c) the total equals the sum of the live lines, and paying for all live lines is
  accepted with no late lines. The generator is a seeded mulberry32 written in the test, so there is **no new
  dependency**. A failure names its seed.
- `scripts/mutation-checks.mjs` gained a `noDb` test option: pure-code mutants skip the fresh start (about 1.5 min each).
- `apps/api/src/ingest.ts`: the last `else` now names `print.reprinted` (the type widened). The behaviour is the same,
  because order events cannot reach that line yet.
- **Decided after review (2026-11-06): the payment wins** over a change or removal that reached the server first (see
  "Payment against a changing order"). The event shape and `checkPayment` were changed to match, in this step.

## Steps

| # | Step | Verification | State |
|---|---|---|---|
| 1 | Schema: `category.code`, `item.code`, `dining_table`, `outlet.table_mode`, `sale.table_id`, seeds, RLS on every new table, catalog import assigns codes (originals fixed in place, then `up:fresh`) | **done 2026-11-06.** After `up:fresh`: DB 39/39 (10 new in `db/test/tables.test.mjs`, plus the every-table RLS test now covering `dining_table`), API 197/197. 11 mutants (`tbl-*`, `code-*` in `scripts/mutation-checks.mjs`), 11/11 caught. No browser (no UI yet) | done, uncommitted |
| 2 | API: manager routes for tables and codes, menu pull carries codes and tables, permission and scope declarations | **done 2026-11-06.** After `up:fresh`: API 204/204 (7 new in `apps/api/test/tables.test.ts`), DB 39/39, tablet 25/25, shared 41/41, typecheck clean. 11 mutants `tblapi-*`/`codeapi-*`, 11/11 caught (two re-run after a test edit). No browser (no screen yet) | done, uncommitted |
| 2b | Tags and diet (D17): `item.diet`, `tag`, `item_tag` (versioned, RLS, pulled), manager routes, resolver carries them to the tablet, filter row (UI in step 6) | DB and API tests on real Postgres, scope tests, mutants | not started |
| 3 | Shared: v2 event types, the fold (`foldOrder`) with property tests (any order of delivery gives the same lines) | **done 2026-11-06.** Shared 53/53 (12 new in `test/order.test.ts`, 3 of them properties over 400 seeds each). Typecheck clean (shared, api, counter, admin). After `up:fresh`: API 204/204 (unchanged). 14 mutants `order-*`/`payv2-*`, 14/14 caught. After the "payment wins" change: shared 54/54, typecheck clean, the 9 payment mutants (6 new) 9/9 caught; the 9 fold mutants were not re-run (their code did not change). 18 step 3 mutants in all. No browser (no UI) | done, uncommitted |
| 4 | Server: relax `sale`/`sale_line` for open orders, ingest v1 and v2, payment rules above, N-1 | fault-injection suite extended (duplicate, reorder, drop response, two devices adding, late line after payment, remove after payment) plus mutants | not started |
| 5 | Tablet: local open orders as line events (Dexie version bump), table state, hold/move | tablet unit tests against fake-indexeddb and the real API | not started |
| 6 | UI: Sell redesign per the prototype (table strip and full map, code search with Add button, Popular row, one-tap Cash/UPI, quick cash, auto-return) | **real browser at 1024x768 and 768x1024**, offline toggle | not started |
| 7 | 12b: outlet open-orders pull and SSE nudge, so a second counter or a waiter sees the table map | two-browser test | not started |
| 8 | Playwright run of the whole counter flow against the new screens (the check owed since phase 4) | run recorded in the progress doc | not started |

### Model per step (see "Model usage plan" in CLAUDE.md; the assistant reminds you before a HIGH step)

| Step | Model | Why |
|---|---|---|
| 1, 2 | done | |
| 2b | STANDARD | follows the pattern of steps 1 and 2 |
| 3 | **HIGH** | the fold and event shapes are what every later step trusts; property tests must be right |
| 4 | **HIGH** | ingest, payment against a changing order, late-line split, trading-table triggers, fault injection: one subtle mistake double-posts or loses money |
| 5 | **HIGH for the local-database design**, then STANDARD | offline storage and outbox ordering are sync-critical; the rest is plumbing |
| 6 | STANDARD | screens from the frozen prototype; the browser check is the safety net |
| 7 | **HIGH** | a new pull channel for open orders: ordering, cursors and offline reads |
| 8 | STANDARD | scripted browser run; escalate only if it exposes a sync bug |

## Decided 2026-11-06 (PLAN D17, D18)

- A line arriving after its order was paid **splits off into a new open order on the same table**, flagged `late_lines`.
- **Any signed-in staff at the outlet, on any of its devices,** may add, change or remove lines of an open order.
  Paying and voiding keep today's rules (cashier pays; a waiter voids only their own open orders). Ingest therefore
  stops requiring `sale.device_id = p.deviceId` for `order.*` events, and checks only "same outlet, user works here".
- Menu browsing uses tags and a diet field, not nested categories (step 2b).
- **A payment wins over a line change or removal that reached the server first** (decided after step 3): payment v2
  names each line with its paid quantity, and the overridden events are recorded `already_paid`.

## Start here (handover for the next session)

Read `CLAUDE.md`, then PLAN.md section 0, then this file. Steps 1, 2 and 3 are done and verified. Next is **step 4**
(HIGH). Step 2b (STANDARD) is independent and can go first. Read "Step 3 notes" and "Payment against a changing
order" before step 4.

- Code to read first: `packages/shared/src/events.ts` (v1 events), `apps/api/src/ingest.ts` (`decide`, `saleOf`, `applySale`,
  `applyPayment`), `db/migrations/0004_trading.sql` (`sale`, `sale_line`, `sale_guard`, the payments trigger),
  `apps/counter/src/sale.ts` and `db.ts` (the tablet's local sale and outbox), `apps/api/test/sync-push.test.ts` (how
  ingest is tested and fault-injected).
- Schema consequences of D15 to plan for in step 4: `sale.total_paise > 0` and `sale_line` write-once both have to
  loosen for an `open` sale (lines get `removed_at` and a changeable `qty`; a trigger keeps the sale's money equal to the
  fold of its live lines); `sale_guard` must still freeze money once the sale leaves `open`; `saleOf` loses its
  `wrong_device` rule for `order.*` events; `payment.taken` v2 carries `lines: [{lineId, qty}]` and `totalPaise`.
- Edit the original migrations in place and `up:fresh` (CLAUDE.md, no real tenant yet).
- Gotchas found in steps 1 and 2:
  - Run `node scripts/validate.mjs fresh --yes` before the API suite, and run stages one after another (the machine is
    short of memory). The runner's "0 ok" count for node:test stages is wrong; read `.validation/<stage>.log`.
  - Do not edit source or commit while `scripts/mutation-checks.mjs` runs; it rewrites files and restores them after.
    Log it to a file and wait for the final `N/N caught` line.
  - A test that needs a signed-in cashier should create its own via `POST /users`; other suites change seeded PINs.
  - Bash heredocs containing backticks broke once here; use the Edit or Write tool for files.
  - Files under `scripts/` and some migrations use CRLF; use regex `from` patterns in mutants for multi-line text.
- Nothing is committed yet. Steps 1 and 2 are uncommitted work in the tree (see `git status`).

## Decisions still needed


- **Waiter on a handheld** is a new device kind in PLAN 5; it stays out of phase 12 unless a pilot needs it. Until then
  a waiter signs in with a PIN on a shared device.
- **Print bill / bill requested** as a state (the prototype's "Bill"): stored as a flag on the open sale, or only
  derived from a print event? Proposed: a `bill.printed` event, shown as "Bill", cleared if lines change afterwards.
- **Code width** other than 2+2 and whether the item code may ever be edited after sales exist (proposed: yes, with the
  warning; sales snapshot names, so history is unaffected).
- Whether holding an order in a cafe should be limited (proposed: no limit, but a held order older than the shift
  is auto-voided at shift close like today's abandoned orders).
