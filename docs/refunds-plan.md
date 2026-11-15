<meta charset="utf-8">

# Refunds — plan

Status: **step 1 done 2026-11-15; steps 2 and 3 not started.** Model plan: **HIGH** (money, the cash drawer, sync,
authorisation).

## Decided (PLAN 17 Q15, revised 2026-11-15; 7.6; invariant 4)

- A whole paid **counter** sale only: `paid → refunded`. No partial refunds. Online sales are refunded by the platform.
- By **the cashier of the open shift that took the payment**, on that shift's tablet, after **typing their PIN
  again**, with a reason. **Online only.** Audited (`sale.refund`; a wrong PIN is `refund.pin_failed`).
- **Cash** goes back out of the drawer it went into (that shift's expected cash drops). **UPI** is recorded as paid
  back outside the app (no drawer effect). A split sale gets one refund row per method.
- A paid sale is never edited (invariant 4): the refund is a new row; the sale's status moves to `refunded`.
- Not refundable yet: sales of another cashier's shift, of a closed shift, or of a closed day. A manager path for
  those is a later decision (it reopens design points 1 and 5 below, which the cashier rule made moot).

## What step 1 built

- **Schema** (`db/migrations/0004_trading.sql`, edited in place): `refund(id, tenant_id, sale_id, method cash|upi,
  amount_paise, reason, shift_id, device_id, refunded_by, refunded_at)`, `UNIQUE (sale_id, method)`, a cash refund must
  name its shift and tablet; RLS; `REVOKE UPDATE, DELETE, TRUNCATE`. `app.assert_sale_payments` (deferred, at commit)
  now also holds: only a refunded sale has refunds, and a refunded sale's refunds equal its payments **method by
  method**. Trigger `refund_sale_ck` runs it on every refund insert.
- **Route** `POST /sales/:id/refund {reason, pin}` (`apps/api/src/routes/refunds.ts`), scope `shift-owner`,
  permission `till`. In order, all before any write: a PIN session on a tablet (a web session gets 403); the PIN
  against the caller's own verifier with the sign-in lockout (`PIN_MAX_FAILED`/`PIN_LOCK_MINUTES` from `auth.ts`,
  same counter; wrong 403, locked 423); the sale's shift is the caller's, open, on this tablet, at one of their
  outlets, and the sale is a counter sale (else 404, the same body as a missing id); `status = 'paid'` (else 409,
  `already refunded` or `only a paid sale can be refunded`). Then the refund rows (from the payments, grouped by
  method), the status, the audit. Lock order shift → sale, as ingest. Publishes the outlet's orders topic after commit.
- **Seed**: one UPI-refunded sale per outlet (`C1-20260101-0002`) in the seeded open shift.
- **Tests**: `apps/api/test/refunds.test.ts` (happy split, twice, open/void, missing reason/PIN, wrong PIN and lock,
  six "whose" cases, waiter and web manager), `db/test/trading.test.mjs` (refund invariant). Mutants `refund-*` in
  `scripts/mutation-checks.mjs`.

## Gaps until step 2

- `expectedCash` does not yet subtract cash refunds, so a drawer that paid a cash refund closes **short** by that
  amount on both server and slip. No screen calls the route yet, so this cannot happen outside tests.

## Remaining design

1. *(Moot for the cashier rule: the drawer is the caller's own open shift.)*
2. *(Built in step 1.)*
3. *(Built in step 1.)*
4. **Expected cash.** `expectedCash` gains the cash refunds paid out of that shift (one function, both sides). Server:
   shift close (`ingest.ts`) and force-close (`routes/dayclose.ts`) read `refund` rows for the shift. Tablet: the
   refund response is stored locally against the open shift, so the slip agrees with the server without a pull; a
   pull change covers a refund the tablet missed the answer to.
5. *(Moot for the cashier rule: day close refuses while a shift is open, so the day is always open.)*
6. **Screens.** The cashier's sales list for the open shift (`Orders.tsx` / `Shift.tsx`): Refund on a paid sale, a
   reason, a confirmation naming the amount by method ("₹6.00 cash from this drawer, ₹4.50 UPI to pay back"), then the
   PIN. Mirror the rule in the route's comment: offer it only for this tablet's open shift. Day close: refunds line
   exists; add cash refunds to the drawer section. Receipt: optional refund slip (58 mm).
7. **Tests still owed.** Expected cash on close and force-close with a cash refund; tablet slip matches the server.
   Browser: refund on a tablet at 1024 and 820, then close the drawer.

## Steps

| # | Step | State |
|---|------|-------|
| 1 | Schema, seed, route, API and DB tests, mutants | done 2026-11-15 |
| 2 | `expectedCash` with refunds: server close paths, tablet store and slip; tests and mutants | not started |
| 3 | Cashier screen, refund slip, day-close drawer line; browser check | not started |
