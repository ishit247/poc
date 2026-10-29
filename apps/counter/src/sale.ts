// Writing a sale. The sale, its outbox events and the receipt counter are written in ONE
// IndexedDB transaction, so there is no state where a receipt number was spent without the
// sale, or a sale exists that the server will never hear about.
import { nextReceipt, OutboxEvent, totals, validatePayments, EVENT_SCHEMA_VERSION, paise, type Cart, type Tender, type TradingSettings } from '@pos/shared';
import { db, getMeta, type DeviceInfo, type LocalSale } from './db.ts';

export interface Actor { id: string; name: string; role: 'cashier' | 'waiter' }

/** The outlet's local calendar date, which is the receipt's business date. */
export function businessDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const saleCreated = (s: LocalSale): OutboxEvent => ({
  type: 'sale.created', schemaVersion: EVENT_SCHEMA_VERSION, saleId: s.id, channel: s.channel, createdBy: s.createdBy,
  businessDate: s.businessDate, createdAtDevice: s.createdAt, menuVersion: s.menuVersion, lines: s.lines,
  subtotalPaise: s.subtotalPaise, taxPaise: s.taxPaise, roundOffPaise: s.roundOffPaise, totalPaise: s.totalPaise,
});

async function queue(event: OutboxEvent): Promise<void> {
  // parse() is the gate: a malformed event throws here and rolls the whole transaction back.
  await db.outbox.add({ eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: OutboxEvent.parse(event) });
}

async function takePayment(device: DeviceInfo, sale: LocalSale, tenders: Tender[], today: string): Promise<LocalSale> {
  const payments = validatePayments(paise(sale.totalPaise), tenders);
  const issued = nextReceipt(device.counterCode, (await getMeta('receiptCounter')) ?? null, today);
  await db.meta.put({ key: 'receiptCounter', value: issued.counter });
  const date = issued.counter.date;
  await queue({ type: 'payment.taken', schemaVersion: EVENT_SCHEMA_VERSION, saleId: sale.id, businessDate: date, receiptNo: issued.receiptNo, receiptSeq: issued.receiptSeq, payments });
  return { ...sale, status: 'paid', businessDate: date, receiptNo: issued.receiptNo, receiptSeq: issued.receiptSeq, payments };
}

/** Saves a new order; with `tenders` it is paid in the same step (cashier). */
export async function createSale(args: {
  device: DeviceInfo; actor: Actor; cart: Cart; settings: TradingSettings; menuVersion: number; tenders?: Tender[]; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, cart, settings, menuVersion, tenders } = args;
  if (cart.length === 0) throw new RangeError('empty cart');
  if (tenders && actor.role !== 'cashier') throw new Error('only a cashier takes payment');
  const now = args.now ?? new Date();
  const t = totals(cart, settings);
  const open: LocalSale = {
    id: crypto.randomUUID(), status: 'open', createdBy: actor.id, createdByName: actor.name, channel: 'counter',
    businessDate: businessDate(device.timezone, now), createdAt: now.toISOString(), menuVersion,
    lines: t.lines.map((l) => ({ itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, netPaise: l.net, taxPaise: l.tax })),
    subtotalPaise: t.subtotal, taxPaise: t.tax, roundOffPaise: t.roundOff, totalPaise: t.total,
    receiptNo: null, receiptSeq: null, payments: [],
  };
  return db.transaction('rw', db.sales, db.outbox, db.meta, async () => {
    await queue(saleCreated(open));
    const final = tenders ? await takePayment(device, open, tenders, open.businessDate) : open;
    await db.sales.put(final);
    return final;
  });
}

/** A cashier pays an order that a waiter (or they) saved earlier. */
export async function payOrder(args: { device: DeviceInfo; actor: Actor; saleId: string; tenders: Tender[]; now?: Date }): Promise<LocalSale> {
  if (args.actor.role !== 'cashier') throw new Error('only a cashier takes payment');
  return db.transaction('rw', db.sales, db.outbox, db.meta, async () => {
    const sale = await db.sales.get(args.saleId);
    if (!sale || sale.status !== 'open') throw new Error('that order is not open');
    const paid = await takePayment(args.device, sale, args.tenders, businessDate(args.device.timezone, args.now ?? new Date()));
    await db.sales.put(paid);
    return paid;
  });
}

/** Orders this person may see: a cashier sees every open order here, a waiter only their own. */
export async function visibleOpenOrders(actor: Actor): Promise<LocalSale[]> {
  const open = await db.sales.where('status').equals('open').toArray();
  return open.filter((s) => actor.role === 'cashier' || s.createdBy === actor.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
