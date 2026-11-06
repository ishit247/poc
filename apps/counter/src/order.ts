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
//
// Other devices' orders (step 7, "12b"). `/sync/orders` sends each changed visit whole (`visits` table). What this
// device shows for a visit is, again by construction, the server's own computation: the shared fold of the events the
// server applied PLUS this device's own kept events (unsent ones included; copies collapse by (deviceId, seq)), less
// what the visit's closed sales took (`openLines`). Where that lands depends on who opened the visit:
// - this device: a `sales` row (the root, or a split the server made after a payment), paid and voided here as before;
// - another device: a `view` on the `visits` row, never a `sales` row, so shift close, receipts and cash totals here
//   cannot touch it. Anyone may add, change or remove its lines (D18), and any cashier may pay it (step 7b: paying
//   turns it into this device's paid `sales` row, see `payOrder`). A cashier, or the waiter who opened it, may void it
//   here too (step 7c, `voidOrder`).
import {
  addItem, foldOrder, liveLines, openLines, totals, DEFAULT_SETTINGS, OrderEvent, ORDER_SCHEMA_VERSION,
  type Cart, type ClosedLine, type MenuEntry, type OrderEnvelope, type OrderOpened, type TradingSettings,
} from '@pos/shared';
import { db, getMeta, type DeviceInfo, type LocalSale, type VisitRow } from './db.ts';
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

/** The open orders this device knows of: its own (`sales`) and other devices' (`visits` views). */
async function openOrders(): Promise<LocalSale[]> {
  const own = (await db.sales.where('status').equals('open').toArray()).filter((s) => s.kind === 'order');
  const others = (await db.visits.toArray()).flatMap((v) => (v.view ? [v.view] : []));
  return [...own, ...others];
}

/** Each table with the open orders on it, this device's and others'. Occupancy is derived from open orders, never stored (D14). */
export async function tableStates(): Promise<{ table: LocalTable; orders: LocalSale[] }[]> {
  const open = await openOrders();
  return (await tables()).map((table) => ({
    table,
    orders: open.filter((s) => s.tableId === table.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}

/** The order with this sale id: this device's own row, or its view of another device's order. */
export async function orderById(saleId: string): Promise<LocalSale | undefined> {
  return (await db.sales.get(saleId)) ?? (await db.visits.where('openSaleId').equals(saleId).first())?.view;
}

/** The tenant's trading settings as last pulled (the same source the Sell screen's menu uses). */
export async function localSettings(): Promise<TradingSettings> {
  const row = await db.entities.where('type').equals('tenant_setting').first();
  return { ...DEFAULT_SETTINGS, ...(row?.data as Partial<TradingSettings> | undefined) };
}

const rootOf = (s: LocalSale) => s.rootId ?? s.id;

const ALL = () => [db.sales, db.outbox, db.meta, db.orderEvents, db.entities, db.visits];

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

/** Every event this device knows for a visit, named by its root: as the server last sent them, plus this device's own kept copies. */
async function visitEvents(rootId: string, visit: VisitRow | undefined): Promise<OrderEnvelope[]> {
  const own = await db.orderEvents.where('saleId').equals(rootId).toArray();
  return [...(visit?.events ?? []), ...own].map((e) => ({ deviceId: e.deviceId, seq: e.seq, payload: { ...e.payload, saleId: rootId } }));
}

/** A row for an open sale this device has not held before (another device's order, or a split): from the visit's opening. */
async function fromOpened(saleId: string, opened: OrderOpened): Promise<LocalSale> {
  const user = await db.entities.get(['user', opened.createdBy]);
  return {
    id: saleId, status: 'open', kind: 'order', tableId: opened.tableId, createdBy: opened.createdBy, createdByName: String(user?.data.name ?? ''),
    channel: 'counter', businessDate: opened.businessDate, createdAt: opened.createdAtDevice, menuVersion: opened.menuVersion,
    lines: [], subtotalPaise: 0, taxPaise: 0, roundOffPaise: 0, totalPaise: 0, receiptNo: null, receiptSeq: null, payments: [],
  };
}

/**
 * Rewrites what this device shows for a visit (see the top of this file). Returns the row or view, or undefined when
 * there is nothing open to show: this device closed it and the server has not heard yet (the closing is in the outbox;
 * when it lands the visit changes, so the pull sends it again), or the opening has not arrived. Call inside a transaction.
 */
async function refold(device: DeviceInfo, rootId: string, settings: TradingSettings): Promise<LocalSale | undefined> {
  const visit = await db.visits.get(rootId);
  const events = await visitEvents(rootId, visit);
  const fold = foldOrder(rootId, events);
  // Only this device's events, all written by this file: a conflict or orphan is a bug, not a race. Stop before saving it.
  // With other devices' events in, show the order and its anomalies rather than lock the table (the server refuses
  // conflicting adds, so this should not happen either).
  const foreign = events.some((e) => e.deviceId !== device.deviceId);
  if (fold.anomalies.length && !foreign) throw new Error(`order ${rootId} folded with anomalies: ${fold.anomalies.map((a) => a.kind).join(', ')}`);

  const saleId = visit?.openSaleId ?? rootId;
  const mine = (visit?.ownerDeviceId ?? device.deviceId) === device.deviceId;
  const own = await db.sales.get(saleId);
  // This device closed that sale (paid it, even if another device opened it: step 7b; or voided it) and the server has
  // not heard yet. The closing wins; there is nothing open here to show.
  if (own && own.status !== 'open') return undefined;
  const existing = mine ? own : visit!.view;
  const base = existing ?? (fold.opened ? await fromOpened(saleId, fold.opened) : undefined);
  if (!base) return undefined;

  const live = liveLines({ ...fold, lines: openLines(fold, visit?.closed ?? []) });
  const t = totals(live, settings);
  const { anomalies: _stale, ownerDeviceId: _owner, ...rest } = base;
  const next: LocalSale = {
    ...rest, id: saleId, rootId, tableId: fold.tableId ?? base.tableId,
    lines: live.map((l, i) => ({ lineId: l.lineId, itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, netPaise: t.lines[i]!.net, taxPaise: t.lines[i]!.tax })),
    subtotalPaise: t.subtotal, taxPaise: t.tax, roundOffPaise: t.roundOff, totalPaise: t.total,
    ...(fold.anomalies.length ? { anomalies: fold.anomalies.map((a) => a.kind) } : {}),
    ...(mine ? {} : { ownerDeviceId: visit!.ownerDeviceId }),
  };
  if (mine) await db.sales.put(next);
  else await db.visits.put({ ...visit!, view: next });
  return next;
}

async function openOrderRow(saleId: string): Promise<LocalSale> {
  const sale = await orderById(saleId);
  if (!sale || sale.kind !== 'order') throw new Error('That is not a table order.');
  if (sale.status !== 'open') throw new Error('That order is already closed.');
  return sale;
}

/** After a change: the refolded order. It is open (the change just added to it), so undefined here is a bug. */
async function refolded(device: DeviceInfo, sale: LocalSale, settings: TradingSettings): Promise<LocalSale> {
  const next = await refold(device, rootOf(sale), settings);
  if (!next) throw new Error(`order ${sale.id} vanished while being changed`);
  return next;
}

/** A visit as `/sync/orders` sends it. `open` null: the visit has no open sale any more. */
export interface PulledVisit {
  rootId: string;
  version: number;
  sales: { id: string; status: string; deviceId: string }[];
  open: null | { saleId: string; deviceId: string; closed: ClosedLine[]; events: { deviceId: string; seq: number; payload: unknown }[] };
}

/**
 * Applies one page of pulled visits. Call inside the transaction that also stores the cursor (sync.ts), so a crash
 * cannot leave the cursor ahead of the data. A payload that does not parse throws, and the page is not applied.
 */
export async function applyVisits(device: DeviceInfo, visits: readonly PulledVisit[], settings: TradingSettings): Promise<void> {
  for (const v of visits) {
    for (const s of v.sales) {
      const local = await db.sales.get(s.id);
      if (local?.status !== 'open') continue;
      // This device shows it open and the server voided it (a manager, online): void it here too.
      if (s.status === 'void') await db.sales.put({ ...local, status: 'void' });
      // Paid on another device (step 7b). Had this device paid it, its row would say so (a closing here is never undone),
      // so the money and the receipt are that device's: drop the row, it is no order of ours any more.
      else if (s.status === 'paid' || s.status === 'refunded') await db.sales.delete(s.id);
    }
    if (!v.open) {
      await db.visits.delete(v.rootId);
      const stillOpen = (await db.sales.where('status').equals('open').toArray()).some((s) => rootOf(s) === v.rootId);
      if (!stillOpen) await db.orderEvents.where('saleId').equals(v.rootId).delete();
      continue;
    }
    const held = await db.visits.get(v.rootId);
    await db.visits.put({
      rootId: v.rootId, openSaleId: v.open.saleId, ownerDeviceId: v.open.deviceId, closed: v.open.closed,
      events: v.open.events.map((e) => ({ deviceId: e.deviceId, seq: e.seq, payload: OrderEvent.parse({ ...(e.payload as object), saleId: v.rootId }) })),
      ...(held?.view && held.view.id === v.open.saleId ? { view: held.view } : {}),
    });
    await refold(device, v.rootId, settings);
  }
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
    const id = crypto.randomUUID();
    const sale: LocalSale = {
      id, rootId: id, status: 'open', kind: 'order', tableId, createdBy: actor.id, createdByName: actor.name, channel: 'counter',
      businessDate: businessDate(device.timezone, now), createdAt: at, menuVersion,
      lines: [], subtotalPaise: 0, taxPaise: 0, roundOffPaise: 0, totalPaise: 0, receiptNo: null, receiptSeq: null, payments: [],
    };
    await db.sales.put(sale);
    await write(device, { type: 'order.opened', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, tableId, createdBy: actor.id, businessDate: sale.businessDate, createdAtDevice: at, menuVersion });
    for (const l of cart) {
      await write(device, { type: 'order.line_added', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, lineId: crypto.randomUUID(), itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, by: actor.id, at: await stamp(now) });
    }
    return refolded(device, sale, settings);
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
    const root = rootOf(sale);
    const at = await stamp(args.now ?? new Date());
    const mine = new Set((await visitEvents(root, await db.visits.get(root)))
      .filter((e) => e.deviceId === device.deviceId && e.payload.type === 'order.line_added').map((e) => (e.payload as { lineId: string }).lineId));
    const same = sale.lines.find((l) => l.itemId === entry.itemId && mine.has(l.lineId!));
    if (same) {
      checkQty(same.qty + qty, settings);
      await write(device, { type: 'order.line_changed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: root, lineId: same.lineId!, qty: same.qty + qty, by: actor.id, at });
    } else {
      await write(device, { type: 'order.line_added', schemaVersion: ORDER_SCHEMA_VERSION, saleId: root, lineId: crypto.randomUUID(), itemId: priced.itemId, name: priced.name, unitPaise: priced.unitPaise, gstRateBp: priced.gstRateBp, qty: priced.qty, by: actor.id, at });
    }
    return refolded(device, sale, settings);
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
      ? { type: 'order.line_removed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: rootOf(sale), lineId, by: actor.id, at }
      : { type: 'order.line_changed', schemaVersion: ORDER_SCHEMA_VERSION, saleId: rootOf(sale), lineId, qty, by: actor.id, at });
    return refolded(device, sale, settings);
  });
}

export const removeLine = (args: Omit<Parameters<typeof setLineQty>[0], 'qty'>) => setLineQty({ ...args, qty: 0 });

/**
 * Voids an open table order with a reason, this device's own or another device's (step 7c). A cashier may void any open
 * order, a waiter only one they opened; the server checks the same, and a payment that reached it first wins. One
 * transaction: the event, and this device's record of the closing. Another device's view becomes a void `sales` row
 * here (as paying it makes a paid one, step 7b), so `refold` cannot reopen it from a pull made before the void lands.
 */
export async function voidOrder(args: { device: DeviceInfo; actor: Actor; saleId: string; reason: string; now?: Date }): Promise<LocalSale> {
  const reason = args.reason.trim();
  if (!reason) throw new Error('Give a reason for voiding this order.');
  if (reason.length > 200) throw new Error('Keep the reason under 200 characters.');
  return db.transaction('rw', ALL(), async () => {
    const sale = await openOrderRow(args.saleId);
    if (args.actor.role !== 'cashier' && sale.createdBy !== args.actor.id) throw new Error('Only a cashier, or whoever opened it, may void this order.');
    await queue({ type: 'order.voided', schemaVersion: ORDER_SCHEMA_VERSION, saleId: sale.id, voidedBy: args.actor.id, reason, at: await stamp(args.now ?? new Date()) });
    const { ownerDeviceId, anomalies: _a, ...rest } = sale;
    const voided: LocalSale = { ...rest, status: 'void' };
    await db.sales.put(voided);
    await db.orderEvents.where('saleId').equals(rootOf(sale)).delete();
    if (ownerDeviceId) {
      const visit = await db.visits.where('openSaleId').equals(sale.id).first();
      if (visit) {
        const { view: _view, ...kept } = visit;
        await db.visits.put(kept);
      }
    }
    return voided;
  });
}

/** Moves an order to another table of this outlet. Moving to the table it is on writes nothing. */
export async function moveOrder(args: {
  device: DeviceInfo; actor: Actor; settings: TradingSettings; saleId: string; tableId: string; now?: Date;
}): Promise<LocalSale> {
  const { device, actor, settings, tableId } = args;
  return db.transaction('rw', ALL(), async () => {
    const sale = await openOrderRow(args.saleId);
    await liveTable(tableId);
    if (sale.tableId === tableId) return sale;
    await write(device, { type: 'order.moved', schemaVersion: ORDER_SCHEMA_VERSION, saleId: rootOf(sale), tableId, by: actor.id, at: await stamp(args.now ?? new Date()) });
    return refolded(device, sale, settings);
  });
}
