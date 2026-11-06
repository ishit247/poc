// Other devices' open orders on the tablet (phase 12 step 7, "12b"), against IndexedDB semantics (fake-indexeddb).
// What the tablet relies on: a pulled visit is shown as the shared fold of the server's events plus this device's own
// unsent ones (union: nothing either side rang is lost), less what closed sales took; another device's order is a
// view, never a `sales` row (so shift close and payment cannot touch it); a split of this device's visit becomes its
// own row; a closing this device has not sent yet is not undone by a pull. The real-API contract is in push.test.ts.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { foldOrder, liveLines, paise, DEFAULT_SETTINGS, type ClosedLine, type MenuEntry, type OrderEvent, type Tender } from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { payOrder, type Actor } from '../src/sale.ts';
import { addToOrder, applyVisits, openOrder, orderById, setLineQty, tableStates, voidOrder, type PulledVisit } from '../src/order.ts';
import { closeShift } from '../src/shift.ts';
import { seedShift } from './helpers.ts';

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'dev-a', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const OTHER = 'dev-b';
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const item = (n: number, name: string, price: number): MenuEntry =>
  ({ itemId: `4444444${n}-4444-4444-8444-444444444444`, categoryId: 'c', name, sortOrder: n, hsnCode: null, pricePaise: paise(price), gstRateBp: 500, available: true });
const tea = item(1, 'Tea', 1000);
const dosa = item(2, 'Dosa', 6000);
const T1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const T2 = 'aaaaaaa1-0000-4000-8000-000000000002';
const settings = DEFAULT_SETTINGS;
const base = { device, settings };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];
const uuid = () => crypto.randomUUID();

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.orderEvents.clear(), db.entities.clear(), db.visits.clear()]);
  await db.entities.bulkPut([
    { type: 'dining_table', id: T1, data: { code: 'T1', sortOrder: 0, isDefault: true } },
    { type: 'dining_table', id: T2, data: { code: 'T2', sortOrder: 1, isDefault: false } },
    { type: 'user', id: waiter.id, data: { name: 'Wait', role: 'waiter' } },
  ]);
  await seedShift(cashier);
});

/** Another device writing order events, numbered as it would number them. */
class Other {
  seq = 0;
  clock = Date.parse('2026-11-06T10:00:00Z');
  events: { deviceId: string; seq: number; payload: OrderEvent }[] = [];
  constructor(readonly deviceId = OTHER) {}
  private at() { return new Date((this.clock += 1000)).toISOString(); }
  private push(payload: OrderEvent) { this.events.push({ deviceId: this.deviceId, seq: ++this.seq, payload }); return payload; }
  open(saleId: string, tableId = T1) {
    return this.push({ type: 'order.opened', schemaVersion: 2, saleId, tableId, createdBy: waiter.id, businessDate: '2026-11-06', createdAtDevice: this.at(), menuVersion: 1 });
  }
  add(saleId: string, lineId: string, e: MenuEntry, qty = 1) {
    return this.push({ type: 'order.line_added', schemaVersion: 2, saleId, lineId, itemId: e.itemId, name: e.name, unitPaise: e.pricePaise, gstRateBp: e.gstRateBp, qty, by: waiter.id, at: this.at() });
  }
  change(saleId: string, lineId: string, qty: number) {
    return this.push({ type: 'order.line_changed', schemaVersion: 2, saleId, lineId, qty, by: waiter.id, at: this.at() });
  }
}

/** What the server would send: these events (any devices), the open sale and its device, the lines closed sales took. */
function visit(rootId: string, events: { deviceId: string; seq: number; payload: OrderEvent }[], o: { saleId?: string; owner?: string; closed?: ClosedLine[]; sales?: PulledVisit['sales'] } = {}): PulledVisit {
  const saleId = o.saleId ?? rootId, owner = o.owner ?? OTHER;
  return { rootId, version: 1, sales: o.sales ?? [{ id: saleId, status: 'open', deviceId: owner }], open: { saleId, deviceId: owner, closed: o.closed ?? [], events } };
}
const apply = (vs: PulledVisit[]) => db.transaction('rw', [db.visits, db.sales, db.orderEvents, db.entities, db.meta], () => applyVisits(device, vs, settings));
/** This device's own kept events, as the server would echo them back once applied. */
const mine = async (rootId: string) => (await db.orderEvents.where('saleId').equals(rootId).toArray()).map((e) => ({ deviceId: e.deviceId, seq: e.seq, payload: e.payload }));
const shown = (s: { lines: { name: string; qty: number }[] } | undefined) => s?.lines.map((l) => [l.name, l.qty]);

test('another device\'s open order is a view on its table, never a sales row: shift close leaves it alone', async () => {
  const b = new Other();
  const root = uuid();
  b.open(root); b.add(root, uuid(), tea, 2);
  await apply([visit(root, b.events)]);

  const t1 = (await tableStates()).find((s) => s.table.id === T1)!;
  assert.equal(t1.orders.length, 1);
  assert.equal(t1.orders[0]!.ownerDeviceId, OTHER);
  assert.equal(t1.orders[0]!.createdByName, 'Wait');
  assert.deepEqual(shown(t1.orders[0]), [['Tea', 2]]);
  assert.equal(t1.orders[0]!.totalPaise, 2100);
  assert.equal(await db.sales.count(), 0, 'not a sales row');

  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.deepEqual((await db.outbox.toArray()).map((r) => r.payload.type), ['shift.closed'], 'shift close voids only this device\'s orders');
  assert.ok((await orderById(root))?.status === 'open');
});

test('7b: a cashier pays another device\'s order here: this device\'s receipt and drawer, and a pull before it lands does not reopen it', async () => {
  const b = new Other();
  const root = uuid();
  b.open(root); b.add(root, uuid(), tea, 2);
  await apply([visit(root, b.events)]);
  const view = await addToOrder({ ...base, actor: cashier, saleId: root, entry: dosa }); // our line, still unsent

  const paid = await payOrder({ device, actor: cashier, saleId: root, tenders: cash(view.totalPaise) });
  assert.equal(paid.status, 'paid');
  assert.match(paid.receiptNo!, /^C1-\d{8}-1$/, 'this device\'s own receipt series');
  assert.deepEqual(shown(paid), [['Tea', 2], ['Dosa', 1]], 'the lines on screen, both devices\'');
  assert.equal(paid.ownerDeviceId, undefined, 'a paid row of this device now');
  assert.equal(paid.rootId, root);
  const pay = (await db.outbox.toArray()).map((r) => r.payload).find((x) => x.type === 'payment.taken') as any;
  assert.equal(pay.saleId, root);
  assert.equal(pay.schemaVersion, 2);
  assert.equal(pay.lines.length, 2);
  assert.equal((await db.visits.get(root))?.view, undefined, 'the view is gone');
  assert.equal((await db.orderEvents.where('saleId').equals(root).count()), 0, 'kept events settled');
  assert.equal((await tableStates()).find((s) => s.table.id === T1)!.orders.length, 0, 'the table is free here');

  // The server has not heard of the payment yet: it still sends the visit open. Nothing reopens here.
  await apply([visit(root, b.events)]);
  assert.equal((await tableStates()).find((s) => s.table.id === T1)!.orders.length, 0, 'a stale open visit does not reopen it');
  assert.equal((await db.sales.get(root))?.status, 'paid');

  // It landed: the visit closes; the paid row stays, and it is this drawer's money.
  await apply([{ rootId: root, version: 2, sales: [{ id: root, status: 'paid', deviceId: OTHER }], open: null }]);
  assert.equal((await db.sales.get(root))?.status, 'paid');
  const slip = await closeShift({ device, actor: cashier, countedCashPaise: view.totalPaise });
  assert.equal(slip.salesCount, 1);
  assert.equal(slip.cashSalesPaise, view.totalPaise);
});

test('7b: this device\'s own order paid on another device: its row goes (no receipt, no void at shift close); a split stays ours', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1, tableId: T1 });
  await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea });
  await apply([{ rootId: s.id, version: 3, sales: [{ id: s.id, status: 'paid', deviceId: device.deviceId }], open: null }]);
  assert.equal(await db.sales.get(s.id), undefined, 'paid elsewhere: not an order of ours any more');
  assert.equal((await tableStates()).find((x) => x.table.id === T1)!.orders.length, 0);
  assert.equal((await db.orderEvents.where('saleId').equals(s.id).count()), 0);
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.deepEqual((await db.outbox.toArray()).map((r) => r.payload.type).filter((t) => t === 'sale.voided'), [], 'nothing to void');

  // With a split: lines this device added after the other device's payment. The split is this device's row.
  await seedShift(cashier);
  const r = await openOrder({ ...base, actor: waiter, menuVersion: 1, tableId: T2 });
  await addToOrder({ ...base, actor: waiter, saleId: r.id, entry: tea });
  await addToOrder({ ...base, actor: waiter, saleId: r.id, entry: dosa });
  const evs = await mine(r.id);
  const teaLine = (await db.sales.get(r.id))!.lines.find((l) => l.name === 'Tea')!;
  const split = uuid();
  await apply([visit(r.id, evs, { saleId: split, owner: device.deviceId, closed: [{ lineId: teaLine.lineId!, qty: 1, removed: false }],
    sales: [{ id: r.id, status: 'paid', deviceId: device.deviceId }, { id: split, status: 'open', deviceId: device.deviceId }] })]);
  assert.equal(await db.sales.get(r.id), undefined, 'the paid part went');
  assert.deepEqual(shown(await db.sales.get(split)), [['Dosa', 1]], 'the unpaid line is our own open order');
});

test('adding to another device\'s order: the event names the root, and the view is the union with what the server sends next', async () => {
  const b = new Other();
  const root = uuid(), l1 = uuid();
  b.open(root); b.add(root, l1, tea);
  await apply([visit(root, [...b.events])]);

  const after = await addToOrder({ ...base, actor: cashier, saleId: root, entry: dosa });
  assert.deepEqual(shown(after), [['Tea', 1], ['Dosa', 1]]);
  const sent = (await db.outbox.toArray()).map((r) => r.payload);
  assert.deepEqual(sent.map((p) => [p.type, (p as any).saleId]), [['order.line_added', root]]);

  // The server has not got our Dosa yet, but has another Tea from the other device: both show.
  b.add(root, uuid(), tea, 3);
  await apply([visit(root, [...b.events])]);
  assert.deepEqual(shown(await orderById(root))?.sort(), [['Dosa', 1], ['Tea', 1], ['Tea', 3]].sort());
  // Once it has ours, the echo collapses with our kept copy: still one Dosa.
  await apply([visit(root, [...b.events, ...(await mine(root))])]);
  assert.deepEqual(shown(await orderById(root))?.sort(), [['Dosa', 1], ['Tea', 1], ['Tea', 3]].sort());
});

test('an item the other device added gets a new line from here, not a bump (two waiters adding one tea both land)', async () => {
  const b = new Other();
  const root = uuid(), l1 = uuid();
  b.open(root); b.add(root, l1, tea);
  await apply([visit(root, b.events)]);
  await addToOrder({ ...base, actor: cashier, saleId: root, entry: tea });
  assert.deepEqual((await db.outbox.toArray()).map((r) => r.payload.type), ['order.line_added']);
  // A second tap on Tea here bumps OUR line.
  const s = await addToOrder({ ...base, actor: cashier, saleId: root, entry: tea });
  assert.deepEqual((await db.outbox.toArray()).map((r) => r.payload.type), ['order.line_added', 'order.line_changed']);
  assert.deepEqual(shown(s), [['Tea', 1], ['Tea', 2]]);
  // An explicit quantity edit of THEIR line is allowed (last edit wins, as on the server).
  const e = await setLineQty({ ...base, actor: cashier, saleId: root, lineId: l1, qty: 4 });
  assert.deepEqual(shown(e), [['Tea', 4], ['Tea', 2]]);
});

test('this device\'s own order with a line another device added: the row it pays from includes that line', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });
  const b = new Other();
  b.add(s.id, uuid(), dosa);
  await apply([visit(s.id, [...(await mine(s.id)), ...b.events], { owner: device.deviceId })]);
  const row = await db.sales.get(s.id);
  assert.deepEqual(shown(row)?.sort(), [['Dosa', 1], ['Tea', 1]]);
  assert.equal(row!.ownerDeviceId, undefined, 'own order: a sales row, not a view');
  assert.equal(await db.visits.get(s.id).then((v) => v?.view), undefined);

  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(row!.totalPaise) });
  const payment = (await db.outbox.toArray()).map((r) => r.payload).find((p) => p.type === 'payment.taken') as any;
  assert.equal(payment.schemaVersion, 2);
  assert.deepEqual(payment.lines.map((l: any) => l.lineId).sort(), row!.lines.map((l) => l.lineId).sort());
  assert.equal(payment.totalPaise, paid.totalPaise);
});

test('a split the server made after this device\'s payment becomes its own open row; the paid root does not change', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 2 }] });
  const own = await mine(s.id);
  const l1 = s.lines[0]!.lineId!;
  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise) });
  assert.equal(await db.orderEvents.count(), 0, 'settled: kept events go');

  // Meanwhile a waiter added a Dosa on another device; it reached the server after our payment, so it was split off.
  const b = new Other();
  const l2 = uuid();
  b.add(s.id, l2, dosa);
  const split = uuid();
  await apply([visit(s.id, [...own, ...b.events], { saleId: split, owner: device.deviceId, closed: [{ lineId: l1, qty: 2, removed: false }],
    sales: [{ id: s.id, status: 'paid', deviceId: device.deviceId }, { id: split, status: 'open', deviceId: device.deviceId }] })]);

  assert.deepEqual(await db.sales.get(s.id), paid, 'the paid root is untouched');
  const row = await db.sales.get(split);
  assert.equal(row?.status, 'open');
  assert.equal(row?.rootId, s.id);
  assert.deepEqual(shown(row), [['Dosa', 1]]);
  assert.equal((await tableStates()).find((x) => x.table.id === T1)!.orders.map((o) => o.id).join(), split);

  // Changing it names the root; paying it names the split, for just the late line.
  await setLineQty({ ...base, actor: cashier, saleId: split, lineId: l2, qty: 2 });
  const two = await db.sales.get(split);
  await payOrder({ device, actor: cashier, saleId: split, tenders: cash(two!.totalPaise) });
  const tail = (await db.outbox.toArray()).map((r) => r.payload).slice(-2) as any[];
  assert.deepEqual([tail[0].type, tail[0].saleId], ['order.line_changed', s.id]);
  assert.deepEqual([tail[1].type, tail[1].saleId, tail[1].lines], ['payment.taken', split, [{ lineId: l2, qty: 2 }]]);
  assert.equal(await db.orderEvents.count(), 0, 'settled: the kept events (filed under the root) go');
});

test('shift close voids this device\'s split and drops its kept events, which are filed under the root', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });
  const own = await mine(s.id);
  await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise) });
  const b = new Other();
  const l2 = uuid(), split = uuid();
  b.add(s.id, l2, dosa);
  await apply([visit(s.id, [...own, ...b.events], { saleId: split, owner: device.deviceId, closed: [{ lineId: s.lines[0]!.lineId!, qty: 1, removed: false }] })]);
  await setLineQty({ ...base, actor: cashier, saleId: split, lineId: l2, qty: 3 }); // a kept event, under the root
  assert.equal(await db.orderEvents.count(), 1);
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.equal((await db.sales.get(split))?.status, 'void');
  const voided = (await db.outbox.toArray()).map((r) => r.payload).find((p) => p.type === 'sale.voided') as any;
  assert.equal(voided.saleId, split);
  assert.equal(await db.orderEvents.count(), 0);
});

test('a pull that still shows a visit open, while this device\'s closing of it is unsent, changes nothing', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });
  const own = await mine(s.id);
  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise) });
  // The server has a waiter's line we did not pay for: once our payment lands it splits off. Until then, the paid row stays as paid.
  const b = new Other();
  b.add(s.id, uuid(), dosa);
  await apply([visit(s.id, [...own, ...b.events], { owner: device.deviceId })]);
  assert.deepEqual(await db.sales.get(s.id), paid);
  assert.equal(await db.sales.count(), 1);
  assert.deepEqual((await tableStates()).flatMap((x) => x.orders), []);
});

test('a visit that closed on the server: another device\'s view goes; this device\'s order voided online is voided here', async () => {
  const b = new Other();
  const theirs = uuid();
  b.open(theirs); b.add(theirs, uuid(), tea);
  await apply([visit(theirs, b.events)]);
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, tableId: T2, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });

  await apply([
    { rootId: theirs, version: 2, sales: [{ id: theirs, status: 'paid', deviceId: OTHER }], open: null },
    { rootId: s.id, version: 3, sales: [{ id: s.id, status: 'void', deviceId: device.deviceId }], open: null },
  ]);
  assert.equal(await db.visits.count(), 0);
  assert.equal((await db.sales.get(s.id))?.status, 'void');
  assert.equal(await db.orderEvents.count(), 0);
  assert.deepEqual((await tableStates()).flatMap((x) => x.orders), []);
});

test('7c: a cashier voids another device\'s order here with a reason: the event, the view gone, and a pull before it lands does not reopen it', async () => {
  const b = new Other();
  const root = uuid();
  b.open(root); b.add(root, uuid(), tea, 2);
  await apply([visit(root, b.events)]);
  await addToOrder({ ...base, actor: cashier, saleId: root, entry: dosa }); // our line, still unsent: it goes out before the void

  await assert.rejects(voidOrder({ device, actor: cashier, saleId: root, reason: '   ' }), /Give a reason/);
  const v = await voidOrder({ device, actor: cashier, saleId: root, reason: ' guest left ' });
  assert.equal(v.status, 'void');
  const out = (await db.outbox.toArray()).map((r) => r.payload);
  assert.deepEqual(out.map((x) => x.type), ['order.line_added', 'order.voided']);
  assert.deepEqual(out[1], { type: 'order.voided', schemaVersion: 2, saleId: root, voidedBy: cashier.id, reason: 'guest left', at: (out[1] as any).at });
  assert.equal((await db.visits.get(root))?.view, undefined, 'the view is gone');
  assert.equal(await db.orderEvents.where('saleId').equals(root).count(), 0);
  assert.equal((await tableStates()).find((s) => s.table.id === T1)!.orders.length, 0, 'the table is free here');

  await apply([visit(root, b.events)]);
  assert.equal((await tableStates()).find((s) => s.table.id === T1)!.orders.length, 0, 'a stale open visit does not reopen it');
  await apply([{ rootId: root, version: 2, sales: [{ id: root, status: 'void', deviceId: OTHER }], open: null }]);
  assert.equal(await db.visits.count(), 0);
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.equal((await db.outbox.toArray()).filter((r) => r.payload.type === 'sale.voided').length, 0, 'shift close has nothing to void');
});

test('7c: a waiter voids only an order they opened; another person\'s order is refused here too', async () => {
  const other: Actor = { id: '33333333-3333-4333-8333-333333333333', name: 'Other', role: 'waiter' };
  const b = new Other();
  const theirs = uuid();
  b.open(theirs); b.add(theirs, uuid(), tea); // opened by `waiter`
  await apply([visit(theirs, b.events)]);
  await assert.rejects(voidOrder({ device, actor: other, saleId: theirs, reason: 'x' }), /cashier/);
  assert.equal((await orderById(theirs))?.status, 'open');
  assert.equal(await db.outbox.count(), 0);

  // Their own order, opened on another device: allowed.
  await voidOrder({ device, actor: waiter, saleId: theirs, reason: 'duplicate' });
  assert.equal((await tableStates()).find((s) => s.table.id === T1)!.orders.length, 0);

  // Their own order on this device: the row is void, its kept events go, shift close does not void it again.
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1, tableId: T2 });
  await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea });
  await voidOrder({ device, actor: waiter, saleId: s.id, reason: 'mistake' });
  assert.equal((await db.sales.get(s.id))?.status, 'void');
  assert.equal(await db.orderEvents.where('saleId').equals(s.id).count(), 0);
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.equal((await db.outbox.toArray()).filter((r) => r.payload.type === 'sale.voided').length, 0);
});

test('7c: the opener\'s order voided on another device: its row is void, its unsent line\'s copy goes, the table frees', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1, tableId: T1 });
  await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea });
  await apply([{ rootId: s.id, version: 3, sales: [{ id: s.id, status: 'void', deviceId: device.deviceId }], open: null }]);
  assert.equal((await db.sales.get(s.id))?.status, 'void');
  assert.equal(await db.orderEvents.where('saleId').equals(s.id).count(), 0);
  assert.equal((await tableStates()).find((x) => x.table.id === T1)!.orders.length, 0);
  await assert.rejects(addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea }), /closed/);
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.equal((await db.outbox.toArray()).filter((r) => r.payload.type === 'sale.voided').length, 0, 'not voided twice');
});

test('a page with an event that does not parse is not applied at all', async () => {
  const b = new Other();
  const good = uuid(), bad = uuid();
  b.open(good);
  const broken = visit(bad, [{ deviceId: OTHER, seq: 9, payload: { type: 'order.line_added', saleId: bad } as any }]);
  await assert.rejects(apply([visit(good, b.events), broken]));
  assert.equal(await db.visits.count(), 0, 'the good visit before it was rolled back too');
});

test('a conflict between another device\'s events and ours is shown on the order, not thrown', async () => {
  const b = new Other();
  const root = uuid(), line = uuid();
  b.open(root); b.add(root, line, tea);
  // Our own kept copy claims the same line id for a different item (cannot happen through this code; written directly).
  await db.orderEvents.add({ deviceId: device.deviceId, seq: 1, saleId: root, payload: { ...(b.events[1]!.payload as any), itemId: dosa.itemId, name: 'Dosa', at: '2026-11-06T11:00:00.000Z' } });
  await apply([visit(root, b.events)]);
  assert.deepEqual((await orderById(root))?.anomalies, ['line_conflict']);
});

// Property: another device's events arrive in growing snapshots (as successive pulls deliver them) while this device
// edits the same order. Whatever the interleaving, what this device shows is always the fold of everything it has
// seen plus everything it wrote; nothing it wrote is lost before the server has it; and once the server echoes all
// of it, the view is the fold of the union.
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test('property: shown = fold(server events ∪ own events), over 40 seeded interleavings', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    await Promise.all([db.outbox.clear(), db.orderEvents.clear(), db.visits.clear(), db.sales.clear()]);
    const r = rng(seed);
    const b = new Other();
    const root = uuid();
    const theirLines: string[] = [];
    b.open(root);
    await apply([visit(root, [...b.events])]);
    for (let step = 0; step < 25; step++) {
      const view = (await orderById(root))!;
      const x = r();
      if (x < 0.3) { const l = uuid(); theirLines.push(l); b.add(root, l, r() < 0.5 ? tea : dosa, 1 + Math.floor(r() * 3)); }
      else if (x < 0.4 && theirLines.length) b.change(root, theirLines[Math.floor(r() * theirLines.length)]!, 1 + Math.floor(r() * 5));
      else if (x < 0.6) await addToOrder({ ...base, actor: cashier, saleId: root, entry: r() < 0.5 ? tea : dosa });
      else if (x < 0.75 && view.lines.length) {
        const l = view.lines[Math.floor(r() * view.lines.length)]!;
        await setLineQty({ ...base, actor: cashier, saleId: root, lineId: l.lineId!, qty: Math.floor(r() * 4) });
      } else {
        // A pull: the server has all of theirs so far and a random prefix of ours (pushes land in order).
        const ours = await mine(root);
        await apply([visit(root, [...b.events, ...ours.slice(0, Math.floor(r() * (ours.length + 1)))])]);
      }
      const expected = liveLines(foldOrder(root, [...(await db.visits.get(root))!.events, ...(await mine(root))]
        .map((e) => ({ ...e, payload: { ...e.payload, saleId: root } }))));
      const got = (await orderById(root))!;
      assert.deepEqual(got.lines.map((l) => [l.lineId, l.qty]), expected.map((l) => [l.lineId, l.qty]), `seed ${seed} step ${step}`);
      assert.equal(got.anomalies, undefined, `seed ${seed} step ${step}`);
    }
    await apply([visit(root, [...b.events, ...(await mine(root))])]);
    const all = liveLines(foldOrder(root, [...b.events, ...(await mine(root))]));
    assert.deepEqual((await orderById(root))!.lines.map((l) => [l.lineId, l.qty]), all.map((l) => [l.lineId, l.qty]), `seed ${seed} final`);
  }
});
