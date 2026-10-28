// Money is integer paise. Never floats. Every function here either returns an
// exact integer or throws; there is no rounding except where named.
export type Paise = number & { readonly __brand: 'paise' };

export function paise(n: number): Paise {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not an integer paise amount: ${n}`);
  return n as Paise;
}

export function add(...xs: Paise[]): Paise {
  return paise(xs.reduce((a, b) => a + b, 0));
}

export function mul(unit: Paise, qty: number): Paise {
  if (!Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`bad quantity: ${qty}`);
  return paise(unit * qty);
}

/**
 * GST on a tax-exclusive amount, rate in basis points (500 = 5%).
 * Rounds half up, once, on the line total: the single named rounding in the system.
 */
export function taxOn(amount: Paise, rateBp: number): Paise {
  if (!Number.isSafeInteger(rateBp) || rateBp < 0) throw new RangeError(`bad rate: ${rateBp}`);
  return paise(Math.floor((amount * rateBp + 5000) / 10000));
}

export interface LineAmounts {
  net: Paise; // unit price x qty, before GST
  tax: Paise; // GST on the line total (tax-exclusive pricing)
  total: Paise; // what the customer pays for the line
}

/**
 * Tax-exclusive pricing: the price typed is before GST, GST is added on top.
 * Tax is computed once on the LINE total (not per unit), so qty 3 is not three
 * separately rounded taxes.
 */
export function exclusiveLine(unit: Paise, qty: number, gstRateBp: number): LineAmounts {
  const net = mul(unit, qty);
  const tax = taxOn(net, gstRateBp);
  return { net, tax, total: add(net, tax) };
}

/** Rupees string for display only, e.g. 12550 -> "125.50". Never parse this back. */
export function formatRupees(p: Paise): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Parses user-typed rupees ("125", "125.5", "125.50") exactly, without floats. */
export function parseRupees(input: string): Paise {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new RangeError(`not a rupee amount: ${input}`);
  return paise(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0));
}
