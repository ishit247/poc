// Platform console health and usage: counts only, correct per tenant, and the warnings derived from them.
// Real Postgres. Tests change a seeded device or two and put them back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { platformPool, pool, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';
import { healthWarnings, type HealthRow } from '../src/platformHealth.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PW = 'dev-password-123';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => Promise.all([pool.end(), platformPool.end()]));

type App = ReturnType<typeof buildApp>;
async function signIn(app: App, email = 'support@platform.test'): Promise<string> {
  await platformPool.query('UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL WHERE email = $1', [email]);
  const r = await app.inject({ method: 'POST', url: '/platform/login', payload: { email, password: PW, code: totpCode(SECRET, totpStep(Date.now())) } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
const get = (app: App, url: string, t: string) => app.inject({ method: 'GET', url, headers: { authorization: `Platform ${t}` } });
type Row = HealthRow & { id: string; devices: number; outlets: number; deviceOutboxEvents: number; integrationsEnabled: number; warnings: { code: string }[] };
const healthOf = async (app: App, t: string, qs = '') => {
  const r = await get(app, `/platform/health${qs}`, t);
  assert.equal(r.statusCode, 200);
  const rows = r.json() as Row[];
  return (id: string) => rows.find((x) => x.id === id)!;
};
const one = async (tenant: string, sql: string, args: unknown[] = []) => withTenant(tenant, async (c) => (await c.query(sql, args)).rows);

test('health: per-tenant counts agree with what each tenant holds, and tenants do not mix', async () => {
  const app = buildApp();
  const t = await signIn(app);
  const of = await healthOf(app, t);
  for (const id of [A, B]) {
    const direct = (await one(id, `SELECT (SELECT count(*)::int FROM outlet) o, (SELECT count(*)::int FROM device WHERE revoked_at IS NULL) d,
      (SELECT count(*)::int FROM outlet_integration WHERE enabled) i`))[0];
    const row = of(id);
    assert.equal(row.outlets, direct.o, 'outlets');
    assert.equal(row.devices, direct.d, 'devices');
    assert.equal(row.integrationsEnabled, direct.i, 'integrations');
  }
  assert.notEqual(of(A).devices, of(B).devices, 'the seed gives the tenants different sizes, or this proves nothing');
  // No row-level detail leaks: only the documented fields come back.
  const keys = Object.keys(of(A)).sort();
  for (const forbidden of ['payload', 'name_snapshot', 'receipt_no', 'webhook_secret', 'credential_hash', 'raw_payload']) {
    assert.ok(!keys.includes(forbidden), forbidden);
  }
});

test('health reflects unsynced tablets, rejected sync events and version skew, per tenant', async () => {
  const app = buildApp();
  const t = await signIn(app);
  const before = await healthOf(app, t);
  const devices = await one(A, 'SELECT id, app_version, outbox_pending FROM device WHERE revoked_at IS NULL ORDER BY id LIMIT 2');
  assert.equal(devices.length, 2);
  try {
    await one(A, 'UPDATE device SET outbox_pending = 7, app_version = $2 WHERE id = $1', [devices[0].id, '1.0.0']);
    await one(A, 'UPDATE device SET app_version = $2 WHERE id = $1', [devices[1].id, '1.1.0']);
    await one(A, `INSERT INTO sync_event (tenant_id, id, device_id, seq, type, created_at_device, outcome, reason, payload)
                  VALUES ($1, $2, $3, $4, 'sale', now(), 'rejected', 'test', '{}')`, [A, randomUUID(), devices[0].id, 900_000 + Math.floor(Math.random() * 90_000)]);
    const after = await healthOf(app, t);
    const a0 = before(A), a1 = after(A);
    assert.equal(a1.devicesUnsynced, a0.devicesUnsynced + (devices[0].outbox_pending > 0 ? 0 : 1));
    assert.equal(a1.deviceOutboxEvents, a0.deviceOutboxEvents - (devices[0].outbox_pending ?? 0) + 7);
    assert.equal(a1.syncRejected24h, a0.syncRejected24h + 1);
    const codes = a1.warnings.map((w) => w.code);
    assert.ok(codes.includes('sync-rejected') && codes.includes('device-unsynced') && codes.includes('version-skew'), codes.join());
    // Tenant B is untouched by tenant A's trouble.
    assert.equal(after(B).syncRejected24h, before(B).syncRejected24h);
    assert.equal(after(B).deviceOutboxEvents, before(B).deviceOutboxEvents);
  } finally {
    for (const d of devices) await one(A, 'UPDATE device SET outbox_pending = $2, app_version = $3 WHERE id = $1', [d.id, d.outbox_pending, d.app_version]);
  }
});

test('the stale and quiet windows are the caller\'s to choose, and are validated', async () => {
  const app = buildApp();
  const t = await signIn(app);
  const normal = await healthOf(app, t);
  assert.equal(normal(A).devicesStale, 0, 'freshly seeded devices are not stale in 24 h');
  assert.equal(normal(A).integrationsQuiet, 0);
  const zero = await healthOf(app, t, '?staleHours=0&quietHours=0');
  assert.equal(zero(A).devicesStale, zero(A).devices, 'a zero-hour window makes every device stale');
  assert.ok(zero(A).integrationsEnabled > 0 && zero(A).integrationsQuiet === zero(A).integrationsEnabled);
  assert.ok(zero(A).warnings.some((w) => w.code === 'device-stale'));
  for (const qs of ['?staleHours=-1', '?staleHours=9999', '?quietHours=abc', '?staleHours=1.5']) {
    assert.equal((await get(app, `/platform/health${qs}`, t)).statusCode, 400, qs);
  }
});

test('usage matches each tenant\'s own paid sales by month; dates are validated', async () => {
  const app = buildApp();
  const t = await signIn(app);
  const r = await get(app, '/platform/usage?since=2026-01-15', t);
  assert.equal(r.statusCode, 200);
  const rows = r.json() as { tenantId: string; month: string; sales: number; onlineOrders: number; activeDevices: number; activeOutlets: number }[];
  for (const id of [A, B]) {
    const direct = (await one(id, `SELECT count(*)::int n, count(DISTINCT outlet_id)::int o FROM sale
                                    WHERE status IN ('paid','refunded') AND business_date >= '2026-01-01' AND business_date < '2026-02-01'`))[0];
    const row = rows.find((x) => x.tenantId === id && x.month === '2026-01')!;
    assert.ok(row, 'January row');
    assert.equal(row.sales, direct.n);
    assert.equal(row.activeOutlets, direct.o);
  }
  const later = (await get(app, '/platform/usage?since=2026-02-01', t)).json() as { month: string }[];
  assert.ok(later.every((x) => x.month >= '2026-02'), 'months before `since` are left out');
  assert.ok(rows.every((x) => 'sales' in x && !('totalPaise' in x)), 'counts only, no money');
  for (const qs of ['?since=2026-13-45', '?since=yesterday', '?since=2026-1-1']) {
    assert.equal((await get(app, `/platform/usage${qs}`, t)).statusCode, 400, qs);
  }
  assert.equal((await get(app, '/platform/usage', t)).statusCode, 200, 'default window');
});

test('health and usage need a console session', async () => {
  const app = buildApp();
  for (const url of ['/platform/health', '/platform/usage']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
    const mgr = await app.inject({ method: 'POST', url: '/login', payload: { email: 'a1@example.test', password: PW }, headers: { host: 'tenant-a.localhost' } });
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${mgr.json().token}` } })).statusCode, 401, `${url} with a tenant token`);
  }
});

test('warning rules', () => {
  const calm: HealthRow = { devicesStale: 0, devicesUnsynced: 0, syncRejected24h: 0, onlineOutboxFailed: 0, onlineOutboxPending: 0, integrationsQuiet: 0, webhookRejected24h: 0, appVersions: { '1.0.0': 3, unknown: 1 } };
  assert.deepEqual(healthWarnings(calm, 24, 24), []);
  const codes = (h: Partial<HealthRow>) => healthWarnings({ ...calm, ...h }, 24, 24).map((w) => w.code);
  assert.deepEqual(codes({ devicesStale: 1 }), ['device-stale']);
  assert.deepEqual(codes({ devicesUnsynced: 2 }), ['device-unsynced']);
  assert.deepEqual(codes({ syncRejected24h: 1 }), ['sync-rejected']);
  assert.deepEqual(codes({ onlineOutboxFailed: 1 }), ['outbox-failed']);
  assert.deepEqual(codes({ onlineOutboxPending: 1 }), ['outbox-backlog']);
  assert.deepEqual(codes({ integrationsQuiet: 1 }), ['integration-quiet']);
  assert.deepEqual(codes({ webhookRejected24h: 1 }), ['webhook-rejected']);
  assert.deepEqual(codes({ appVersions: { '1.0.0': 1, '1.1.0': 1 } }), ['version-skew']);
  assert.deepEqual(codes({ appVersions: { '1.0.0': 1, unknown: 5 } }), [], '"unknown" is not a second version');
  assert.equal(healthWarnings({ ...calm, syncRejected24h: 1 }, 24, 24)[0]!.severity, 'alert');
});
