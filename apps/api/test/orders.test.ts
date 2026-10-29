import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function managerToken(app: App, tenant: string, email: string) {
  return (await app.inject({ method: 'POST', url: '/login', payload: { tenantId: tenant, email, password: 'dev-password-123' } })).json().token as string;
}
async function world(app: App, tenant: string, email: string, outletName: string) {
  const mgr = await managerToken(app, tenant, email);
  const o = await withTenant(tenant, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const id = (name: string) => withTenant(tenant, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [name])).rows[0].id as string);
  const staffToken = async (role: 'waiter' | 'cashier') => {
    const userId = await id(`${outletName} ${role}`);
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } });
    assert.equal(r.statusCode, 200);
    return { token: r.json().token as string, userId };
  };
  return { mgr, outletId: o.id as string, deviceId: cred.split('.')[1]!, staffToken };
}

/** Inserts an open order straight into the table (orders arrive by sync push in phase 4). */
async function openOrder(tenant: string, outletId: string, deviceId: string, createdBy: string) {
  return withTenant(tenant, async (c) => {
    const r = await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-02-01', $3, $4, 'open', 1, 1000, 50, 1050, now()) RETURNING id`,
      [tenant, outletId, deviceId, createdBy]);
    await c.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       SELECT $1, $2, id, 'Tea', 1000, 500, 1, 1000, 50 FROM item LIMIT 1`, [tenant, r.rows[0].id]);
    return r.rows[0].id as string;
  });
}
const statusOf = (tenant: string, id: string) => withTenant(tenant, async (c) => (await c.query('SELECT status FROM sale WHERE id = $1', [id])).rows[0].status as string);

// One entry per route that declares scope 'own-orders'. The enumeration test fails if a route is
// added without an entry here, so a new order route cannot ship without its "whose" attack.
const ATTACKS: Record<string, (app: App, token: string, orderId: string) => Promise<{ status: number; body: string }>> = {
  'GET /orders/:id': async (app, token, id) => { const r = await app.inject({ method: 'GET', url: `/orders/${id}`, headers: bearer(token) }); return { status: r.statusCode, body: r.body }; },
  'POST /orders/:id/void': async (app, token, id) => { const r = await app.inject({ method: 'POST', url: `/orders/${id}/void`, headers: bearer(token), payload: { reason: 'attack' } }); return { status: r.statusCode, body: r.body }; },
};

test('every route with the own-orders scope has an attack test here', async () => {
  const app = buildApp();
  const seen = new Set<string>();
  app.addHook('onRoute', (r) => {
    if (r.config?.scope === 'own-orders') for (const m of [r.method].flat()) if (m !== 'HEAD') seen.add(`${m} ${r.url}`);
  });
  await app.ready();
  assert.deepEqual([...seen].sort(), ['GET /orders', 'GET /orders/:id', 'POST /orders/:id/void'].sort());
  // The list route has no id to attack; it is covered by the visibility test below.
  for (const route of seen) if (route !== 'GET /orders') assert.ok(ATTACKS[route], `${route} has no attack test`);
});

test('a waiter sees and voids only their own open orders; others look nonexistent (404, identical body)', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const waiter = await w.staffToken('waiter');
  const cashier = await w.staffToken('cashier');
  const other = await openOrder(A, w.outletId, w.deviceId, cashier.userId); // someone else's open order, same outlet
  const missing = '22222222-2222-4222-8222-222222222222';

  const list = (await app.inject({ method: 'GET', url: '/orders', headers: bearer(waiter.token) })).json() as { id: string; createdBy: string; status: string }[];
  assert.ok(list.length >= 1);
  for (const o of list) { assert.equal(o.createdBy, waiter.userId); assert.equal(o.status, 'open'); }
  assert.ok(!list.some((o) => o.id === other), 'waiter listed someone else’s order');

  for (const [route, attack] of Object.entries(ATTACKS)) {
    const theirs = await attack(app, waiter.token, other);
    const nothing = await attack(app, waiter.token, missing);
    assert.equal(theirs.status, 404, `${route}: waiter reached another person's order`);
    assert.equal(theirs.body, nothing.body, `${route}: response distinguishes "not yours" from "does not exist"`);
  }
  assert.equal(await statusOf(A, other), 'open', 'the attack voided it');

  // Their own: readable and voidable. Once paid it is no longer theirs to touch.
  const mine = list[0]!.id;
  assert.equal((await app.inject({ method: 'GET', url: `/orders/${mine}`, headers: bearer(waiter.token) })).statusCode, 200);
  const seededPaid = await withTenant(A, async (c) => (await c.query("SELECT id FROM sale WHERE receipt_no = 'C1-20260101-0001' AND outlet_id = $1", [w.outletId])).rows[0].id as string);
  assert.equal((await ATTACKS['GET /orders/:id']!(app, waiter.token, seededPaid)).status, 404, 'waiter read a paid sale');
  // A PAID sale the waiter took themselves: still not theirs to read once it has left 'open'.
  const ownPaid = await withTenant(A, async (c) => {
    const seq = Date.now() % 1_000_000; // unique per run: receipts are unique per device per day
    const s = await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-02-03', $3, $4, 'paid', $5, $6, 1, 1000, 50, 1050, now()) RETURNING id`,
      [A, w.outletId, w.deviceId, waiter.userId, `C1-20260203-${seq}`, seq]);
    await c.query("INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, 'upi', 1050)", [A, s.rows[0].id]);
    return s.rows[0].id as string;
  });
  assert.equal((await ATTACKS['GET /orders/:id']!(app, waiter.token, ownPaid)).status, 404, 'waiter read their own order after it was paid');
  const mineNow = await openOrder(A, w.outletId, w.deviceId, waiter.userId);
  assert.equal((await ATTACKS['POST /orders/:id/void']!(app, waiter.token, mineNow)).status, 200);
  assert.equal(await statusOf(A, mineNow), 'void');
  assert.equal((await ATTACKS['POST /orders/:id/void']!(app, waiter.token, mineNow)).status, 404, 'voiding twice');
  assert.equal((await app.inject({ method: 'POST', url: `/orders/${mine}/void`, headers: bearer(waiter.token), payload: {} })).statusCode, 400, 'void needs a reason');
});

test('cashier: open orders at the outlet and their own shift; manager: the outlet; nobody across outlets or tenants', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const waiter = await w.staffToken('waiter');
  const cashier = await w.staffToken('cashier');
  const waitersOrder = await openOrder(A, w.outletId, w.deviceId, waiter.userId);
  const paid = await withTenant(A, async (c) => (await c.query("SELECT id FROM sale WHERE receipt_no = 'C1-20260101-0001' AND outlet_id = $1", [w.outletId])).rows[0].id as string);

  // Cashier takes payment on the waiter's order, so must see it; and sees the paid sale of their own shift.
  assert.equal((await ATTACKS['GET /orders/:id']!(app, cashier.token, waitersOrder)).status, 200);
  assert.equal((await ATTACKS['GET /orders/:id']!(app, cashier.token, paid)).status, 200);
  // A paid sale of someone else's shift is not theirs.
  const foreignShiftPaid = await withTenant(A, async (c) => {
    const s = await c.query(
      `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 0) RETURNING id`, [A, w.outletId, w.deviceId, waiter.userId]);
    const sale = await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, shift_id, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-02-02', $3, $4, $5, 'paid', 'C1-20260202-0001', 1, 1, 1000, 50, 1050, now()) RETURNING id`,
      [A, w.outletId, s.rows[0].id, w.deviceId, waiter.userId]);
    await c.query("INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, 'upi', 1050)", [A, sale.rows[0].id]);
    return sale.rows[0].id as string;
  });
  assert.equal((await ATTACKS['GET /orders/:id']!(app, cashier.token, foreignShiftPaid)).status, 404, 'cashier read a paid sale from another cashier’s shift');
  assert.equal((await ATTACKS['GET /orders/:id']!(app, w.mgr, foreignShiftPaid)).status, 200, 'manager sees their outlet');

  // Another outlet of the same tenant, and another tenant.
  const a2 = await world(app, A, 'a2@example.test', 'School 2 Canteen');
  const a2waiter = await a2.staffToken('waiter');
  const b = await world(app, B, 'b1@example.test', 'Main Canteen');
  for (const intruder of [a2waiter.token, (await a2.staffToken('cashier')).token, a2.mgr, b.mgr, (await b.staffToken('cashier')).token]) {
    for (const id of [waitersOrder, paid]) {
      for (const [route, attack] of Object.entries(ATTACKS)) {
        assert.equal((await attack(app, intruder, id)).status, 404, `${route}: reached another outlet or tenant`);
      }
    }
  }
  assert.equal(await statusOf(A, waitersOrder), 'open');
  assert.equal(await statusOf(A, paid), 'paid');
  const seenByA2 = (await app.inject({ method: 'GET', url: '/orders', headers: bearer(a2.mgr) })).json() as { id: string }[];
  assert.ok(!seenByA2.some((o) => o.id === waitersOrder || o.id === paid), 'another outlet’s manager listed these orders');
});

test('a paid sale cannot be voided through the order route', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.staffToken('cashier');
  const paid = await withTenant(A, async (c) => (await c.query("SELECT id FROM sale WHERE receipt_no = 'C1-20260101-0001' AND outlet_id = $1", [w.outletId])).rows[0].id as string);
  assert.equal((await ATTACKS['POST /orders/:id/void']!(app, cashier.token, paid)).status, 404);
  assert.equal((await ATTACKS['POST /orders/:id/void']!(app, w.mgr, paid)).status, 404);
  assert.equal(await statusOf(A, paid), 'paid');
});
