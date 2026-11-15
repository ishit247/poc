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

/** A bill discount as the cashier gave it (docs/discounts-plan.md): a percentage in basis points, or flat paise. */
export interface DiscountRule {
  kind: 'percent' | 'amount';
  value: number; // percent: 1..10000 bp; amount: paise
}

/**
 * The discount in paise on a bill of `subtotal` (line nets before GST). A percentage is rounded half up, once, on the
 * subtotal; a flat amount is taken as given. Something must be left to pay: a discount of the whole subtotal or more,
 * or one that comes to nothing, throws. Mirrors: ingest `checkArithmetic`, order-ingest via `checkPayment`.
 */
export function discountOn(subtotal: Paise, d: DiscountRule): Paise {
  if (!Number.isSafeInteger(d.value) || d.value < 1 || (d.kind === 'percent' && d.value > 10000)) throw new RangeError(`bad discount: ${d.value}`);
  const p = d.kind === 'percent' ? Number((BigInt(subtotal) * BigInt(d.value) + 5000n) / 10000n) : d.value;
  if (p < 1) throw new RangeError('discount comes to less than one paisa');
  if (p >= subtotal) throw new RangeError('discount must leave something to pay');
  return paise(p);
}

/** Over the manager's cap (`tenant_setting.discount_max_bp`)? A percentage by its rate; a flat amount by its share of the subtotal. */
export function discountOverCap(subtotal: Paise, d: DiscountRule, capBp: number): boolean {
  return d.kind === 'percent' ? d.value > capBp : BigInt(d.value) * 10000n > BigInt(capBp) * BigInt(subtotal);
}

/**
 * Splits a bill discount over lines in proportion to each line's net, so lines with different GST rates each carry
 * their share. Each share is rounded down; the paise left over go one each to the lines with the largest remainders,
 * ties to the earlier line, so the shares add up to the discount exactly and none exceeds its line's net.
 * Line ORDER matters for ties: callers split in the order the event lists the lines.
 */
export function discountLines(nets: readonly Paise[], discount: Paise): Paise[] {
  const sum = nets.reduce((a, n) => a + n, 0);
  if (discount === 0) return nets.map(() => paise(0));
  if (!Number.isSafeInteger(discount) || discount < 0 || discount >= sum) throw new RangeError(`bad discount ${discount} on ${sum}`);
  const parts = nets.map((n, i) => {
    const exact = BigInt(n) * BigInt(discount);
    return { i, share: Number(exact / BigInt(sum)), rem: exact % BigInt(sum) };
  });
  let left = discount - parts.reduce((a, x) => a + x.share, 0);
  for (const x of [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    if (left-- <= 0) break;
    x.share += 1;
  }
  return parts.map((x) => paise(x.share));
}

export interface LineAmounts {
  net: Paise; // unit price x qty, before GST and discount
  tax: Paise; // GST on the line total less its discount share (tax-exclusive pricing)
  total: Paise; // what the customer pays for the line: net - discount + tax
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

/** A menu price as typed, "45" or "45.50", to paise (at most 10,00,000 rupees, the API's ceiling), or null.
 *  Parsed from the text so no float rounding is involved. Mirrors the price check in api `routes/menu.ts`. */
export const parsePaise = (s: string): number | null => {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim());
  const p = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  return p >= 0 && p <= 100_000_000 ? p : null;
};

/** A GST rate as typed, "5" or "2.5" percent, to basis points (0 to 4000), or null. */
export const parseGstBp = (s: string): number | null => {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s.trim());
  const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  return bp >= 0 && bp <= 4000 ? bp : null;
};

/** A percentage as typed, "10" or "12.5", to basis points (0 to 10000), or null. Discounts and the discount cap. */
export const parsePercentBp = (s: string): number | null => {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s.trim());
  const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  return bp >= 0 && bp <= 10000 ? bp : null;
};

/** Parses user-typed rupees ("125", "125.5", "125.50") exactly, without floats. */
export function parseRupees(input: string): Paise {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new RangeError(`not a rupee amount: ${input}`);
  return paise(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0));
}
