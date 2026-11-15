<meta charset="utf-8">

# Discounts — plan

Status: **steps 1 and 2 done 2026-11-15 (server, shared rule, schema; tablet, receipt, slip, Settings); step 3 (reports, day close) next.** Model plan: **HIGH** for steps 1 and 2 (money arithmetic, GST,
sync events, ingest); STANDARD for step 3.

## Decided (PLAN 17 Q17, 2026-11-15)

- **One kind: a bill discount, given at Pay**, as a percentage or a flat ₹ amount, on a **counter** sale (a whole sale,
  or the lines a running-order payment covers). No line-level discounts, coupons, happy hours or automatic offers in
  v1. Online orders carry no discount of ours (the platform's offers are its own).
- **Before GST.** A discount shown on the bill at the time of sale lowers the taxable value, so GST is charged on the
  discounted amount. *To confirm with the accountant along with Q3.*
- **Spread over the lines.** Lines can have different GST rates, so the bill discount is split across lines in
  proportion to each line's net, with the paise left over handed out by largest remainder, so the parts add up to the
  discount exactly. Each line's GST is then taken on its discounted net, **rounded once per line** as today. A
  percentage is first turned into paise on the subtotal (half up), then spread the same way: one path for both.
- **Round-off comes last**, on subtotal − discount + GST.
- **Who:** anyone who may take a payment on the tablet (cashier, and a waiter where they take payment), **up to a cap
  the manager sets** (`tenant_setting.discount_max_bp`, default 0 = discounts off). Above the cap is not offered; no
  manager override in v1. **A reason is required**, picked from a manager-kept list (`discount_reasons`, the same
  shape and limits as `refund_reasons`) or typed.
- **Works offline.** The discount is part of the sale or payment event. The server **rejects** wrong arithmetic (as
  today) but only **flags** a discount over the cap in force (`over_discount_cap`, like `over_qty_cap`): the sale
  happened, and the setting may have changed while the tablet was offline.
- **The bill must stay above zero.** A free meal is not a 100% discount; that is out of scope.
- **Refunds are unchanged:** a refund pays back what was paid, method by method, which is already after the discount.
- A paid sale is never edited (invariant 4): a discount is fixed at payment, never added afterwards.

## Design

1. **One rule** (`packages/shared`): `discountLines(lines, discount)` in `money.ts` (proportional split, largest
   remainder) and `totals(cart, settings, discount?)` in `cart.ts` returning `discount` alongside `subtotal`, `tax`,
   `roundOff`, `total`. `orderTotals` and `checkPayment` (`order.ts`) pass it through. Mirrors: tablet `sale.ts` /
   `order.ts`, server `ingest.ts` / `order-ingest.ts`, `Sell.tsx` / `PayDialog.tsx`.
2. **Events** (`packages/shared/src/events.ts`, edited in place at the current versions: no tablet is in the field):
   `sale.created` and v2 `payment.taken` gain `discount: { kind: 'percent' | 'amount', value, reason } | null`, and
   per line `discountPaise`. Refine: `total = subtotal − discount + tax + roundOff`.
3. **Schema** (`db/migrations/0004_trading.sql`, in place): `sale.discount_paise` (≥ 0, default 0),
   `sale.discount_bp` (NULL for a flat amount), `sale.discount_reason` (required iff discount > 0);
   `sale_line.discount_paise` (0 ≤ discount ≤ line_total). CHECK on `sale`:
   `total = subtotal − discount + tax + round_off`, and `discount < subtotal + tax` for a paid sale. The sale's discount
   equals the sum of its lines' discounts: checked in the deferred `app.assert_sale_payments`-style trigger at commit.
   The paid-sale freeze trigger adds the new columns to its list. `tenant_setting.discount_max_bp` (0..10000) and
   `discount_reasons` (the `refund_reasons` CHECK copied).
4. **Ingest:** `checkArithmetic` checks each line's discount share against `discountLines` and its tax on the discounted
   net (any of the three rounding modes, as today); `policyFlags` adds `over_discount_cap`. `checkPayment` totals the
   paid lines with the payment's discount. Lines that arrive after a payment (the split-off order) carry no discount.
5. **Tablet:** Pay dialog gets a plain **Discount** control (not prominent; disabled with the reason as its title when
   the cap is 0): % or ₹, the reason (combobox plus tap buttons, as in `RefundDialog.tsx`), the new total shown before
   tendering. Clearing it is one tap. The tender amounts follow the discounted total.
6. **Receipt and slips** (`receipt-text.ts`): `Sub Total`, `Discount (reason)  -₹x`, GST, `Round Off`, `TOTAL`.
   Reprint shows the same. Shift slip: `Discounts (n)  ₹x`.
7. **Reports and day close:** a `Discounts ₹x (n bills)` line per day and per cashier; sales figures are after
   discount. Grep every report that sums `subtotal_paise` and decide gross or net for each before changing it.
8. **Seed:** one percentage-discounted and one flat-discounted sale per outlet, with mixed GST rates, so the split and
   per-line rounding are exercised.

## Step 1 notes (built 2026-11-15)

Decided while building, for steps 2 and 3 to rely on:

- **The rule is `totals(cart, settings, discount)`** (`cart.ts`): `discountOn` (`money.ts`) turns `{ kind, value }` into
  paise (percent half up on the subtotal, value in basis points; flat value in paise), `discountLines` splits it, and
  each `PricedLine` carries `discount`; `CartTotals` gains `discount`. `discountOverCap(subtotal, d, capBp)` judges a
  percentage by its rate and a flat amount by its share of the subtotal; the tablet should use it to decide what to
  offer. A discount that comes to under a paisa, or to the whole subtotal or more, throws: **something of the
  subtotal is always left**. That is the CHECK `discount_paise = 0 OR discount_paise < subtotal_paise`, stricter
  than the "< subtotal + tax" first written above.
- **Ties in the split go by line order**, so both sides must split in the same order. A whole sale splits in its
  event's line order. A v2 payment's `lines` are now **in the order the cashier saw them**, and `checkPayment` totals
  the paid lines in that order (it used to use fold order). The tablet must send them in the order it priced them.
- **Wire shape:** `sale.created` has `discount` (`{ kind, value, reason }` or null) and `discountPaise`, and each line
  has `discountPaise`. v2 `payment.taken` has `discount`, and each line has `discountPaise`. All default to none when
  absent, so older fixtures and tablets parse unchanged. The tablet's `queue` takes `OutboxEventInput`. A v1 payment
  carries no discount: the tablet only creates a whole sale with its tenders in the same step, so the discount goes on
  `sale.created`.
- **Refusals:** `discount_invalid` (nothing left to pay, or under a paisa), `discount_mismatch` (the amount does not
  match the percentage), `line_discount_mismatch` (a share is not `discountLines`). A v2 payment with a wrong share is
  `payment_total_mismatch`, as a wrong total is. `over_discount_cap` is a flag on both the whole sale and the order
  payment.
- **Schema:** the commit-time function is `app.assert_sale_lines`, renamed from `assert_order_lines`. It now checks
  every sale's discount against its live lines' shares, and order money as before. Trigger names are unchanged.
  `discount_bp` is 1..10000 or NULL, the reason is 1..200 characters, and only counter sales carry a discount.
- **Settings:** `TradingSettings` has `discountMaxBp` and `discountReasons`, in `GET`/`PUT /settings` and the pull.
  The manager screen keeps the values but has no fields for them yet (step 2). Default reasons: Staff meal, Regular
  customer, Complaint, Late order. **Seed:** tenant A's cap is 10% and B's is 20%. Each outlet has a 10%-off and a
  flat-5.55-off UPI sale (receipts 0003 and 0004 of 2026-01-01), each mixing 5% and 18% GST.

Evidence: shared 71/71 (`test/discount.test.ts` 9 new), DB 50/50 (2 new), API 270/270 (`discounts.test.ts` 6 new;
`settings.test.ts` extended), tablet 95/95 (2 expectations now include `discountPaise: 0`); fresh start passed.
Mutants: see the step table.

## Step 2 notes (built 2026-11-15)

- **Store** (`apps/counter/src/sale.ts`): `priced(lines, settings, discount)` is the one place the tablet prices a bill;
  the Pay dialog previews with it and `createSale`/`payOrder` save with it. `discountProblem` refuses what the dialog
  does not offer (cap 0 = off, over the cap by `discountOverCap`, nothing left to pay), so a refused discount writes
  nothing and spends no receipt number. A discount is only given with payment (`createSale` without tenders refuses
  one). `payOrder` reprices the order's lines **in the order shown** and sends each line's share on the v2 payment;
  it needs `settings` with a discount. An open *whole* sale (v1 payment) cannot take one: the dialog disables it.
- `LocalSale` gains `discount`, `discountPaise` and per line `discountPaise` (all optional: older rows read as none).
- **Pay dialog**: a plain **Discount** button shares one slot with **No discount** at the left of the action row;
  disabled with the reason as its title when discounts are off or the bill cannot take one. % or ₹, the value, the
  reason (combobox plus the manager's picks), and a line "Bill ₹x, discount −₹y before GST, GST ₹z". The due, the cash
  placeholder, quick cash and change follow the discounted total. Confirm is disabled with the reason until the
  discount is complete. The dialog is 580 px wide with a sticky action row, so Confirm stays in view at 1024x768.
- **Receipt**: `Discount 10% (Staff meal)  -3.00` between Sub Total and GST; a reason too long for 32 characters goes
  on the next line. **Shift slip**: `Discounts (n)  x` under Bills, only when one was given.
- **Settings → Selling rules**: "Largest bill discount a cashier may give, %" (0 to 100, two decimals; 0 = off) and a
  discount-reasons list with the refund list's limits. `parsePercentBp` (money.ts) parses both this and the dialog.

Evidence: tablet 100/100 (`test/discount.test.ts` 5 new: event split matches `totals`, v2 payment accepted by
`checkPayment` on the fold, refusals write nothing, receipt and slip lines); shared 71/71; 8 `tab-discount-*` mutants
8/8 caught (`.validation/mutation-discount-step2.log`), `--check` 553/553; `scripts/browser-discount.mjs` 61/61 at
1024x768 and 820x1180 (Settings, % on a counter sale, ₹ on a running order, server rows unflagged, shift close, off).

## Steps

| # | Step | Model | State |
|---|------|-------|-------|
| 1 | Shared rule (`discountLines`, `totals`), events, schema 0004 in place, ingest and order-ingest checks and flag, seed; shared, DB and API tests; mutants (`discount-*`) | HIGH | **done 2026-11-15**: tests above; 16 `discount-*` mutants and the 6 re-pointed (`sale-total-unchecked`, `order-totals-count-removed`, `order-pay-removed-line-unpaid`, `order-pay-fold-qty`, `order-pay-total-unchecked`, `ro-pay-fold-qty`) 22/22 caught, log `.validation/mutation-discount-step1.log`; `--check` 545/545 |
| 2 | Settings (cap, reasons) in Settings → Selling rules; tablet Pay dialog, store, receipt and shift slip; tablet tests; `scripts/browser-discount.mjs` at 1024x768 and 820x1180 (counter sale, running-order payment, through shift close) | HIGH (store), STANDARD (screen) | **done 2026-11-15**: see step 2 notes |
| 3 | Reports and day-close discount lines; API tests; browser check of the reports | STANDARD | not started |

## Tests that must exist

- Shared: the split adds up exactly; mixed GST rates; rounding per line in all three modes; percent and flat give the
  same result for the same paise; round-off after discount; total stays > 0.
- DB: the sale and line CHECKs; sale discount = sum of line discounts at commit; a paid sale's discount cannot change.
- API: tampered line share or tax rejected; over cap flagged, not rejected; running-order payment with a discount;
  split-off lines undiscounted; refund of a discounted sale pays back the discounted payments.
- Mutants: split remainder dropped, GST on the gross net, round-off before discount, cap not flagged, discount omitted
  from `checkPayment`.

## Still open

- GST treatment of the discount (before GST) is assumed; confirm with the accountant under Q3.
- Later: per-item discounts, a manager override above the cap, automatic offers.
