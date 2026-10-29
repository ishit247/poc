import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const dev = (c: string, extra: Record<string, string> = {}) => ({ authorization: `Device ${c}`, ...extra });

async function managerToken(app: App, tenant: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', payload: { tenantId: tenant, email, password: 'dev-password-123' } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
const outletNamed = (tenant: string, name: string) => withTenant(tenant, async (c) =>
  (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [name])).rows[0] as { id: string; counter_id: string });
const userNamed = (tenant: string, name: string) => withTenant(tenant, async (c) =>
  (await c.query('SELECT id FROM app_user WHERE name = $1', [name])).rows[0].id as string);
async function enrol(app: App, mgr: string, outletId: string, counterId: string) {
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId, counterId } })).json().code as string;
  return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
}
const signin = (app: App, cred: string, userId: string, pin: string) =>
  app.inject({ method: 'POST', url: '/device/pin-signin', headers: dev(cred), payload: { userId, pin } });
const unlockState = (tenant: string, userId: string) => withTenant(tenant, (c) =>
  c.query("UPDATE login_lockout SET failed = 0, locked_until = NULL WHERE user_id = $1 AND kind = 'pin'", [userId]));

async function pullUsers(app: App, cred: string, from = 0) {
  let cursor = from;
  const users: { id: string; version: number; deleted: boolean; data: any }[] = [];
  for (let i = 0; i < 50; i++) {
    const j = (await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: dev(cred) })).json();
    users.push(...j.changes.filter((c: any) => c.type === 'user'));
    cursor = j.cursor;
    if (!j.hasMore) break;
  }
  return { users, cursor };
}

test('PIN sign-in: cashier and waiter get a device-bound session; managers, other outlets and bad PINs do not', async () => {
  const app = buildApp();
  const mgr = await managerToken(app, A, 'a1@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const cred = await enrol(app, mgr, o1.id, o1.counter_id);
  const waiter = await userNamed(A, 'School 1 Canteen waiter');
  const cashier = await userNamed(A, 'School 1 Canteen cashier');
  const otherOutletWaiter = await userNamed(A, 'School 2 Canteen waiter');
  const manager = await userNamed(A, 'School 1 Canteen manager');

  const ok = await signin(app, cred, waiter, PIN);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(Object.keys(ok.json().user).sort(), ['id', 'name', 'role']);
  assert.equal(ok.json().user.role, 'waiter');
  assert.equal((await signin(app, cred, cashier, PIN)).statusCode, 200);

  // The session works for staff routes, and is refused on manager routes.
  const tok = ok.json().token as string;
  assert.equal((await app.inject({ method: 'GET', url: '/orders', headers: bearer(tok) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/users', headers: bearer(tok) })).statusCode, 403);

  const wrong = await signin(app, cred, waiter, '739150');
  const unknown = await signin(app, cred, '11111111-1111-4111-8111-111111111111', PIN);
  const elsewhere = await signin(app, cred, otherOutletWaiter, PIN); // right PIN, user works at another outlet
  // Give the manager a REAL, valid PIN verifier: the role rule must be what refuses them, not a bad hash.
  await withTenant(A, (c) => c.query('UPDATE app_user SET pin_verifier = (SELECT pin_verifier FROM app_user WHERE id = $2) WHERE id = $1', [manager, waiter]));
  let mgrPin;
  try {
    mgrPin = await signin(app, cred, manager, PIN);
  } finally {
    await withTenant(A, (c) => c.query("UPDATE app_user SET pin_verifier = 'seed-unset' WHERE id = $1", [manager]));
  }
  for (const r of [wrong, unknown, elsewhere, mgrPin]) assert.equal(r.statusCode, 401);
  assert.equal(wrong.body, unknown.body);
  assert.equal(wrong.body, elsewhere.body);
  assert.equal((await app.inject({ method: 'POST', url: '/device/pin-signin', payload: { userId: waiter, pin: PIN } })).statusCode, 401, 'needs a device');
  assert.equal((await app.inject({ method: 'POST', url: '/device/pin-signin', headers: bearer(mgr), payload: { userId: waiter, pin: PIN } })).statusCode, 403, 'a user session is not a device');
  assert.equal((await signin(app, cred, waiter, '12ab')).statusCode, 400);
  await unlockState(A, waiter);
});

test('PIN lockout: 5 failures lock the user on every tablet; a manager unlock restores; scope and role are enforced', async () => {
  const app = buildApp();
  const mgrA1 = await managerToken(app, A, 'a1@example.test');
  const mgrA2 = await managerToken(app, A, 'a2@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const credX = await enrol(app, mgrA1, o1.id, o1.counter_id);
  const credY = await enrol(app, mgrA1, o1.id, o1.counter_id); // a second tablet at the same outlet
  const waiter = await userNamed(A, 'School 1 Canteen waiter');
  try {
    for (let i = 0; i < 4; i++) assert.equal((await signin(app, i % 2 ? credX : credY, waiter, '739150')).statusCode, 401);
    assert.equal((await signin(app, credX, waiter, '739150')).statusCode, 401, '5th failure');
    const locked = await signin(app, credY, waiter, PIN);
    assert.equal(locked.statusCode, 423, 'the correct PIN is refused while locked, on a tablet that never saw a failure');
    assert.ok(locked.json().lockedUntil);

    // Unlock: manager only, own outlets only, audited.
    const cashierTok = (await signin(app, credX, await userNamed(A, 'School 1 Canteen cashier'), PIN)).json().token as string;
    assert.equal((await app.inject({ method: 'POST', url: `/users/${waiter}/unlock`, headers: bearer(cashierTok) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/users/${waiter}/unlock`, headers: bearer(mgrA2) })).statusCode, 404, 'a manager of another outlet');
    assert.equal((await signin(app, credY, waiter, PIN)).statusCode, 423, 'refused attempts did not unlock');
    assert.equal((await app.inject({ method: 'POST', url: `/users/${waiter}/unlock`, headers: bearer(mgrA1) })).statusCode, 200);
    assert.equal((await signin(app, credY, waiter, PIN)).statusCode, 200);
    const audited = await withTenant(A, (c) => c.query("SELECT 1 FROM audit WHERE action = 'user.unlock' AND entity_id = $1", [waiter]));
    assert.ok(audited.rowCount);

    // A success resets the counter: 4 failures, a success, 4 more failures do not lock.
    for (let i = 0; i < 4; i++) await signin(app, credX, waiter, '739150');
    assert.equal((await signin(app, credX, waiter, PIN)).statusCode, 200);
    for (let i = 0; i < 4; i++) await signin(app, credX, waiter, '739150');
    assert.equal((await signin(app, credX, waiter, PIN)).statusCode, 200);
  } finally {
    await unlockState(A, waiter);
  }
});

test('PIN sessions end when the device is revoked or the user is deactivated', async () => {
  const app = buildApp();
  const mgr = await managerToken(app, A, 'a1@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const cred = await enrol(app, mgr, o1.id, o1.counter_id);
  const waiter = await userNamed(A, 'School 1 Canteen waiter');
  const deviceId = cred.split('.')[1]!;
  const tok = (await signin(app, cred, waiter, PIN)).json().token as string;
  assert.equal((await app.inject({ method: 'GET', url: '/orders', headers: bearer(tok) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/devices/${deviceId}/revoke`, headers: bearer(mgr) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/orders', headers: bearer(tok) })).statusCode, 401, 'session of a revoked device');

  const cred2 = await enrol(app, mgr, o1.id, o1.counter_id);
  const tok2 = (await signin(app, cred2, waiter, PIN)).json().token as string;
  try {
    await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { active: false } });
    assert.equal((await app.inject({ method: 'GET', url: '/orders', headers: bearer(tok2) })).statusCode, 401);
    assert.equal((await signin(app, cred2, waiter, PIN)).statusCode, 401);
  } finally {
    await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { active: true } });
  }
});

test('pull carries this outlet’s cashiers and waiters with verifiers; never managers, other outlets or other tenants', async () => {
  const app = buildApp();
  const mgr = await managerToken(app, A, 'a1@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const cred = await enrol(app, mgr, o1.id, o1.counter_id);
  const { users } = await pullUsers(app, cred);
  // Oracle straight from the tables (other tests may have added staff here): active cashiers and waiters of this outlet.
  const expected = await withTenant(A, async (c) => (await c.query(
    `SELECT u.id FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
      WHERE uo.outlet_id = $1 AND uo.deleted_at IS NULL AND u.active AND u.role IN ('cashier', 'waiter') ORDER BY u.id`, [o1.id])).rows.map((r) => r.id as string));
  assert.deepEqual(users.filter((u) => !u.deleted).map((u) => u.id).sort(), expected);
  const names = users.map((u) => u.data.name);
  assert.ok(names.includes('School 1 Canteen cashier') && names.includes('School 1 Canteen waiter'));
  assert.ok(!names.some((n) => /manager|School 2/.test(n)), 'a manager or another outlet’s staff was pulled');
  for (const u of users.filter((x) => !x.deleted)) {
    assert.deepEqual(Object.keys(u.data).sort(), ['name', 'pinVerifier', 'role']);
    const row = await withTenant(A, async (c) => (await c.query('SELECT pin_verifier FROM app_user WHERE id = $1', [u.id])).rows[0]);
    assert.equal(u.data.pinVerifier, row.pin_verifier, 'the pulled verifier is the stored one');
    if (/^School 1 Canteen (cashier|waiter)$/.test(u.data.name)) assert.match(u.data.pinVerifier, /^scrypt\$/);
  }
  // Tenant B's tablet sees only B's staff.
  const mgrB = await managerToken(app, B, 'b1@example.test');
  const ob = await outletNamed(B, 'Main Canteen');
  const credB = await enrol(app, mgrB, ob.id, ob.counter_id);
  const bNames = (await pullUsers(app, credB)).users.map((u) => String(u.data.name));
  assert.ok(bNames.includes('Main Canteen cashier'));
  assert.ok(!bNames.some((n) => /School/.test(n)), 'tenant A staff reached a tenant B tablet');
});

test('pull: PIN change, deactivation and removal reach the tablet; a failed PIN does not', async () => {
  const app = buildApp();
  const mgr = await managerToken(app, A, 'a1@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const cred = await enrol(app, mgr, o1.id, o1.counter_id);
  const waiter = await userNamed(A, 'School 1 Canteen waiter');
  const before = await pullUsers(app, cred);
  const oldVerifier = before.users.find((u) => u.id === waiter)!.data.pinVerifier as string;
  try {
    // Failed attempts change lockout state only: no user row moves.
    for (let i = 0; i < 3; i++) await signin(app, cred, waiter, '739150');
    assert.equal((await pullUsers(app, cred, before.cursor)).users.length, 0, 'a failed PIN made devices re-pull the user');
    await unlockState(A, waiter);

    // Manager resets the PIN: new verifier arrives, and a pending lockout is cleared with it.
    const reset = await app.inject({ method: 'POST', url: `/users/${waiter}/pin`, headers: bearer(mgr), payload: { pin: '739150' } });
    assert.equal(reset.statusCode, 200);
    const afterReset = await pullUsers(app, cred, before.cursor);
    assert.equal(afterReset.users.length, 1);
    assert.notEqual(afterReset.users[0]!.data.pinVerifier, oldVerifier);

    // Deactivation is a tombstone with no verifier.
    await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { active: false } });
    const afterOff = await pullUsers(app, cred, afterReset.cursor);
    assert.equal(afterOff.users.length, 1);
    assert.equal(afterOff.users[0]!.deleted, true);
    assert.deepEqual(afterOff.users[0]!.data, {});

    // Reactivated: back, with a verifier.
    await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { active: true } });
    const afterOn = await pullUsers(app, cred, afterOff.cursor);
    assert.equal(afterOn.users[0]!.deleted, false);

    // Removing the membership tombstones it; re-adding revives it. Unchanged memberships do not move.
    const noop = await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { outletIds: [o1.id] } });
    assert.equal(noop.statusCode, 200);
    assert.equal((await pullUsers(app, cred, afterOn.cursor)).users.length, 0, 'an unchanged membership was re-versioned');
    await withTenant(A, (c) => c.query('UPDATE user_outlet SET deleted_at = now() WHERE user_id = $1', [waiter]));
    const removed = await pullUsers(app, cred, afterOn.cursor);
    assert.equal(removed.users[0]!.deleted, true);
    assert.deepEqual(removed.users[0]!.data, {});
  } finally {
    await withTenant(A, (c) => c.query('UPDATE user_outlet SET deleted_at = NULL WHERE user_id = $1', [waiter]));
    await withTenant(A, (c) => c.query('UPDATE app_user SET pin_verifier = $2 WHERE id = $1', [waiter, oldVerifier])); // the reset above changed the PIN
    await app.inject({ method: 'PATCH', url: `/users/${waiter}`, headers: bearer(mgr), payload: { active: true } });
    await unlockState(A, waiter);
  }
});

test('hard-deleting staff or memberships is not possible for the app role', async () => {
  const waiter = await userNamed(A, 'School 1 Canteen waiter');
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM user_outlet WHERE user_id = $1', [waiter])), /permission denied/);
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM app_user WHERE id = $1', [waiter])), /permission denied/);
});

test('app_version: a tablet reports its build in a header; garbage is ignored', async () => {
  const app = buildApp();
  const mgr = await managerToken(app, A, 'a1@example.test');
  const o1 = await outletNamed(A, 'School 1 Canteen');
  const cred = await enrol(app, mgr, o1.id, o1.counter_id);
  const deviceId = cred.split('.')[1]!;
  const version = () => withTenant(A, async (c) => (await c.query('SELECT app_version FROM device WHERE id = $1', [deviceId])).rows[0].app_version as string | null);
  assert.equal(await version(), null);
  await app.inject({ method: 'GET', url: '/device/whoami', headers: dev(cred, { 'x-app-version': '0.3.1+abc' }) });
  assert.equal(await version(), '0.3.1+abc');
  await app.inject({ method: 'GET', url: '/device/whoami', headers: dev(cred, { 'x-app-version': 'x'.repeat(100) }) });
  await app.inject({ method: 'GET', url: '/device/whoami', headers: dev(cred, { 'x-app-version': '<script>' }) });
  assert.equal(await version(), '0.3.1+abc', 'a malformed value overwrote the build');
  await app.inject({ method: 'GET', url: '/device/whoami', headers: dev(cred) });
  assert.equal(await version(), '0.3.1+abc', 'a missing header cleared the build');
});
