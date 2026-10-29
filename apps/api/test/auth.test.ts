import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PW = 'dev-password-123';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });

async function login(app: App, tenantId: string, email: string, password = PW) {
  return post(app, '/login', { email, password }, { host: hostFor(tenantId) });
}
async function token(app: App, tenantId: string, email: string) {
  const r = await login(app, tenantId, email);
  assert.equal(r.statusCode, 200, `login ${email}`);
  return r.json().token as string;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function outletsAndCounter(tenantId: string, email: string) {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT o.id AS outlet_id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id
         FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id JOIN outlet o ON o.id = uo.outlet_id
        WHERE lower(u.email) = $1`, [email]);
    return r.rows[0] as { outlet_id: string; counter_id: string };
  });
}

test('login: success, and failure is identical for wrong password and unknown user', async () => {
  const app = buildApp();
  const ok = await login(app, A, 'a1@example.test');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.json().token, new RegExp(`^${A}\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$`));

  const wrong = await login(app, A, 'a1@example.test', 'wrong-password-xx');
  const unknown = await login(app, A, 'nobody@example.test');
  const otherTenant = await login(app, B, 'a1@example.test'); // right user, wrong tenant
  for (const r of [wrong, unknown, otherTenant]) assert.equal(r.statusCode, 401);
  assert.equal(wrong.body, unknown.body);
  assert.equal(wrong.body, otherTenant.body);
});

test('/me lists only the manager\'s own outlets, with each outlet\'s today', async () => {
  const app = buildApp();
  const assigned = await withTenant(A, async (c) => (await c.query(
    `SELECT uo.outlet_id FROM user_outlet uo JOIN app_user u ON u.id = uo.user_id
      WHERE lower(u.email) = 'a1@example.test' AND uo.deleted_at IS NULL`)).rows.map((x) => x.outlet_id as string).sort());
  const theirs = await outletsAndCounter(B, 'b1@example.test');
  const r = await app.inject({ method: 'GET', url: '/me', headers: bearer(await token(app, A, 'a1@example.test')) });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(assigned.length > 0);
  assert.deepEqual(body.outlets.map((o: { id: string }) => o.id).sort(), assigned);
  assert.ok(!body.outlets.some((o: { id: string }) => o.id === theirs.outlet_id));
  assert.match(body.outlets[0].today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await app.inject({ method: 'GET', url: '/me' })).statusCode, 401);
});

test('login: locks after 5 failures, even for the correct password', async () => {
  const app = buildApp();
  for (let i = 0; i < 5; i++) assert.equal((await login(app, A, 'a2@example.test', `bad-password-${i}x`)).statusCode, 401);
  assert.equal((await login(app, A, 'a2@example.test')).statusCode, 401, 'correct password must be refused while locked');
  await withTenant(A, (c) => c.query("UPDATE login_lockout SET failed = 0, locked_until = NULL WHERE user_id = (SELECT id FROM app_user WHERE lower(email) = 'a2@example.test')"));
  assert.equal((await login(app, A, 'a2@example.test')).statusCode, 200);
});

test('login is rate limited per client', async () => {
  const app = buildApp();
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await post(app, '/login', { email: 'nobody@example.test', password: 'x' }, { host: hostFor(B) })).statusCode);
  assert.ok(codes.includes(429), `expected a 429 in ${codes.join(',')}`);
});

test('login rejects malformed bodies and unknown fields', async () => {
  const app = buildApp();
  assert.equal((await post(app, '/login', { email: 1, password: 'y' }, { host: hostFor(A) })).statusCode, 400);
  assert.equal((await post(app, '/login', { tenantId: A, email: 'a1@example.test', password: PW }, { host: hostFor(A) })).statusCode, 400);
});

test('protected routes: no/garbage/forged credentials all give 401; wrong kind gives 403', async () => {
  const app = buildApp();
  const call = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/device/whoami', headers });
  assert.equal((await call({})).statusCode, 401);
  assert.equal((await call({ authorization: 'Bearer garbage' })).statusCode, 401);

  // A valid tenant-A session secret presented under tenant B's id must not authenticate.
  const t = await token(app, A, 'a1@example.test');
  const [, sid, secret] = t.split('.');
  assert.equal((await call({ authorization: `Bearer ${B}.${sid}.${secret}` })).statusCode, 401);

  // A valid manager session on a device-only route: authenticated but not permitted.
  assert.equal((await call(bearer(t))).statusCode, 403);
});

test('a session with the right id but wrong secret, or past expiry, is refused', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const [tid, sid] = t.split('.');
  const wrongSecret = `${tid}.${sid}.${'A'.repeat(43)}`;
  assert.equal((await post(app, '/logout', {}, bearer(wrongSecret))).statusCode, 401);

  await withTenant(A, (c) => c.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE id = $1", [sid]));
  assert.equal((await post(app, '/logout', {}, bearer(t))).statusCode, 401);
});

test('a device credential with the right id but wrong secret is refused', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const mine = await outletsAndCounter(A, 'a1@example.test');
  const code = (await post(app, '/enrolment-codes', { outletId: mine.outlet_id, counterId: mine.counter_id }, bearer(t))).json().code as string;
  const { credential } = (await post(app, '/enrol', { code })).json();
  const [tid, did] = (credential as string).split('.');
  const forged = `${tid}.${did}.${'A'.repeat(43)}`;
  assert.equal((await app.inject({ method: 'GET', url: '/device/whoami', headers: { authorization: `Device ${forged}` } })).statusCode, 401);
});

test('enrolment: manager creates code, device redeems once, credential works, revoke kills it', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { outlet_id, counter_id } = await outletsAndCounter(A, 'a1@example.test');

  const created = await post(app, '/enrolment-codes', { outletId: outlet_id, counterId: counter_id }, bearer(t));
  assert.equal(created.statusCode, 200);
  const code = created.json().code as string;

  const enrolled = await post(app, '/enrol', { code });
  assert.equal(enrolled.statusCode, 200);
  const { deviceId, credential } = enrolled.json();

  const reuse = await post(app, '/enrol', { code });
  assert.equal(reuse.statusCode, 401, 'a code is single-use');

  const who = await app.inject({ method: 'GET', url: '/device/whoami', headers: { authorization: `Device ${credential}` } });
  assert.equal(who.statusCode, 200);
  assert.deepEqual(who.json(), { deviceId, outletId: outlet_id, counterId: counter_id, counterCode: who.json().counterCode, outletName: who.json().outletName, timezone: 'Asia/Kolkata' });
  assert.match(who.json().counterCode, /^C[12]$/);

  // Stored only as a hash.
  const stored = await withTenant(A, (c) => c.query('SELECT credential_hash FROM device WHERE id = $1', [deviceId]));
  assert.ok(!credential.includes(stored.rows[0].credential_hash));
  assert.match(stored.rows[0].credential_hash, /^[0-9a-f]{64}$/);

  // A manager of tenant B cannot revoke tenant A's device (and learns nothing: 404).
  const tb = await token(app, B, 'b1@example.test');
  assert.equal((await post(app, `/devices/${deviceId}/revoke`, {}, bearer(tb))).statusCode, 404);
  // A manager of another outlet in the same tenant cannot either.
  const t2 = await token(app, A, 'a2@example.test');
  assert.equal((await post(app, `/devices/${deviceId}/revoke`, {}, bearer(t2))).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/device/whoami', headers: { authorization: `Device ${credential}` } })).statusCode, 200);

  assert.equal((await post(app, `/devices/${deviceId}/revoke`, {}, bearer(t))).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/device/whoami', headers: { authorization: `Device ${credential}` } })).statusCode, 401);
});

test('enrolment code: expired code refused; scope: cannot mint codes for another outlet or tenant', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const mine = await outletsAndCounter(A, 'a1@example.test');
  const sibling = await outletsAndCounter(A, 'a2@example.test');
  const foreign = await outletsAndCounter(B, 'b1@example.test');

  assert.equal((await post(app, '/enrolment-codes', { outletId: sibling.outlet_id, counterId: sibling.counter_id }, bearer(t))).statusCode, 404);
  assert.equal((await post(app, '/enrolment-codes', { outletId: foreign.outlet_id, counterId: foreign.counter_id }, bearer(t))).statusCode, 404);
  // Counter of another outlet paired with my outlet.
  assert.equal((await post(app, '/enrolment-codes', { outletId: mine.outlet_id, counterId: sibling.counter_id }, bearer(t))).statusCode, 404);
  assert.equal((await post(app, '/enrolment-codes', { outletId: mine.outlet_id, counterId: mine.counter_id })).statusCode, 401);

  const created = await post(app, '/enrolment-codes', { outletId: mine.outlet_id, counterId: mine.counter_id }, bearer(t));
  const code = created.json().code as string;
  await withTenant(A, (c) => c.query("UPDATE enrolment_code SET expires_at = now() - interval '1 second' WHERE id = $1", [code.split('.')[1]]));
  assert.equal((await post(app, '/enrol', { code })).statusCode, 401);
});

test('concurrent redemption of one code yields exactly one device', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const mine = await outletsAndCounter(A, 'a1@example.test');
  const code = (await post(app, '/enrolment-codes', { outletId: mine.outlet_id, counterId: mine.counter_id }, bearer(t))).json().code as string;
  const results = await Promise.all(Array.from({ length: 6 }, () => post(app, '/enrol', { code })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
});

test('logout revokes the session; audit records login and enrolment', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  assert.equal((await post(app, '/logout', {}, bearer(t))).statusCode, 200);
  assert.equal((await post(app, '/logout', {}, bearer(t))).statusCode, 401);
  const actions = await withTenant(A, (c) => c.query("SELECT DISTINCT action FROM audit WHERE action <> 'seed'"));
  const set = new Set(actions.rows.map((r) => r.action));
  for (const a of ['login.ok', 'login.failed', 'login.locked', 'logout', 'enrolment_code.create', 'device.enrol', 'device.revoke']) {
    assert.ok(set.has(a), `audit missing ${a}`);
  }
});

test('internal errors do not leak details', async () => {
  const app = buildApp();
  const r = await app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: '{bad json' });
  assert.ok(r.statusCode >= 400 && r.statusCode < 500);
  assert.doesNotMatch(r.body, /SyntaxError|at |node_modules/);
});
