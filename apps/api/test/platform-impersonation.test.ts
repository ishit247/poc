// Support impersonation: read-only, 30 minutes, reason required, visible to the tenant, owner only.
// Real Postgres. Each test starts its own grant; the grants stay in the tables as history.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { platformPool, pool, requestMode, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';
import { A_ID as A, B_ID as B, hostFor } from './hosts.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PW = 'dev-password-123';
const owner = new pg.Pool({ connectionString: process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos' });
test.after(() => Promise.all([pool.end(), platformPool.end(), owner.end()]));

type App = ReturnType<typeof buildApp>;
async function signIn(app: App, email: string): Promise<string> {
  await platformPool.query('UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL WHERE email = $1', [email]);
  const r = await app.inject({ method: 'POST', url: '/platform/login', payload: { email, password: PW, code: totpCode(SECRET, totpStep(Date.now())) } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
const plat = (t: string) => ({ authorization: `Platform ${t}` });
const start = (app: App, t: string, tenant: string, reason: unknown = 'investigating a sync complaint') =>
  app.inject({ method: 'POST', url: `/platform/tenants/${tenant}/impersonate`, headers: plat(t), payload: { reason } });
async function grant(app: App, tenant = A) {
  const t = await signIn(app, 'owner@platform.test');
  const r = await start(app, t, tenant);
  assert.equal(r.statusCode, 201);
  return { t, ...(r.json() as { id: string; credential: string; expiresAt: string; readOnly: boolean }) };
}
const as = (cred: string, host = hostFor(A)) => ({ authorization: cred, host });
/** Run SQL as the table owner with a tenant stamp (the app role cannot write impersonation). */
async function asOwner(tenant: string, sql: string, args: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const r = await c.query(sql, args);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

test('only an owner may start support access, and a reason is required', async () => {
  const app = buildApp();
  const support = await signIn(app, 'support@platform.test');
  assert.equal((await start(app, support, A)).statusCode, 403);
  const t = await signIn(app, 'owner@platform.test');
  assert.equal((await start(app, t, A, '')).statusCode, 400);
  assert.equal((await start(app, t, A, 'ok')).statusCode, 400); // too short to be a reason
  assert.equal((await start(app, t, '00000000-0000-4000-8000-0000000000ff')).statusCode, 404);
  const none = await app.inject({ method: 'POST', url: `/platform/tenants/${A}/impersonate`, payload: { reason: 'no session at all' } });
  assert.equal(none.statusCode, 401);
});

test('the grant lasts 30 minutes at most and says it is read-only', async () => {
  const app = buildApp();
  const g = await grant(app);
  assert.equal(g.readOnly, true);
  const mins = (new Date(g.expiresAt).getTime() - Date.now()) / 60_000;
  assert.ok(mins > 29 && mins <= 30, `expires in ${mins} minutes`);
  // The database refuses a longer one even if some code tried to write it.
  await assert.rejects(asOwner(A, `UPDATE impersonation SET expires_at = created_at + interval '31 minutes' WHERE id = $1`, [g.id]), /check/i);
});

test('a support session reads the tenant and writes nothing', async () => {
  const app = buildApp();
  const g = await grant(app);
  const get = await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential) });
  assert.equal(get.statusCode, 200);
  const before = JSON.stringify(get.json());
  for (const method of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
    const r = await app.inject({ method, url: '/settings', headers: as(g.credential), payload: { maxLineQty: 1, gstRounding: 'line', billRoundTo: 1, offlineDays: 1 } });
    assert.equal(r.statusCode, 403, method);
    if (method === 'PUT') assert.equal(r.json().error, 'read-only support session'); // the others have no /settings route at all
  }
  const post = await app.inject({ method: 'POST', url: '/enrolment-codes', headers: as(g.credential), payload: {} });
  assert.equal(post.statusCode, 403);
  assert.equal(post.json().error, 'read-only support session'); // a real manager POST route, refused on method before any validation
  const after = await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential) });
  assert.equal(JSON.stringify(after.json()), before);
});

test('the database itself refuses a write on a support request', async () => {
  // What the API hook sets once a support credential is proved; here the route layer is out of the picture.
  await requestMode.run({ readOnly: true }, async () => {
    await assert.rejects(
      withTenant(A, (c) => c.query(`INSERT INTO audit (tenant_id, actor_kind, action, entity) VALUES ($1, 'system', 'x.should.fail', 'x')`, [A])),
      (e: { code?: string }) => e.code === '25006');
    const rows = await withTenant(A, async (c) => (await c.query('SELECT 1 AS one')).rows);
    assert.equal(rows[0].one, 1);
  });
  // and an ordinary request is not affected
  await requestMode.run({ readOnly: false }, () => withTenant(A, (c) => c.query('SELECT 1')));
});

test('a GET route that tries to write fails under a support session, and works for a real manager', async () => {
  const app = buildApp();
  // A deliberately badly written route: a GET that writes. It exists only in this test.
  app.get('/_writes-on-get', { config: { scope: 'tenant', permission: 'manager' } }, async (req) => {
    await withTenant(req.principal!.tenantId, (c) => c.query(`INSERT INTO audit (tenant_id, actor_kind, action, entity) VALUES ($1, 'system', 'test.write-on-get', 'x')`, [A]));
    return { wrote: true };
  });
  const g = await grant(app);
  const before = (await withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM audit WHERE action = 'test.write-on-get'`))).rows[0].n;
  const r = await app.inject({ method: 'GET', url: '/_writes-on-get', headers: as(g.credential) });
  assert.equal(r.statusCode, 500);
  const mid = (await withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM audit WHERE action = 'test.write-on-get'`))).rows[0].n;
  assert.equal(mid, before, 'nothing was written');
  // The same route for a real manager writes: the refusal above came from the support flag, not from the route.
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: PW } });
  const ok = await app.inject({ method: 'GET', url: '/_writes-on-get', headers: { authorization: `Bearer ${login.json().token}`, host: hostFor(A) } });
  assert.equal(ok.statusCode, 200);
});

test('support access cannot reach another tenant, or act as a device', async () => {
  const app = buildApp();
  const g = await grant(app, A);
  // The credential names tenant A. Pointed at B by id it is refused. The address is cosmetic (D12): on B's address it
  // is still A's session, never B's.
  const swapped = g.credential.replace(A, B);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(swapped, hostFor(B)) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential, hostFor(B)) })).statusCode, 200);
  // Device-only routes are not for it.
  assert.equal((await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: as(g.credential) })).statusCode, 403);
  // A wrong secret, and a Platform-style bearer, are the same plain 401.
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential.slice(0, -3) + 'AAA') })).statusCode, 401);
});

test('ending the grant, or letting it expire, ends access at once', async () => {
  const app = buildApp();
  const g = await grant(app);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential) })).statusCode, 200);
  const end = await app.inject({ method: 'POST', url: `/platform/tenants/${A}/impersonations/${g.id}/end`, headers: plat(g.t) });
  assert.equal(end.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(g.credential) })).statusCode, 401);
  const again = await app.inject({ method: 'POST', url: `/platform/tenants/${A}/impersonations/${g.id}/end`, headers: plat(g.t) });
  assert.equal(again.statusCode, 404);

  const g2 = await grant(app);
  await asOwner(A, `UPDATE impersonation SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`, [g2.id]);
  assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: as(g2.credential) })).statusCode, 401);
});

test("the tenant's managers can see who looked, why, and when; tenant B cannot", async () => {
  const app = buildApp();
  const g = await grant(app, A);
  const login = async (tenant: string, email: string) =>
    (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: PW } })).json().token as string;
  const a1 = await login(A, 'a1@example.test');
  const seen = (await app.inject({ method: 'GET', url: '/support-access', headers: { authorization: `Bearer ${a1}`, host: hostFor(A) } })).json() as
    { id: string; operator: string; reason: string; endedAt: string | null }[];
  const mine = seen.find((x) => x.id === g.id)!;
  assert.ok(mine, 'the grant is listed');
  assert.equal(mine.reason, 'investigating a sync complaint');
  assert.ok(mine.operator.length > 0);
  assert.ok(!('token_hash' in mine) && !('tokenHash' in mine));
  const audit = await withTenant(A, async (c) => (await c.query(`SELECT detail FROM audit WHERE action = 'support.access.start' AND entity_id = $1`, [g.id])).rows);
  assert.equal(audit.length, 1);
  const b1 = await login(B, 'b1@example.test');
  const other = (await app.inject({ method: 'GET', url: '/support-access', headers: { authorization: `Bearer ${b1}`, host: hostFor(B) } })).json() as { id: string }[];
  assert.ok(!other.some((x) => x.id === g.id));
  // The platform side recorded it too.
  const p = await platformPool.query(`SELECT 1 FROM platform_audit WHERE action = 'impersonation.start' AND entity_id = $1`, [g.id]);
  assert.equal(p.rowCount, 1);
});

test('the tenant API role cannot create or alter a grant; the console role cannot touch the table', async () => {
  const g = await grant(buildApp());
  await assert.rejects(withTenant(A, (c) => c.query(`UPDATE impersonation SET expires_at = now() + interval '20 minutes' WHERE id = $1`, [g.id])), /permission denied/);
  await assert.rejects(withTenant(A, (c) => c.query(`DELETE FROM impersonation WHERE id = $1`, [g.id])), /permission denied/);
  await assert.rejects(platformPool.query(`SELECT * FROM impersonation`), /permission denied/);
});
