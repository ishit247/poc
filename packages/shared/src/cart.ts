// The cart: pure, immutable, integer paise. The tablet and the server both total a
// sale with this, so a receipt can never disagree with what the server accepts.
import type { MenuEntry } from './menu.ts';
import { add, discountLines, discountOn, mul, paise, roundOffFor, taxOn, type DiscountRule, type LineAmounts, type Paise } from './money.ts';
import { DEFAULT_SETTINGS, type TradingSettings } from './settings.ts';

export interface CartLine {
  itemId: string;
  name: string; // snapshot: a later rename must not change a sold line
  unitPaise: Paise; // before GST
  gstRateBp: number;
  qty: number;
}

export type Cart = readonly CartLine[];

export interface PricedLine extends CartLine, LineAmounts {
  discount: Paise; // this line's share of the bill discount (0 without one)
}

export interface CartTotals {
  lines: PricedLine[];
  subtotal: Paise; // sum of line nets, before the discount
  discount: Paise; // the bill discount, the sum of the lines' shares
  tax: Paise; // sum of line taxes, each on its discounted net
  roundOff: Paise; // signed, last; total = subtotal - discount + tax + roundOff
  total: Paise;
}

type CartSettings = Pick<TradingSettings, 'maxLineQty'>;
type TotalSettings = Pick<TradingSettings, 'gstRounding' | 'billRoundTo'>;

export function addItem(cart: Cart, entry: MenuEntry, qty = 1, s: CartSettings = DEFAULT_SETTINGS): Cart {
  if (!entry.available) throw new RangeError(`item is not available: ${entry.name}`);
  const existing = cart.find((l) => l.itemId === entry.itemId);
  if (existing) return setQty(cart, entry.itemId, existing.qty + qty, s);
  checkQty(qty, s.maxLineQty);
  return [...cart, { itemId: entry.itemId, name: entry.name, unitPaise: entry.pricePaise, gstRateBp: entry.gstRateBp, qty }];
}

/** Quantity 0 removes the line. */
export function setQty(cart: Cart, itemId: string, qty: number, s: CartSettings = DEFAULT_SETTINGS): Cart {
  if (qty === 0) return cart.filter((l) => l.itemId !== itemId);
  checkQty(qty, s.maxLineQty);
  return cart.map((l) => (l.itemId === itemId ? { ...l, qty } : l));
}

/**
 * A bill's money (docs/discounts-plan.md): the discount is taken off before GST, split over the lines by their nets,
 * each line's GST is rounded once on its discounted net, and round-off comes last. Splits in the cart's line order.
 * Mirrors: ingest `checkArithmetic`/`policyFlags`, order-ingest `writeOpen`/`payOrder` (through `checkPayment`).
 */
export function totals(cart: Cart, s: TotalSettings = DEFAULT_SETTINGS, discount: DiscountRule | null = null): CartTotals {
  const nets = cart.map((l) => mul(l.unitPaise, l.qty));
  const subtotal = add(...nets);
  const off = discount ? discountOn(subtotal, discount) : paise(0);
  const shares = discountLines(nets, off);
  const lines = cart.map((l, i) => {
    const tax = taxOn(paise(nets[i]! - shares[i]!), l.gstRateBp, s.gstRounding);
    return { ...l, net: nets[i]!, discount: shares[i]!, tax, total: paise(nets[i]! - shares[i]! + tax) };
  });
  const tax = add(...lines.map((l) => l.tax));
  const roundOff = roundOffFor(paise(subtotal - off + tax), s.billRoundTo);
  return { lines, subtotal, discount: off, tax, roundOff, total: paise(subtotal - off + tax + roundOff) };
}

function checkQty(qty: number, cap: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError(`bad quantity: ${qty}`);
  if (qty > cap) throw new RangeError(`At most ${cap} of one item per order.`);
}
