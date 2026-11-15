// Refunds on the tablet (docs/refunds-plan.md step 2): the slip's expected cash drops by the cash paid out, and agrees
// with the server's, whether the route's answer arrived or only the pull did. Against the real server and Postgres.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, DEFAULT_SETTINGS, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { createSale, type Actor } from '../src/sale.ts';
import { pull, push } from '../src/sync.ts';
import { closeShift, managerCloseShift, openShift, slipFor } from '../src/shift.ts';
import { refundByMethod, refundSale, whyNotRefundable, whyNotRefundableEach } from '../src/refund.ts';
import { signInOnline } from '../src/online.ts';
import { buildApp } from '../../api/src/app.ts';
import { pool, withTenant } from '../../api/src/db.ts';

(globalThis as any).__APP_VERSION__ = 'test';
test.after(() => pool.end());

const A = '00000000-0000-4000-8000-00000000000a';
const PIN = '482913';
const app = buildApp();
const realFetch = globalThis.fetch;

async function setup() {
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: 'tenant-a.localhost' }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(A, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = 'School 1 Canteen'")).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const credential = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const ids = await withTenant(A, async (c) => ({
    user: (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'")).rows[0].id as string,
    item: (await c.query("SELECT id FROM item WHERE name = 'Tea'")).rows[0].id as string,
  }));
  const device: DeviceInfo = { credential, deviceId: credential.split('.')[1]!, tenantId: A, outletId: o.id, counterId: o.counter_id, counterCode: 'C1', outletName: 'School 1 Canteen', timezone: 'Asia/Kolkata' };
  const actor: Actor = { id: ids.user, name: 'School 1 Canteen cashier', role: 'cashier' };
  const tea: MenuEntry = { itemId: ids.item, categoryId: 'c', name: 'Tea', sortOrder: 0, hsnCode: null, pricePaise: paise(1000), gstRateBp: 500, available: true };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const r = await app.inject({ method: (init.method ?? 'GET') as 'GET' | 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  const signIn = await signInOnline(credential, ids.user, PIN);
  assert.ok(signIn.ok);
  // Pull everything up to now, so a later pull carries only what the test does next.
  await pull(device);
  return { mgr, device, actor, tea, token: signIn.token };
}

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.shifts.clear(), db.orderEvents.clear(), db.entities.clear()]);
  globalThis.fetch = realFetch;
});

const serverShift = (id: string) => withTenant(A, async (c) => (await c.query(
  'SELECT expected_cash_paise::int AS expected, variance_paise::int AS variance FROM shift WHERE id = $1', [id])).rows[0]);
// Tea is 10.00 + 5% GST = 10.50 a cup.
const split = (cash: number, upi: number): Tender[] => [
  { method: 'cash', amountPaise: paise(cash), tenderedPaise: paise(cash) }, { method: 'upi', amountPaise: paise(upi), tenderedPaise: paise(upi) }];

test('a cash refund comes out of the slip and the server alike; UPI does not touch the drawer', async () => {
  const { device, actor, tea, token } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 50_000 });
  const refunded = await createSale({ device, actor, cart: addItem([], tea, 2), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: split(1200, 900) });
  await createSale({ device, actor, cart: addItem([], tea, 1), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: split(1050, 0).slice(0, 1) });

  assert.match(await whyNotRefundable(refunded, actor) ?? '', /not reached the server/, 'still in the outbox');
  // The dialog names what will be paid out; it matches what the server answers below.
  assert.deepEqual(refundByMethod(refunded), [{ method: 'cash', amountPaise: 1200 }, { method: 'upi', amountPaise: 900 }]);
  await assert.rejects(refundSale({ actor, token, saleId: refunded.id, reason: 'wrong item', pin: PIN }), /not reached the server/);
  await push(device);
  await assert.rejects(refundSale({ actor, token, saleId: refunded.id, reason: 'wrong item', pin: '000000' }), /Wrong PIN/);
  assert.equal((await db.sales.get(refunded.id))!.status, 'paid');

  assert.deepEqual((await refundSale({ actor, token, saleId: refunded.id, reason: 'wrong item', pin: PIN })).sort((a, b) => a.method.localeCompare(b.method)),
    [{ method: 'cash', amountPaise: 1200 }, { method: 'upi', amountPaise: 900 }]);
  assert.equal((await db.sales.get(refunded.id))!.status, 'refunded');
  assert.equal(await whyNotRefundable((await db.sales.get(refunded.id))!, actor), 'Already refunded.');

  // 500.00 float + 12.00 + 10.50 cash taken - 12.00 cash paid back = 510.50. The cashier counts 510.00.
  const slip = await closeShift({ device, actor, countedCashPaise: 51_000 });
  assert.equal(slip.variancePaise, -50);
  assert.deepEqual(slip.refunds, { count: 1, cashPaise: 1200, upiPaise: 900 });
  assert.equal(slip.cashSalesPaise, 2250, 'the refunded sale was still taken');
  await push(device);
  assert.deepEqual(await serverShift(shift.id), { expected: 51_050, variance: -50 }, 'the server agrees with the slip');
});

test('the answer was lost: pull marks the sale refunded and the slip still agrees with the server', async () => {
  const { device, actor, tea, token } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 0 });
  const sale = await createSale({ device, actor, cart: addItem([], tea, 1), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: split(1050, 0).slice(0, 1) });
  await push(device);
  // The server refunds; the tablet never hears back.
  const r = await app.inject({ method: 'POST', url: `/sales/${sale.id}/refund`, headers: { authorization: `Bearer ${token}` }, payload: { reason: 'cold', pin: PIN } });
  assert.equal(r.statusCode, 200);
  assert.equal((await db.sales.get(sale.id))!.status, 'paid');
  await assert.rejects(refundSale({ actor, token, saleId: sale.id, reason: 'cold', pin: PIN }), /Already refunded/);

  await pull(device);
  assert.deepEqual((await db.sales.get(sale.id))!.refunds, [{ method: 'cash', amountPaise: 1050 }]);
  assert.equal((await db.sales.get(sale.id))!.status, 'refunded');
  await pull(device); // a page seen twice changes nothing
  assert.equal((await db.sales.get(sale.id))!.refunds!.length, 1);

  const slip = await closeShift({ device, actor, countedCashPaise: 0 });
  assert.equal(slip.variancePaise, 0);
  await push(device);
  assert.deepEqual(await serverShift(shift.id), { expected: 0, variance: 0 });
});

test('a manager closing the drawer counts the refund out too', async () => {
  const { mgr, device, actor, tea, token } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 10_000 });
  const sale = await createSale({ device, actor, cart: addItem([], tea, 1), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: split(1050, 0).slice(0, 1) });
  await push(device);
  await refundSale({ actor, token, saleId: sale.id, reason: 'spilt', pin: PIN });
  await managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 10_000 });
  assert.deepEqual((await db.shifts.get(shift.id))!.closedByManager, { expectedCashPaise: 10_000, variancePaise: 0 });
  // The tablet's own slip for the same drawer agrees.
  assert.equal((await slipFor((await db.shifts.get(shift.id))!, device)).variancePaise, 0);
});

test('only this drawer’s paid bills are offered, and only to its cashier', async () => {
  const { device, actor, tea } = await setup();
  await openShift({ actor, openingCashPaise: 0 });
  const sale = await createSale({ device, actor, cart: addItem([], tea, 1), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: split(1050, 0).slice(0, 1) });
  await push(device);
  assert.equal(await whyNotRefundable(sale, actor), null);
  assert.match(await whyNotRefundable(sale, { ...actor, id: crypto.randomUUID(), name: 'Other' }) ?? '', /belongs to/);
  assert.match(await whyNotRefundable({ ...sale, shiftId: crypto.randomUUID() }, actor) ?? '', /drawer open now/);
  assert.match(await whyNotRefundable({ ...sale, status: 'void' }, actor) ?? '', /Only a paid bill/);
  // An event the server refused for good is not "waiting to be sent": it does not block the offer.
  await db.outbox.add({ eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), payload: { type: 'print.reprinted', saleId: sale.id } as never, rejected: 'test' });
  // The list form (Recent receipts) gives each sale the same answer as the single form.
  const other = { ...sale, id: crypto.randomUUID(), shiftId: crypto.randomUUID() };
  assert.deepEqual([...(await whyNotRefundableEach([sale, other], actor))].map(([, why]) => why === null), [true, false]);
  await closeShift({ device, actor, countedCashPaise: 1050 });
  assert.match(await whyNotRefundable(sale, actor) ?? '', /drawer open now/, 'a closed drawer');
});
