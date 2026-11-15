<meta charset="utf-8">

# Discounts — plan

Status: **decided 2026-11-15; ready for step 1.** Model plan: **HIGH** for steps 1 and 2 (money arithmetic, GST,
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

## Steps

| # | Step | Model | State |
|---|------|-------|-------|
| 1 | Shared rule (`discountLines`, `totals`), events, schema 0004 in place, ingest and order-ingest checks and flag, seed; shared, DB and API tests; mutants (`discount-*`) | HIGH | not started |
| 2 | Settings (cap, reasons) in Settings → Selling rules; tablet Pay dialog, store, receipt and shift slip; tablet tests; `scripts/browser-discount.mjs` at 1024x768 and 820x1180 (counter sale, running-order payment, through shift close) | HIGH (store), STANDARD (screen) | not started |
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
