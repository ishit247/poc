<meta charset="utf-8">

# Refunds — plan

Status: **steps 1 to 3 done 2026-11-15.** Model plan: **HIGH** (money, the cash drawer, sync,
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

## What step 2 built

- **One rule:** `expectedCash(opening, payments, refunds)` in `packages/shared/src/shift.ts` takes the refunds as a
  required argument and subtracts their cash part. A refunded sale's payments stay in `payments` on both sides.
- **Server:** shift close (`ingest.ts`) and force-close (`routes/dayclose.ts`) pass `refundsOf(c, shiftId)`
  (`apps/api/src/refunds.ts`). Both lock the shift first, as the route does, so no refund lands after a close.
- **Schema:** `refund` gained `version`/`updated_at` (`app.make_versioned`, in 0004 in place) and an index on
  `(device_id, version)`. Pull sends a tablet its own refund rows (`type: 'refund'`, one per method).
- **Tablet:** `LocalSale` has status `refunded` and `refunds[]`. `apps/counter/src/refund.ts`: `whyNotRefundable`
  (the route's rule mirrored, plus "not yet sent"), `refundSale` (calls the route, stores the answer), `applyRefund`
  (merge by method; used by the answer and by pull). The slip counts refunded sales as taken and lists `Refunded (n)`:
  cash from drawer, UPI paid back.
- **Tests:** `packages/shared/test/shift.test.ts`, `apps/api/test/refunds.test.ts` (force-close, pull scope, no
  refund after close), `apps/counter/test/refund.test.ts` (slip = server on close, lost answer repaired by pull,
  manager close, offer rule). Mutants `refund-cash-kept-in-drawer`, `refund-*-ignored`, `refund-of-any-shift`,
  `refund-pull-any-device`, `tab-refund-*`.

## What step 3 built

- **Tablet, Orders → Recent receipts** (`Orders.tsx`): lists paid and refunded bills. Each row has a plain Refund button
  in one slot, disabled with the reason as its title (`whyNotRefundableEach` in `refund.ts`: one read of the drawer and
  the outbox for the whole list, the same rule as `whyNotRefundable`). A refunded bill is tagged Refunded; its Refund
  and Reprint are disabled.
- **Dialog** (`RefundDialog.tsx`): names the payout by method (`refundByMethod`, mirroring the route's grouping of
  payments), takes a reason and the PIN. One PIN entry: `signInOnline` opens the session, then `refundSale` sends the
  same PIN for the route's re-check. A wrong PIN or no network refunds nothing and says so.
- **Reasons:** the manager keeps a list (Settings → Selling rules, one per line; `tenant_setting.refund_reasons`, up to
  10 of up to 60 characters, case-insensitively unique; in `TradingSettings`, pulled with the other settings). The
  dialog offers it as a combobox (`<datalist>`) and as tap buttons; a typed reason is still allowed. The PIN field is
  `type="text"` masked by CSS (`.pin-mask`): with a password field present, the browser treated the dialog as a login
  form and filled a saved email into Reason.
- **Refund slip** (58 mm): `renderRefundSlip` in `packages/shared/src/shift.ts`, shown with Print after the server
  answers. Its time is the tablet's clock at the answer; the server's `refunded_at` is the record.
- **Day close:** the drawer row sums `refund` cash by shift in the query (`refundedCash`, no schema change; the frozen
  totals carry it) and the Shifts table shows "(after ₹x cash refunded)" next to Expected.
- **Tests:** `packages/shared/test/shift.test.ts` (refund slip), `apps/counter/test/refund.test.ts` (list rule, a
  rejected outbox row does not block, payout by method), `apps/api/test/refunds.test.ts` (day-close `refundedCash`).
  Browser: `scripts/browser-refund.mjs` (1024x768 cash refund, 820x1180 UPI refund, each through the shift close).
  Mutants: `tab-refund-list-ignores-drawer`, `tab-refund-unsent-rejected`, `refund-dayclose-upi-as-cash`,
  `refund-slip-total-wrong`; `tab-refund-unsent` and `tablet-recent-includes-open` updated.
- Still true: a slip printed while a refund's answer was lost is short by that refund until a pull; the server's
  figure is right.

## Remaining design

1. *(Moot for the cashier rule: the drawer is the caller's own open shift.)*
2. *(Built in step 1.)*
3. *(Built in step 1.)*
4. **Expected cash.** `expectedCash` gains the cash refunds paid out of that shift (one function, both sides). Server:
   shift close (`ingest.ts`) and force-close (`routes/dayclose.ts`) read `refund` rows for the shift. Tablet: the
   refund response is stored locally against the open shift, so the slip agrees with the server without a pull; a
   pull change covers a refund the tablet missed the answer to.
5. *(Moot for the cashier rule: day close refuses while a shift is open, so the day is always open.)*
6. *(Built in step 3; see above.)* **Screens.** The cashier's sales list for the open shift (`Orders.tsx` / `Shift.tsx`): Refund on a paid sale, a
   reason, a confirmation naming the amount by method ("₹6.00 cash from this drawer, ₹4.50 UPI to pay back"), then the
   PIN. Mirror the rule in the route's comment: offer it only for this tablet's open shift. Day close: refunds line
   exists; add cash refunds to the drawer section. Receipt: optional refund slip (58 mm).
7. *(Built: close, force-close and slip = server in step 2; the browser run in step 3, `scripts/browser-refund.mjs`.)*
8. **Later:** a manager path for another cashier's or a closed shift's sale (see Decided).

## Steps

| # | Step | State |
|---|------|-------|
| 1 | Schema, seed, route, API and DB tests, mutants | done 2026-11-15 |
| 2 | `expectedCash` with refunds: server close paths, tablet store and slip; tests and mutants | done 2026-11-15 |
| 3 | Cashier screen, refund slip, day-close drawer line; browser check | done 2026-11-15 |
