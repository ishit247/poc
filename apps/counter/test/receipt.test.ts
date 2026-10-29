// What a receipt prints and what a reprint leaves behind, on the tablet's write path (fake-indexeddb).
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, renderReceipt, RECEIPT_WIDTH, DEFAULT_SETTINGS, OutboxEvent, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { createSale, recentReceipts, recordReprint, type Actor } from '../src/sale.ts';
import { toReceiptView, type OutletInfo } from '../src/receipt.ts';

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'd', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test Canteen', timezone: 'Asia/Kolkata' };
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const tea: MenuEntry = { itemId: '44444444-4444-4444-8444-444444444444', categoryId: 'c', name: 'Tea', sortOrder: 0, hsnCode: null, pricePaise: paise(1000), gstRateBp: 500, available: true };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n + 500) }];
const outlet: OutletInfo = { gstEnabled: true, gstin: '27ABCDE1234F1Z5', address: '1 Test Road', fssaiNo: '11516034000797' };
const base = { device, cart: addItem([], tea, 2), settings: DEFAULT_SETTINGS, menuVersion: 1 };

beforeEach(async () => { await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear()]); });

test('a paid sale becomes a receipt that fits the paper; an unpaid order has none', async () => {
  const paid = await createSale({ ...base, actor: cashier, tenders: cash(2100) });
  const text = renderReceipt(toReceiptView(paid, device, outlet, false));
  assert.ok(text.every((l) => l.length <= RECEIPT_WIDTH));
  assert.ok(text.some((l) => l.includes(paid.receiptNo!)));
  assert.ok(text.some((l) => /TOTAL\s+21\.00$/.test(l)));
  // 2 x 10.00 at 5% = 1.00 tax, shown as 0.50 CGST + 0.50 SGST.
  assert.ok(text.some((l) => /CGST @2\.5%\s+0\.50$/.test(l)) && text.some((l) => /SGST @2\.5%\s+0\.50$/.test(l)));
  const open = await createSale({ ...base, actor: waiter });
  assert.throws(() => toReceiptView(open, device, outlet, false), /no receipt/);
});

test('a reprint is queued as an event with who and when; only a cashier, only a paid sale', async () => {
  const paid = await createSale({ ...base, actor: cashier, tenders: cash(2100) });
  const open = await createSale({ ...base, actor: waiter });
  const before = await db.outbox.count();

  await assert.rejects(recordReprint({ actor: waiter, saleId: paid.id }), /only a cashier/);
  await assert.rejects(recordReprint({ actor: cashier, saleId: open.id }), /only a paid sale/);
  await assert.rejects(recordReprint({ actor: cashier, saleId: crypto.randomUUID() }), /only a paid sale/);
  assert.equal(await db.outbox.count(), before, 'refused reprints leave nothing behind');

  const now = new Date('2026-03-01T10:00:00Z');
  await recordReprint({ actor: cashier, saleId: paid.id, now });
  const last = (await db.outbox.orderBy('seq').last())!;
  assert.deepEqual(OutboxEvent.parse(last.payload), { type: 'print.reprinted', schemaVersion: 1, saleId: paid.id, reprintedBy: cashier.id, at: now.toISOString() });
  assert.equal(await db.outbox.count(), before + 1);
});

test('recent receipts are the paid sales only, newest first', async () => {
  const a = await createSale({ ...base, actor: cashier, tenders: cash(2100), now: new Date('2026-03-01T09:00:00Z') });
  await createSale({ ...base, actor: waiter, now: new Date('2026-03-01T09:30:00Z') });
  const c = await createSale({ ...base, actor: cashier, tenders: cash(2100), now: new Date('2026-03-01T10:00:00Z') });
  assert.deepEqual((await recentReceipts()).map((s) => s.id), [c.id, a.id]);
  assert.equal((await recentReceipts(1)).length, 1);
});
