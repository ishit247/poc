// Running orders on the tablet (phase 12, D14 and D15). An order sits on a table and is changed by line events. Every
// change is ONE IndexedDB transaction that writes the event to the outbox, keeps a copy in `orderEvents` under the
// same seq, and refolds the order with the shared `foldOrder` into its `sales` row. So the row the screen shows is,
// by construction, the fold the server will reach from the same events (docs/phase12-plan.md, steps 3 and 4).
//
// Rules this file keeps, and why:
// - Event times never go backwards on this device (`stamp`). The fold orders events by device time, then device,
//   then seq; a clock set back mid-order would otherwise reorder this device's own changes.
// - Adding an item merges into a live line of the same item only if THIS device added that line. A line another
//   device added is never bumped from here: a new line is added instead, so two waiters each adding "one more tea"
//   both land (adds are a union; changes are last-wins). Setting a quantity is an explicit edit and is last-wins.
// - Quantity 0 is a removal (`order.line_removed`), never a change to 0.
import {
  addItem, foldOrder, liveLines, totals, ORDER_SCHEMA_VERSION,
  type Cart, type MenuEntry, type OrderEvent, type TradingSettings,
} from '@pos/shared';
import { db, getMeta, type DeviceInfo, type LocalSale } from './db.ts';
import { businessDate, queue, type Actor } from './sale.ts';

export interface LocalTable { id: string; code: string; sortOrder: number; isDefault: boolean }

/** The outlet's live tables, in floor order (pulled; a removed table is a tombstone and is gone from here). */
export async function tables(): Promise<LocalTable[]> {
  const rows = await db.entities.where('type').equals('dining_table').toArray();
  return rows
    .map((r) => ({ id: r.id, code: String(r.data.code), sortOrder: Number(r.data.sortOrder ?? 0), isDefault: r.data.isDefault === true }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/** `default`: a cafe, every order on the one default table. `map`: a restaurant choosing tables. */
export async function tableMode(): Promise<'default' | 'map'> {
  const outlet = (await db.entities.where('type').equals('outlet').toArray())[0];
  return outlet?.data.tableMode === 'map' ? 'map' : 'default';
}

/** Each table with the open orders on it. Occupancy is derived from open orders, never stored (D14). */
export async function tableStates(): Promise<{ table: LocalTable; orders: LocalSale[] }[]> {
  const open = (await db.sales.where('status').equals('open').toArray()).filter((s) => s.kind === 'order');
  return (await tables()).map((table) => ({
    table,
    orders: open.filter((s) => s.tableId === table.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

const ALL = () => [db.sales, db.outbox, db.meta, db.orderEvents, db.entities];

/** A device time for the next order event: now, or the last one stamped if the clock went back. Call inside the transaction. */
async function stamp(now: Date): Promise<string> {
  const last = await getMeta('eventClock');
  const t = Math.max(now.getTime(), last ? Date.parse(last) : 0);
  const at = new Date(t).toISOString();
  await db.meta.put({ key: 'eventClock', value: at });
  return at;
}

async function write(device: DeviceInfo, payload: OrderEvent): Promise<void> {
  const seq = await queue(payload);
  await db.orderEvents.add({ deviceId: device.deviceId, seq, saleId: payload.saleId, payload });
}

/** Rewrites the order's row from the fold of the events this device holds for it. */
async function refold(sale: LocalSale, settings: TradingSettings): Promise<LocalSale> {
  const events = await db.orderEvents.where('saleId').equals(sale.id).toArray();
  const fold = foldOrder(sale.id, events.map((e) => ({ deviceId: e.deviceId, seq: e.seq, payload: e.payload })));
  // Every event here was written by this file, so a conflict or orphan is a bug, not a race: stop before saving it.
  if (fold.anomalies.length) throw new Error(`order ${sale.id} folded with anomalies: ${fold.anomalies.map((a) => a.kind).join(', ')}`);
  const live = liveLines(fold);
  const t = totals(live, settings);
  const next: LocalSale = {
    ...sale,
    tableId: fold.tableId,
    lines: live.map((l, i) => ({ lineId: l.lineId, itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, netPaise: t.lines[i]!.net, taxPaise: t.lines[i]!.tax })),
    subtotalPaise: t.subtotal, taxPaise: t.tax, roundOffPaise: t.roundOff, totalPaise: t.total,
  };
  await db.sales.put(next);
  return next;
}

async function openOrderRow(saleId: string): Promise<LocalSale> {
  const sale = await db.sales.get(saleId);
  if (!sale || sale.kind !== 'order') throw new Error('That is not a table order.');
  if (sale.status !== 'open') throw new Error('That order is already closed.');
  return sale;
}

async function liveTable(tableId: string): Promise<void> {
  if (!(await db.entities.get(['dining_table', tableId]))) throw new Error('That table is not on this outlet.');
}

function checkQty(qty: number, settings: TradingSettings): void {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError(`bad quantity: ${qty}`);
  if (qty > settings.maxLineQty) throw new RangeError(`At most ${settings.maxLineQty} of one item per order.`);
}

/**
 * Opens an order on a table (the default table if none is given) with the cart's lines, if any. This is "hold" in a
 * cafe and "seat" in a restaurant. A busy table may take a second order: devices cannot know about each other offline,
 * so the server flags it rather than refusing, and the tablet does the same (it simply allows it).
 */
export async function openOrder(args: {
  device: DeviceInfo; actor: Actor; settings: TradingSettings; menuVersion: number; tableId?: string; cart?: Cart; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, settings, menuVersion, cart = [] } = args;
  for (const l of cart) checkQty(l.qty, settings);
  const now = args.now ?? new Date();
  return db.transaction('rw', ALL(), async () => {
    const tableId = args.tableId ?? (await tables()).find((t) => t.isDefault)?.id;
    if (!tableId) throw new Error('This counter has no tables yet. Sync, then try again.');
    await liveTable(tableId);
    const at = await stamp(now);
    const sale: LocalSale = {
      id: crypto.randomUUID(), status: 'open', kind: 'order', tableId, createdBy: actor.id, createdByName: actor.name, channel: 'counter',
      businessDate: businessDate(device.timezone, now), createdAt: at, menuVersion,
      lines: [], subtotalPaise: 0, taxPaise: 0, roundOffPaise: 0, totalPaise: 0, receiptNo: null, receiptSeq: null, payments: [],
    };
    await write(device, { type: 'order.opened', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, tableId, createdBy: actor.id, businessDate: sale.businessDate, createdAtDevice: at, menuVersion });
    for (const l of cart) {
      await write(device, { type: 'order.line_added', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId: crypto.randomUUID(), itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, by: actor.id, at: await stamp(now) });
    }
    return refold(sale, settings);
  });
}

/** Adds an item to an open order (see the merge rule at the top of this file). */
export async function addToOrder(args: {
  device: DeviceInfo; actor: Actor; settings: TradingSettings; saleId: string; entry: MenuEntry; qty?: number; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, settings, entry, qty = 1 } = args;
  const priced = addItem([], entry, qty, settings)[0]!; // availability, quantity and the price snapshot, as at the counter
  return db.transaction('rw', ALL(), async () => {
    const sale = await openOrderRow(args.saleId);
    const at = await stamp(args.now ?? new Date());
    const mine = new Set((await db.orderEvents.where('saleId').equals(sale.id).toArray())
      .filter((e) => e.deviceId === device.deviceId && e.payload.type === 'order.line_added').map((e) => (e.payload as { lineId: string }).lineId));
    const same = sale.lines.find((l) => l.itemId === entry.itemId && mine.has(l.lineId!));
    if (same) {
      checkQty(same.qty + qty, settings);
      await write(device, { type: 'order.line_changed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId: same.lineId!, qty: same.qty + qty, by: actor.id, at });
    } else {
      await write(device, { type: 'order.line_added', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId: crypto.randomUUID(), itemId: priced.itemId, name: priced.name, unitPaise: priced.unitPaise, gstRateBp: priced.gstRateBp, qty: priced.qty, by: actor.id, at });
    }
    return refold(sale, settings);
  });
}

/** Sets a live line's quantity; 0 removes it. Setting the quantity it already has writes nothing. */
export async function setLineQty(args: {
  device: DeviceInfo; actor: Actor; settings: TradingSettings; saleId: string; lineId: string; qty: number; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, settings, lineId, qty } = args;
  if (qty !== 0) checkQty(qty, settings);
  return db.transaction('rw', ALL(), async () => {
    const sale = await openOrderRow(args.saleId);
    const line = sale.lines.find((l) => l.lineId === lineId);
    if (!line) throw new Error('That line is not on this order.');
    if (line.qty === qty) return sale;
    const at = await stamp(args.now ?? new Date());
    await write(device, qty === 0
      ? { type: 'order.line_removed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId, by: actor.id, at }
      : { type: 'order.line_changed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId, qty, by: actor.id, at });
    return refold(sale, settings);
  });
}

export const removeLine = (args: Omit<Parameters<typeof setLineQty>[0], 'qty'>) => setLineQty({ ...args, qty: 0 });

/** Moves an order to another table of this outlet. Moving to the table it is on writes nothing. */
export async function moveOrder(args: {
  device: DeviceInfo; actor: Actor; settings: TradingSettings; saleId: string; tableId: string; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, settings, tableId } = args;
  return db.transaction('rw', ALL(), async () => {
    const sale = await openOrderRow(args.saleId);
    await liveTable(tableId);
    if (sale.tableId === tableId) return sale;
    await write(device, { type: 'order.moved', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, tableId, by: actor.id, at: await stamp(args.now ?? new Date()) });
    return refold(sale, settings);
  });
}
