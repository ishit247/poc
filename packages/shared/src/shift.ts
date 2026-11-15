// A cashier's shift: the float they started with, the cash the sales put in the drawer, and the
// count at the end. The same arithmetic runs on the tablet (for the slip) and on the server (the
// figure that counts), so the two cannot drift apart.
import { formatRupees, paise } from './money.ts';
import { RECEIPT_WIDTH } from './receipt-text.ts';

type Money = readonly { method: string; amountPaise: number }[];
const cashIn = (xs: Money) => xs.filter((x) => x.method === 'cash').reduce((a, x) => a + x.amountPaise, 0);

/**
 * Cash that should be in the drawer: the float, plus the cash part of every payment, less the cash refunds paid out of
 * it (docs/refunds-plan.md). Change handed back is already out of `amountPaise`; a UPI refund is paid back outside the
 * app and does not touch the drawer. Server: shift close (ingest.ts) and force-close (routes/dayclose.ts). Tablet: the slip (shift.ts).
 */
export function expectedCash(openingCashPaise: number, payments: Money, refunds: Money): number {
  return openingCashPaise + cashIn(payments) - cashIn(refunds);
}

export interface ShiftSlipView {
  outletName: string;
  counterCode: string;
  cashier: string;
  openedAt: string;
  closedAt: string;
  timeZone: string;
  openingCashPaise: number;
  cashSalesPaise: number;
  upiSalesPaise: number;
  salesCount: number;
  /** Bill discounts given on this shift's sales; the sales above are already after them. Absent on older slips. */
  discounts?: { count: number; paise: number };
  /**
   * Money this drawer took for payments the server refused (phase 12 step 7d): another device's closing of the order
   * stood. Not in the sales above; the cash IS in `expectedCash` (it is in the drawer). Absent on older slips.
   */
  refused?: { count: number; cashPaise: number; upiPaise: number };
  /**
   * Sales of this shift refunded by its cashier. Their payments are still in the sales above; the cash part left the
   * drawer, so it is OUT of `expectedCash`. UPI is paid back outside the app. Absent on older slips.
   */
  refunds?: { count: number; cashPaise: number; upiPaise: number };
  countedCashPaise: number;
  /** counted - expected. Negative is short. */
  variancePaise: number;
  /** Events this tablet still holds: the totals above are only its own until they reach the server. */
  unsyncedCount: number;
}

const money = (n: number) => `${n < 0 ? '-' : ''}${formatRupees(paise(Math.abs(n)))}`;
const row = (left: string, right: string, width: number) => left + ' '.repeat(Math.max(1, width - left.length - right.length)) + right;
const stamp = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace(',', '');

/** The slip the cashier keeps (and the manager checks the drawer against). Fixed-width text, like the receipt. */
export function renderShiftSlip(v: ShiftSlipView, width = RECEIPT_WIDTH): string[] {
  const rule = '-'.repeat(width);
  const out: string[] = [
    v.outletName.slice(0, width),
    'SHIFT SLIP',
    rule,
    row('Counter', v.counterCode, width),
    row('Cashier', v.cashier.slice(0, width - 8), width),
    row('Opened', stamp(v.openedAt, v.timeZone), width),
    row('Closed', stamp(v.closedAt, v.timeZone), width),
    rule,
    row('Opening cash', money(v.openingCashPaise), width),
    row(`Cash sales`, money(v.cashSalesPaise), width),
    row('UPI sales', money(v.upiSalesPaise), width),
    row('Bills', String(v.salesCount), width),
  ];
  if (v.discounts && v.discounts.count > 0) out.push(row(`Discounts (${v.discounts.count})`, money(v.discounts.paise), width));
  // The customer paid, the server refused it: refund it or hand it to the manager. Its cash is in "expected" below.
  if (v.refused && v.refused.count > 0) {
    out.push(rule, `Taken, refused by server (${v.refused.count})`);
    if (v.refused.cashPaise) out.push(row(' Cash, in drawer', money(v.refused.cashPaise), width));
    if (v.refused.upiPaise) out.push(row(' UPI', money(v.refused.upiPaise), width));
    out.push('Refund or hand to manager.');
  }
  if (v.refunds && v.refunds.count > 0) {
    out.push(rule, `Refunded (${v.refunds.count})`);
    if (v.refunds.cashPaise) out.push(row(' Cash, from drawer', money(-v.refunds.cashPaise), width));
    if (v.refunds.upiPaise) out.push(row(' UPI, paid back', money(v.refunds.upiPaise), width));
  }
  out.push(
    rule,
    row('Counted cash', money(v.countedCashPaise), width),
    row(v.variancePaise === 0 ? 'Cash matches' : v.variancePaise < 0 ? 'SHORT' : 'OVER', v.variancePaise === 0 ? '' : money(Math.abs(v.variancePaise)), width),
  );
  if (v.unsyncedCount > 0) out.push(rule, `${v.unsyncedCount} record${v.unsyncedCount === 1 ? '' : 's'} not yet sent.`, 'Check totals with the manager.');
  return out;
}

export interface RefundSlipView {
  outletName: string;
  counterCode: string;
  receiptNo: string;
  cashier: string;
  refundedAt: string;
  timeZone: string;
  reason: string;
  /** The server's refund rows, one per method (docs/refunds-plan.md). */
  refunds: readonly { method: 'cash' | 'upi'; amountPaise: number }[];
}

/** The slip a refund prints (58 mm): which bill, how much went back by which way, and why. Kept with the drawer cash. */
export function renderRefundSlip(v: RefundSlipView, width = RECEIPT_WIDTH): string[] {
  const rule = '-'.repeat(width);
  const out: string[] = [
    v.outletName.slice(0, width),
    'REFUND',
    rule,
    row('Bill', v.receiptNo, width),
    row('Counter', v.counterCode, width),
    row('Cashier', v.cashier.slice(0, width - 8), width),
    row('Refunded', stamp(v.refundedAt, v.timeZone), width),
    rule,
  ];
  for (const r of v.refunds) out.push(row(r.method === 'cash' ? 'Cash, from drawer' : 'UPI, to pay back', money(r.amountPaise), width));
  out.push(row('Total refunded', money(v.refunds.reduce((a, r) => a + r.amountPaise, 0)), width), rule);
  for (let s = `Reason: ${v.reason}`; s.length > 0; s = s.slice(width)) out.push(s.slice(0, width));
  return out;
}
