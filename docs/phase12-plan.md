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

## Step 2b notes (diet and tags)

- Migration `0003_menu.sql` edited in place: `item.diet` (`veg`, `egg`, `non_veg`, or NULL), `tag` (name unique per tenant,
  any case, among live tags; 1 to 30 characters, no padding), `item_tag` (surrogate id, composite keys so both ends are the
  same tenant's, one live link per item and tag). Both tables are versioned, RLS, soft delete only.
- Manager routes in `routes/menu.ts` (scope `tenant`, permission `manager`): `GET/POST /tags`, `PATCH/DELETE /tags/:id`,
  `PUT /items/:id/tags` (replaces the whole set; an unknown, removed or foreign tag id is 400 and changes nothing).
  Deleting a tag, or an item, tombstones its links in the same transaction. A duplicate name is 409 `tag name in use`.
  Items (and `GET /menu`, which also lists `tags`) now carry `diet` and `tagIds`; `diet` is accepted on create and patch.
- Pull carries `diet` on item rows and new `tag` and `item_tag` rows (tenant-wide, like the menu).
- **The shared resolver is untouched, on purpose.** Tags and diet never affect price, GST, codes or the cart, and the server
  prices orders with the same `resolveMenu`. The tablet's `loadMenu` (`apps/counter/src/menu.ts`) carries `diet` and `tagIds`
  in `extras` and a sorted `tags` list; the filter row itself is step 6.
- Seeds: tenant A has tags Snack, Hot; tenant B has Quick bite, Spicy, Cold; Tea has no diet mark (unset is valid).
- `scripts/validate.mjs` `db` stage now also runs `tables.test.mjs` and `tags.test.mjs` (tables was missing from it).
- `apps/api/test/menu.test.ts` ("pull pages") lists the pulled tables by hand; `tag` and `item_tag` added.
- Not tested: that deleting an *item* tombstones its tag links (one line in `DELETE /items/:id`; no mutant). No manager screen
  to set diet or tags yet.

## Step 4 notes (server: ingest of running orders)

- **Shape: a table visit.** The sale opened by `order.opened` is the visit's **root** (`sale.order_root_id = id`). A sale split
  off for lines that arrived after a payment carries the root's id in `order_root_id` too. At most one sale of a visit is
  open (`sale_one_open_per_order`). A whole sale (v1 `sale.created`, an online order) has `order_root_id` NULL.
- **The server's rows are the fold, by construction** (`apps/api/src/order-ingest.ts`). After every order event the server
  folds *all* the visit's applied order events (renamed to the root) with the shared `foldOrder`, then rewrites the visit's
  one open sale to hold `openLines(fold, closed)` (new, pure, in `packages/shared/src/order.ts`): a line with a row on a
  paid, refunded or void sale is settled there, and only its live quantity beyond what the closed sales took stays open,
  **under the same lineId**. Money comes from the same `totals()` as the tablet, at the tenant's current settings. Every
  change to a visit runs under a row lock on its root, taken before any other sale row (also in `saleOf`, so a payment
  and a line event cannot deadlock).
- **Ingest rules** (reason codes in brackets):
  - `order.opened`: staff of this outlet [`unknown_user`], a live table of this outlet [`unknown_table`]; a second order on
    a busy table is applied and flagged `table_shared`; an identical re-queued open is applied as a no-op, anything else
    claiming the id is refused [`sale_exists`].
  - Line events and moves, from **any device of the sale's outlet** (D18) [`wrong_outlet`], by staff of the outlet
    [`unknown_user`]; the visit must not be void [`sale_void`]. An add for an unknown item is refused [`unknown_item`];
    an unavailable one is flagged `sold_unavailable`. A second, *different* add under one lineId is refused
    [`line_conflict`] (an identical one is applied and changes nothing). A change or removal whose add has not arrived
    is **deferred** (`line_not_yet_received`), or refused if that add was refused [`line_rejected`]. A change or removal
    of a settled line is refused [`already_paid`, or `sale_void`], and the rejection is in the ledger and the audit.
    A move needs an open sale in the visit [`not_open`].
  - `payment.taken` v2 is for order sales only [`not_an_order`]; v1 is for whole sales only [`order_needs_v2_payment`].
    The check runs against the paying sale's rows with `checkPayment`: a line not on it is deferred if never seen, refused if
    it is on another sale of the visit [`line_not_on_sale`]. A total that fits the tenant's settings is paid; one that fits
    other rounding settings (the manager changed them while the tablet was offline) is paid and flagged `settings_differ`;
    anything else is refused [`payment_total_mismatch`]. **The payment wins**: the paid sale's lines become the paid lines
    at the paid quantities (a removed one comes back), each override is audited `order.payment_overrode` and the sale
    flagged `payment_overrode`; unpaid live lines leave the sale and land on a new split flagged `late_lines` (audited
    `order.split`). Removed, unpaid lines stay on the paid sale as history.
  - Ingest's version check is now per type (`KNOWN` in `ingest.ts`): v1 for the six old types, v1 and v2 for
    `payment.taken`, v2 for the order events. The ledger records each event's own version.
- **Schema** (`0004_trading.sql`, edited in place): `sale.order_root_id` (immutable; an order needs a table and the counter
  channel); `total_paise >= 0` and `> 0` unless open or void; `|round_off| <= 50`; `table_id` frozen once not open.
  `sale_line` gains `line_id` (unique per sale), `added_by/at`, `removed_by/at`, and `line_total = unit x qty`. UPDATE
  and DELETE are granted again but refused by the `sale_line_guard` trigger unless the sale is open, and what a line *is*
  (item, name, price, rate, who added it) never changes. A deferred trigger keeps an order's subtotal and tax equal to
  the sums of its live lines. The ledger's entity index now leads with `entity_id` (order events come from many devices).
- Reports (`items`, `unavailable`) and `GET /orders/:id` leave removed lines out.
- **Decided here, worth a look:**
  - The unpaid excess of a raised line stays on the split **under its own lineId**, not a new one. It follows from the
    decided rule that a change to a paid line after payment is refused, but it means that excess can be paid or voided,
    not edited. A new lineId would need server-made events; it can come later if waiters need it.
  - **Paying and voiding stay with the device that opened the visit** (`wrong_device`, as before); a split takes the
    root's device. Paying another device's order needs a "paid on device" column (receipt numbers are per device);
    that belongs with 12b (step 7).
- **Open until later steps:** no tablet hears about a split until 12b (step 7). Until then an open split blocks day close
  like any open order; a cashier or manager voids it with `POST /orders/:id/void`. The tablet's shift-close auto-void
  covers only its own orders. There is still no gap check on device sequence numbers (PLAN 7.5).

## Step 5 notes (tablet: running orders in IndexedDB)

- **Local database (Dexie version 4, `apps/counter/src/db.ts`).** New table `orderEvents` keyed `[deviceId+seq]`, indexed by
  `saleId`: a copy of every order event this device wrote, kept while its order is open. Its `seq` is the **same number as
  the outbox row** (both written in one transaction; `queue()` now returns the seq), so (deviceId, seq) identifies an event
  to the fold on the tablet and on the server alike. The outbox row leaves on acknowledgement as before; the kept copy
  leaves when the order is paid or voided (the paid sale row is the record then). `sales` gains a `tableId` index;
  `LocalSale` gains `kind` (`'order'`, or absent/`'whole'` for a v1 sale) and `tableId`, and its lines an optional `lineId`.
  No upgrade function: old rows read as whole sales with no table. Meta key `eventClock` holds the last order-event time.
- **The row is the fold** (`apps/counter/src/order.ts`). Every change is one transaction: queue the event, keep the copy,
  refold the order with the shared `foldOrder` over the kept copies, rewrite the `sales` row (live lines only, totals from
  `totals()` at the settings passed in). A fold anomaly aborts the transaction: every event here came from this file, so
  one is a bug. `payOrder` pays from that row, so the v2 payment lists exactly the lines and quantities on screen.
- **Event time never goes backwards on one device** (`stamp`): max(now, `eventClock`). The fold orders by device time;
  a clock set back mid-order would otherwise reorder this device's own changes. Ties fall to seq, which is in order.
- **Operations**: `openOrder` (on the default table unless a table is given, optionally with a cart; this is "hold" in a
  cafe), `addToOrder`, `setLineQty` (0 is `order.line_removed`, never a change to 0), `removeLine`, `moveOrder`,
  `tables`, `tableMode`, `tableStates` (occupancy derived from open orders). Setting the quantity a line has, or moving to
  the table it is on, writes nothing. A busy table may take a second order (the default table always does).
- **Decided here, worth a look: the merge rule.** Adding an item that already has a live line merges (`line_changed`) only
  if **this device** added that line; otherwise it adds a new line beside it. Reason: adds are a union and changes are
  last-wins, so two waiters each adding "one more tea" to a line would otherwise lose one. The cost: one item can appear
  on two lines (and two receipt lines) when two devices added it. An explicit quantity edit stays last-wins.
- **Payment.** `payOrder` sends `payment.taken` v2 for an order (lines at shown qty, `totalPaise`), v1 for a whole sale, so
  old outboxes and old open sales still pay as before. An order with no live lines cannot be paid (void it instead).
  Shift close voids open orders too, with `sale.voided` v1 (the server accepts it for an order's own device), and drops
  their kept events.
- **Not changed in this step, on purpose:** `createSale` (Pay now, and Save) still writes a v1 whole sale; the Sell screen
  is not wired to `openOrder` yet. Step 6 switches Save/Hold to `openOrder` when it builds the new screen. Whole sales stay
  the right shape for pay-at-once counter sales (two events instead of 2 + lines).
- **For step 7:** other devices' orders can arrive as events into the same `orderEvents` table (deviceId differs), and the
  same `refold` gives the merged view; the merge rule above already looks at the device. The anomaly guard must then
  become "show, don't abort" for foreign events. Paying an order whose remote changes arrive between display and pay is
  covered by the payment winning, but the screen should show the order changed.
- Tests: `apps/counter/test/order.test.ts` (11, fake-indexeddb, no server): one per rule, a failure part-way through a
  change leaving nothing, and a property over 60 seeded histories of 25 random edits with a clock jumping both ways
  (row = naive model = fold of the kept events, total = `totals()` of the fold, no anomalies). One contract test in
  `apps/counter/test/push.test.ts` runs the real tablet code against the real API and Postgres: pull (tables, menu,
  settings), open, add, merge, change, move, push while open (the server's open sale equals the tablet row line for line),
  remove offline, pay v2, push (server paid with the same lines, total and receipt number, no flags).
- Not tested: the fold-anomaly abort (unreachable with this device's own events). No browser (no screen yet).
- Mutation lesson: the first run reported 14/14, but two were "caught" by a test that was failing on its own (the empty-
  order guard sat after `validatePayments`, which threw first with another message). Run the suite green **before** the
  mutants, and check that each mutant's catching test is the one written for it.

## Step 6 notes (Sell screen)

- `apps/counter/src/Sell.tsx` rewritten; `menu.ts` now carries category `code` and the full quick code (category + item) in
  `extras[itemId].code`; `PayDialog` takes `initialMode` and shows Exact plus quick-cash buttons.
- Two kinds of cart. **Default (cafe) mode**: an in-memory draft; Cash/UPI pays it at once with v1 `createSale`; "Hold & new"
  and "Save order" call `openOrder` on the default table; held orders show as chips and resume into the running order.
  **Map mode (restaurant)**: pick a table; its first item calls `openOrder`, then every tap is `addToOrder`/`setLineQty`.
  Paying a running order uses `payOrder` (v2).
- Code search: digits match the code prefix across the whole menu; Add (and Enter) is enabled only for one exact, available code.
  Popular row = the six most-sold items in this device's own sales (no setting). Filter row = diet marks and tags.
  After a paid receipt the screen returns to Sell by itself after 6 s.
- **Known gaps:** "Clear" on a running order removes every line (events) and leaves an empty open order, voided at shift
  close; there is no single-order void on the tablet because `sale.voided` only allows `abandoned_at_shift_close`.
  No "Print bill" state (decision still open). The strip's ‹ › scroll buttons are not built (it scrolls by touch).
  Map mode with several orders on one table shows only the first.
- **Not covered by the browser run:** the diet/tag filter row (clicked by no check), a waiter's view, a table with a
  second order, rapid double taps. The run leaves the outlet in `default` mode and adds tables T2, T3 to tenant A (reseed
  with `up:fresh` to clear). Header wraps awkwardly at 768 wide (existing, not from this step).
- Test lesson: IndexedDB live queries repaint a moment after a click, so the script waits 400 ms before reading the cart.
  Step 8 should use proper polling assertions.

## Step 7 notes (12b: other devices' open orders)

- **Cursor (`order_visit`, in `0004_trading.sql`, edited in place).** One row per table visit (root sale id, outlet,
  version). A **deferred** constraint trigger on `sale` (order sales only) stamps it with the tenant's commit-ordered
  `app.next_version` at commit. So a device that pulled to N never misses a later commit below N (as with the menu),
  and the tenant's version row is locked only between the stamp and the commit, not for the whole ingest. A trigger on
  `sale` alone sees every change: a line write always comes with a sale write (money is a cache of the lines), and
  status changes are sale writes, whether from ingest or `POST /orders/:id/void`. The app role may only read it (REVOKE).
  Not the plan's "updated_version on sale": `sale` is not versioned, and making it so would put every sale write in the
  tenant behind one lock for the whole transaction.
- **`GET /sync/orders?cursor=&fresh=`** (scope outlet, permission device; `routes/sync.ts`). One statement, so one
  snapshot. Each changed visit of the device's own outlet is sent **whole**: every *applied* order event (any device),
  the lines its closed sales took (`closed`), the open sale's id and device, and every sale's status. A visit with no
  open sale is sent with `open: null`. `fresh=1` (a tablet that holds no visits yet, for every page of its first pass)
  skips closed visits. That can't be inferred from cursor 0, because page 2 of a first pass has a cursor above 0; a
  test caught exactly that. 100 visits a page.
- **`GET /sync/orders/stream`**: payload-free SSE ("changed"), same pattern as the online queue. `hub.ts` is keyed by topic
  (`orders:<outlet>`). Published after `/sync/push` applies anything, and after the online void route.
- **Tablet (Dexie version 5, `visits` table keyed by root, indexed by open sale id).** The pulled visit is stored as sent,
  so the cursor can move past it safely. What the screen shows is derived (`refold` in `apps/counter/src/order.ts`):
  `openLines(foldOrder(server events ∪ this device's kept events), closed)`, the server's own construction. Copies
  collapse by (deviceId, seq), so the echo of our own pushed event is not a second line.
  - Another device's order is a **view** on the `visits` row (`ownerDeviceId` set), **never a `sales` row**: shift close
    voids every open `sales` row, and receipts and cash totals read `sales`. Anyone may add, change, remove or move its
    lines (D18; events name the visit's root). Pay is refused ("take payment there"); the Sell screen disables Cash and UPI
    and says so.
  - This device's own visit stays a `sales` row; lines other devices added appear in it, so the payment lists them.
  - **A split** the server made after our payment (late lines) becomes a new open `sales` row on this device (id = the
    split, `rootId` = the root). Paying it names the split; its events name the root; kept events are filed under the
    root, so payment and shift close now delete by root.
  - **A closing this device has not sent yet wins**: if the local row is paid or void, a pull that still shows the visit open
    changes nothing. When the closing lands the visit changes, so the next pull brings the result (closed, or a split).
  - A sale this device shows open that the server says is void (a manager, online) is voided here.
  - The fold-anomaly guard is now "throw if every event is this device's own (a bug); otherwise show it" (`anomalies` on the
    row). The server refuses conflicting adds, so this should not happen.
  - Pulled payloads go through `OrderEvent.parse`; a page that does not parse is not applied (cursor unchanged).
- **When it pulls**: after every sync (push, menu pull, orders pull), on the stream's nudge, and on reconnect. `pullOrders`
  runs one at a time, so an older page can't be written over a newer one. New in `App.tsx`: a sync 0.8 s after the outbox
  grows. Before this, an order change waited for the 60 s timer, which would have made the map up to a minute stale on
  other devices. `sync` is now single-flight.
- **Not built in step 7: paying another device's order.** Built in step 7b (below). Voiding another device's order: step 7c.
- **Known gaps:** the Orders tab lists this device's open orders only; a table with two orders still shows only the first (step 6
  gap); this device's own *rejected* order events stay folded into its row (as before step 7); a parked rejected payment
  leaves the local row paid while the server's stays open (as before).
- **Not mutation-tested:** the trigger being *deferred* (an immediate trigger makes the late-commit test hang, not fail),
  the publish from the online void route, `pullOrders` running one at a time, the tablet's `fresh`/`ordersPrimed` logic
  (covered by the browser run, not a mutant), and the lock-held-only-at-commit performance property.
- **Found while verifying:**
  - The SSE test left its streams open when an assertion failed, so `app.close()` waited forever and the `ov-no-nudge`
    mutant hung the mutation run (caught, but never finished). Streams are now closed in `finally`, with
    `closeAllConnections()`. Any future test of a hijacked stream must do the same.
  - Stopping `mutation-checks.mjs` from outside (not Ctrl-C) leaves the current mutant in the source. After a stop, check
    the mutated line is back before anything else.
  - The step 3 tablet contract test opened on the default table and moved to "the first non-default table". The API suite
    leaves about 17 open orders on School 1's default table, so after the API suite it saw `table_shared`. Step 5's 37/37
    had run straight after a fresh seed. It now uses two tables of its own.
  - The every-table RLS test needs tenant B rows in `order_visit`: the seed adds one empty, voided past table visit per
    outlet (no table is left busy).
  - The browser scripts need a fresh seed (the API suite changes seeded PINs): run `fresh`, then the browser scripts.

## Step 7b notes (paying another device's order)

- **Rule.** A table order (`order_root_id` set) may be paid by a cashier on **any device of its outlet**. The money and
  the receipt belong to the device that paid: the receipt number is from the payer's own series, the payment is in the
  payer's shift (so the payer's drawer count balances), and `sale.paid_device_id` records the payer. A whole (v1) sale is
  still paid where it was rung up. **Voiding stayed with the opener** (`wrong_device`; relaxed in step 7c for `order.voided`,
  the shift-close `sale.voided` still is); a reprint is of the payer's receipt,
  so it is the payer's (`wrong_device` elsewhere). A device of another outlet is refused (`wrong_outlet`).
- **Schema** (`0004_trading.sql`, `0001_tenancy.sql`, edited in place):
  - `sale.paid_device_id`, set by ingest on every payment.
  - A foreign key to `device(tenant_id, outlet_id, id)`, which is a new unique key on `device`. The payer must be a
    device of the sale's own outlet; a device's outlet never changes.
  - It is frozen once the sale leaves `open`, and is only set with a receipt.
  - The receipt uniqueness is now `(COALESCE(paid_device_id, device_id), business_date, receipt_seq)`. NULL reads as the
    opener, for rows written before (fixtures). Use the same COALESCE wherever "whose receipt series" is meant.
- **Changed to follow the payer:** the day-close receipt-gap check (`dayclose.ts`) and the sales-by-counter report
  (`reports.ts`): the counter that took the money is credited. Shift expected cash already followed the payer (payments
  are joined by `sale.shift_id`, the payer's shift).
- **Two devices paying one order.** The visit's root lock serializes them; the second is refused `already_paid`, and the
  first payment stands (tested both ways). The tablet that lost still shows its row paid with a receipt it printed,
  and a parked rejected event. This is the "parked rejected payment" gap from step 7, now possible across devices: the
  counted drawer is over by that amount and the manager sees the rejection. Only cashiers pay, so it needs two cashiers
  to take the same table's money while one is offline.
- **Tablet** (`sale.ts` `payOrder`, `order.ts`):
  - Paying a view makes it this device's paid `sales` row (no `ownerDeviceId`) on this device's receipt counter, and
    drops the view. Kept events are deleted by root as before.
  - `refold` now returns nothing when this device holds a paid or void row with that sale id, *whoever opened the visit*.
    So a pull that comes before the payment lands cannot reopen the view.
  - On the opener's tablet, a pull showing its open sale as paid (by another device) **deletes** its row. A paid row of
    this device would never be open, so the money and receipt are not this device's. Unpaid lines it added later come
    back as its own split, as before.
  - The Sell screen enables Cash and UPI on another device's order and says the receipt and drawer will be this counter's.
- **Known gaps:** the opener's Sell screen just finds the table free when its order was paid elsewhere (no "paid at C2"
  note); ~~voiding another device's order is still not possible~~ (step 7c); the tablet does not undo a payment the server refused.

## Step 7c notes (voiding an open order from any device of the outlet)

- **Rule (agreed 2026-11-06), the same as the online void (`ORDER_SCOPE`):** a **cashier** on any device of the outlet may
  void any open table order there; a **waiter** only an order they opened (`sale.created_by`), from any device. A reason is
  required. A manager voids online (`POST /orders/:id/void`, day-close screen); no tablet signs a manager in, so ingest
  accepts cashiers and waiters only. Offered on the Sell screen for this device's own orders too (before 7c a tablet
  had no Void at all; the only tablet void was the automatic one at shift close).
- **Event `order.voided` v2** (`packages/shared/src/events.ts`): `saleId` (the open sale: the root, or a split, as a payment
  names it), `voidedBy`, `reason` (trimmed, 1 to 200), `at`. In `OutboxEvent`, not in `OrderEvent`: it closes a sale like a
  payment and is not folded. `sale.voided` v1 stays for the shift-close void, opener only, unchanged.
- **Ingest** (`apps/api/src/ingest.ts`, `applyOrderVoid`): `saleOf(…, 'void')` locks the root then the sale, and for a table
  order checks only the outlet (`wrong_outlet`); a whole (v1) sale stays opener-only, as with paying. Then: `voidedBy` must
  be a cashier or waiter of this outlet (`unknown_user`); a waiter on someone else's order is `not_own_order`; the status
  must still be `open` (`not_open` after a payment, `already_void`). **The payment wins in both orders of arrival:** a void
  after it is `not_open`; a payment after the void is `sale_void` (unchanged rule in `applyPayment`); later line events are
  `sale_void` (unchanged). A retry is `duplicate` by event id. Audit `order.voided`, actor the user, detail `reason`, `at`,
  `deviceId` (the voiding device), `openedOnDeviceId`, `rootId`. The push publishes the outlet's SSE nudge as for any applied event.
- **Tablet** (`apps/counter/src/order.ts` `voidOrder`, `Sell.tsx`): one transaction queues the event (after any unsent
  line events of this device, so they reach the server first) and records the closing here: the row becomes a **void
  `sales` row** (for another device's order too, as paying makes a paid one in 7b), kept events are deleted by root, and
  the view is dropped. So `refold` cannot reopen it from a pull made before the void lands. The Sell screen shows "Void
  order" when the signed-in person may void the order on screen, then a required reason, "Void", "Cancel"
  (`void-order`, `void-reason`, `void-go`, `void-cancel`).
- **The opener's tablet** needed no change: a pull showing its open sale `void` already voids its row (written for the
  online manager void in step 7), and a visit with no open sale drops its kept events. Tested for 7c with an unsent line.
- **Known gaps:** an opener that pays offline while another device voids loses the race the other way round (the void
  landed first): its payment is refused `sale_void` and it keeps a local paid row and printed receipt, the same parked
  rejected payment as in 7b; the manager sees the rejection. Likewise, its unsent line events on that order are parked
  `sale_void`. The opener's Sell screen just finds the table free (no "voided at C2 by …" note). Day close lists the voided
  order's reason only in the audit, not on a screen.
- **Verified 2026-11-07**, after `fresh`: API 239/239 (4 new in `running-orders.test.ts`), tablet 54/54 (3 new in
  `visits.test.ts`), shared 55/55, typecheck clean (shared, api, counter); DB not re-run (no schema change); 13 mutants (`vo-*`, `tab-void-*`, retargeted `pd-opener-only` and re-run `pd-any-outlet`), 13/13 caught.
  `browser-tables.mjs` 39/39 (10 new: the counter voids the waiter tablet's order with a required reason, it drops off the
  waiter's tablet, the waiter gets no Void on the counter's order, the counter voids its own, server rows and audit),
  `browser-sell.mjs` 27/27, `browser-flow.mjs` 44/44. The first `browser-flow` run (just after midnight) failed at the
  online order's "accepted" step (timeout); a re-run after `fresh` passed 44/44. Not explained; this change does not touch
  the online queue. Watch for it.

## Step 8 notes (whole counter flow in a real browser)

- **Script:** `scripts/browser-flow.mjs` (Playwright, installed Edge, headless, 1024x768, Docker stack on :8080). Run
  `node scripts/validate.mjs fresh --yes` first: the script closes today's business day for School 1, so a second run
  without a fresh seed fails at day close. Log `.validation/browser-flow.log`, screenshots `.validation/screens/flow-*.png`.
  Assertions poll (`until`) instead of fixed waits, and the end state is checked in Postgres, not only on screen.
- **Result 2026-11-06: 41/41** (after a fresh seed). One tablet, one business day:
  - enrol, PIN sign-in, open the drawer;
  - diet and tag filter row (only this tenant's tags; a tag and a diet filter show only matching items; clearing restores);
  - quick-code add, cash and UPI sales with consecutive receipts;
  - a saved order paid from the Open orders tab; reprint shown as a copy, `print()` called once, `sale.reprinted` in `audit`;
  - **offline:** two sales queue; the page **reloads with no network** (service worker), **offline PIN sign-in** works, the
    outbox survives the reload, and drains on reconnect (about 0.2 s);
  - **tab killed mid-push:** the push reaches the server, the response is dropped, the tab closes; a new tab resends and
    drains, and the sale exists once, paid;
  - **receipt gap:** one offline sale's events are deleted from IndexedDB, the next sale syncs; day close names the
    missing receipt number;
  - online order (manual provider): new, accept, ready, hand over;
  - shift close: slip with cash sales, counted cash and variance; the server has the shift closed with the count;
  - server state: every receipt but the lost one, in order, all paid; no rejected `sync_event`;
  - manager on the tablet: force-closes a forgotten drawer, gross on screen equals the server's paid sales, closes the
    day (`business_day.closed_at` set), Reports loads; no sideways scroll; no page errors.
- **Found:**
  - ~~A past-day open order blocks day close, and no screen can clear it.~~ **Fixed 2026-11-06.** The day-close
    blockers now carry `openOrders` (the same rows as the `openSales` count, first 50: date, table, channel, total, who
    opened it, live lines), and `apps/counter/src/manager/VoidOrder.tsx` shows each one in the day-close screen with
    Void and a required reason, calling the existing `POST /orders/:id/void` (no new route); the blocker reloads after.
    An online (Zomato/Swiggy) open order is listed but not voidable there: its state lives in the online queue, and
    voiding only its sale would leave the online order "received" (unaccepted ones are expired and voided by the
    server's job). Verified: API 235/235 after `fresh` (1 new test in `apps/api/test/zz-online-dayclose.test.ts`:
    only this outlet's open orders are listed, with live lines only, not later-dated ones; another outlet's manager gets
    404 for the void and the preview; a paid order 404; the void writes `order.void` with the reason and the manager as
    actor; the blocker clears and the day closes; voiding twice 404). Mutants `dayclose-list-any-outlet`,
    `-voided-too`, `-any-date`, `-removed-lines`: 4/4 caught. `browser-flow.mjs` step 11 now voids the seed's stale
    order through the screen: **44/44** (3 new checks: listed with its lines, void needs a reason, blocker clears and
    the audit row exists).
  - Day close lists two tablets on one counter as "Counter C1" twice (no label), so a manager cannot tell which one is
    which. Cosmetic until a counter has two tablets.
  - Only Samosa has a Zomato price in the seed; the New online order dialog correctly refuses an unpriced item.
- **Not covered:** portrait size in this script (step 6 covers 768x1024), restaurant map mode (steps 6, 7, 7b scripts),
  printing on hardware, a storage-pressure or `storage.persist()` check on a real tablet, the N-1 upgrade path, refunds
  (no route). This is a scripted run, not a guard: no mutants. The kill-tab check would also pass if the server's
  unique receipt index alone stopped a duplicate; the event-id idempotency is proven by the phase 4 API tests and mutants.

## Steps

| # | Step | Verification | State |
|---|---|---|---|
| 1 | Schema: `category.code`, `item.code`, `dining_table`, `outlet.table_mode`, `sale.table_id`, seeds, RLS on every new table, catalog import assigns codes (originals fixed in place, then `up:fresh`) | **done 2026-11-06.** After `up:fresh`: DB 39/39 (10 new in `db/test/tables.test.mjs`, plus the every-table RLS test now covering `dining_table`), API 197/197. 11 mutants (`tbl-*`, `code-*` in `scripts/mutation-checks.mjs`), 11/11 caught. No browser (no UI yet) | done, uncommitted |
| 2 | API: manager routes for tables and codes, menu pull carries codes and tables, permission and scope declarations | **done 2026-11-06.** After `up:fresh`: API 204/204 (7 new in `apps/api/test/tables.test.ts`), DB 39/39, tablet 25/25, shared 41/41, typecheck clean. 11 mutants `tblapi-*`/`codeapi-*`, 11/11 caught (two re-run after a test edit). No browser (no screen yet) | done, uncommitted |
| 2b | Tags and diet (D17): `item.diet`, `tag`, `item_tag` (versioned, RLS, pulled), manager routes, resolver carries them to the tablet, filter row (UI in step 6) | **done 2026-11-06.** After `up:fresh`: DB 22/22 (the `tags`, `tables` and `rls` files; 4 new in `db/test/tags.test.mjs`), API 209/209 (5 new in `apps/api/test/tags.test.ts`), tablet 25/25, typecheck clean. 12 mutants `tag-*`/`tagapi-*`, 12/12 caught (one survivor, the cross-tenant link key, led to a test fix and was re-run). No browser (no screen yet) | done, uncommitted |
| 3 | Shared: v2 event types, the fold (`foldOrder`) with property tests (any order of delivery gives the same lines) | **done 2026-11-06.** Shared 53/53 (12 new in `test/order.test.ts`, 3 of them properties over 400 seeds each). Typecheck clean (shared, api, counter, admin). After `up:fresh`: API 204/204 (unchanged). 14 mutants `order-*`/`payv2-*`, 14/14 caught. After the "payment wins" change: shared 54/54, typecheck clean, the 9 payment mutants (6 new) 9/9 caught; the 9 fold mutants were not re-run (their code did not change). 18 step 3 mutants in all. No browser (no UI) | done, uncommitted |
| 4 | Server: relax `sale`/`sale_line` for open orders, ingest v1 and v2, payment rules above, N-1 | **done 2026-11-06.** After `up:fresh`: DB 45/45 (2 new in `db/test/trading.test.mjs`), API 222/222 (13 new in `apps/api/test/running-orders.test.ts`: duplicate and doubled batch, reorder and deferral, two devices adding concurrently, late line after payment, remove/change after payment, the payment winning, settings drift, v1/v2 mixing, void, move, and a property over 12 seeded two-device histories delivered in random order with retries: server rows = `foldOrder`), shared 55/55, tablet 25/25, typecheck clean. 52 mutants run (43 new `order-*`/`ro-*`, plus the retargeted and touched ingest ones): 50 caught at first; `ro-pay-keeps-unpaid` survived, which exposed a missing case (a whole line that reached the server before the payment, but was not in it). That test was added and the mutant re-run and caught; `ro-removed-counts-as-taken` was an equivalent mutant and was dropped. No browser (no UI) | done, uncommitted |
| 5 | Tablet: local open orders as line events (Dexie version bump), table state, hold/move | **done 2026-11-06.** After `up:fresh`: tablet 37/37 (11 new in `apps/counter/test/order.test.ts`, one a property over 60 seeded histories; 1 new real-API contract in `test/push.test.ts`), counter typecheck clean. 14 mutants `tab-ord-*`/`tab-pay-*`/`tab-shift-*`, 14/14 caught (two re-run after a guard fix, see notes). API, DB and shared suites not re-run (no server or shared code changed). No browser (no screen yet) | done, uncommitted |
| 6 | UI: Sell redesign per the prototype (table strip and full map, code search with Add button, Popular row, one-tap Cash/UPI, quick cash, auto-return) | **real browser at 1024x768 and 768x1024**, offline toggle | **done 2026-11-06, browser-verified.** `node scripts/browser-sell.mjs` (Playwright, installed Edge, Docker stack on :8080 rebuilt): 27/27 at 1024x768 and 768x1024, log in `.validation/browser-sell.log`, screenshots in `.validation/screens/`. Covers code search and Add, hold/resume, edit and quick-cash pay of a running order, UPI, a sale offline, restaurant table strip and map, no sideways scroll, no page errors. Tablet tests 37/37, typecheck clean. No mutants (UI, not a guard) | done, uncommitted |
| 7 | 12b: outlet open-orders pull and SSE nudge, so a second counter or a waiter sees the table map | two-browser test | **done 2026-11-06, browser-verified.** `node scripts/browser-tables.mjs` (two Edge contexts, two devices: cashier 1024x768, waiter 768x1024, map mode, Docker stack rebuilt): 24/24, log in `.validation/browser-tables.log`. Covers the other device's order appearing with no sync pressed (under 1 s), adds both ways with the same total, an offline device's line arriving on reconnect, payment refused on the other device's order, paying its own order with the other device's line, the table freeing on both. `browser-sell.mjs` re-run 27/27. After `up:fresh`: DB 45/45, API 230/230 (8 new in `apps/api/test/orders-pull.test.ts`), tablet 49/49 (11 new in `test/visits.test.ts`, one a property over 40 seeds; 1 new two-device real-API contract in `test/push.test.ts`), typecheck clean. 20 mutants (`ov-*`, `vis-*`, 3 retargeted `tab-*`), 20/20 caught. Shared not re-run (unchanged) | done, uncommitted |
| 7b | Paying another device's order: any cashier device of the outlet pays a table order, on its own receipt series and shift (`sale.paid_device_id`) | two-browser test | **done 2026-11-06, browser-verified.** `scripts/browser-tables.mjs` 29/29: the counter pays the waiter tablet's order (3 lines, one added offline), the table frees on the waiter's tablet, the counter's next receipt is the next number in its series, and the server row says paid on the counter, on its receipt. `browser-sell.mjs` 27/27. After `up:fresh`: DB 46/46 (1 new), API 234/234 (4 new in `running-orders.test.ts`: payer's receipt/shift/cash, void and reprint rules, both paying, per-payer series and day-close gaps, counter report, another outlet), tablet 51/51 (2 new in `visits.test.ts`; the two-device contract now pays across devices against the real API), typecheck clean. 19 mutants (`pd-*`, `vis-*`, 2 retargeted phase 4 ones), 19/19 caught. Shared not re-run (unchanged) | done, uncommitted |
| 7c | Voiding an open order from any device of the outlet: a cashier any, a waiter only their own, with a reason (`order.voided` v2) | ingest tests, mutants, two-browser test | **done 2026-11-07, browser-verified.** See "Step 7c notes" | done, uncommitted |
| 8 | Playwright run of the whole counter flow against the new screens (the check owed since phase 4) | run recorded in the progress doc | **done 2026-11-06, browser-verified.** `node scripts/browser-flow.mjs` after `fresh`: 41/41 (see "Step 8 notes"). Found: no screen to void a past-day open order, which blocks day close. No unit suites re-run (no app code changed) | done, uncommitted |

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
| 7c | **HIGH** | ingest and authorization: who may close another device's order |
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

Read `CLAUDE.md`, then PLAN.md section 0, then this file. Steps 1 to 8, 2b, 7b and 7c are done and verified (7 and 7b with
a two-browser run, 8 with `scripts/browser-flow.mjs`, 41/41). Step 8 is uncommitted.

Phase 12's steps are all done, and the day-close void screen (step 8 notes, "Found") is built and browser-checked.
Voiding another device's order is built (step 7c). Open before a pilot: two cashiers paying one table while one is offline
(step 7b notes), and its 7c twin, a payment taken offline on an order another device voided. Then PLAN.md 0.3 item 3.

The notes below were written for step 4 and are kept for reference.

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
