import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { sign } from '../src/providers/index.js';
import { openSecret, webhookSecretContext } from '../src/security/crypto.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

const app = buildApp();
type Method = 'GET' | 'PUT' | 'DELETE';
const login = async (tenant: string, email: string) =>
  (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
const call = (t: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
const outletOf = async (tenant: string, email: string) => (await withTenant(tenant, (c) => c.query(
  'SELECT uo.outlet_id AS id FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id WHERE lower(u.email) = $1', [email]))).rows[0].id as string;
const itemId = async (tenant: string, name: string) =>
  (await withTenant(tenant, (c) => c.query('SELECT id FROM item WHERE name = $1 AND deleted_at IS NULL', [name]))).rows[0].id as string;
const rand = () => randomUUID().slice(0, 8);

test('a manager sees their outlet\'s integration, never its secret, and nobody else\'s', async () => {
  const a1 = await login(A, 'a1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const r = await call(a1, 'GET', `/outlets/${o1}/integrations`);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  const zomato = j.integrations.find((i: { channel: string }) => i.channel === 'zomato');
  assert.equal(zomato.externalStoreId, 'dev-store-a1');
  assert.ok(!/secret|v1:/.test(r.body), 'no secret, sealed or plain, in the response');
  assert.ok(j.devices.length > 0 && j.users.length > 0, 'pickers are filled');
  assert.ok(j.events.some((e: { detail: string }) => e.detail === 'seed sample'));

  assert.equal((await call(a1, 'GET', `/outlets/${o2}/integrations`)).statusCode, 404, 'another outlet of the same tenant');
  const b1 = await login(B, 'b1@example.test');
  assert.equal((await call(b1, 'GET', `/outlets/${o1}/integrations`)).statusCode, 404, 'another tenant');
  assert.equal((await call(b1, 'GET', `/outlets/${o1}/item-maps?channel=zomato`)).statusCode, 404, 'another tenant, maps');
});

test('saving an integration seals the secret, checks the tablet and person, and keeps the secret when left out', async () => {
  const a1 = await login(A, 'a1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const { devices, users } = (await call(a1, 'GET', `/outlets/${o1}/integrations`)).json();
  const otherDevice = (await withTenant(A, (c) => c.query('SELECT id FROM device WHERE outlet_id = $1 LIMIT 1', [o2]))).rows[0].id;
  const otherUser = (await withTenant(A, (c) => c.query(
    `SELECT u.id FROM app_user u WHERE NOT EXISTS (SELECT 1 FROM user_outlet uo WHERE uo.user_id = u.id AND uo.outlet_id = $1 AND uo.deleted_at IS NULL) LIMIT 1`, [o1]))).rows[0].id;
  const store = `sw-a-${rand()}`;
  const body = { externalStoreId: store, serviceUserId: users[0].id, deviceId: devices[0].id, enabled: true };
  const url = `/outlets/${o1}/integrations/swiggy`;
  const sealed = () => withTenant(A, async (c) => (await c.query(
    "SELECT id, webhook_secret_sealed AS s FROM outlet_integration WHERE outlet_id = $1 AND channel = 'swiggy'", [o1])).rows[0]);

  if (!(await sealed())) assert.equal((await call(a1, 'PUT', url, body)).statusCode, 400, 'first save needs a secret');
  assert.equal((await call(a1, 'PUT', url, { ...body, webhookSecret: 'too-short' })).statusCode, 400);
  assert.equal((await call(a1, 'PUT', url, { ...body, deviceId: otherDevice, webhookSecret: 'x'.repeat(20) })).json().error, 'tablet not at this outlet');
  assert.equal((await call(a1, 'PUT', url, { ...body, serviceUserId: otherUser, webhookSecret: 'x'.repeat(20) })).json().error, 'person not at this outlet');

  const secret = `sw-secret-${rand()}-0123456789`;
  assert.equal((await call(a1, 'PUT', url, { ...body, webhookSecret: secret })).statusCode, 200);
  const row = await sealed();
  assert.equal(openSecret(row.s, webhookSecretContext(row.id)), secret);
  assert.equal((await call(a1, 'PUT', url, { ...body, enabled: false })).statusCode, 200);
  assert.equal((await sealed()).s, row.s, 'secret kept when left out');

  // The store id is how a webhook finds its tenant, so another tenant cannot claim it.
  const b1 = await login(B, 'b1@example.test');
  const ob = await outletOf(B, 'b1@example.test');
  const bOpts = (await call(b1, 'GET', `/outlets/${ob}/integrations`)).json();
  const taken = await call(b1, 'PUT', `/outlets/${ob}/integrations/swiggy`,
    { externalStoreId: store, serviceUserId: bOpts.users[0].id, deviceId: bOpts.devices[0].id, enabled: true, webhookSecret: 'y'.repeat(20) });
  assert.equal(taken.statusCode, 409);
  assert.equal((await call(b1, 'PUT', `/outlets/${o1}/integrations/swiggy`, { ...body, webhookSecret: secret })).statusCode, 404, 'another tenant\'s outlet');
});

test('an unmapped platform item is listed until it is mapped; maps are per outlet and tenant', async () => {
  const a1 = await login(A, 'a1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const ext = `ZX-${rand()}`;
  const raw = JSON.stringify({ store_id: 'dev-store-a1', order_id: `M-${rand()}`, lines: [
    { item_id: 'ZS-a-samosa', name: 'Samosa', qty: 1, unit_price_paise: 2500 },
    { item_id: ext, name: 'Masala Tea', qty: 2, unit_price_paise: 1500 },
  ] });
  const t = String(Math.floor(Date.now() / 1000));
  const hook = await app.inject({ method: 'POST', url: '/webhooks/zomato', payload: raw,
    headers: { 'content-type': 'application/json', 'x-timestamp': t, 'x-signature': sign('dev-webhook-secret-a1', t, raw) } });
  assert.equal(hook.statusCode, 201);

  const list = async () => (await call(a1, 'GET', `/outlets/${o1}/item-maps?channel=zomato`)).json();
  let j = await list();
  assert.ok(j.maps.some((m: { externalItemId: string; priced: boolean }) => m.externalItemId === 'ZS-a-samosa' && m.priced));
  assert.deepEqual(j.unmapped.filter((u: { externalItemId: string }) => u.externalItemId === ext).map((u: { name: string; orders: number }) => [u.name, u.orders]), [['Masala Tea', 1]]);

  const tea = await itemId(A, 'Tea');
  assert.equal((await call(a1, 'PUT', `/outlets/${o1}/item-maps`, { channel: 'zomato', externalItemId: ext, itemId: await itemId(B, 'Tea') })).statusCode, 404, 'another tenant\'s item');
  const put = await call(a1, 'PUT', `/outlets/${o1}/item-maps`, { channel: 'zomato', externalItemId: ext, itemId: tea });
  assert.equal(put.statusCode, 200);
  j = await list();
  assert.ok(!j.unmapped.some((u: { externalItemId: string }) => u.externalItemId === ext), 'no longer unmapped');
  const m = j.maps.find((x: { externalItemId: string }) => x.externalItemId === ext);
  assert.equal(m.itemName, 'Tea');
  assert.equal(m.priced, false, 'Tea has no zomato price, so orders naming it would be rejected');

  assert.equal((await call(a1, 'DELETE', `/outlets/${o2}/item-maps/${m.id}`)).statusCode, 404, 'outlet in the path is not mine');
  const a2 = await login(A, 'a2@example.test');
  assert.equal((await call(a2, 'DELETE', `/outlets/${o2}/item-maps/${m.id}`)).statusCode, 404, 'my outlet in the path, another outlet\'s map id');
  const b1 = await login(B, 'b1@example.test');
  const ob = await outletOf(B, 'b1@example.test');
  assert.equal((await call(b1, 'DELETE', `/outlets/${ob}/item-maps/${m.id}`)).statusCode, 404, 'another tenant\'s map id');
  assert.equal((await call(a1, 'DELETE', `/outlets/${o1}/item-maps/${m.id}`)).statusCode, 200);
  assert.equal((await call(a1, 'DELETE', `/outlets/${o1}/item-maps/${m.id}`)).statusCode, 404);
  assert.ok((await list()).unmapped.some((u: { externalItemId: string }) => u.externalItemId === ext), 'unmapped again');
});
