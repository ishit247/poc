import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { sign } from '../src/providers/index.js';
import { senders } from '../src/jobs/outbox.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SECRET_A = 'dev-webhook-secret-a1';
const SECRET_B = 'dev-webhook-secret-b1';
test.after(() => pool.end());

const app = buildApp();
const oid = () => `W-${randomUUID().slice(0, 8)}`;
const ts = () => String(Math.floor(Date.now() / 1000));

function post(body: unknown, opt: { secret?: string; timestamp?: string; signature?: string; raw?: string } = {}) {
  const raw = opt.raw ?? JSON.stringify(body);
  const t = opt.timestamp ?? ts();
  return app.inject({
    method: 'POST', url: '/webhooks/zomato', payload: raw,
    headers: { 'content-type': 'application/json', 'x-timestamp': t, 'x-signature': opt.signature ?? sign(opt.secret ?? SECRET_A, t, raw) },
  });
}
const payload = (orderId: string, lines = [{ item_id: 'ZS-a-samosa', name: 'Samosa', qty: 2, unit_price_paise: 2500 }]) =>
  ({ store_id: 'dev-store-a1', order_id: orderId, customer_label: 'Block B, Room 214', lines });
const orderRow = (tenant: string, ext: string) =>
  withTenant(tenant, async (c) => (await c.query(
    `SELECT provider, channel, status, price_overridden AS "po", unmapped_lines AS "un", raw_payload IS NOT NULL AS "hasRaw" FROM online_order WHERE external_order_id = $1`, [ext])).rows);
const events = (tenant: string) => withTenant(tenant, async (c) => Number((await c.query('SELECT count(*) FROM inbound_event')).rows[0].count));

test('a signed order creates a zomato online order with its raw payload, in the right tenant only', async () => {
  const id = oid();
  const r = await post(payload(id));
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().result, 'created');
  const rows = await orderRow(A, id);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { provider: 'zomato', channel: 'zomato', status: 'received', po: false, un: [], hasRaw: true });
  assert.equal((await orderRow(B, id)).length, 0, 'tenant B must not see tenant A\'s order');
});

test('the platform price is kept and flagged when it differs from the menu', async () => {
  const id = oid();
  assert.equal((await post(payload(id, [{ item_id: 'ZS-a-samosa', name: 'Samosa', qty: 1, unit_price_paise: 2600 }]))).statusCode, 201);
  assert.equal((await orderRow(A, id))[0].po, true);
});

test('a repeated delivery is a duplicate, not a second order', async () => {
  const id = oid();
  assert.equal((await post(payload(id))).statusCode, 201);
  const again = await post(payload(id));
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().result, 'duplicate');
  assert.equal((await orderRow(A, id)).length, 1);
});

test('unauthenticated calls are refused and leave no trace', async () => {
  const before = await events(A);
  const id = oid();
  assert.equal((await post(payload(id), { signature: 'ab'.repeat(32) })).statusCode, 401, 'bad signature');
  assert.equal((await post(payload(id), { signature: '' })).statusCode, 401, 'missing signature');
  assert.equal((await post(payload(id), { secret: SECRET_B })).statusCode, 401, 'another tenant\'s secret');
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await post(payload(id), { timestamp: stale })).statusCode, 401, 'stale timestamp');
  assert.equal((await post({ ...payload(id), store_id: 'nope' })).statusCode, 401, 'unknown store');
  assert.equal((await orderRow(A, id)).length, 0);
  assert.equal(await events(A), before, 'no inbound_event for unauthenticated calls');
});

test('a tampered body fails the signature', async () => {
  const id = oid();
  const t = ts();
  const signed = JSON.stringify(payload(id));
  const tampered = signed.replace('"qty":2', '"qty":9');
  assert.notEqual(signed, tampered);
  assert.equal((await post(null, { raw: tampered, timestamp: t, signature: sign(SECRET_A, t, signed) })).statusCode, 401);
});

test('an unmapped line is flagged but does not drop the order; all-unmapped is rejected and recorded', async () => {
  const id = oid();
  const r = await post(payload(id, [
    { item_id: 'ZS-a-samosa', name: 'Samosa', qty: 1, unit_price_paise: 2500 },
    { item_id: 'ZS-unknown', name: 'Mystery', qty: 3, unit_price_paise: 900 },
  ]));
  assert.equal(r.statusCode, 201);
  const un = (await orderRow(A, id))[0].un as { externalItemId: string }[];
  assert.equal(un.length, 1);
  assert.equal(un[0]?.externalItemId, 'ZS-unknown');

  const before = await events(A);
  const id2 = oid();
  const r2 = await post(payload(id2, [{ item_id: 'ZS-unknown', name: 'Mystery', qty: 1, unit_price_paise: 900 }]));
  assert.equal(r2.statusCode, 422);
  assert.equal((await orderRow(A, id2)).length, 0);
  assert.equal(await events(A), before + 1, 'the rejection is recorded with its payload');
});

test('a payload of the wrong shape is rejected and recorded', async () => {
  const before = await events(A);
  const r = await post({ store_id: 'dev-store-a1', order_id: oid(), lines: [] });
  assert.equal(r.statusCode, 422);
  assert.equal(await events(A), before + 1);
});

test('not JSON is a 400', async () => {
  assert.equal((await post(null, { raw: 'not json' })).statusCode, 400);
});

test('inbound_event is append-only for the application role', async () => {
  await post(payload(oid())); // make sure a row exists
  for (const sql of ['UPDATE inbound_event SET result = result', 'DELETE FROM inbound_event']) {
    await withTenant(A, async (c) => {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(sql), /permission denied/, sql);
      await c.query('ROLLBACK TO s');
    });
  }
});

test('outbound messages for a platform with no partner API fail visibly, never silently succeed', async () => {
  await assert.rejects(senders.zomato!({ id: 'x', tenantId: A, outletId: 'x', onlineOrderId: 'x', provider: 'zomato', action: 'accept', payload: {} }), /partner API not configured/);
});
