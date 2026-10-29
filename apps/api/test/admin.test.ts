import test from 'node:test';
import { hostFor } from './hosts.js';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { verifyPassword } from '../src/security/password.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PW = 'dev-password-123';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const send = (app: App, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET', url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(t), ...(payload === undefined ? {} : { payload: payload as object }) });
async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenantId) }, payload: { email, password: PW } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function placeOf(tenantId: string, email: string) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT o.id AS outlet_id, c.id, c.code FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
       JOIN outlet o ON o.id = uo.outlet_id JOIN counter c ON c.outlet_id = o.id WHERE lower(u.email) = $1 ORDER BY c.code`, [email]));
  return { outletId: r.rows[0].outlet_id as string, c1: r.rows[0].id as string };
}
const uniq = () => Math.random().toString(36).slice(2, 8);

// --- counters ---------------------------------------------------------------
test('counters: create, rename, duplicate codes refused, scoped to own outlets', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const o2 = await placeOf(A, 'a2@example.test');
  const ob = await placeOf(B, 'b1@example.test');
  const code = `T${uniq()}`.slice(0, 8);

  const created = await send(app, 'POST', `/outlets/${o1.outletId}/counters`, t1, { code });
  assert.equal(created.statusCode, 201);
  assert.equal((await send(app, 'POST', `/outlets/${o1.outletId}/counters`, t1, { code })).statusCode, 409, 'duplicate in one outlet');
  // The same code may exist in another outlet
  assert.equal((await send(app, 'POST', `/outlets/${o2.outletId}/counters`, await token(app, A, 'a2@example.test'), { code })).statusCode, 201);

  const renamed = `${code}x`;
  assert.equal((await send(app, 'PATCH', `/counters/${created.json().id}`, t1, { code: renamed })).json().code, renamed);
  assert.equal((await send(app, 'PATCH', `/counters/${created.json().id}`, t1, { code: 'C1' })).statusCode, 409);

  for (const bad of ['', 'has space', 'a'.repeat(21), 'x;drop', 'é']) assert.equal((await send(app, 'POST', `/outlets/${o1.outletId}/counters`, t1, { code: bad })).statusCode, 400, bad);
  assert.equal((await send(app, 'POST', `/outlets/${o1.outletId}/counters`, t1, { code: 'ok', extra: 1 })).statusCode, 400);

  // scope
  assert.equal((await send(app, 'POST', `/outlets/${o2.outletId}/counters`, t1, { code: 'Z1' })).statusCode, 404, 'sibling outlet');
  assert.equal((await send(app, 'POST', `/outlets/${ob.outletId}/counters`, t1, { code: 'Z1' })).statusCode, 404, 'other tenant outlet');
  assert.equal((await send(app, 'PATCH', `/counters/${ob.c1}`, t1, { code: 'Z9' })).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/counters/${o2.c1}`, t1, { code: 'Z9' })).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/counters/${o1.c1}`, tb, { code: 'Z9' })).statusCode, 404);
  const unchanged = await withTenant(A, (c) => c.query("SELECT 1 FROM counter WHERE code = 'Z9' OR code = 'Z1'"));
  assert.equal(unchanged.rowCount, 0);
});

// --- users ------------------------------------------------------------------
test('users: create a cashier/waiter with a hashed PIN; PIN is never stored plain or audited', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const name = `Cashier ${uniq()}`;

  const created = await send(app, 'POST', '/users', t1, { name, role: 'cashier', pin: '735196', outletIds: [o1.outletId] });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  assert.ok(!JSON.stringify(created.json()).includes('735196'));
  assert.ok(!JSON.stringify(created.json()).includes('pin_verifier'));

  const row = (await withTenant(A, (c) => c.query('SELECT pin_verifier, email, password_hash FROM app_user WHERE id = $1', [id]))).rows[0];
  assert.ok(!row.pin_verifier.includes('735196'));
  assert.match(row.pin_verifier, /^scrypt\$/);
  assert.equal(await verifyPassword('735196', row.pin_verifier), true);
  assert.equal(await verifyPassword('735197', row.pin_verifier), false);
  assert.equal(row.email, null, 'no web login for cashiers');
  assert.equal(row.password_hash, null);

  assert.equal((await send(app, 'POST', `/users/${id}/pin`, t1, { pin: '208461' })).statusCode, 200);
  const after = (await withTenant(A, (c) => c.query('SELECT pin_verifier FROM app_user WHERE id = $1', [id]))).rows[0].pin_verifier;
  assert.notEqual(after, row.pin_verifier);
  assert.equal(await verifyPassword('208461', after), true);
  assert.equal(await verifyPassword('735196', after), false, 'old PIN stops working');

  const trail = await withTenant(A, (c) => c.query("SELECT detail::text AS d FROM audit WHERE entity_id = $1", [id]));
  assert.ok(trail.rowCount! >= 2);
  assert.ok(trail.rows.every((r) => !r.d.includes('735196') && !r.d.includes('208461')), 'PIN in audit trail');
});

test('users: weak and malformed PINs, bad roles and unknown fields are refused', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const mk = (extra: object) => send(app, 'POST', '/users', t1, { name: 'X', role: 'waiter', pin: '735196', outletIds: [o1.outletId], ...extra });
  for (const pin of ['12345', '123456', '111111', '654321', '121212', '123123', '1234567890', 'abcdef', '735 196', '']) {
    assert.equal((await mk({ pin })).statusCode, 400, `pin ${JSON.stringify(pin)}`);
  }
  assert.equal((await mk({ role: 'manager' })).statusCode, 400, 'managers are not creatable here');
  assert.equal((await mk({ role: 'platform' })).statusCode, 400);
  assert.equal((await mk({ outletIds: [] })).statusCode, 400);
  assert.equal((await mk({ name: '' })).statusCode, 400);
  assert.equal((await mk({ email: 'a@b.c' })).statusCode, 400, 'unknown field');
  assert.equal((await mk({ active: false })).statusCode, 400);
  assert.equal((await mk({})).statusCode, 201);
});

test('users: a manager only assigns and manages within their own outlets', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const o2 = await placeOf(A, 'a2@example.test');
  const ob = await placeOf(B, 'b1@example.test');
  const mk = (outletIds: string[]) => send(app, 'POST', '/users', t1, { name: 'Scoped', role: 'waiter', pin: '735196', outletIds });

  assert.equal((await mk([o2.outletId])).statusCode, 404, 'sibling outlet');
  assert.equal((await mk([ob.outletId])).statusCode, 404, 'other tenant outlet');
  assert.equal((await mk([o1.outletId, o2.outletId])).statusCode, 404, 'one bad outlet poisons the request');

  // someone who works at both A1 and A2 is out of reach for a manager who only runs A1
  const shared = await withTenant(A, async (c) => {
    const u = await c.query("INSERT INTO app_user (tenant_id, name, pin_verifier, role) VALUES ($1, 'Shared', 'x', 'cashier') RETURNING id", [A]);
    for (const o of [o1.outletId, o2.outletId]) await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [A, u.rows[0].id, o]);
    return u.rows[0].id as string;
  });
  assert.equal((await send(app, 'PATCH', `/users/${shared}`, t1, { active: false })).statusCode, 404);
  assert.equal((await send(app, 'POST', `/users/${shared}/pin`, t1, { pin: '735196' })).statusCode, 404);

  // managers cannot be edited through this route, even by a manager of the same outlet
  const mgr = (await withTenant(A, (c) => c.query("SELECT id FROM app_user WHERE lower(email) = 'a1@example.test'"))).rows[0].id as string;
  assert.equal((await send(app, 'PATCH', `/users/${mgr}`, t1, { active: false })).statusCode, 404);
  assert.equal((await send(app, 'POST', `/users/${mgr}/pin`, t1, { pin: '735196' })).statusCode, 404);

  // another tenant's manager cannot touch A's users
  const own = (await send(app, 'POST', '/users', t1, { name: 'Mine', role: 'cashier', pin: '735196', outletIds: [o1.outletId] })).json().id as string;
  assert.equal((await send(app, 'PATCH', `/users/${own}`, tb, { active: false })).statusCode, 404);
  assert.equal((await send(app, 'POST', `/users/${own}/pin`, tb, { pin: '735196' })).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/users/${own}`, t1, { outletIds: [o2.outletId] })).statusCode, 404, 'cannot move a user to an outlet you do not run');
  const state = (await withTenant(A, (c) => c.query('SELECT u.active, array_agg(uo.outlet_id) AS o FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id WHERE u.id = $1 GROUP BY u.active', [own]))).rows[0];
  assert.deepEqual([state.active, state.o], [true, [o1.outletId]]);
  const sharedActive = (await withTenant(A, (c) => c.query('SELECT active FROM app_user WHERE id = $1', [shared]))).rows[0].active;
  assert.equal(sharedActive, true);
});

test('users: list shows only people at my outlets, with no secrets; deactivate and rename work', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const created = (await send(app, 'POST', '/users', t1, { name: `Lister ${uniq()}`, role: 'waiter', pin: '735196', outletIds: [o1.outletId] })).json();

  const list = await send(app, 'GET', '/users', t1);
  const body = list.body;
  assert.ok(!/pin|hash|verifier|password/i.test(body.replace(/"name":"[^"]*"/g, '')), 'secrets in list');
  const users = list.json() as { id: string; role: string; outletIds: string[] }[];
  assert.ok(users.some((u) => u.id === created.id));
  assert.ok(users.every((u) => u.outletIds.every((o) => o === o1.outletId)), 'other outlets leaked into the list');
  const listB = (await send(app, 'GET', '/users', tb)).json() as { id: string }[];
  assert.ok(!listB.some((u) => u.id === created.id), 'other tenant sees my user');

  assert.equal((await send(app, 'PATCH', `/users/${created.id}`, t1, { name: 'Renamed', active: false })).statusCode, 200);
  const r = (await withTenant(A, (c) => c.query('SELECT name, active FROM app_user WHERE id = $1', [created.id]))).rows[0];
  assert.deepEqual([r.name, r.active], ['Renamed', false]);
  assert.equal((await send(app, 'PATCH', `/users/${created.id}`, t1, {})).statusCode, 400);
  assert.equal((await send(app, 'PATCH', `/users/${created.id}`, t1, { role: 'manager' })).statusCode, 400, 'role cannot be changed');
  assert.equal((await send(app, 'PATCH', '/users/nope', t1, { active: true })).statusCode, 400);
});

// --- devices ----------------------------------------------------------------
test('devices: labelled at enrolment, listed per outlet, renamed, revoked, no secrets exposed', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const label = `Till ${uniq()}`;

  const code = (await send(app, 'POST', '/enrolment-codes', t1, { outletId: o1.outletId, counterId: o1.c1, label })).json().code as string;
  const { deviceId, credential } = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json();

  const list = await send(app, 'GET', '/devices', t1);
  assert.ok(!list.body.includes('credential'), 'credential material in the list');
  assert.ok(!list.body.includes(credential));
  const devices = list.json() as { id: string; label: string; outletId: string; counterCode: string; lastSeenAt: string | null }[];
  assert.ok(devices.every((d) => d.outletId === o1.outletId), "another outlet's device listed");
  const mine = devices.find((d) => d.id === deviceId)!;
  assert.equal(mine.label, label);
  assert.equal(mine.counterCode, 'C1');

  // using the device updates last seen
  await app.inject({ method: 'GET', url: '/device/whoami', headers: { authorization: `Device ${credential}` } });
  const seen = ((await send(app, 'GET', '/devices', t1)).json() as typeof devices).find((d) => d.id === deviceId)!;
  assert.ok(seen.lastSeenAt);

  assert.ok(!((await send(app, 'GET', '/devices', t2)).json() as { id: string }[]).some((d) => d.id === deviceId), 'sibling manager sees it');
  assert.ok(!((await send(app, 'GET', '/devices', tb)).json() as { id: string }[]).some((d) => d.id === deviceId), 'other tenant sees it');

  assert.equal((await send(app, 'PATCH', `/devices/${deviceId}`, t1, { label: 'Front till' })).statusCode, 200);
  assert.equal((await send(app, 'PATCH', `/devices/${deviceId}`, t2, { label: 'hijack' })).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/devices/${deviceId}`, tb, { label: 'hijack' })).statusCode, 404);
  for (const bad of ['', 'x'.repeat(61), 5]) assert.equal((await send(app, 'PATCH', `/devices/${deviceId}`, t1, { label: bad })).statusCode, 400);
  const lbl = (await withTenant(A, (c) => c.query('SELECT label FROM device WHERE id = $1', [deviceId]))).rows[0].label;
  assert.equal(lbl, 'Front till');

  assert.equal((await send(app, 'POST', `/devices/${deviceId}/revoke`, t1)).statusCode, 200);
  const revoked = ((await send(app, 'GET', '/devices', t1)).json() as { id: string; revokedAt: string | null }[]).find((d) => d.id === deviceId)!;
  assert.ok(revoked.revokedAt, 'revoked devices stay listed, marked revoked');
});

test('enrolment codes can be cancelled before use, only by a manager of that outlet', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const mint = async () => (await send(app, 'POST', '/enrolment-codes', t1, { outletId: o1.outletId, counterId: o1.c1 })).json().code as string;

  const keep = await mint();
  const keepId = keep.split('.')[1];
  assert.equal((await send(app, 'DELETE', `/enrolment-codes/${keepId}`, t2)).statusCode, 404, 'sibling manager cannot cancel');
  assert.equal((await app.inject({ method: 'DELETE', url: `/enrolment-codes/${keepId}` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/enrol', payload: { code: keep } })).statusCode, 200, 'code survived the failed cancels');

  const cancel = await mint();
  assert.equal((await send(app, 'DELETE', `/enrolment-codes/${cancel.split('.')[1]}`, t1)).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/enrol', payload: { code: cancel } })).statusCode, 401, 'cancelled code must not enrol');
  assert.equal((await send(app, 'DELETE', `/enrolment-codes/${cancel.split('.')[1]}`, t1)).statusCode, 404, 'already cancelled');
  assert.equal((await send(app, 'DELETE', `/enrolment-codes/${keepId}`, t1)).statusCode, 404, 'already used');
});

test('admin routes need a manager session: none 401, device 403', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const code = (await send(app, 'POST', '/enrolment-codes', t1, { outletId: o1.outletId, counterId: o1.c1 })).json().code as string;
  const dev = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  for (const [method, url] of [['GET', '/users'], ['GET', '/devices'], ['POST', '/users'], ['POST', `/outlets/${o1.outletId}/counters`]] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
    assert.equal((await app.inject({ method, url, headers: { authorization: `Device ${dev}` } })).statusCode, 403, `${method} ${url}`);
  }
});

test('admin actions are audited', async () => {
  const actions = await withTenant(A, (c) => c.query("SELECT DISTINCT action FROM audit WHERE action ~ '^(user|counter|device|enrolment_code)\\.'"));
  const set = new Set(actions.rows.map((r) => r.action));
  for (const a of ['counter.create', 'counter.rename', 'user.create', 'user.update', 'user.pin_reset', 'device.label', 'enrolment_code.cancel']) {
    assert.ok(set.has(a), `audit missing ${a}`);
  }
});
