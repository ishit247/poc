// A cashier's shift: the float they started with, the cash the sales put in the drawer, and the
// count at the end. The same arithmetic runs on the tablet (for the slip) and on the server (the
// figure that counts), so the two cannot drift apart.
import { formatRupees, paise } from './money.ts';
import { RECEIPT_WIDTH } from './receipt-text.ts';

/** Cash that should be in the drawer: the float plus the cash part of every payment. Change handed back is already out of `amountPaise`. */
export function expectedCash(openingCashPaise: number, payments: readonly { method: string; amountPaise: number }[]): number {
  return openingCashPaise + payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amountPaise, 0);
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
  const out = [
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
    rule,
    row('Counted cash', money(v.countedCashPaise), width),
    row(v.variancePaise === 0 ? 'Cash matches' : v.variancePaise < 0 ? 'SHORT' : 'OVER', v.variancePaise === 0 ? '' : money(Math.abs(v.variancePaise)), width),
  ];
  if (v.unsyncedCount > 0) out.push(rule, `${v.unsyncedCount} record${v.unsyncedCount === 1 ? '' : 's'} not yet sent.`, 'Check totals with the manager.');
  return out;
}
