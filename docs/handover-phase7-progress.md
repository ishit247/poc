# Phase 7 progress: online orders (manual provider)

Plan: [phase7-plan.md](phase7-plan.md). How to check the state of the application: [validation.md](validation.md).

## Done (steps 1 to 4)

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

## Decisions made (not in the original plan)

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

## Test fixes made on the way

- `apps/counter/test/push.test.ts`: the pull contract test read only the first page, so it failed once other suites
  had filled the shared database. It now follows `hasMore`.
- `scripts/mutation-checks.mjs`: seven stale or ambiguous mutant patterns repaired; INVALID results print as they happen.

## Still to do

5. Outbox worker with the manual no-op provider (table exists).
6. Settlement import: API and manager screen in `apps/counter/src/manager/`.
7. Day close: check handover-date and open-order blockers against online gross.
8. Final browser check over the whole phase, and the browser checks still owed for phases 4 to 6.

## Known gaps

- Only Samosa has a Zomato price in the seed, and no item has a Swiggy price, so other items return `422 unknown_item`.
- The queue shows active orders only; there is no history screen yet (phase 8, reports).
- The expiry timer in `server.ts` is untested directly; the tests call `expireDueOrders()`. The browser check did watch
  the real job expire an order.
