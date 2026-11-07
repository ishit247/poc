// A manager closes another cashier's drawer from the tablet (managerCloseShift). Against the real server and Postgres.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, DEFAULT_SETTINGS, type MenuEntry, type Tender } from '@pos/shared';
import { currentShift, db, type DeviceInfo } from '../src/db.ts';
import { createSale, type Actor } from '../src/sale.ts';
import { push } from '../src/sync.ts';
import { managerCloseShift, openShift } from '../src/shift.ts';
import { buildApp } from '../../api/src/app.ts';
import { pool, withTenant } from '../../api/src/db.ts';

(globalThis as any).__APP_VERSION__ = 'test';
test.after(() => pool.end());

const A = '00000000-0000-4000-8000-00000000000a';
const app = buildApp();
const realFetch = globalThis.fetch;
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];

/** A real enrolled tablet at School 1, the first cashier, a manager token, and fetch routed into the real app. */
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
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const r = await app.inject({ method: (init.method ?? 'GET') as 'GET' | 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  return { mgr, device, actor, tea, calls };
}

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.shifts.clear(), db.orderEvents.clear()]);
  globalThis.fetch = realFetch;
});

const serverShift = (id: string) => withTenant(A, async (c) => (await c.query(
  'SELECT closed_at IS NOT NULL AS closed, counted_cash_paise::int AS counted, expected_cash_paise::int AS expected, variance_paise::int AS variance FROM shift WHERE id = $1', [id])).rows[0]);

test('a manager closes a drawer its cashier left open; the next cashier is no longer blocked', async () => {
  const { mgr, device, actor, tea } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 50_000 });
  await createSale({ device, actor, cart: addItem([], tea, 2), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: cash(2100) });
  await push(device);
  assert.equal(await db.outbox.count(), 0);

  await managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 52_000 }); // ₹1.00 short of 500 + 21

  const local = (await db.shifts.get(shift.id))!;
  assert.deepEqual([local.closedAt !== null, local.countedCashPaise, local.closedByManager], [true, 52_000, { expectedCashPaise: 52_100, variancePaise: -100 }]);
  assert.equal(await currentShift(), undefined, 'no drawer is open: the next cashier can open theirs');
  assert.deepEqual(await serverShift(shift.id), { closed: true, counted: 52_000, expected: 52_100, variance: -100 });

  // Closed already (a second manager, or Day close): not an error, and the first count stands.
  await managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 1 });
  assert.equal((await serverShift(shift.id)).counted, 52_000);
});

test('refuses while a sale is still waiting to be sent, and does not touch the server', async () => {
  const { mgr, device, actor, tea, calls } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 50_000 });
  await push(device); // the server knows the drawer...
  await createSale({ device, actor, cart: addItem([], tea, 1), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: cash(1050) }); // ...but not this sale
  calls.length = 0;

  await assert.rejects(managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 51_050 }), /not reached the server/);
  assert.deepEqual(calls, [], 'no request: the server would have worked out expected cash without this sale');
  assert.equal((await currentShift())?.id, shift.id, 'still open on the tablet');
  assert.equal((await serverShift(shift.id)).closed, false, 'still open on the server');

  // Once it is sent, the close goes through and the sale is in the expected figure.
  await push(device);
  await managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 51_050 });
  assert.deepEqual(await serverShift(shift.id), { closed: true, counted: 51_050, expected: 51_050, variance: 0 });
});

test('a drawer the server never heard of is refused with a clear message and stays open', async () => {
  const { mgr, device, actor } = await setup();
  const shift = await openShift({ actor, openingCashPaise: 0 });
  await db.outbox.clear(); // as after a server reset: the tablet thinks it was sent, the server has no row
  await assert.rejects(managerCloseShift({ device, token: mgr, shiftId: shift.id, countedCashPaise: 0 }), /no record of this drawer/);
  assert.equal((await currentShift())?.id, shift.id);
});
