// Platform console: sign-in (password + authenticator code), the two console roles, tenant lifecycle, suspension
// enforced on the tenant side, and the console's audit trail. Real Postgres, both pools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { allowedAdmin } from '../src/auth.js';
import { platformPool, pool, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // scripts/seed.ts DEV_TOTP_SECRET
const PW = 'dev-password-123';
const OWNER = 'owner@platform.test';
const SUPPORT = 'support@platform.test';
const A = '00000000-0000-4000-8000-00000000000a';
test.after(() => Promise.all([pool.end(), platformPool.end()]));

type App = ReturnType<typeof buildApp>;
const code = (stepOffset = 0) => totpCode(SECRET, totpStep(Date.now()) + stepOffset);
const plat = (t: string) => ({ authorization: `Platform ${t}` });

/** Clears the replay marker and lockout so each test can sign in within one 30 s step. */
async function resetAdmin(email: string) {
  await platformPool.query(
    'UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL, active = true WHERE lower(email) = $1', [email]);
}
const loginRaw = (app: App, email: string, password = PW, c = code()) =>
  app.inject({ method: 'POST', url: '/platform/login', payload: { email, password, code: c } });
async function signIn(app: App, email: string): Promise<string> {
  await resetAdmin(email);
  const r = await loginRaw(app, email);
  assert.equal(r.statusCode, 200, `platform login ${email}`);
  return r.json().token as string;
}
const get = (app: App, url: string, t: string, host?: string) =>
  app.inject({ method: 'GET', url, headers: { ...plat(t), ...(host ? { host } : {}) } });
const send = (app: App, method: 'POST' | 'PATCH', url: string, t: string, payload: object = {}) =>
  app.inject({ method, url, payload, headers: plat(t) });
const auditActions = async (tenantId: string) =>
  (await platformPool.query('SELECT action FROM platform_audit WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows.map((r) => r.action as string);
const fresh = () => `t-${randomBytes(4).toString('hex')}`;

test('sign-in needs password AND code; every failure looks the same', async () => {
  const app = buildApp();
  await resetAdmin(OWNER);
  const ok = await loginRaw(app, OWNER);
  assert.equal(ok.statusCode, 200);
  assert.match(ok.json().token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

  await resetAdmin(OWNER);
  const wrongPw = await loginRaw(app, OWNER, 'not-the-password');
  const wrongCode = await loginRaw(app, OWNER, PW, code(5));
  const noCode = await loginRaw(app, OWNER, PW, '000000');
  const unknown = await loginRaw(app, 'nobody@platform.test');
  for (const r of [wrongPw, wrongCode, noCode, unknown]) {
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.json(), { error: 'invalid credentials' });
  }
  assert.equal((await app.inject({ method: 'POST', url: '/platform/login', payload: { email: OWNER, password: PW } })).statusCode, 400);
});

test('a code already used cannot be replayed', async () => {
  const app = buildApp();
  await resetAdmin(OWNER);
  const c = code();
  assert.equal((await loginRaw(app, OWNER, PW, c)).statusCode, 200);
  assert.equal((await loginRaw(app, OWNER, PW, c)).statusCode, 401);
  assert.equal((await loginRaw(app, OWNER, PW, code(-1))).statusCode, 401, 'an older step is also refused');
});

test('five failures lock the account, even against the right password and code', async () => {
  const app = buildApp();
  await resetAdmin(SUPPORT);
  for (let i = 0; i < 5; i++) assert.equal((await loginRaw(app, SUPPORT, 'wrong-password-here')).statusCode, 401);
  assert.equal((await loginRaw(app, SUPPORT)).statusCode, 401, 'locked');
  const row = (await platformPool.query("SELECT locked_until FROM platform_admin WHERE email = $1", [SUPPORT])).rows[0];
  assert.ok(row.locked_until, 'locked_until set');
  await resetAdmin(SUPPORT);
  assert.equal((await loginRaw(app, SUPPORT)).statusCode, 200, 'unlocks when cleared');
});

test('console and tenant credentials do not cross', async () => {
  const app = buildApp();
  const token = await signIn(app, OWNER);
  // A console token is not a tenant credential, whichever scheme it is presented under.
  for (const h of [`Platform ${token}`, `Bearer ${A}.${token}`]) {
    const r = await app.inject({ method: 'GET', url: '/settings', headers: { authorization: h, host: 'tenant-a.localhost' } });
    assert.equal(r.statusCode, 401, h.slice(0, 20));
  }
  // A tenant manager's token is not a console credential.
  const mgr = await app.inject({ method: 'POST', url: '/login', payload: { email: 'a1@example.test', password: PW }, headers: { host: 'tenant-a.localhost' } });
  const mt = mgr.json().token as string;
  for (const h of [`Bearer ${mt}`, `Platform ${mt}`, `Platform ${mt.split('.').slice(1).join('.')}`]) {
    const r = await app.inject({ method: 'GET', url: '/platform/tenants', headers: { authorization: h } });
    assert.equal(r.statusCode, 401, h.slice(0, 20));
  }
  assert.equal((await app.inject({ method: 'GET', url: '/platform/tenants' })).statusCode, 401);
});

test('support can look but not change; owner can do everything', async () => {
  const app = buildApp();
  const support = await signIn(app, SUPPORT);
  assert.equal((await get(app, '/platform/tenants', support)).statusCode, 200);
  assert.equal((await get(app, '/platform/audit', support)).statusCode, 200);
  assert.equal((await get(app, '/platform/me', support)).json().role, 'support');
  const t = fresh();
  assert.equal((await send(app, 'POST', '/platform/tenants', support, { name: 'No', subdomain: t })).statusCode, 403);
  const tenants = (await get(app, '/platform/tenants', support)).json() as { id: string }[];
  assert.ok(tenants.length >= 2);
  const id = tenants[0]!.id;
  assert.equal((await send(app, 'PATCH', `/platform/tenants/${id}`, support, { name: 'x' })).statusCode, 403);
  assert.equal((await send(app, 'POST', `/platform/tenants/${id}/suspend`, support, { reason: 'because' })).statusCode, 403);
  assert.equal((await send(app, 'POST', `/platform/tenants/${id}/managers`, support, { name: 'x', email: 'x@example.test', password: 'long-enough-password' })).statusCode, 403);
  assert.equal((await platformPool.query("SELECT 1 FROM tenant WHERE subdomain = $1", [t])).rowCount, 0);
});

test('owner creates and renames a tenant; bad, reserved and duplicate subdomains are refused', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const sub = fresh();
  const made = await send(app, 'POST', '/platform/tenants', owner, { name: 'Fresh Caterer', subdomain: sub });
  assert.equal(made.statusCode, 201);
  const t = made.json();
  assert.equal(t.subdomain, sub);
  assert.equal(t.suspendedAt, null);
  assert.equal(t.outlets, 0);

  assert.equal((await send(app, 'POST', '/platform/tenants', owner, { name: 'Dup', subdomain: sub })).statusCode, 409);
  for (const bad of ['admin', 'api', 'Has Caps', '-lead', 'x'.repeat(64), '']) {
    const r = await send(app, 'POST', '/platform/tenants', owner, { name: 'Bad', subdomain: bad });
    assert.equal(r.statusCode, 400, `subdomain "${bad}"`);
  }
  assert.equal((await send(app, 'POST', '/platform/tenants', owner, { name: 'Extra', subdomain: fresh(), plan: 'gold' })).statusCode, 400);

  const renamed = await send(app, 'PATCH', `/platform/tenants/${t.id}`, owner, { name: 'Renamed' });
  assert.equal(renamed.json().name, 'Renamed');
  assert.equal((await send(app, 'PATCH', `/platform/tenants/00000000-0000-4000-8000-0000000000ff`, owner, { name: 'x' })).statusCode, 404);

  assert.deepEqual(await auditActions(t.id), ['tenant.create', 'tenant.rename']);
});

test('suspending a tenant stops its managers and devices; reactivating restores them', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const sub = fresh();
  const host = `${sub}.localhost`;
  const t = (await send(app, 'POST', '/platform/tenants', owner, { name: 'Suspend Me', subdomain: sub })).json();
  const email = `boss-${sub}@example.test`;
  const mgr = await send(app, 'POST', `/platform/tenants/${t.id}/managers`, owner, { name: 'Boss', email, password: PW });
  assert.equal(mgr.statusCode, 201);
  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/managers`, owner, { name: 'Boss 2', email: email.toUpperCase(), password: PW })).statusCode, 409);
  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/managers`, owner, { name: 'Weak', email: 'w@example.test', password: 'short' })).statusCode, 400);

  // A device for the tenant, made the way enrolment would.
  const secret = randomBytes(32).toString('base64url');
  const deviceId = await withTenant(t.id, async (c) => {
    const o = (await c.query("INSERT INTO outlet (tenant_id, name) VALUES ($1, 'Main') RETURNING id", [t.id])).rows[0];
    const k = (await c.query("INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1') RETURNING id", [t.id, o.id])).rows[0];
    return (await c.query(
      'INSERT INTO device (tenant_id, outlet_id, counter_id, credential_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [t.id, o.id, k.id, createHash('sha256').update(secret).digest('hex')])).rows[0].id as string;
  });
  const deviceHeaders = { authorization: `Device ${t.id}.${deviceId}.${secret}`, host };
  const login = () => app.inject({ method: 'POST', url: '/login', payload: { email, password: PW }, headers: { host } });

  const before = await login();
  assert.equal(before.statusCode, 200);
  const bearer = { authorization: `Bearer ${before.json().token}`, host };
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: bearer })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/sync/pull', headers: deviceHeaders })).statusCode < 400, true, 'device works before');

  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/suspend`, owner, {})).statusCode, 400, 'a reason is required');
  const sus = await send(app, 'POST', `/platform/tenants/${t.id}/suspend`, owner, { reason: 'unpaid invoice' });
  assert.equal(sus.statusCode, 200);
  assert.ok(sus.json().suspendedAt);
  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/suspend`, owner, { reason: 'again' })).statusCode, 404, 'already suspended');

  const blockedLogin = await login();
  assert.equal(blockedLogin.statusCode, 403);
  assert.deepEqual(blockedLogin.json(), { error: 'tenant suspended' });
  // A wrong password is still a plain 401: suspension is not an oracle for strangers.
  const strangers = await app.inject({ method: 'POST', url: '/login', payload: { email, password: 'wrong-password-123' }, headers: { host } });
  assert.equal(strangers.statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: bearer })).statusCode, 403, 'existing session');
  assert.equal((await app.inject({ method: 'GET', url: '/sync/pull', headers: deviceHeaders })).statusCode, 403, 'device');

  // Enrolment: a live code is refused while suspended (and not consumed); a bogus code stays a plain 401.
  const codeSecret = 'ABCDEFGHJKLMNPQR';
  const codeId = await withTenant(t.id, async (c) => {
    const o = (await c.query('SELECT outlet_id, id AS counter_id FROM counter WHERE tenant_id = $1 LIMIT 1', [t.id])).rows[0];
    const u = (await c.query('SELECT id FROM app_user WHERE tenant_id = $1 LIMIT 1', [t.id])).rows[0];
    return (await c.query(
      `INSERT INTO enrolment_code (tenant_id, outlet_id, counter_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes') RETURNING id`,
      [t.id, o.outlet_id, o.counter_id, createHash('sha256').update(codeSecret).digest('hex'), u.id])).rows[0].id as string;
  });
  const enrol = (code: string) => app.inject({ method: 'POST', url: '/enrol', payload: { code }, headers: { host } });
  const blockedEnrol = await enrol(`${t.id}.${codeId}.${codeSecret}`);
  assert.equal(blockedEnrol.statusCode, 403);
  assert.deepEqual(blockedEnrol.json(), { error: 'tenant suspended' });
  assert.equal((await enrol(`${t.id}.${codeId}.ZZZZZZZZZZZZZZZZ`)).statusCode, 401, 'wrong secret is not an oracle');

  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/reactivate`, owner, { reason: 'paid' })).statusCode, 200);
  assert.equal((await enrol(`${t.id}.${codeId}.${codeSecret}`)).statusCode, 200, 'code survived the suspension');
  assert.equal((await send(app, 'POST', `/platform/tenants/${t.id}/reactivate`, owner, { reason: 'again' })).statusCode, 404, 'not suspended');
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: bearer })).statusCode, 200);
  assert.equal((await login()).statusCode, 200);
  assert.ok((await app.inject({ method: 'GET', url: '/sync/pull', headers: deviceHeaders })).statusCode < 400);

  assert.deepEqual(await auditActions(t.id), ['tenant.create', 'manager.create', 'tenant.suspend', 'tenant.reactivate']);
  // The tenant's own managers can see the platform created the account.
  const seen = await withTenant(t.id, async (c) => (await c.query("SELECT action, actor_kind, detail FROM audit WHERE action = 'platform.manager.create'")).rows);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actor_kind, 'system');
  assert.ok(seen[0].detail.platformAdminId);
});

test('the other tenants are untouched by one suspension', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const sub = fresh();
  const t = (await send(app, 'POST', '/platform/tenants', owner, { name: 'Alone', subdomain: sub })).json();
  await send(app, 'POST', `/platform/tenants/${t.id}/suspend`, owner, { reason: 'test isolation' });
  const r = await app.inject({ method: 'POST', url: '/login', payload: { email: 'a1@example.test', password: PW }, headers: { host: 'tenant-a.localhost' } });
  assert.equal(r.statusCode, 200);
});

test('logout, expiry and deactivation each end a console session', async () => {
  const app = buildApp();
  const t1 = await signIn(app, OWNER);
  assert.equal((await send(app, 'POST', '/platform/logout', t1)).statusCode, 200);
  assert.equal((await get(app, '/platform/me', t1)).statusCode, 401, 'after logout');

  const t2 = await signIn(app, OWNER);
  await platformPool.query("UPDATE platform_session SET expires_at = now() - interval '1 second' WHERE id = $1", [t2.split('.')[0]]);
  assert.equal((await get(app, '/platform/me', t2)).statusCode, 401, 'after expiry');

  const t3 = await signIn(app, OWNER);
  await platformPool.query("UPDATE platform_admin SET active = false WHERE email = $1", [OWNER]);
  assert.equal((await get(app, '/platform/me', t3)).statusCode, 401, 'after deactivation');
  await resetAdmin(OWNER);

  const t4 = await signIn(app, OWNER);
  const [id, secret] = t4.split('.');
  assert.equal((await get(app, '/platform/me', `${id}.${secret!.slice(0, -1)}${secret!.endsWith('A') ? 'B' : 'A'}`)).statusCode, 401, 'wrong secret');
});

test('the console answers only on PLATFORM_HOST when one is set', async () => {
  const app = buildApp();
  const t = await signIn(app, OWNER);
  process.env.PLATFORM_HOST = 'admin.example.test';
  try {
    assert.equal((await get(app, '/platform/me', t)).statusCode, 404, 'default host');
    assert.equal((await get(app, '/platform/me', t, 'tenant-a.localhost')).statusCode, 404, 'tenant host');
    assert.equal((await app.inject({ method: 'POST', url: '/platform/login', payload: { email: OWNER, password: PW, code: code() } })).statusCode, 404, 'login too');
    assert.equal((await get(app, '/platform/me', t, 'admin.example.test:8443')).statusCode, 200);
    assert.equal((await get(app, '/platform/me', t, 'ADMIN.example.test')).statusCode, 200);
  } finally {
    delete process.env.PLATFORM_HOST;
  }
});

test('login, failures and actions are on the platform audit trail with who did them', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const r = await get(app, '/platform/audit?limit=50', owner);
  assert.equal(r.statusCode, 200);
  const rows = r.json() as { action: string; adminId: string | null }[];
  assert.ok(rows.some((x) => x.action === 'login.ok' && x.adminId));
  assert.ok(rows.some((x) => x.action === 'login.failed' && x.adminId));
  assert.equal((await get(app, '/platform/audit?limit=0', owner)).statusCode, 400);
  assert.equal((await get(app, '/platform/audit?tenantId=nope', owner)).statusCode, 400);
});

test('console permissions: owner everything, support only the any-role routes, tenant permissions never', () => {
  const owner = { adminId: 'a', role: 'owner', sessionId: 's' } as const;
  const support = { adminId: 'b', role: 'support', sessionId: 's' } as const;
  assert.equal(allowedAdmin('platform-owner', owner), true);
  assert.equal(allowedAdmin('platform-any', owner), true);
  assert.equal(allowedAdmin('platform-owner', support), false);
  assert.equal(allowedAdmin('platform-any', support), true);
  for (const p of ['manager', 'till', 'staff', 'device'] as const) assert.equal(allowedAdmin(p, owner), false, p);
});
