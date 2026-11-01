# Phase 7 progress: online orders (manual provider)

Plan: [phase7-plan.md](phase7-plan.md). How to check the state of the application: [validation.md](validation.md).

## Done (steps 1 to 6)

1. **Schema.** `db/migrations/0005_online.sql`: `online_order` (lifecycle trigger as the floor), `online_order_event`
   (append-only), `integration_outbox`, `settlement_import`, `settlement_line`, all with RLS. The `sale` CHECK in 0004
   now says: counter sales carry a receipt when paid, every other channel never does. Seed: one delivered Zomato and
   one open Swiggy order per tenant, plus a settlement import.
2. **API** (`apps/api/src/routes/online.ts`): create, list, read, transition. Priced from the platform channel; a keyed
   price that differs is accepted and flagged. Same `(channel, external id)` returns the existing order. Handover marks
   the sale paid with one `aggregator` payment, no receipt number, no shift. Rejected, cancelled or expired voids it.
3. **Expiry job** (`apps/api/src/jobs/expireOnline.ts`, started from `server.ts`, every 15 s). It finds overdue
   `received` orders across tenants through the SELECT-only `expiry_scan` policy (stamp `app.job`), then moves each in
   its own tenant's transaction through `moveOrder`. Actor kind `system` in the audit trail.
4. **Stream and queue.** `GET /online-orders/stream` (SSE, payload-free "changed" events, scoped to the caller's
   outlets, `apps/api/src/hub.ts`). Tablet: Online tab for cashiers (`apps/counter/src/OnlineQueue.tsx`, `online.ts`):
   badge, chime, countdown to `accept_by`, Accept / Preparing / Ready / Handed over, reject or cancel with a reason, key
   in a new order, poll fallback, refresh on reconnect and on the browser's `online` event.

5. **Outbox worker** (`apps/api/src/jobs/outbox.ts`, started from `server.ts`, every 5 s). `moveOrder` queues one
   `integration_outbox` row per move in the same transaction (`expired` sends `reject`; `preparing` sends nothing;
   unique `dedupe_key` = order id + action). The worker finds due rows across tenants through the SELECT-only
   `outbox_scan` policy (stamp `app.job = 'outbox'`, in 0005), then sends each in its own tenant's transaction with
   `FOR UPDATE SKIP LOCKED`. The `manual` sender is a no-op, so its rows go straight to `done`. A failing sender backs off
   30 s, 60 s ... capped at 1 h, and the row becomes `failed` after 8 attempts. Phase 9 adds entries to `senders`.

6. **Settlement import** (`apps/api/src/settlement.ts` parser, `apps/api/src/routes/settlement.ts`, manager screen
   `apps/counter/src/manager/Settlements.tsx` under a new `ManagerTools` tab bar). A manager uploads a platform's CSV
   (sent as JSON text, 2 MB route limit, 5000 lines, period at most 93 days). The file is read by header name; amounts
   go through `parseRupees`, never a float; any fault refuses the whole file with row numbers and writes nothing. Each
   line is `matched`, `amount_mismatch` or `unknown_order` against this outlet's orders on that platform. The report
   also lists orders we handed over in the period that the statement omits ("missing", computed on read, not stored),
   and counts lines paid by the platform for orders we did not deliver. No sale is edited. Audited as `settlement.import`.

## Decisions made (not in the original plan)

- **Settlement matching compares gross to the sale total only.** An order we rejected or expired that the platform
  paid for matches on amount and is reported separately as "paid but not delivered", not as a mismatch.
- **The sign-in button now reads "Manager tools"** (test id `mgr-open` unchanged); day close is the first tab.

- **The routes use a cashier or manager session on an enrolled tablet, not the device credential.** The sale needs a
  person (`created_by`). A user with no device gets `409 device_required`. Scope rule: `outlet`.
- **The tablet has no server session** (PIN sign-in is offline). Opening the Online tab asks for the PIN again and gets
  a session from `/device/pin-signin`, held in memory only.
- **A SECURITY DEFINER function cannot read across tenants** (row security is FORCEd for the owner too). The expiry job
  uses a stamped, SELECT-only policy instead, the same shape as the tenant lookup by host.
- **Proposals for the two open decisions were built as written:** the sale counts at `handed_over`; business date is the
  outlet's local date at handover; online sales have no shift.

## Verified

- Fresh start (`pnpm run up:fresh`) applies 0001 to 0005 and reseeds.
- API 117/117, tablet 25/25, database tests 20/20 (real Postgres).
- Mutation checks: the full run was 138 of 145 caught, the seven others INVALID (stale patterns). Those seven were
  repaired and caught. Added since, all caught: 10 for the API, 4 for expiry, 2 for the stream. The full run has not
  been repeated since these were added.
- Real browser (Edge, 1024x768 then 768x1024, production build, vite preview, API on :3000): 23/23 checks. It found one
  defect the tests missed (a stale "Needs internet" after the network returned), now fixed. The script is in the
  session scratchpad, not the repo.

- Step 6: settlement tests 8/8 on real Postgres; 19 new mutants, all caught after four tests were tightened (first
  run 14/19). Full `pnpm test` green (shared 41, tablet 25, API 131, RLS 8). Real browser (Edge, production build,
  fresh database, 1024x768 and 768x1024): 19/19, including a refused file, a quoted-comma amount, reopening an old
  import, and no sideways scroll. The script is in the session scratchpad, not the repo.
- `scope.test.ts` "withTenant stamps..." counts outlets and fails on a database other suites have used (tenant A
  gains outlets). It passes on a fresh `up:fresh`; it was not changed.

## Test fixes made on the way

- `apps/counter/test/push.test.ts`: the pull contract test read only the first page, so it failed once other suites
  had filled the shared database. It now follows `hasMore`.
- `scripts/mutation-checks.mjs`: seven stale or ambiguous mutant patterns repaired; INVALID results print as they happen.

7. **Day close** (`apps/api/src/routes/dayclose.ts`). Checked: an order still in flight blocks the close through the
   existing open-sale blocker (`business_date <= day`); a handover counts in `onlineGrossPaise` and `grossPaise` via its
   one `aggregator` payment; a handover into an already-closed day is flagged `late_arrival` and leaves the frozen totals
   alone. One gap found and fixed: `lateAdjustments` only looked at sync events, so a late online handover never showed
   on the next close. It now also accepts `online_order.status = 'handed_over'` after the previous close. Test in
   `apps/api/test/zz-online-dayclose.test.ts` (own outlet; the name makes it run last, because the extra outlet breaks
   the outlet and scope suites if it runs earlier); it fails with the fix reverted. API 132/132 on a fresh start. Online voids are not in the day's void count
   (they carry no business day); not changed.

## Still to do

8. Final browser check over the whole phase, and the browser checks still owed for phases 4 to 6.

## Known gaps

- Only Samosa has a Zomato price in the seed, and no item has a Swiggy price, so other items return `422 unknown_item`.
- The queue shows active orders only; there is no history screen yet (phase 8, reports).
- The expiry timer in `server.ts` is untested directly; the tests call `expireDueOrders()`. The browser check did watch
  the real job expire an order.
