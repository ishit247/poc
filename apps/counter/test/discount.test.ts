// Bill discounts on the tablet (docs/discounts-plan.md step 2), against IndexedDB semantics (fake-indexeddb). The
// server's checks are in apps/api/test/discounts.test.ts; here each event is checked with the SAME shared rule the
// server uses (`totals`, `checkPayment`), so a tablet that splits or totals differently fails here first.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem, checkPayment, foldOrder, paise, renderReceipt, renderShiftSlip, totals, DEFAULT_SETTINGS,
  type BillDiscount, type MenuEntry, type Tender, type TradingSettings,
} from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { createSale, payOrder, type Actor } from '../src/sale.ts';
import { addToOrder, openOrder } from '../src/order.ts';
import { closeShift } from '../src/shift.ts';
import { toReceiptView } from '../src/receipt.ts';
import { seedShift } from './helpers.ts';

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'dev-a', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const item = (n: number, name: string, price: number, gstRateBp: number): MenuEntry =>
  ({ itemId: `4444444${n}-4444-4444-8444-444444444444`, categoryId: 'c', name, sortOrder: n, hsnCode: null, pricePaise: paise(price), gstRateBp, available: true });
// Mixed GST rates and awkward prices, so the split has remainders and lines round separately.
const tea = item(1, 'Tea', 1033, 500);
const cake = item(2, 'Cake', 14999, 1800);
const T1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const settings: TradingSettings = { ...DEFAULT_SETTINGS, discountMaxBp: 1000, billRoundTo: 100 };
const cart = addItem(addItem([], tea, 3), cake, 1);
const tenRupeesOff: BillDiscount = { kind: 'amount', value: 1000, reason: 'Regular customer' };
const tenPercent: BillDiscount = { kind: 'percent', value: 1000, reason: 'Staff meal' };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];
const payloads = async () => (await db.outbox.orderBy('seq').toArray()).map((r) => r.payload);
const state = async () => ({ sales: await db.sales.count(), outbox: await db.outbox.count(), counter: (await db.meta.get('receiptCounter'))?.value });

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.orderEvents.clear(), db.entities.clear()]);
  await db.entities.bulkPut([
    { type: 'dining_table', id: T1, data: { code: 'T1', sortOrder: 0, isDefault: true } },
    { type: 'tenant_setting', id: 't', data: settings },
  ]);
  await seedShift(cashier);
});

test('a counter sale with a discount: the event carries it split by the shared rule, the tenders pay the discounted total', async () => {
  const want = totals(cart, settings, tenPercent);
  assert.ok(want.discount > 0 && want.roundOff !== 0, 'the case exercises round-off after the discount');
  const sale = await createSale({ device, actor: cashier, cart, settings, menuVersion: 1, tenders: cash(want.total), discount: tenPercent });
  assert.equal(sale.status, 'paid');
  assert.equal(sale.totalPaise, want.total);
  assert.equal(sale.discountPaise, want.discount);
  const created = (await payloads()).find((e) => e.type === 'sale.created')!;
  assert.equal(created.type, 'sale.created');
  if (created.type !== 'sale.created') return;
  assert.deepEqual(created.discount, tenPercent);
  assert.equal(created.discountPaise, want.discount);
  assert.deepEqual(created.lines.map((l) => [l.discountPaise, l.taxPaise]), want.lines.map((l) => [l.discount, l.tax]));
  assert.equal(created.lines.reduce((a, l) => a + l.discountPaise, 0), want.discount, 'the shares add up to the discount');
  assert.equal(created.totalPaise, want.total);
  // The payment covers the discounted total, not the bill before it.
  const pay = (await payloads()).find((e) => e.type === 'payment.taken')!;
  assert.equal(pay.type === 'payment.taken' && pay.payments.reduce((a, p) => a + p.amountPaise, 0), want.total);
});

test('the receipt shows the discount before GST, and the shift slip counts it', async () => {
  const want = totals(cart, settings, tenRupeesOff);
  const sale = await createSale({ device, actor: cashier, cart, settings, menuVersion: 1, tenders: cash(want.total), discount: tenRupeesOff });
  const text = renderReceipt(toReceiptView(sale, device, { gstEnabled: true, gstin: '29ABCDE1234F1Z5', address: null, fssaiNo: null }, false));
  const at = (s: string) => text.findIndex((l) => l.startsWith(s));
  // Too long for one line at 32 characters: the reason goes under the amount.
  assert.match(text[at('Discount')]!, /^Discount +-10\.00$/, text.join('\n'));
  assert.equal(text[at('Discount') + 1], '(Regular customer)');
  assert.ok(at('Sub Total') < at('Discount') && at('Discount') < at('CGST'), 'sub total, then discount, then GST');
  const pctSale = await createSale({ device, actor: cashier, cart, settings, menuVersion: 1, tenders: cash(totals(cart, settings, tenPercent).total), discount: tenPercent });
  const pctText = renderReceipt(toReceiptView(pctSale, device, { gstEnabled: true, gstin: '29ABCDE1234F1Z5', address: null, fssaiNo: null }, false));
  assert.ok(pctText.some((l) => l.startsWith('Discount 10%')), 'a percentage shows its rate');
  assert.ok(pctText.every((l) => l.length <= 32), 'nothing runs past the paper');
  const plain = await createSale({ device, actor: cashier, cart, settings, menuVersion: 1, tenders: cash(totals(cart, settings).total) });
  const slip = await closeShift({ device, actor: cashier, countedCashPaise: sale.totalPaise + pctSale.totalPaise + plain.totalPaise });
  assert.deepEqual(slip.discounts, { count: 2, paise: sale.discountPaise! + pctSale.discountPaise! });
  assert.ok(renderShiftSlip(slip).some((l) => /^Discounts \(2\) +\d+\.\d\d$/.test(l)));
  assert.equal(slip.variancePaise, 0, 'the drawer expects the discounted payments');
});

test('a discount the tablet does not offer is refused, and nothing is saved or numbered', async () => {
  const before = await state();
  const total = totals(cart, settings).total;
  const refuse = (why: RegExp, discount: BillDiscount, s = settings) =>
    assert.rejects(createSale({ device, actor: cashier, cart, settings: s, menuVersion: 1, tenders: cash(total), discount }), why);
  await refuse(/At most 10%/, { ...tenPercent, value: 1001 });
  await refuse(/At most 10%/, { kind: 'amount', value: Math.floor(totals(cart, settings).subtotal / 10) + 1, reason: 'x' }); // flat, over 10% of the subtotal
  await refuse(/Discounts are off/, tenPercent, { ...settings, discountMaxBp: 0 });
  await refuse(/leave something to pay/, { kind: 'percent', value: 10000, reason: 'x' }, { ...settings, discountMaxBp: 10000 });
  await assert.rejects(createSale({ device, actor: waiter, cart, settings, menuVersion: 1, discount: tenPercent }), /when the bill is paid/);
  assert.deepEqual(await state(), before);
});

test('a running order paid with a discount: v2 lines in the order shown with their shares, accepted by checkPayment', async () => {
  let s = await openOrder({ device, settings, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ device, settings, actor: waiter, saleId: s.id, entry: cake });
  s = await addToOrder({ device, settings, actor: waiter, saleId: s.id, entry: tea, qty: 3 });
  // The server's view of the order: the fold of the events the tablet sent, before payment settles them.
  const rows = await db.orderEvents.where('saleId').equals(s.id).toArray();
  const fold = foldOrder(s.id, rows.map((r) => ({ deviceId: r.deviceId, seq: r.seq, payload: r.payload })));
  const want = totals(s.lines.map((l) => ({ ...l, unitPaise: paise(l.unitPaise) })), settings, tenPercent);
  assert.notEqual(want.total, s.totalPaise);

  const before = await state();
  await assert.rejects(payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise), discount: tenPercent, settings }), /add up|total/i,
    'tendering the undiscounted total is refused');
  assert.deepEqual(await state(), before, 'and spends no receipt number');

  const paid = await payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(want.total), discount: tenPercent, settings });
  assert.equal(paid.totalPaise, want.total);
  assert.equal(paid.discountPaise, want.discount);
  assert.deepEqual((await db.sales.get(s.id))!.lines.map((l) => l.discountPaise), want.lines.map((l) => l.discount), 'the stored row is the receipt');
  const pay = (await payloads()).at(-1)!;
  assert.ok(pay.type === 'payment.taken' && pay.schemaVersion === 2);
  if (pay.type !== 'payment.taken' || pay.schemaVersion !== 2) return;
  assert.deepEqual(pay.lines.map((l) => l.lineId), s.lines.map((l) => l.lineId), 'in the order shown');
  assert.deepEqual(pay.discount, tenPercent);
  assert.equal(pay.totalPaise, want.total);
  const check = checkPayment(fold, pay.lines, pay.totalPaise, settings, pay.discount);
  assert.equal(check.kind, 'ok', JSON.stringify(check));
});

test('an order cannot be discounted over the cap, and stays open', async () => {
  let s = await openOrder({ device, settings, actor: waiter, menuVersion: 1 });
  s = await addToOrder({ device, settings, actor: waiter, saleId: s.id, entry: tea });
  const before = await state();
  await assert.rejects(payOrder({ device, actor: cashier, saleId: s.id, tenders: cash(s.totalPaise), discount: { ...tenPercent, value: 2000 }, settings }), /At most 10%/);
  assert.deepEqual(await state(), before);
  assert.equal((await db.sales.get(s.id))!.status, 'open');
});
