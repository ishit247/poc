// Operator onboarding end to end (docs/phase11-platform-admin.md step 5): outlet + counters, an invited manager who
// chooses their own password, and that manager creating an enrolment code a tablet redeems. Real Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { platformPool, pool, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // scripts/seed.ts DEV_TOTP_SECRET
const PW = 'dev-password-123';
const A = '00000000-0000-4000-8000-00000000000a';
test.after(() => Promise.all([pool.end(), platformPool.end()]));

type App = ReturnType<typeof buildApp>;
const plat = (t: string) => ({ authorization: `Platform ${t}` });
async function signIn(app: App, email: string): Promise<string> {
  await platformPool.query(
    'UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL, active = true WHERE lower(email) = $1', [email]);
  const r = await app.inject({ method: 'POST', url: '/platform/login', payload: { email, password: PW, code: totpCode(SECRET, totpStep(Date.now())) } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
const post = (app: App, url: string, t: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, headers: plat(t) });
const get = (app: App, url: string, t: string) => app.inject({ method: 'GET', url, headers: plat(t) });
const redeem = (app: App, token: string, password = 'a-brand-new-password') =>
  app.inject({ method: 'POST', url: '/invite/redeem', payload: { token, password } });
const login = (app: App, email: string, password: string) => app.inject({ method: 'POST', url: '/login', payload: { email, password } });
const uniq = () => randomBytes(4).toString('hex');

async function tenantWithOutlet(app: App, owner: string) {
  const t = (await post(app, '/platform/tenants', owner, { name: `Onboard ${uniq()}` })).json().id as string;
  const o = await post(app, `/platform/tenants/${t}/outlets`, owner, { name: 'Main Canteen', counters: ['c1', 'C2', 'c1'] });
  assert.equal(o.statusCode, 201);
  return { tenantId: t, outlet: o.json() as { id: string; counters: { id: string; code: string }[] } };
}

test('outlet create: counters upper-cased and de-duplicated, listed back, owner only, audited', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId, outlet } = await tenantWithOutlet(app, owner);
  assert.deepEqual(outlet.counters.map((c) => c.code).sort(), ['C1', 'C2']);

  const list = (await get(app, `/platform/tenants/${tenantId}/outlets`, owner)).json();
  assert.equal(list.outlets.length, 1);
  assert.equal(list.outlets[0].counters.length, 2);

  const dup = await post(app, `/platform/tenants/${tenantId}/outlets`, owner, { name: 'X', counters: ['bad code!'] });
  assert.equal(dup.statusCode, 400);

  const support = await signIn(app, 'support@platform.test');
  assert.equal((await post(app, `/platform/tenants/${tenantId}/outlets`, support, { name: 'Nope' })).statusCode, 403);
  assert.equal((await get(app, `/platform/tenants/${tenantId}/outlets`, support)).statusCode, 200); // read is allowed
  assert.equal((await get(app, `/platform/tenants/${A}/outlets`, support)).statusCode, 200);

  const actions = (await platformPool.query('SELECT action FROM platform_audit WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows.map((r) => r.action);
  assert.ok(actions.includes('outlet.create'));
  await app.close();
});

test('invited manager: no password known, cannot sign in until the invite is redeemed, then signs in and enrols a tablet', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId, outlet } = await tenantWithOutlet(app, owner);
  const email = `m-${uniq()}@example.test`;

  const made = await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'New Manager', email, outletIds: [outlet.id] });
  assert.equal(made.statusCode, 201);
  const { invite } = made.json() as { invite: string };
  assert.match(invite, new RegExp(`^${tenantId}\\.`));

  // Before redeeming: the stored hash is of a secret nobody holds.
  assert.equal((await login(app, email, PW)).statusCode, 401);
  assert.equal((await login(app, email, invite)).statusCode, 401);

  assert.equal((await redeem(app, invite, 'short')).statusCode, 400); // too short, and not consumed
  const ok = await redeem(app, invite, 'my-own-long-password');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().email, email);
  assert.equal((await redeem(app, invite, 'another-long-password')).statusCode, 401, 'single use');
  assert.equal((await login(app, email, 'another-long-password')).statusCode, 401);

  const s = await login(app, email, 'my-own-long-password');
  assert.equal(s.statusCode, 200);
  const bearer = { authorization: `Bearer ${s.json().token}` };
  const me = (await app.inject({ method: 'GET', url: '/me', headers: bearer })).json();
  assert.deepEqual(me.outlets.map((o: { id: string }) => o.id), [outlet.id]);

  // The manager creates a code for their own outlet and a tablet redeems it.
  const code = await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer, payload: { outletId: outlet.id, counterId: outlet.counters[0]!.id } });
  assert.equal(code.statusCode, 200);
  const enrol = await app.inject({ method: 'POST', url: '/enrol', payload: { code: code.json().code } });
  assert.equal(enrol.statusCode, 200);
  assert.ok(enrol.json().credential);

  // Both audit trails: the tenant's own (so its managers can see the platform acted) and the platform's.
  const tenantActions = await withTenant(tenantId, async (c) => (await c.query('SELECT action FROM audit ORDER BY id')).rows.map((r) => r.action as string));
  for (const a of ['platform.outlet.create', 'platform.manager.create', 'manager.invite.accept']) assert.ok(tenantActions.includes(a), a);
  await app.close();
});

test('invite refusals: tampered secret, expired, suspended tenant (not consumed), unknown tenant', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId, outlet } = await tenantWithOutlet(app, owner);
  const mk = async () => (await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'M', email: `m-${uniq()}@example.test`, outletIds: [outlet.id] })).json().invite as string;

  const t1 = await mk();
  const parts = t1.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -1)}${parts[2]!.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await redeem(app, tampered)).statusCode, 401);
  assert.equal((await redeem(app, 'garbage')).statusCode, 401);
  assert.equal((await redeem(app, `${A.replace(/a$/, 'c')}.${parts[1]}.${parts[2]}`)).statusCode, 401, 'wrong tenant');

  // Expired.
  await withTenant(tenantId, (c) => c.query("UPDATE manager_invite SET created_at = now() - interval '5 days', expires_at = now() - interval '1 day' WHERE used_at IS NULL"));
  assert.equal((await redeem(app, t1)).statusCode, 401);

  // Suspended: refused with the reason, and the invite survives for after reactivation.
  const t2 = await mk();
  assert.equal((await post(app, `/platform/tenants/${tenantId}/suspend`, owner, { reason: 'test suspend' })).statusCode, 200);
  assert.equal((await redeem(app, t2)).statusCode, 403);
  assert.equal((await post(app, `/platform/tenants/${tenantId}/reactivate`, owner, { reason: 'test back' })).statusCode, 200);
  assert.equal((await redeem(app, t2)).statusCode, 200);
  await app.close();
});

test('re-invite replaces an unused link; a manager who already accepted cannot be re-invited; password path still works', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId, outlet } = await tenantWithOutlet(app, owner);
  const made = (await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'M', email: `m-${uniq()}@example.test`, outletIds: [outlet.id] })).json();

  const again = await post(app, `/platform/tenants/${tenantId}/managers/${made.id}/invite`, owner);
  assert.equal(again.statusCode, 200);
  assert.equal((await redeem(app, made.invite)).statusCode, 401, 'the old link no longer works');
  assert.equal((await redeem(app, again.json().invite)).statusCode, 200);
  assert.equal((await post(app, `/platform/tenants/${tenantId}/managers/${made.id}/invite`, owner)).statusCode, 404, 'already accepted');

  const support = await signIn(app, 'support@platform.test');
  assert.equal((await post(app, `/platform/tenants/${tenantId}/managers/${made.id}/invite`, support)).statusCode, 403);

  // Existing behaviour: an operator-chosen password still creates a ready manager and returns no invite.
  const direct = await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'D', email: `d-${uniq()}@example.test`, password: 'operator-chosen-pw' });
  assert.equal(direct.statusCode, 201);
  assert.equal(direct.json().invite, undefined);
  await app.close();
});

test('the database refuses an invite that lives longer than 7 days, and the app role cannot delete invites', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId, outlet } = await tenantWithOutlet(app, owner);
  await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'M', email: `m-${uniq()}@example.test`, outletIds: [outlet.id] });
  await assert.rejects(withTenant(tenantId, (c) => c.query("UPDATE manager_invite SET expires_at = created_at + interval '30 days'")), /check/i);
  await assert.rejects(withTenant(tenantId, (c) => c.query('DELETE FROM manager_invite')), /permission denied/i);
  await app.close();
});

test('outletIds must belong to the tenant: another tenant\'s outlet is a 404 and no manager is created', async () => {
  const app = buildApp();
  const owner = await signIn(app, 'owner@platform.test');
  const { tenantId } = await tenantWithOutlet(app, owner);
  const other = (await tenantWithOutlet(app, owner)).outlet;
  const email = `x-${uniq()}@example.test`;
  const r = await post(app, `/platform/tenants/${tenantId}/managers`, owner, { name: 'X', email, outletIds: [other.id] });
  assert.equal(r.statusCode, 404);
  const n = await withTenant(tenantId, async (c) => (await c.query('SELECT count(*)::int AS n FROM app_user WHERE lower(email) = $1', [email])).rows[0].n);
  assert.equal(n, 0);
  await app.close();
});
