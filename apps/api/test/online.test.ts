import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';
import { expireDueOrders, scanDue } from '../src/jobs/expireOnline.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function world(app: App, tenant: string, email: string, outletName: string) {
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(tenant, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const staffToken = async (role: 'waiter' | 'cashier') => {
    const userId = (await withTenant(tenant, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [`${outletName} ${role}`])).rows[0].id)) as string;
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } });
    assert.equal(r.statusCode, 200);
    return r.json().token as string;
  };
  const items = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT i.id, i.name FROM item i JOIN item_price ip ON ip.item_id = i.id AND ip.channel = 'zomato' AND ip.deleted_at IS NULL
                     WHERE i.deleted_at IS NULL ORDER BY i.name LIMIT 2`)).rows as { id: string; name: string }[]);
  return { mgr, outletId: o.id as string, staffToken, items };
}

const create = (app: App, token: string, body: object) => app.inject({ method: 'POST', url: '/online-orders', headers: bearer(token), payload: body });
const move = (app: App, token: string, id: string, body: object) => app.inject({ method: 'POST', url: `/online-orders/${id}/transition`, headers: bearer(token), payload: body });
const newId = () => `T-${randomUUID().slice(0, 8)}`;

test('an order is priced from the platform channel, and the same platform id returns the same order', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const cashier = await w.staffToken('cashier');
  const ext = newId();
  const body = { channel: 'zomato', externalOrderId: ext, customerLabel: 'Block B', lines: [{ itemId: w.items[0]!.id, qty: 2 }, { itemId: w.items[0]!.id, qty: 1 }] };
  const r1 = await create(app, cashier, body);
  assert.equal(r1.statusCode, 201);
  const o = r1.json();
  assert.equal(o.status, 'received');
  assert.equal(o.priceOverridden, false);
  const lineSum = o.lines.reduce((a: number, l: { lineTotalPaise: number; taxPaise: number }) => a + Number(l.lineTotalPaise) + Number(l.taxPaise), 0);
  assert.equal(Number(o.totalPaise), lineSum);

  const r2 = await create(app, cashier, body);
  assert.equal(r2.json().id, o.id);
  const n = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n FROM online_order WHERE external_order_id = $1', [ext])).rows[0].n);
  assert.equal(n, 1);
});

test('a keyed price that differs from the menu is accepted and flagged', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const r = await create(app, await w.staffToken('cashier'), { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w.items[0]!.id, qty: 1, unitPaise: 12345 }] });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().priceOverridden, true);
  assert.equal(Number(r.json().lines[0].unitPricePaise), 12345);
});

test('handover makes the sale paid with one aggregator payment, no receipt number and no shift', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const t = await w.staffToken('cashier');
  const o = (await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w.items[0]!.id, qty: 1 }] })).json();
  for (const to of ['accepted', 'preparing', 'ready']) assert.equal((await move(app, t, o.id, { to, prepMinutes: 10 })).statusCode, 200);
  const done = await move(app, t, o.id, { to: 'handed_over' });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().status, 'handed_over');
  const s = await withTenant(A, async (c) => ({
    sale: (await c.query('SELECT status, receipt_no, receipt_seq, shift_id, business_day_id FROM sale WHERE id = $1', [o.saleId])).rows[0],
    pay: (await c.query('SELECT method, amount_paise FROM payment WHERE sale_id = $1', [o.saleId])).rows,
    events: (await c.query('SELECT to_status FROM online_order_event WHERE online_order_id = $1 ORDER BY at, id', [o.id])).rows.map((r) => r.to_status),
  }));
  assert.equal(s.sale.status, 'paid');
  assert.equal(s.sale.receipt_no, null);
  assert.equal(s.sale.shift_id, null);
  assert.ok(s.sale.business_day_id);
  assert.equal(s.pay.length, 1);
  assert.equal(s.pay[0].method, 'aggregator');
  assert.equal(Number(s.pay[0].amount_paise), Number(o.totalPaise));
  assert.deepEqual(s.events, ['received', 'accepted', 'preparing', 'ready', 'handed_over']);
});

test('the lifecycle only moves forward; a rejection needs a reason and voids the sale', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const t = await w.staffToken('cashier');
  const mk = async () => (await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w.items[0]!.id, qty: 1 }] })).json();

  const o = await mk();
  assert.equal((await move(app, t, o.id, { to: 'ready' })).statusCode, 409, 'received cannot jump to ready');
  assert.equal((await move(app, t, o.id, { to: 'handed_over' })).statusCode, 409);
  assert.equal((await move(app, t, o.id, { to: 'rejected' })).statusCode, 422, 'a rejection needs a reason');
  assert.equal((await move(app, t, o.id, { to: 'rejected', reason: 'out of stock' })).statusCode, 200);
  assert.equal((await move(app, t, o.id, { to: 'accepted' })).statusCode, 409, 'a rejected order is final');
  const sale = await withTenant(A, async (c) => (await c.query('SELECT status, void_reason FROM sale WHERE id = $1', [o.saleId])).rows[0]);
  assert.equal(sale.status, 'void');
  assert.match(sale.void_reason, /out of stock/);
  assert.equal((await move(app, t, (await mk()).id, { to: 'expired', reason: 'x' })).statusCode, 400, 'expiry is the job\'s, not a caller\'s');
});

test('whose: another outlet or tenant cannot see or move an order; a waiter cannot use the queue', async () => {
  const app = buildApp();
  const w1 = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const w2 = await world(app, A, 'a2@example.test', 'School 2 Canteen');
  const wb = await world(app, B, 'b1@example.test', 'Main Canteen');
  const t1 = await w1.staffToken('cashier');
  const o = (await create(app, t1, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w1.items[0]!.id, qty: 1 }] })).json();

  for (const other of [await w2.staffToken('cashier'), await wb.staffToken('cashier')]) {
    assert.equal((await app.inject({ method: 'GET', url: `/online-orders/${o.id}`, headers: bearer(other) })).statusCode, 404);
    assert.equal((await move(app, other, o.id, { to: 'accepted' })).statusCode, 404);
    const list = (await app.inject({ method: 'GET', url: '/online-orders', headers: bearer(other) })).json() as { id: string }[];
    assert.ok(!list.some((x) => x.id === o.id));
  }
  assert.equal((await app.inject({ method: 'GET', url: '/online-orders', headers: bearer(await w1.staffToken('waiter')) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/online-orders' })).statusCode, 401);
  const own = (await app.inject({ method: 'GET', url: '/online-orders', headers: bearer(t1) })).json() as { id: string }[];
  assert.ok(own.some((x) => x.id === o.id));
});

const late = (tenant: string, id: string) =>
  withTenant(tenant, (c) => c.query("UPDATE online_order SET accept_by = now() - interval '1 minute' WHERE id = $1", [id]));

test('the expiry job voids unaccepted orders past their deadline, in every tenant, and leaves the rest alone', async () => {
  const app = buildApp();
  const wa = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const wb = await world(app, B, 'b1@example.test', 'Main Canteen');
  const ta = await wa.staffToken('cashier');
  const tb = await wb.staffToken('cashier');
  const mk = async (w: typeof wa, t: string) => (await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w.items[0]!.id, qty: 1 }] })).json();

  const lateA = await mk(wa, ta);
  const lateB = await mk(wb, tb);
  const accepted = await mk(wa, ta);
  const fresh = await mk(wa, ta);
  assert.equal((await move(app, ta, accepted.id, { to: 'accepted' })).statusCode, 200);
  await late(A, lateA.id); await late(B, lateB.id); await late(A, accepted.id);

  assert.ok((await expireDueOrders()) >= 2);

  const state = (tenant: string, o: { id: string; saleId: string }) => withTenant(tenant, async (c) => ({
    o: (await c.query('SELECT status, reason FROM online_order WHERE id = $1', [o.id])).rows[0],
    sale: (await c.query('SELECT status FROM sale WHERE id = $1', [o.saleId])).rows[0].status,
    audit: (await c.query("SELECT actor_kind FROM audit WHERE entity_id = $1 AND action = 'online_order.expired'", [o.id])).rows.map((r) => r.actor_kind),
  }));
  for (const [tenant, o] of [[A, lateA], [B, lateB]] as const) {
    const s = await state(tenant, o);
    assert.equal(s.o.status, 'expired');
    assert.equal(s.sale, 'void');
    assert.deepEqual(s.audit, ['system']);
  }
  assert.equal((await state(A, accepted)).o.status, 'accepted', 'an accepted order is never expired');
  assert.equal((await state(A, fresh)).o.status, 'received', 'an order inside its deadline is untouched');
  assert.equal((await move(app, ta, lateA.id, { to: 'accepted' })).statusCode, 409, 'expired is final');
});

test('the expiry scan window shows only overdue received orders, only under the job stamp, and never allows a write', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const t = await w.staffToken('cashier');
  const mk = async () => (await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w.items[0]!.id, qty: 1 }] })).json();
  const overdue = await mk(); const accepted = await mk(); const fresh = await mk();
  assert.equal((await move(app, t, accepted.id, { to: 'accepted' })).statusCode, 200);
  await late(A, overdue.id); await late(A, accepted.id);

  const ids = [overdue.id, accepted.id, fresh.id];
  assert.equal((await pool.query('SELECT id FROM online_order WHERE id = ANY($1::uuid[])', [ids])).rowCount, 0, 'no stamp, no rows');
  const seen = (await scanDue()).map((r) => r.id);
  assert.ok(seen.includes(overdue.id));
  assert.ok(!seen.includes(accepted.id) && !seen.includes(fresh.id));

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.job', 'expire_online', true)");
    assert.equal((await c.query("UPDATE online_order SET reason = 'tampered' WHERE id = $1", [overdue.id])).rowCount, 0, 'the job stamp reads, it cannot write');
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

async function openStream(base: string, token?: string) {
  const ac = new AbortController();
  const r = await fetch(`${base}/online-orders/stream`, { headers: token ? bearer(token) : {}, signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  /** Reads until `needle` shows up in the stream, or `ms` pass. Returns whether it did. */
  const sees = async (needle: string, ms: number) => {
    const until = Date.now() + ms;
    while (!buf.includes(needle) && Date.now() < until) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), Math.max(1, until - Date.now())))]);
      if (chunk && !chunk.done) buf += dec.decode(chunk.value);
      else if (chunk?.done) break;
    }
    return buf.includes(needle);
  };
  return { status: r.status, sees, close: () => ac.abort() };
}

test('the stream wakes a signed-in cashier for changes at their own outlet only', async () => {
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const w1 = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const w2 = await world(app, A, 'a2@example.test', 'School 2 Canteen');
  const t1 = await w1.staffToken('cashier');
  const s1 = await openStream(base, await w1.staffToken('cashier'));
  const s2 = await openStream(base, await w2.staffToken('cashier'));
  try {
    assert.equal((await openStream(base)).status, 401, 'no session, no stream');
    assert.ok(await s1.sees('event: ready', 2000));
    assert.ok(await s2.sees('event: ready', 2000));

    const o = (await create(app, t1, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: w1.items[0]!.id, qty: 1 }] })).json();
    assert.ok(await s1.sees('event: changed', 2000), 'the outlet that got the order is told');
    assert.ok(!(await s2.sees('event: changed', 700)), 'another outlet is not');
    assert.equal(o.status, 'received');
  } finally {
    s1.close(); s2.close();
    await app.close();
  }
});

test('bad input is refused: unknown item, unknown field, no lines', async () => {
  const app = buildApp();
  const w = await world(app, A, 'a1@example.test', 'School 1 Canteen');
  const t = await w.staffToken('cashier');
  assert.equal((await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [{ itemId: randomUUID(), qty: 1 }] })).statusCode, 422);
  assert.equal((await create(app, t, { channel: 'zomato', externalOrderId: newId(), lines: [] })).statusCode, 400);
  assert.equal((await create(app, t, { channel: 'zomato', externalOrderId: newId(), outletId: w.outletId, lines: [{ itemId: w.items[0]!.id, qty: 1 }] })).statusCode, 400);
});
