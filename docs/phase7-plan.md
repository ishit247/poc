# Phase 7: online orders (manual provider)

Scope from PLAN 19: queue, lifecycle, SSE, outbox, settlement import. Provider is `manual` only: a cashier keys in an
order read off the Zomato/Swiggy app. Real adapters are phase 9 and need Q1 answered; nothing here needs it.

## Why the existing schema does not fit

`sale` (0004) assumes a counter sale: `device_id NOT NULL`, `device_seq`, and a CHECK that a paid sale carries a
receipt number from the tablet's own per-day series. An online order is created online, by the server, and the
platform (not a till) takes the money. Drawing a receipt number from a tablet's series on the server would punch gaps
in invariant 5 whenever the tablet is offline. So:

## Decisions I am proposing (two are yours, marked *)

1. **Online orders are online-only API calls, not outbox events.** The tablet calls the server directly and shows
   "needs internet" offline (PLAN 10.7). They bypass `sync_event`.
2. **Each order is a `sale` with `channel = zomato|swiggy`** (the books stay one set), plus an `online_order` row
   (PLAN 8) with the lifecycle. Edit 0004 in place (no real tenant yet): `device_id` stays set to the counter that
   keyed it; `receipt_no`/`receipt_seq` are NULL for non-counter channels; the CHECK becomes "counter sales carry a
   receipt when paid; others never do". The platform's order id is the reference on slips and reports.
3. **\* When does it count as a sale?** Proposed: `sale.status` is `open` while `received…ready`, becomes `paid`
   (with one `aggregator` payment for the full total) at `handed_over`, and `void` on `rejected | cancelled |
   expired`. Alternative: count at `accepted`. Handover is safer for the day-close totals (a cancelled order never
   inflates a day), at the cost of an order accepted at 11:59 pm landing on the next day.
4. **\* Business date and shift.** Proposed: business date = the outlet's local date at *handover*; online sales
   belong to no cashier shift (they are not drawer cash), so `shift_id` is NULL and drawer expectations are
   unaffected. Day close already blocks on open sales dated on or before the day, so an undelivered order holds the
   day open until handed over or voided: intended.
5. **Prices** come from the `zomato`/`swiggy` channel prices already in the menu; the manual cashier may override a
   line price when the platform's price differs (flagged `price_overridden`, audited). GST as for counter sales.
6. **Realtime** is SSE per outlet (`GET /outlets/:id/online-orders/stream`), with a poll fallback. Counters need
   only a session, so the stream authenticates with the device credential and is scope-checked to the device's outlet.
7. **`integration_outbox`** is built now (retry/backoff, dedupe key) with the `manual` provider as a no-op sink, so
   phase 9 only adds adapters.
8. **Settlement import**: CSV upload by a manager; `settlement_import` + `settlement_line`; match on
   `(provider, external_order_id)`; report missing, extra, and amount mismatches. Never edits sales.

## Order of work (each step: tests on real Postgres, mutants for the gates)

1. Schema in 0004 (sale CHECK; `online_order`, `online_order_event`, `integration_outbox`, `settlement_*`; RLS;
   REVOKE UPDATE/DELETE where facts) + seed + `up:fresh` + RLS test per new table.
2. Create/list/transition API (`device` principal, scope = own outlet), lifecycle table enforced in one function,
   duplicate `(tenant, provider, external_order_id)` returns the existing order. Handover writes the payment.
3. `expired` job: unaccepted orders past `accept_by` become `expired` and void.
4. SSE stream + tablet queue screen (badge, sound, countdown to `accept_by`, Accept/Ready/Handed over, reject reason).
5. Outbox table + worker with the manual no-op provider.
6. Settlement import (API + manager screen in `apps/counter/src/manager/`).
7. Day close: online gross already has a total line; check handover-date and open-order blockers against it.
8. Real-browser check at tablet size, owed also for phases 4 to 6.

## Not in this phase

Real Zomato/Swiggy adapters, webhooks and signature checks (phase 9); item availability pushes; reports (phase 8).
