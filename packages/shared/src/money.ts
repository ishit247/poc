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

/** How a line's GST is rounded to a whole paisa. A manager setting (tenant_setting.gst_rounding). */
export type GstRounding = 'half_up' | 'up' | 'down';

/**
 * GST on a tax-exclusive amount, rate in basis points (500 = 5%).
 * Rounded once, on the line total, in the chosen mode (default half up).
 */
export function taxOn(amount: Paise, rateBp: number, mode: GstRounding = 'half_up'): Paise {
  if (!Number.isSafeInteger(rateBp) || rateBp < 0) throw new RangeError(`bad rate: ${rateBp}`);
  const exact = amount * rateBp; // in units of 1/10000 paisa
  const bias = mode === 'half_up' ? 5000 : mode === 'up' ? 9999 : 0;
  return paise(Math.floor((exact + bias) / 10000));
}

/**
 * Bill round-off: the total rounded half up to a multiple of `step` paise (0 = off).
 * Returns the signed adjustment to add to the total. Never rounds a bill down to zero.
 */
export function roundOffFor(total: Paise, step: number): Paise {
  if (!Number.isSafeInteger(step) || step < 0) throw new RangeError(`bad round-off step: ${step}`);
  if (step === 0) return paise(0);
  const rounded = Math.floor((total + step / 2) / step) * step;
  return paise(rounded === 0 ? 0 : rounded - total);
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
export function exclusiveLine(unit: Paise, qty: number, gstRateBp: number, rounding: GstRounding = 'half_up'): LineAmounts {
  const net = mul(unit, qty);
  const tax = taxOn(net, gstRateBp, rounding);
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
