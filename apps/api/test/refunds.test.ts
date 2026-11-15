import test from 'node:test';
import { hostFor } from './hosts.js';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

// Refunds (docs/refunds-plan.md, PLAN 17 Q15): the cashier of the open shift that took the payment, on that tablet,
// after typing their PIN again. Everything else reads as not found.
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function enrol(app: App, tenant: string, email: string, outletName: string) {
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(tenant, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const signIn = async (name: string) => {
    const userId = await withTenant(tenant, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [name])).rows[0].id as string);
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } });
    assert.equal(r.statusCode, 200);
    return { token: r.json().token as string, userId };
  };
  return { mgr, outletId: o.id as string, deviceId: cred.split('.')[1]!, signIn };
}

let seq = Date.now() % 100_000; // receipts are unique per device per day
async function openShift(tenant: string, outletId: string, deviceId: string, userId: string) {
  return withTenant(tenant, async (c) => (await c.query(
    `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 10000) RETURNING id`, [tenant, outletId, deviceId, userId])).rows[0].id as string);
}
/** A sale of `shiftId`, paid 600 cash + 450 UPI unless told otherwise. */
async function paidSale(tenant: string, outletId: string, deviceId: string, userId: string, shiftId: string | null,
  { status = 'paid', pays = [['cash', 600], ['upi', 450]] as [string, number][] } = {}) {
  return withTenant(tenant, async (c) => {
    const n = ++seq;
    const paid = status !== 'open' && status !== 'void';
    const s = await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, shift_id, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device, void_reason)
       VALUES (gen_random_uuid(), $1, $2, '2026-02-10', $3, $4, $5, $6, $7, $8, 1, 1000, 50, 1050, now(), CASE WHEN $6 = 'void' THEN 'x' END) RETURNING id`,
      [tenant, outletId, shiftId, deviceId, userId, status, paid ? `C1-20260210-${n}` : null, paid ? n : null]);
    if (paid) for (const [method, amount] of pays) await c.query('INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1,$2,$3,$4)', [tenant, s.rows[0].id, method, amount]);
    return s.rows[0].id as string;
  });
}
const refund = (app: App, token: string, id: string, payload: Record<string, unknown> = { reason: 'wrong item', pin: PIN }) =>
  app.inject({ method: 'POST', url: `/sales/${id}/refund`, headers: bearer(token), payload });
const statusOf = (tenant: string, id: string) => withTenant(tenant, async (c) => (await c.query('SELECT status FROM sale WHERE id = $1', [id])).rows[0].status as string);
const clearPinLock = (tenant: string, userId: string) => withTenant(tenant, (c) => c.query("UPDATE login_lockout SET failed = 0, locked_until = NULL WHERE user_id = $1 AND kind = 'pin'", [userId]));

test('the cashier refunds a sale of their own open shift: each method paid back, status refunded, audited once', async () => {
  const app = buildApp();
  const w = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.signIn('School 1 Canteen cashier');
  const shift = await openShift(A, w.outletId, w.deviceId, cashier.userId);
  const sale = await paidSale(A, w.outletId, w.deviceId, cashier.userId, shift);

  const r = await refund(app, cashier.token, sale);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().refunds.sort((a: { method: string }, b: { method: string }) => a.method.localeCompare(b.method)),
    [{ method: 'cash', amountPaise: 600 }, { method: 'upi', amountPaise: 450 }]);
  assert.equal(await statusOf(A, sale), 'refunded');
  const rows = await withTenant(A, async (c) => (await c.query(
    'SELECT method, amount_paise::int AS amount, reason, shift_id, device_id, refunded_by FROM refund WHERE sale_id = $1 ORDER BY method', [sale])).rows);
  assert.deepEqual(rows, [
    { method: 'cash', amount: 600, reason: 'wrong item', shift_id: shift, device_id: w.deviceId, refunded_by: cashier.userId },
    { method: 'upi', amount: 450, reason: 'wrong item', shift_id: shift, device_id: w.deviceId, refunded_by: cashier.userId },
  ]);
  const audits = await withTenant(A, async (c) => (await c.query(
    "SELECT actor_id, detail FROM audit WHERE action = 'sale.refund' AND entity_id = $1", [sale])).rows);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, cashier.userId);
  assert.equal(audits[0].detail.reason, 'wrong item');
  assert.equal(audits[0].detail.shiftId, shift);

  // Twice: refused, nothing more written.
  const again = await refund(app, cashier.token, sale);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already refunded');
  assert.equal((await withTenant(A, (c) => c.query('SELECT 1 FROM refund WHERE sale_id = $1', [sale]))).rowCount, 2);

  // Only a paid sale: open and void sales of the same shift are refused.
  for (const status of ['open', 'void']) {
    const s = await paidSale(A, w.outletId, w.deviceId, cashier.userId, shift, { status });
    const x = await refund(app, cashier.token, s);
    assert.equal(x.statusCode, 409, status);
    assert.equal(await statusOf(A, s), status);
  }
  // A reason and a PIN are both required.
  const s = await paidSale(A, w.outletId, w.deviceId, cashier.userId, shift);
  assert.equal((await refund(app, cashier.token, s, { pin: PIN })).statusCode, 400, 'no reason');
  assert.equal((await refund(app, cashier.token, s, { reason: '  ', pin: PIN })).statusCode, 400, 'blank reason');
  assert.equal((await refund(app, cashier.token, s, { reason: 'x' })).statusCode, 400, 'no pin');
  assert.equal(await statusOf(A, s), 'paid');
});

test('the PIN must be typed again: a wrong one refunds nothing, counts towards the sign-in lockout, and locks', async () => {
  const app = buildApp();
  const w = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.signIn('School 1 Canteen cashier');
  const shift = await openShift(A, w.outletId, w.deviceId, cashier.userId);
  const sale = await paidSale(A, w.outletId, w.deviceId, cashier.userId, shift);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await refund(app, cashier.token, sale, { reason: 'x', pin: '000000' });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().error, 'wrong pin');
    }
    assert.equal(await statusOf(A, sale), 'paid');
    assert.equal((await withTenant(A, (c) => c.query("SELECT 1 FROM audit WHERE action = 'refund.pin_failed' AND entity_id = $1", [sale]))).rowCount, 4);
    // The fifth wrong PIN locks the account: the right PIN is then refused, here and at sign-in.
    assert.equal((await refund(app, cashier.token, sale, { reason: 'x', pin: '000000' })).statusCode, 403);
    assert.equal((await refund(app, cashier.token, sale)).statusCode, 423);
    assert.equal(await statusOf(A, sale), 'paid');
    await clearPinLock(A, cashier.userId);
    assert.equal((await refund(app, cashier.token, sale)).statusCode, 200);
  } finally {
    await clearPinLock(A, cashier.userId);
  }
});

test('whose: another cashier’s shift, a closed shift, another tablet, an online order, another tenant all look nonexistent', async () => {
  const app = buildApp();
  const w = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.signIn('School 1 Canteen cashier');
  // The caller HAS an open shift here, so every refusal below is about the sale, not a missing drawer.
  await openShift(A, w.outletId, w.deviceId, cashier.userId);
  const missing = '22222222-2222-4222-8222-222222222222';
  const nothing = await refund(app, cashier.token, missing);
  assert.equal(nothing.statusCode, 404);

  // Another cashier's open shift on another tablet of the same outlet.
  const w2 = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier2 = await w2.signIn('School 1 Canteen cashier 2');
  const shift2 = await openShift(A, w2.outletId, w2.deviceId, cashier2.userId);
  const theirs = await paidSale(A, w2.outletId, w2.deviceId, cashier2.userId, shift2);
  // This cashier's own sale, on this very tablet, from a shift they already closed: only "closed" refuses it.
  const closed = await withTenant(A, async (c) => (await c.query(
    `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, closed_at, opening_cash_paise, counted_cash_paise, expected_cash_paise, variance_paise, refused_cash_paise)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now() - interval '1 day', now() - interval '20 hours', 0, 0, 0, 0, 0) RETURNING id`,
    [A, w.outletId, w.deviceId, cashier.userId])).rows[0].id as string);
  const fromClosed = await paidSale(A, w.outletId, w.deviceId, cashier.userId, closed);
  // This cashier's own open shift on ANOTHER tablet: its drawer is not the one in front of them.
  const elsewhere = await withTenant(A, async (c) => (await c.query(
    "SELECT id FROM sale WHERE receipt_no = 'C1-20260101-0001' AND outlet_id = $1", [w.outletId])).rows[0].id as string); // seeded: cashier's shift on the seeded tablet
  const online = await withTenant(A, async (c) => (await c.query(
    "SELECT id FROM sale WHERE channel <> 'counter' AND status = 'paid' AND outlet_id = $1 LIMIT 1", [w.outletId])).rows[0].id as string);
  const b = await enrol(app, B, 'b1@example.test', 'Main Canteen');
  const bCashier = await b.signIn('Main Canteen cashier');
  const bShift = await openShift(B, b.outletId, b.deviceId, bCashier.userId);
  const otherTenant = await paidSale(B, b.outletId, b.deviceId, bCashier.userId, bShift);

  // This tablet's drawer, but another cashier's shift: signing in on their tablet does not make it yours.
  const w3 = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const onW3 = await w3.signIn('School 1 Canteen cashier');
  const w3Shift = await openShift(A, w3.outletId, w3.deviceId, cashier2.userId);
  const theirsHere = await paidSale(A, w3.outletId, w3.deviceId, cashier2.userId, w3Shift);
  const r3 = await refund(app, onW3.token, theirsHere);
  assert.equal(r3.statusCode, 404, 'another cashier’s shift on this tablet');
  assert.equal(await statusOf(A, theirsHere), 'paid');

  for (const [name, id, tenant] of [['another cashier', theirs, A], ['closed shift', fromClosed, A], ['another tablet', elsewhere, A],
    ['online order', online, A], ['another tenant', otherTenant, B]] as const) {
    const r = await refund(app, cashier.token, id);
    assert.equal(r.statusCode, 404, name);
    assert.equal(r.body, nothing.body, `${name}: response distinguishes "not yours" from "does not exist"`);
    assert.equal(await statusOf(tenant, id), 'paid', `${name}: refunded anyway`);
  }
});

test('who: a waiter and a manager’s web session cannot refund', async () => {
  const app = buildApp();
  const w = await enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.signIn('School 1 Canteen cashier');
  const waiter = await w.signIn('School 1 Canteen waiter');
  const shift = await openShift(A, w.outletId, w.deviceId, cashier.userId);
  const sale = await paidSale(A, w.outletId, w.deviceId, cashier.userId, shift);
  assert.equal((await refund(app, waiter.token, sale)).statusCode, 403, 'waiter');
  // A web session has no drawer: told so plainly, before any PIN is checked or counted against the manager.
  const mgrId = await withTenant(A, async (c) => (await c.query("SELECT id FROM app_user WHERE lower(email) = 'a1@example.test'")).rows[0].id as string);
  const failsBefore = await withTenant(A, async (c) => (await c.query("SELECT count(*)::int AS n FROM audit WHERE actor_id = $1 AND action IN ('refund.pin_failed', 'pin.locked')", [mgrId])).rows[0].n as number);
  const mgr = await refund(app, w.mgr, sale);
  assert.equal(mgr.statusCode, 403, 'manager on the web: no drawer');
  assert.equal(mgr.json().error, 'refund on the tablet whose drawer pays it out');
  const failsAfter = await withTenant(A, async (c) => (await c.query("SELECT count(*)::int AS n FROM audit WHERE actor_id = $1 AND action IN ('refund.pin_failed', 'pin.locked')", [mgrId])).rows[0].n as number);
  assert.equal(failsAfter, failsBefore, 'a web session was counted as a PIN failure');
  assert.equal(await statusOf(A, sale), 'paid');
});
