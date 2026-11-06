// Step 7d: a payment this tablet took, refused by the server because another device's closing of the order stood
// (`already_paid`: paid there first; `sale_void`: voided there first). Scripted server answers; the real-API races are
// in push.test.ts. What must hold: the row stops counting as paid, the receipt and cash stay accounted for, a later
// pull neither resurrects nor deletes it, and only a manager's acknowledgement clears the banner.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, renderShiftSlip, DEFAULT_SETTINGS, type MenuEntry, type OrderEvent, type Tender } from '@pos/shared';
import { db, getMeta, type DeviceInfo } from '../src/db.ts';
import { createSale, payOrder, recentReceipts, type Actor } from '../src/sale.ts';
import { addToOrder, applyVisits, openOrder, tableStates, type PulledVisit } from '../src/order.ts';
import { closeShift } from '../src/shift.ts';
import { push } from '../src/sync.ts';
import { acknowledgeRefused, isRefusedPayment, unacknowledgedRefused } from '../src/refused.ts';
import { seedShift } from './helpers.ts';

(globalThis as any).__APP_VERSION__ = 'test';
const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'dev-a', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const OTHER = 'dev-b';
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const tea: MenuEntry = { itemId: '44444441-4444-4444-8444-444444444444', categoryId: 'c', name: 'Tea', sortOrder: 1, hsnCode: null, pricePaise: paise(1000), gstRateBp: 500, available: true };
const T1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const T2 = 'aaaaaaa1-0000-4000-8000-000000000002';
const settings = DEFAULT_SETTINGS;
const base = { device, settings };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.orderEvents.clear(), db.entities.clear(), db.visits.clear()]);
  await db.entities.bulkPut([
    { type: 'dining_table', id: T1, data: { code: 'T1', sortOrder: 0, isDefault: true } },
    { type: 'dining_table', id: T2, data: { code: 'T2', sortOrder: 1, isDefault: false } },
    { type: 'user', id: waiter.id, data: { name: 'Wait', role: 'waiter' } },
  ]);
  await seedShift(cashier);
});

/** The server: refuses a payment of `saleId` with `reason`, applies everything else. Ack calls answer `ack`. */
function server(saleId: string, reason: string, ack = 200) {
  const acks: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes('/refused-payments/')) { acks.push(String(url)); return new Response('{}', { status: ack }); }
    const events = JSON.parse(init.body as string).events as { eventId: string; payload: { type: string; saleId?: string } }[];
    return new Response(JSON.stringify({ results: events.map((e) =>
      (e.payload.type === 'payment.taken' && e.payload.saleId === saleId ? { eventId: e.eventId, status: 'rejected', reason } : { eventId: e.eventId, status: 'applied' })) }), { status: 200 });
  }) as typeof fetch;
  return acks;
}
const apply = (vs: PulledVisit[]) => db.transaction('rw', [db.visits, db.sales, db.orderEvents, db.entities, db.meta], () => applyVisits(device, vs, settings));
const onT2 = async () => (await tableStates()).find((s) => s.table.id === T2)!.orders;

test('7d already_paid: the row is refused, keeps its receipt and payments, the counter is unchanged, and the slip accounts for the cash', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, tableId: T2 });
  const row = await addToOrder({ ...base, actor: cashier, saleId: s.id, entry: tea });
  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(row.totalPaise) });
  const other = await createSale({ device, actor: cashier, cart: addItem([], tea, 1), settings, menuVersion: 1, tenders: cash(1050) });
  const counter = await getMeta('receiptCounter');
  server(s.id, 'already_paid');

  const sum = await push(device);
  assert.equal(sum.parked, 1);
  const after = (await db.sales.get(s.id))!;
  assert.equal(after.status, 'refused');
  assert.equal(after.refused?.reason, 'already_paid');
  assert.equal(after.receiptNo, paid.receiptNo, 'the receipt number stays this row\'s');
  assert.deepEqual(after.payments, paid.payments);
  assert.deepEqual(await getMeta('receiptCounter'), counter, 'the receipt counter is not touched');
  assert.equal((await db.sales.get(other.id))!.status, 'paid', 'the other sale is untouched');
  const parked = (await db.outbox.toArray()).filter((r) => r.rejected);
  assert.equal(parked.length, 1);
  assert.ok(isRefusedPayment(parked[0]!), 'shown by the refused banner, not the generic one');
  assert.equal(after.refused?.eventId, parked[0]!.eventId);
  assert.deepEqual((await unacknowledgedRefused()).map((x) => x.id), [s.id]);
  assert.deepEqual((await recentReceipts()).map((x) => x.id), [other.id], 'not offered for reprint as a paid receipt');

  // A later pull: the server says the visit is paid by the other device and closed. The refused row stays as it is.
  await apply([{ rootId: s.id, version: 9, sales: [{ id: s.id, status: 'paid', deviceId: OTHER }], open: null }]);
  assert.equal((await db.sales.get(s.id))?.status, 'refused', 'not deleted by the pull');
  assert.equal((await onT2()).length, 0, 'and not on the table');

  // Shift close: both amounts are in the drawer. A count of exactly that matches; the refused part is its own line.
  const slip = await closeShift({ device, actor: cashier, countedCashPaise: row.totalPaise + 1050 });
  assert.equal(slip.salesCount, 1);
  assert.equal(slip.cashSalesPaise, 1050);
  assert.deepEqual(slip.refused, { count: 1, cashPaise: row.totalPaise, upiPaise: 0 });
  assert.equal(slip.variancePaise, 0);
  const text = renderShiftSlip(slip).join('\n');
  assert.match(text, /Taken, refused by server \(1\)/);
  assert.match(text, /Refund or hand to manager\./);
  assert.match(text, /Cash matches/);
  assert.equal((await db.sales.get(s.id))?.status, 'refused', 'shift close does not void or drop it');
});

test('7d sale_void: another device\'s order paid here, voided there first: refused; a stale open pull does not reopen it', async () => {
  // The other device's order, as pulled.
  const root = crypto.randomUUID();
  const ev = (seq: number, payload: OrderEvent) => ({ deviceId: OTHER, seq, payload });
  const events = [
    ev(1, { type: 'order.opened', schemaVersion: 2, saleId: root, tableId: T2, createdBy: waiter.id, businessDate: '2026-11-06', createdAtDevice: '2026-11-06T10:00:00Z', menuVersion: 1 }),
    ev(2, { type: 'order.line_added', schemaVersion: 2, saleId: root, lineId: crypto.randomUUID(), itemId: tea.itemId, name: 'Tea', unitPaise: tea.pricePaise, gstRateBp: 500, qty: 2, by: waiter.id, at: '2026-11-06T10:00:01Z' }),
  ];
  const openVisit: PulledVisit = { rootId: root, version: 1, sales: [{ id: root, status: 'open', deviceId: OTHER }], open: { saleId: root, deviceId: OTHER, closed: [], events } };
  await apply([openVisit]);
  const view = (await onT2())[0]!;
  const upi: Tender[] = [{ method: 'upi', amountPaise: paise(view.totalPaise), tenderedPaise: null, upiRef: 'UTR9' }];
  await payOrder({ device, actor: cashier, saleId: root, tenders: upi });
  server(root, 'sale_void');
  await push(device);
  assert.equal((await db.sales.get(root))?.status, 'refused');
  assert.equal((await db.sales.get(root))?.refused?.reason, 'sale_void');

  // A pull made before the void reached this tablet still shows it open: it does not come back as a view.
  await apply([openVisit]);
  assert.equal((await onT2()).length, 0, 'not resurrected');
  // And the closed visit: the refused row stays.
  await apply([{ rootId: root, version: 2, sales: [{ id: root, status: 'void', deviceId: OTHER }], open: null }]);
  assert.equal((await db.sales.get(root))?.status, 'refused', 'not voided or deleted by the pull');

  const slip = await closeShift({ device, actor: cashier, countedCashPaise: 0 });
  assert.deepEqual(slip.refused, { count: 1, cashPaise: 0, upiPaise: view.totalPaise });
  assert.equal(slip.variancePaise, 0, 'UPI is not in the drawer');
  assert.equal(slip.salesCount, 0);
});

test('7d: any other refusal of a payment leaves the row paid and parks it the old way (a fault for the manager)', async () => {
  const sale = await createSale({ device, actor: cashier, cart: addItem([], tea, 1), settings, menuVersion: 1, tenders: cash(1050) });
  server(sale.id, 'bad_receipt_no');
  await push(device);
  assert.equal((await db.sales.get(sale.id))?.status, 'paid');
  const parked = (await db.outbox.toArray()).filter((r) => r.rejected);
  assert.equal(parked.length, 1);
  assert.equal(isRefusedPayment(parked[0]!), false);
  assert.deepEqual(await unacknowledgedRefused(), []);
});

test('7d: a manager\'s acknowledgement clears the banner and the parked row; a refused server call changes nothing here', async () => {
  const s = await openOrder({ ...base, actor: cashier, menuVersion: 1, tableId: T2 });
  const row = await addToOrder({ ...base, actor: cashier, saleId: s.id, entry: tea });
  await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(row.totalPaise) });
  server(s.id, 'already_paid', 404);
  await push(device);
  const eventId = (await db.sales.get(s.id))!.refused!.eventId;

  await assert.rejects(acknowledgeRefused({ token: 'tok', outletId: 'o', saleId: s.id }), /no record/);
  assert.equal((await unacknowledgedRefused()).length, 1, 'still shown');
  assert.equal(await db.outbox.where('eventId').equals(eventId).count(), 1);

  const acks = server(s.id, 'already_paid', 200);
  await acknowledgeRefused({ token: 'tok', outletId: 'o', saleId: s.id });
  assert.deepEqual(acks, [`/api/outlets/o/refused-payments/${eventId}/ack`]);
  assert.deepEqual(await unacknowledgedRefused(), []);
  assert.equal(await db.outbox.where('eventId').equals(eventId).count(), 0, 'the parked copy goes: the server holds the event');
  const after = (await db.sales.get(s.id))!;
  assert.equal(after.status, 'refused', 'still refused: acknowledging changes no money');
  assert.ok(after.refused?.ackAt);
  const slip = await closeShift({ device, actor: cashier, countedCashPaise: row.totalPaise });
  assert.deepEqual(slip.refused, { count: 1, cashPaise: row.totalPaise, upiPaise: 0 }, 'the slip still counts it');
  assert.equal(slip.variancePaise, 0);
});
