// Day close with online orders (phase 7, step 7). Named to run last: it adds an outlet to tenant A, and the
// outlet and scope suites pick "the first outlet" and count outlets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';

const A = '00000000-0000-4000-8000-00000000000a';
const PIN = '482913';
test.after(() => pool.end());

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// The outlet is the test's own: closing today would block every other test's handovers.
async function world(app: ReturnType<typeof buildApp>) {
  const name = `ZZ online close ${randomUUID().slice(0, 8)}`;
  const { outletId, counterId, cashierId } = await withTenant(A, async (c) => {
    const o = (await c.query('INSERT INTO outlet (tenant_id, name) VALUES ($1, $2) RETURNING id', [A, name])).rows[0].id as string;
    const k = (await c.query("INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1') RETURNING id", [A, o])).rows[0].id as string;
    const u = (await c.query(
      `INSERT INTO app_user (tenant_id, name, pin_verifier, role)
       SELECT $1, $2, pin_verifier, 'cashier' FROM app_user WHERE name = 'School 1 Canteen cashier' RETURNING id`, [A, `${name} cashier`])).rows[0].id as string;
    for (const user of [u, (await c.query("SELECT id FROM app_user WHERE email = 'a1@example.test'")).rows[0].id]) {
      await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [A, user, o]);
    }
    return { outletId: o, counterId: k, cashierId: u };
  });
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId, counterId } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const signin = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: cashierId, pin: PIN } });
  assert.equal(signin.statusCode, 200);
  const itemId = await withTenant(A, async (c) =>
    (await c.query(`SELECT i.id FROM item i JOIN item_price ip ON ip.item_id = i.id AND ip.channel = 'zomato' AND ip.deleted_at IS NULL
                     WHERE i.deleted_at IS NULL ORDER BY i.name LIMIT 1`)).rows[0].id as string);
  return { mgr, outletId, itemId, cashier: signin.json().token as string };
}

test('day close: an undelivered online order blocks it; a handover counts as online gross; a handover after the close shows on the next close', async () => {
  const app = buildApp();
  const w = await world(app);
  const today = await withTenant(A, async (c) => (await c.query('SELECT (now() AT TIME ZONE timezone)::date::text d FROM outlet WHERE id = $1', [w.outletId])).rows[0].d as string);
  const close = (date: string) => app.inject({ method: 'POST', url: `/outlets/${w.outletId}/day-close`, headers: bearer(w.mgr), payload: { date } });
  const preview = async (date: string) => (await app.inject({ method: 'GET', url: `/outlets/${w.outletId}/day-close?date=${date}`, headers: bearer(w.mgr) })).json();
  const order = async () => (await app.inject({ method: 'POST', url: '/online-orders', headers: bearer(w.cashier),
    payload: { channel: 'zomato', externalOrderId: `T-${randomUUID().slice(0, 8)}`, lines: [{ itemId: w.itemId, qty: 1 }] } })).json();
  const deliver = async (id: string) => {
    for (const to of ['accepted', 'preparing', 'ready', 'handed_over']) {
      assert.equal((await app.inject({ method: 'POST', url: `/online-orders/${id}/transition`, headers: bearer(w.cashier), payload: { to, prepMinutes: 5 } })).statusCode, 200);
    }
  };

  const first = await order();
  const blocked = await close(today);
  assert.equal(blocked.statusCode, 409, 'an order still in flight holds the day open');
  assert.equal(blocked.json().blockers.openSales, 1);

  await deliver(first.id);
  const p = await preview(today);
  assert.equal(p.totals.onlineGrossPaise, Number(first.totalPaise));
  assert.equal(p.totals.grossPaise, Number(first.totalPaise));
  assert.equal(p.totals.cashPaise, 0);
  const closed = await close(today);
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().totals.onlineGrossPaise, Number(first.totalPaise));

  // Handed over after the close: flagged, the frozen totals do not move, and the next close has to show it.
  const second = await order();
  await deliver(second.id);
  const flags = await withTenant(A, async (c) => (await c.query('SELECT flags FROM sale WHERE id = $1', [second.saleId])).rows[0].flags);
  assert.deepEqual(flags, ['late_arrival']);
  const frozen = await withTenant(A, async (c) => (await c.query('SELECT totals FROM business_day WHERE outlet_id = $1 AND date = $2', [w.outletId, today])).rows[0].totals);
  assert.equal(frozen.onlineGrossPaise, Number(first.totalPaise), 'the closed day did not move');

  const tomorrow = await withTenant(A, async (c) => (await c.query('SELECT ($1::date + 1)::text d', [today])).rows[0].d as string);
  const next = await preview(tomorrow);
  assert.deepEqual(next.lateAdjustments.map((x: any) => [x.businessDate, x.totalPaise, x.receiptNo]), [[today, Number(second.totalPaise), null]]);
});
