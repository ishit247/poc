import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';
import { runOutbox, scanDue, senders, backoffSeconds, MAX_ATTEMPTS } from '../src/jobs/outbox.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function cashier(app: App, tenant: string, email: string, outletName: string) {
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(tenant, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const userId = (await withTenant(tenant, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [`${outletName} cashier`])).rows[0].id)) as string;
  const token = (await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } })).json().token as string;
  const item = await withTenant(tenant, async (c) =>
    (await c.query(`SELECT i.id FROM item i JOIN item_price ip ON ip.item_id = i.id AND ip.channel = 'zomato' AND ip.deleted_at IS NULL WHERE i.deleted_at IS NULL LIMIT 1`)).rows[0].id as string);
  return { token, item };
}

const order = async (app: App, w: { token: string; item: string }) =>
  (await app.inject({ method: 'POST', url: '/online-orders', headers: bearer(w.token),
    payload: { channel: 'zomato', externalOrderId: `T-${randomUUID().slice(0, 8)}`, lines: [{ itemId: w.item, qty: 1 }] } })).json();
const go = (app: App, t: string, id: string, body: object) => app.inject({ method: 'POST', url: `/online-orders/${id}/transition`, headers: bearer(t), payload: body });
const rows = (tenant: string, orderId: string) =>
  withTenant(tenant, async (c) => (await c.query('SELECT action, status, attempts, dedupe_key, last_error, next_attempt_at FROM integration_outbox WHERE online_order_id = $1 ORDER BY created_at, action', [orderId])).rows);

test('each move queues one message in the same transaction, and a repeated move cannot queue it twice', async () => {
  const app = buildApp();
  const w = await cashier(app, A, 'a1@example.test', 'School 1 Canteen');
  const o = await order(app, w);
  assert.equal((await rows(A, o.id)).length, 0, 'creating an order sends nothing');
  assert.equal((await go(app, w.token, o.id, { to: 'accepted' })).statusCode, 200);
  assert.equal((await go(app, w.token, o.id, { to: 'accepted' })).statusCode, 409);
  assert.deepEqual((await rows(A, o.id)).map((r) => [r.action, r.status]), [['accept', 'pending']]);
  // a refused move queues nothing
  assert.equal((await go(app, w.token, o.id, { to: 'handed_over' })).statusCode, 409);
  assert.equal((await rows(A, o.id)).length, 1);
  // the table's unique key is the guard: the same action cannot be stored twice, even by a buggy caller
  const dup = `INSERT INTO integration_outbox (tenant_id, outlet_id, online_order_id, provider, action, dedupe_key)
               SELECT tenant_id, outlet_id, id, provider, 'accept', id::text || ':accept' FROM online_order WHERE id = $1`;
  await assert.rejects(withTenant(A, (c) => c.query(dup, [o.id])), /duplicate key|unique/);
  await withTenant(A, (c) => c.query(`${dup} ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, [o.id]));
  assert.equal((await rows(A, o.id)).length, 1);
});

test('the worker sends due messages for every tenant with the manual provider and marks them done', async () => {
  const app = buildApp();
  const wa = await cashier(app, A, 'a1@example.test', 'School 1 Canteen');
  const wb = await cashier(app, B, 'b1@example.test', 'Main Canteen');
  const oa = await order(app, wa); const ob = await order(app, wb);
  await go(app, wa.token, oa.id, { to: 'accepted' });
  await go(app, wb.token, ob.id, { to: 'rejected', reason: 'closed' });
  assert.ok((await runOutbox()) >= 2);
  const ra = (await rows(A, oa.id))[0], rb = (await rows(B, ob.id))[0];
  assert.deepEqual([ra.status, ra.attempts], ['done', 1]);
  assert.deepEqual([rb.action, rb.status], ['reject', 'done']);
  assert.equal((await withTenant(A, async (c) => (await c.query('SELECT done_at FROM integration_outbox WHERE online_order_id = $1', [oa.id])).rows[0].done_at)) !== null, true);
});

test('a failing provider is retried with backoff, never blocks another message, and ends as failed', async () => {
  const app = buildApp();
  const w = await cashier(app, A, 'a1@example.test', 'School 1 Canteen');
  const bad = await order(app, w); const good = await order(app, w);
  await go(app, w.token, bad.id, { to: 'accepted' }); await go(app, w.token, good.id, { to: 'accepted' });
  // make only the first order's message fail, by pointing it at a provider with a throwing sender
  await withTenant(A, (c) => c.query(`UPDATE integration_outbox SET provider = 'broken' WHERE online_order_id = $1`, [bad.id]));
  senders.broken = async () => { throw new Error('platform said 503'); };
  try {
    await runOutbox();
    assert.equal((await rows(A, good.id))[0].status, 'done', 'the healthy message went through');
    let r = (await rows(A, bad.id))[0];
    assert.deepEqual([r.status, r.attempts, r.last_error], ['pending', 1, 'platform said 503']);
    assert.ok(new Date(r.next_attempt_at).getTime() > Date.now() + 20_000, 'next attempt is pushed out');

    await runOutbox(); // not due yet: untouched
    assert.equal((await rows(A, bad.id))[0].attempts, 1);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await withTenant(A, (c) => c.query(`UPDATE integration_outbox SET next_attempt_at = now() WHERE online_order_id = $1`, [bad.id]));
      await runOutbox();
    }
    r = (await rows(A, bad.id))[0];
    assert.deepEqual([r.status, r.attempts], ['failed', MAX_ATTEMPTS]);
    await withTenant(A, (c) => c.query(`UPDATE integration_outbox SET next_attempt_at = now() WHERE online_order_id = $1`, [bad.id]));
    await runOutbox();
    assert.equal((await rows(A, bad.id))[0].attempts, MAX_ATTEMPTS, 'a failed message is not retried');
  } finally {
    delete senders.broken;
  }
});

test('backoff doubles from 30 s and is capped at an hour', () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffSeconds), [30, 60, 120, 240]);
  assert.equal(backoffSeconds(20), 3600);
});

test('the scan window shows only due pending messages, only under the job stamp, and allows no write', async () => {
  const app = buildApp();
  const w = await cashier(app, A, 'a1@example.test', 'School 1 Canteen');
  const o = await order(app, w);
  await go(app, w.token, o.id, { to: 'accepted' });
  assert.ok((await scanDue()).length >= 1);
  const stamped = async (job: string | null, sql: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (job) await c.query("SELECT set_config('app.job', $1, true)", [job]);
      const r = await c.query(sql);
      await c.query('ROLLBACK');
      return r.rowCount;
    } finally { c.release(); }
  };
  assert.equal(await stamped(null, 'SELECT 1 FROM integration_outbox'), 0, 'no stamp, no rows');
  assert.equal(await stamped('expire_online', 'SELECT 1 FROM integration_outbox'), 0, 'the expiry stamp does not open the outbox');
  assert.equal(await stamped('outbox', "UPDATE integration_outbox SET status = 'done', done_at = now()"), 0, 'the window is read-only');
  await withTenant(A, (c) => c.query(`UPDATE integration_outbox SET next_attempt_at = now() + interval '1 hour' WHERE online_order_id = $1`, [o.id]));
  const later = await stamped('outbox', `SELECT 1 FROM integration_outbox WHERE online_order_id = '${o.id}'`);
  assert.equal(later, 0, 'a message not yet due is hidden');
});

test('the outbox is tenant-isolated and its rows cannot be deleted by the app role', async () => {
  const app = buildApp();
  const w = await cashier(app, A, 'a1@example.test', 'School 1 Canteen');
  const o = await order(app, w);
  await go(app, w.token, o.id, { to: 'accepted' });
  assert.equal((await rows(B, o.id)).length, 0, 'tenant B sees nothing of tenant A');
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM integration_outbox WHERE online_order_id = $1', [o.id])), /permission denied/);
});
