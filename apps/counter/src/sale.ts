// Writing a sale. The sale, its outbox events and the receipt counter are written in ONE
// IndexedDB transaction, so there is no state where a receipt number was spent without the
// sale, or a sale exists that the server will never hear about.
import {
  discountOn, discountOverCap, nextReceipt, OutboxEvent, totals, type OutboxEventInput, validatePayments, EVENT_SCHEMA_VERSION, ORDER_SCHEMA_VERSION,
  paise, type BillDiscount, type Cart, type DiscountRule, type Tender, type TradingSettings,
} from '@pos/shared';
import { currentShift, db, getMeta, type DeviceInfo, type LocalSale } from './db.ts';

export interface Actor { id: string; name: string; role: 'cashier' | 'waiter' }

/** The outlet's local calendar date, which is the receipt's business date. */
export function businessDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const saleCreated = (s: LocalSale): OutboxEventInput => ({
  type: 'sale.created', schemaVersion: EVENT_SCHEMA_VERSION, saleId: s.id, channel: s.channel, createdBy: s.createdBy,
  businessDate: s.businessDate, createdAtDevice: s.createdAt, menuVersion: s.menuVersion, lines: s.lines,
  subtotalPaise: s.subtotalPaise, discount: s.discount ?? null, discountPaise: s.discountPaise ?? 0,
  taxPaise: s.taxPaise, roundOffPaise: s.roundOffPaise, totalPaise: s.totalPaise,
});

const pct = (bp: number) => `${bp / 100}%`;

/**
 * Why this discount may not be given on a bill of `subtotal`, or null if it may. The Pay dialog offers nothing this
 * refuses, and the store refuses it again. Over the cap is only FLAGGED by the server (the cap may have changed while
 * this tablet was offline); the tablet does not offer it at all. Mirrors: `discountOverCap`, `discountOn` (money.ts).
 */
export function discountProblem(subtotal: number, d: DiscountRule, s: Pick<TradingSettings, 'discountMaxBp'>): string | null {
  if (s.discountMaxBp === 0) return 'Discounts are off. A manager can turn them on in Settings.';
  if (discountOverCap(paise(subtotal), d, s.discountMaxBp)) return `At most ${pct(s.discountMaxBp)} of the bill may be taken off.`;
  try { discountOn(paise(subtotal), d); } catch { return 'A discount must come to at least 0.01 and leave something to pay.'; }
  return null;
}

/** A line of a bill on screen: a cart line, or an order's line (with its lineId). */
export type BillLine = Pick<LocalSale['lines'][number], 'lineId' | 'itemId' | 'name' | 'unitPaise' | 'gstRateBp' | 'qty'>;

/**
 * A bill's lines and money from `totals`, with the bill discount split over the lines (in the lines' order, which is
 * the order they are sent in) when one is given. Lines keep their lineId. Throws an Error fit to show for a discount
 * `discountProblem` refuses.
 */
export function priced(bill: readonly BillLine[], s: TradingSettings, discount: BillDiscount | null = null) {
  const cart: Cart = bill.map((l) => ({ itemId: l.itemId, name: l.name, unitPaise: paise(l.unitPaise), gstRateBp: l.gstRateBp, qty: l.qty }));
  if (discount) {
    const why = discountProblem(totals(cart, s).subtotal, discount, s);
    if (why) throw new Error(why);
  }
  const t = totals(cart, s, discount);
  return {
    lines: t.lines.map((l, i) => ({
      ...(bill[i]!.lineId ? { lineId: bill[i]!.lineId } : {}),
      itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, netPaise: l.net, discountPaise: l.discount, taxPaise: l.tax,
    })),
    subtotalPaise: t.subtotal, discount, discountPaise: t.discount, taxPaise: t.tax, roundOffPaise: t.roundOff, totalPaise: t.total,
  };
}

/** Queues an event and returns its outbox seq (the device order the server replays, and the fold's event identity). */
export async function queue(event: OutboxEventInput): Promise<number> {
  // parse() is the gate: a malformed event throws here and rolls the whole transaction back.
  return db.outbox.add({ eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: OutboxEvent.parse(event) });
}

/** Money goes into the drawer of an open shift, and only its owner may put it there. Call inside the transaction. */
async function drawerFor(actor: Actor): Promise<string> {
  const shift = await currentShift();
  if (!shift) throw new Error('Open a shift before taking payment.');
  if (shift.userId !== actor.id) throw new Error(`The open shift belongs to ${shift.userName}. Close it before taking payment as someone else (if they are not here, a manager can close it from the Shift tab).`);
  return shift.id;
}

async function takePayment(device: DeviceInfo, sale: LocalSale, tenders: Tender[], today: string, shiftId: string): Promise<LocalSale> {
  if (sale.kind === 'order' && sale.lines.length === 0) throw new Error('This order has nothing on it to pay for.');
  const payments = validatePayments(paise(sale.totalPaise), tenders);
  const issued = nextReceipt(device.counterCode, (await getMeta('receiptCounter')) ?? null, today);
  await db.meta.put({ key: 'receiptCounter', value: issued.counter });
  const date = issued.counter.date;
  const common = { type: 'payment.taken', saleId: sale.id, shiftId, businessDate: date, receiptNo: issued.receiptNo, receiptSeq: issued.receiptSeq, payments } as const;
  if (sale.kind === 'order') {
    // v2: exactly the lines on screen, at the quantities on screen, for the total on screen. The payment wins on the
    // server (step 4), so what is listed here is what the receipt says, whatever another device did meanwhile.
    // In the order shown, which is the order the discount was split in (the server splits in this order too).
    await queue({
      ...common, schemaVersion: ORDER_SCHEMA_VERSION, lines: sale.lines.map((l) => ({ lineId: l.lineId!, qty: l.qty, discountPaise: l.discountPaise ?? 0 })),
      discount: sale.discount ?? null, totalPaise: sale.totalPaise,
    });
    // Settled: the paid sale row is the record now. Kept events are filed under the visit's root (a split's id differs).
    await db.orderEvents.where('saleId').equals(sale.rootId ?? sale.id).delete();
  } else {
    await queue({ ...common, schemaVersion: EVENT_SCHEMA_VERSION });
  }
  return { ...sale, status: 'paid', shiftId, businessDate: date, receiptNo: issued.receiptNo, receiptSeq: issued.receiptSeq, payments };
}

/** Saves a new order; with `tenders` it is paid in the same step (cashier), and may carry a bill discount. */
export async function createSale(args: {
  device: DeviceInfo; actor: Actor; cart: Cart; settings: TradingSettings; menuVersion: number; tenders?: Tender[]; discount?: BillDiscount | null; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, cart, settings, menuVersion, tenders } = args;
  if (cart.length === 0) throw new RangeError('empty cart');
  if (tenders && actor.role !== 'cashier') throw new Error('only a cashier takes payment');
  if (args.discount && !tenders) throw new Error('A discount is given when the bill is paid.');
  const now = args.now ?? new Date();
  const open: LocalSale = {
    id: crypto.randomUUID(), status: 'open', createdBy: actor.id, createdByName: actor.name, channel: 'counter',
    businessDate: businessDate(device.timezone, now), createdAt: now.toISOString(), menuVersion,
    ...priced(cart, settings, args.discount ?? null),
    receiptNo: null, receiptSeq: null, payments: [],
  };
  return db.transaction('rw', db.sales, db.outbox, db.meta, db.shifts, async () => {
    const shiftId = tenders ? await drawerFor(actor) : null; // checked first: no shift, no sale saved either
    await queue(saleCreated(open));
    const final = tenders ? await takePayment(device, open, tenders, open.businessDate, shiftId!) : open;
    await db.sales.put(final);
    return final;
  });
}

/**
 * A cashier pays an order that a waiter (or they) saved earlier, on this device or another one of the outlet (step 7b).
 * Another device's order is a view on its `visits` row; once paid HERE it becomes this device's `sales` row: the receipt
 * is from this device's series and the cash is in this drawer, which is what the server records too (`paid_device_id`,
 * this shift). The view is dropped, and `refold` never brings it back while this row is paid.
 */
export async function payOrder(args: {
  device: DeviceInfo; actor: Actor; saleId: string; tenders: Tender[]; discount?: BillDiscount | null; settings?: TradingSettings; now?: Date;
}): Promise<LocalSale> {
  if (args.actor.role !== 'cashier') throw new Error('only a cashier takes payment');
  const { discount = null, settings } = args;
  if (discount && !settings) throw new RangeError('a discount needs the trading settings');
  return db.transaction('rw', [db.sales, db.outbox, db.meta, db.shifts, db.orderEvents, db.visits], async () => {
    const own = await db.sales.get(args.saleId);
    const visit = own ? undefined : await db.visits.where('openSaleId').equals(args.saleId).first();
    let sale: LocalSale | undefined = own;
    if (!own && visit?.view) {
      const { ownerDeviceId: _owner, ...rest } = visit.view;
      sale = rest;
    }
    if (!sale || sale.status !== 'open') throw new Error('that order is not open');
    if (discount) {
      // Only a running order's v2 payment carries a discount; an open whole sale's v1 payment has nowhere to put one.
      if (sale.kind !== 'order') throw new Error('This bill cannot take a discount.');
      sale = { ...sale, ...priced(sale.lines, settings!, discount) };
    }
    const paid = await takePayment(args.device, sale, args.tenders, businessDate(args.device.timezone, args.now ?? new Date()), await drawerFor(args.actor));
    await db.sales.put(paid);
    if (visit) {
      const { view: _view, ...kept } = visit;
      await db.visits.put(kept);
    }
    return paid;
  });
}

/** Paid receipts, newest first, for reprinting. */
/** The cashier's latest receipts: paid, and refunded (shown as such, with a refund slip instead of a reprint). */
export async function recentReceipts(limit = 20): Promise<LocalSale[]> {
  const paid = await db.sales.where('status').anyOf('paid', 'refunded').toArray();
  return paid.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** A cashier prints a paid receipt again. The event is the audit trail; it is queued with the same care as a sale. */
export async function recordReprint(args: { actor: Actor; saleId: string; now?: Date }): Promise<void> {
  if (args.actor.role !== 'cashier') throw new Error('only a cashier reprints a receipt');
  await db.transaction('rw', db.sales, db.outbox, async () => {
    const sale = await db.sales.get(args.saleId);
    if (!sale || sale.status !== 'paid') throw new Error('only a paid sale has a receipt to reprint');
    await queue({ type: 'print.reprinted', schemaVersion: EVENT_SCHEMA_VERSION, saleId: sale.id, reprintedBy: args.actor.id, at: (args.now ?? new Date()).toISOString() });
  });
}

/** Orders this person may see: a cashier sees every open order here, a waiter only their own. */
export async function visibleOpenOrders(actor: Actor): Promise<LocalSale[]> {
  const open = await db.sales.where('status').equals('open').toArray();
  // An order with nothing on it (everything removed) is not worth listing or paying.
  return open.filter((s) => s.lines.length > 0 && (actor.role === 'cashier' || s.createdBy === actor.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
