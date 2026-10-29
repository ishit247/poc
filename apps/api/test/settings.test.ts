import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { DEFAULT_SETTINGS } from '@pos/shared';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', payload: { tenantId, email, password: 'dev-password-123' } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function deviceFor(app: App, t: string, tenantId: string, email: string) {
  const p = (await withTenant(tenantId, (c) => c.query(
    `SELECT o.id AS outlet_id, c.id FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
       JOIN outlet o ON o.id = uo.outlet_id JOIN counter c ON c.outlet_id = o.id WHERE lower(u.email) = $1 ORDER BY c.code LIMIT 1`, [email]))).rows[0];
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(t), payload: { outletId: p.outlet_id, counterId: p.id } })).json().code;
  return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
}
const pulledSetting = async (app: App, cred: string) => {
  const r = await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: { authorization: `Device ${cred}` } });
  assert.equal(r.statusCode, 200);
  // The first page may not hold everything on a big catalogue, so page through.
  let j = r.json();
  const all = [...j.changes];
  while (j.hasMore) {
    j = (await app.inject({ method: 'GET', url: `/sync/pull?cursor=${j.cursor}`, headers: { authorization: `Device ${cred}` } })).json();
    all.push(...j.changes);
  }
  return all.filter((c: { type: string }) => c.type === 'tenant_setting') as { id: string; data: Record<string, unknown> }[];
};

test('settings: manager reads, validates, replaces; tablets of that tenant only receive it', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const b1 = await token(app, B, 'b1@example.test');
  const credA = await deviceFor(app, a1, A, 'a1@example.test');
  const credB = await deviceFor(app, b1, B, 'b1@example.test');
  const before = (await app.inject({ method: 'GET', url: '/settings', headers: bearer(a1) })).json();
  try {
    assert.deepEqual(before, DEFAULT_SETTINGS); // seeded A = defaults
    const bSeen = await pulledSetting(app, credB);
    assert.equal(bSeen.length, 1);
    assert.equal(bSeen[0]!.id, B);
    assert.equal(bSeen[0]!.data.billRoundTo, 100);

    for (const bad of [{ ...DEFAULT_SETTINGS, maxLineQty: 0 }, { ...DEFAULT_SETTINGS, maxLineQty: 1000 }, { ...DEFAULT_SETTINGS, gstRounding: 'x' },
                       { ...DEFAULT_SETTINGS, billRoundTo: 25 }, { maxLineQty: 5 }, { ...DEFAULT_SETTINGS, extra: 1 }]) {
      const r = await app.inject({ method: 'PUT', url: '/settings', headers: bearer(a1), payload: bad });
      assert.equal(r.statusCode, 400, JSON.stringify(bad));
    }

    const next = { maxLineQty: 12, gstRounding: 'down', billRoundTo: 50, offlineDays: 3 };
    assert.equal((await app.inject({ method: 'PUT', url: '/settings', headers: bearer(a1), payload: next })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/settings', headers: bearer(a1) })).json(), next);

    const aSeen = await pulledSetting(app, credA);
    assert.equal(aSeen.length, 1);
    assert.equal(aSeen[0]!.id, A);
    assert.deepEqual(aSeen[0]!.data, next);
    // B is untouched by A's change, in the API and in what B's tablet pulls.
    const bAfter = await pulledSetting(app, credB);
    assert.equal(bAfter[0]!.data.maxLineQty, 20);
    assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: bearer(b1) })).json().maxLineQty, 20);
    const audited = await withTenant(A, (c) => c.query("SELECT 1 FROM audit WHERE action = 'settings.update'"));
    assert.ok((audited.rowCount ?? 0) >= 1);
  } finally {
    await app.inject({ method: 'PUT', url: '/settings', headers: bearer(a1), payload: before });
  }
});

test('settings: a tablet cannot read or change them through the manager routes', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const cred = await deviceFor(app, a1, A, 'a1@example.test');
  const h = { authorization: `Device ${cred}` };
  assert.ok([401, 403].includes((await app.inject({ method: 'GET', url: '/settings', headers: h })).statusCode));
  assert.ok([401, 403].includes((await app.inject({ method: 'PUT', url: '/settings', headers: h, payload: DEFAULT_SETTINGS })).statusCode));
  assert.equal((await app.inject({ method: 'PUT', url: '/settings', payload: DEFAULT_SETTINGS })).statusCode, 401);
});

test('settings: a signed-in cashier or waiter is refused (permission answers what)', async () => {
  const app = buildApp();
  const a1 = await token(app, A, 'a1@example.test');
  const cred = await deviceFor(app, a1, A, 'a1@example.test');
  for (const role of ['cashier', 'waiter']) {
    const userId = (await withTenant(A, (c) => c.query('SELECT id FROM app_user WHERE name = $1', [`School 1 Canteen ${role}`]))).rows[0].id;
    const s = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: '482913' } });
    assert.equal(s.statusCode, 200);
    const t = s.json().token as string;
    assert.equal((await app.inject({ method: 'GET', url: '/settings', headers: bearer(t) })).statusCode, 403, role);
    assert.equal((await app.inject({ method: 'PUT', url: '/settings', headers: bearer(t), payload: DEFAULT_SETTINGS })).statusCode, 403, role);
  }
});
