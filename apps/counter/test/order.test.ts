// Running orders on the tablet (phase 12 step 5), against IndexedDB semantics (fake-indexeddb). No server here:
// the contract with the real API is in push.test.ts.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { foldOrder, liveLines, paise, totals, DEFAULT_SETTINGS, type MenuEntry, type Tender, type OrderEvent } from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { payOrder, type Actor } from '../src/sale.ts';
import { addToOrder, moveOrder, openOrder, removeLine, setLineQty, tableStates } from '../src/order.ts';
import { closeShift } from '../src/shift.ts';
import { seedShift } from './helpers.ts';

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'dev-a', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const item = (n: number, name: string, price: number): MenuEntry =>
  ({ itemId: `4444444${n}-4444-4444-8444-444444444444`, categoryId: 'c', name, sortOrder: n, hsnCode: null, pricePaise: paise(price), gstRateBp: 500, available: true });
const tea = item(1, 'Tea', 1000);
const dosa = item(2, 'Dosa', 6000);
const vada = item(3, 'Vada', 2500);
const T1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const T2 = 'aaaaaaa1-0000-4000-8000-000000000002';
const settings = DEFAULT_SETTINGS;
const base = { device, settings };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];
const payloads = async () => (await db.outbox.orderBy('seq').toArray()).map((r) => r.payload);

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.orderEvents.clear(), db.entities.clear()]);
  await db.entities.bulkPut([
    { type: 'dining_table', id: T1, data: { code: 'T1', sortOrder: 0, isDefault: true } },
    { type: 'dining_table', id: T2, data: { code: 'T2', sortOrder: 1, isDefault: false } },
  ]);
  await seedShift(cashier);
});

/** The fold of what the tablet holds for a sale, independently of the row the code wrote. */
async function foldOf(saleId: string) {
  const rows = await db.orderEvents.where('saleId').equals(saleId).toArray();
  return foldOrder(saleId, rows.map((r) => ({ deviceId: r.deviceId, seq: r.seq, payload: r.payload })));
}

test('an order opens on the default table; each event is in the outbox and kept under the same seq', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 3, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 2 }] });
  assert.equal(s.kind, 'order');
  assert.equal(s.tableId, T1);
  assert.deepEqual(s.lines.map((l) => [l.name, l.qty]), [['Tea', 2]]);
  assert.equal(s.totalPaise, 2100);
  const outbox = await db.outbox.orderBy('seq').toArray();
  assert.deepEqual(outbox.map((r) => r.payload.type), ['order.opened', 'order.line_added']);
  const kept = await db.orderEvents.toArray();
  assert.deepEqual(kept.map((k) => [k.deviceId, k.seq]), outbox.map((r) => [device.deviceId, r.seq]));
  assert.deepEqual(kept.map((k) => k.payload), outbox.map((r) => r.payload));
  assert.equal((outbox[1]!.payload as any).lineId, s.lines[0]!.lineId);
});

test('no table pulled yet: no order, and nothing is written', async () => {
  await db.entities.clear();
  await assert.rejects(openOrder({ ...base, actor: waiter, menuVersion: 1 }), /no tables/);
  await assert.rejects(openOrder({ ...base, actor: waiter, menuVersion: 1, tableId: T2 }), /not on this outlet/);
  assert.equal(await db.outbox.count(), 0);
  assert.equal(await db.sales.count(), 0);
});

test('adding an item again bumps this device\'s line; a line another device added gets a new line beside it', async () => {
  let s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea, qty: 2 });
  assert.deepEqual(s.lines.map((l) => [l.name, l.qty]), [['Tea', 3]]);
  assert.deepEqual((await payloads()).map((p) => p.type), ['order.opened', 'order.line_added', 'order.line_changed']);

  // Another device's tea on the same order (step 7 brings such events; here it is planted).
  const foreign: OrderEvent = { type: 'order.line_added', schemaVersion: 2, saleId: s.id, lineId: crypto.randomUUID(), itemId: dosa.itemId, name: 'Dosa', unitPaise: dosa.pricePaise, gstRateBp: 500, qty: 1, by: cashier.id, at: new Date().toISOString() };
  await db.orderEvents.add({ deviceId: 'dev-b', seq: 1, saleId: s.id, payload: foreign });
  s = await moveOrder({ ...base, actor: waiter, saleId: s.id, tableId: T2 }); // any event refolds, so the row now shows it
  assert.deepEqual(s.lines.map((l) => [l.name, l.qty]), [['Tea', 3], ['Dosa', 1]]);
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: dosa });
  assert.deepEqual(s.lines.map((l) => [l.name, l.qty]), [['Tea', 3], ['Dosa', 1], ['Dosa', 1]], 'both dosas land');
});

test('quantity 0 removes the line (a removal, not a change); the same quantity writes nothing', async () => {
  let s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea, qty: 2 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: vada });
  const teaLine = s.lines[0]!.lineId!;
  const before = await db.outbox.count();
  s = await setLineQty({ ...base, actor: waiter, saleId: s.id, lineId: teaLine, qty: 2 });
  assert.equal(await db.outbox.count(), before);
  s = await removeLine({ ...base, actor: cashier, saleId: s.id, lineId: teaLine });
  assert.deepEqual(s.lines.map((l) => l.name), ['Vada']);
  assert.equal(s.totalPaise, 2625);
  const last = (await payloads()).at(-1)!;
  assert.equal(last.type, 'order.line_removed');
  assert.equal((last as any).by, cashier.id, 'any staff may change an order (D18), and the event says who');
  // The removed line is still in the fold (reports show it); it cannot be changed again.
  assert.equal((await foldOf(s.id)).lines.find((l) => l.lineId === teaLine)!.removedBy, cashier.id);
  await assert.rejects(setLineQty({ ...base, actor: waiter, saleId: s.id, lineId: teaLine, qty: 1 }), /not on this order/);
  await assert.rejects(setLineQty({ ...base, actor: waiter, saleId: s.id, lineId: s.lines[0]!.lineId!, qty: 100 }), /At most 99/);
});

test('event times never go backwards on this device, even when the clock does', async () => {
  const t0 = new Date('2026-11-06T10:00:00.000Z');
  let s = await openOrder({ ...base, actor: waiter, menuVersion: 1, now: t0 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea, now: new Date('2026-11-06T09:00:00.000Z') }); // clock set back an hour
  s = await setLineQty({ ...base, actor: waiter, saleId: s.id, lineId: s.lines[0]!.lineId!, qty: 4, now: new Date('2026-11-06T09:00:01.000Z') });
  const times = (await payloads()).map((p) => (p.type === 'order.opened' ? p.createdAtDevice : (p as { at: string }).at));
  assert.deepEqual(times, [t0.toISOString(), t0.toISOString(), t0.toISOString()]);
  assert.equal(s.lines[0]!.qty, 4, 'the change still beats its add');
});

test('moving an order: to a live table only; the same table writes nothing; occupancy follows the order', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });
  await openOrder({ ...base, actor: waiter, menuVersion: 1 }); // a second order on the default table is allowed
  assert.deepEqual((await tableStates()).map((t) => [t.table.code, t.orders.length]), [['T1', 2], ['T2', 0]]);
  const before = await db.outbox.count();
  await moveOrder({ ...base, actor: waiter, saleId: s.id, tableId: T1 });
  await assert.rejects(moveOrder({ ...base, actor: waiter, saleId: s.id, tableId: crypto.randomUUID() }), /not on this outlet/);
  assert.equal(await db.outbox.count(), before);
  const moved = await moveOrder({ ...base, actor: waiter, saleId: s.id, tableId: T2 });
  assert.equal(moved.tableId, T2);
  assert.deepEqual((await tableStates()).map((t) => [t.table.code, t.orders.map((o) => o.id)]).find((x) => x[0] === 'T2')![1], [s.id]);
});

test('paying an order sends v2 with the lines at the quantities shown, and settles its kept events', async () => {
  let s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea, qty: 3 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: dosa });
  s = await removeLine({ ...base, actor: waiter, saleId: s.id, lineId: s.lines[1]!.lineId! });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: vada, qty: 2 });
  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise) });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.receiptNo !== null, true);
  const pay = (await payloads()).at(-1)!;
  assert.equal(pay.type, 'payment.taken');
  assert.equal(pay.schemaVersion, 2);
  assert.deepEqual((pay as any).lines, s.lines.map((l) => ({ lineId: l.lineId, qty: l.qty })));
  assert.equal((pay as any).totalPaise, 3150 + 5250);
  assert.equal(await db.orderEvents.count(), 0);
  await assert.rejects(addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea }), /already closed/);
});

test('an order with nothing on it cannot be paid, and spends no receipt number', async () => {
  let s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea });
  s = await removeLine({ ...base, actor: waiter, saleId: s.id, lineId: s.lines[0]!.lineId! });
  const before = await db.outbox.count();
  await assert.rejects(payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(1050) }), /nothing on it/);
  assert.equal(await db.outbox.count(), before);
  assert.equal(await db.meta.get('receiptCounter'), undefined);
  assert.equal((await db.sales.get(s.id))!.status, 'open');
});

test('a failure part-way through a line change leaves nothing behind', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
  const before = { outbox: await db.outbox.count(), kept: await db.orderEvents.count(), row: await db.sales.get(s.id) };
  const put = db.sales.put.bind(db.sales);
  db.sales.put = (() => Promise.reject(new Error('disk full'))) as any; // the refold's write fails after the event is queued
  try { await assert.rejects(addToOrder({ ...base, actor: waiter, saleId: s.id, entry: tea }), /disk full/); }
  finally { db.sales.put = put; }
  assert.deepEqual({ outbox: await db.outbox.count(), kept: await db.orderEvents.count(), row: await db.sales.get(s.id) }, before);
});

test('closing the shift voids open orders and drops their kept events', async () => {
  const s = await openOrder({ ...base, actor: waiter, menuVersion: 1, cart: [{ itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 1 }] });
  await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.equal((await db.sales.get(s.id))!.status, 'void');
  assert.equal(await db.orderEvents.count(), 0);
  assert.ok((await payloads()).some((p) => p.type === 'sale.voided' && p.saleId === s.id));
});

/** mulberry32: a seeded generator, so a failing history can be replayed from its seed. */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('property: after any sequence of edits the row equals a naive model and the fold of the kept events', async () => {
  const menu = [tea, dosa, vada];
  for (let seed = 1; seed <= 60; seed++) {
    await Promise.all([db.sales.clear(), db.outbox.clear(), db.orderEvents.clear(), db.meta.clear()]);
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    let s = await openOrder({ ...base, actor: waiter, menuVersion: 1 });
    const model: { lineId: string; itemId: string; qty: number }[] = [];
    let table = T1;
    for (let step = 0; step < 25; step++) {
      const op = r();
      const at = new Date(Date.UTC(2026, 10, 6, 10, 0, Math.floor(r() * 60))); // a clock that jumps both ways
      if (op < 0.45 || model.length === 0) {
        const e = pick(menu);
        const q = 1 + Math.floor(r() * 3);
        s = await addToOrder({ ...base, actor: waiter, saleId: s.id, entry: e, qty: q, now: at });
        const same = model.find((m) => m.itemId === e.itemId);
        if (same) same.qty += q; else model.push({ lineId: s.lines.at(-1)!.lineId!, itemId: e.itemId, qty: q });
      } else if (op < 0.75) {
        const m = pick(model);
        const q = 1 + Math.floor(r() * 5);
        s = await setLineQty({ ...base, actor: cashier, saleId: s.id, lineId: m.lineId, qty: q, now: at });
        m.qty = q;
      } else if (op < 0.9) {
        const m = pick(model);
        s = await removeLine({ ...base, actor: waiter, saleId: s.id, lineId: m.lineId, now: at });
        model.splice(model.indexOf(m), 1);
      } else {
        table = table === T1 ? T2 : T1;
        s = await moveOrder({ ...base, actor: waiter, saleId: s.id, tableId: table, now: at });
      }
      const row = (await db.sales.get(s.id))!;
      const fold = await foldOf(s.id);
      const msg = `seed ${seed}, step ${step}`;
      assert.deepEqual(row.lines.map((l) => [l.lineId, l.qty]), model.map((m) => [m.lineId, m.qty]), msg);
      assert.deepEqual(liveLines(fold).map((l) => [l.lineId, l.qty]), model.map((m) => [m.lineId, m.qty]), msg);
      assert.equal(row.totalPaise, totals(liveLines(fold), settings).total, msg);
      assert.equal(row.tableId, table, msg);
      assert.deepEqual(fold.anomalies, [], msg);
    }
  }
});
