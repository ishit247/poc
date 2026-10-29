// The cart: pure, immutable, integer paise. The tablet and the server both total a
// sale with this, so a receipt can never disagree with what the server accepts.
import type { MenuEntry } from './menu.ts';
import { add, exclusiveLine, paise, roundOffFor, type LineAmounts, type Paise } from './money.ts';
import { DEFAULT_SETTINGS, type TradingSettings } from './settings.ts';

export interface CartLine {
  itemId: string;
  name: string; // snapshot: a later rename must not change a sold line
  unitPaise: Paise; // before GST
  gstRateBp: number;
  qty: number;
}

export type Cart = readonly CartLine[];

export interface PricedLine extends CartLine, LineAmounts {}

export interface CartTotals {
  lines: PricedLine[];
  subtotal: Paise; // sum of line nets
  tax: Paise;
  roundOff: Paise; // signed; total = subtotal + tax + roundOff
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

export function totals(cart: Cart, s: TotalSettings = DEFAULT_SETTINGS): CartTotals {
  const lines = cart.map((l) => ({ ...l, ...exclusiveLine(l.unitPaise, l.qty, l.gstRateBp, s.gstRounding) }));
  const subtotal = add(...lines.map((l) => l.net));
  const tax = add(...lines.map((l) => l.tax));
  const roundOff = roundOffFor(paise(subtotal + tax), s.billRoundTo);
  return { lines, subtotal, tax, roundOff, total: paise(subtotal + tax + roundOff) };
}

function checkQty(qty: number, cap: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > cap) throw new RangeError(`bad quantity: ${qty} (limit ${cap})`);
}
