// The platform console's database walls, against real Postgres. Two roles are exercised:
//   pos_app      (tenant API): must have no right at all on platform_* tables.
//   app_platform (console)   : holds only what migration 0007 grants; sees tenants, never sales.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos' });
const platPool = new pg.Pool({ connectionString: process.env.PLATFORM_DATABASE_URL ?? 'postgres://app_platform:app_platform@localhost:55432/pos' });
test.after(() => Promise.all([appPool.end(), platPool.end()]));

const PLATFORM_TABLES = ['platform_admin', 'platform_session', 'platform_audit'];

async function rolledBack(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Every public table, discovered from the catalog so a new table is judged without editing this test. */
async function allTables() {
  const r = await platPool.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migration'`);
  return r.rows.map((x) => x.relname);
}

test('the console role cannot bypass RLS and is not the tenant role', async () => {
  const r = await platPool.query("SELECT current_user u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  assert.deepEqual(r.rows[0], { u: 'app_platform', rolsuper: false, rolbypassrls: false });
});

test('the tenant API role has no right of any kind on platform tables', async () => {
  for (const t of PLATFORM_TABLES) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) {
      const r = await appPool.query('SELECT has_table_privilege(current_user, $1, $2) ok', [t, p]);
      assert.equal(r.rows[0].ok, false, `pos_app has ${p} on ${t}`);
    }
    await assert.rejects(appPool.query(`SELECT 1 FROM ${t}`), /permission denied/);
  }
});

test('the console role holds exactly the granted rights, on every table', async () => {
  const allowed = {
    platform_admin: ['SELECT', 'INSERT', 'UPDATE'],
    platform_session: ['SELECT', 'INSERT', 'UPDATE'],
    platform_audit: ['SELECT', 'INSERT'],
    tenant: ['SELECT', 'INSERT', 'UPDATE'],
    outlet: ['SELECT'],
    device: ['SELECT'],
  };
  for (const t of await allTables()) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const r = await platPool.query('SELECT has_table_privilege(current_user, $1, $2) ok', [t, p]);
      assert.equal(r.rows[0].ok, (allowed[t] ?? []).includes(p), `app_platform ${p} on ${t}`);
    }
  }
});

test('the console sees every tenant, outlet and device, but no sales or credentials', async () => {
  const tenants = await platPool.query('SELECT id FROM tenant WHERE id = ANY($1)', [[A, B]]);
  assert.equal(tenants.rowCount, 2);
  assert.ok((await platPool.query('SELECT count(*)::int n FROM outlet')).rows[0].n >= 2);
  assert.ok((await platPool.query('SELECT count(*)::int n FROM device')).rows[0].n >= 2);
  for (const t of ['sale', 'payment', 'app_user', 'session', 'audit', 'sync_event']) {
    await assert.rejects(platPool.query(`SELECT 1 FROM ${t}`), /permission denied/, `${t} readable by the console`);
  }
});

test('the console role cannot edit outlets or devices, or delete tenants', async () => {
  await rolledBack(platPool, async (c) => {
    for (const stmt of ['UPDATE outlet SET name = name', 'DELETE FROM device', 'DELETE FROM tenant', 'TRUNCATE tenant']) {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(stmt), /permission denied/, stmt);
      await c.query('ROLLBACK TO s');
    }
  });
});

test('the platform widening is not available to the tenant role', async () => {
  // Unstamped, pos_app sees no tenant, outlet or device row even though policies exist for app_platform.
  for (const t of ['tenant', 'outlet', 'device']) {
    const r = await appPool.query(`SELECT count(*)::int n FROM ${t}`);
    assert.equal(r.rows[0].n, 0, `${t}: pos_app sees rows with no tenant stamp`);
  }
  await assert.rejects(
    rolledBack(appPool, (c) => c.query("INSERT INTO tenant (name, subdomain) VALUES ('x', 'sneaky-x')")),
    /row-level security/);
});

test('a console can suspend a tenant; the audit trail cannot be edited or deleted', async () => {
  await rolledBack(platPool, async (c) => {
    const up = await c.query('UPDATE tenant SET suspended_at = now() WHERE id = $1', [A]);
    assert.equal(up.rowCount, 1);
    const adm = await c.query(
      "INSERT INTO platform_admin (email, name, role, password_hash, totp_secret) VALUES ('t@example.test', 'T', 'owner', 'x', 'JBSWY3DPEHPK3PXP') RETURNING id");
    await c.query("INSERT INTO platform_audit (admin_id, action, tenant_id, entity) VALUES ($1, 'tenant.suspend', $2, 'tenant')", [adm.rows[0].id, A]);
    for (const stmt of ['UPDATE platform_audit SET action = $$x$$', 'DELETE FROM platform_audit', 'TRUNCATE platform_audit']) {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(stmt), /permission denied/, stmt);
      await c.query('ROLLBACK TO s');
    }
  });
});

test('support and owner are the only console roles; email is unique ignoring case', async () => {
  await rolledBack(platPool, async (c) => {
    const ins = (email, role) => c.query(
      'INSERT INTO platform_admin (email, name, role, password_hash, totp_secret) VALUES ($1, $$n$$, $2, $$x$$, $$s$$)', [email, role]);
    await ins('Dup@example.test', 'owner');
    await c.query('SAVEPOINT s1');
    await assert.rejects(ins('dup@EXAMPLE.test', 'owner'), /duplicate key/);
    await c.query('ROLLBACK TO s1');
    await assert.rejects(ins('other@example.test', 'god'), /check constraint/);
  });
});

test('health functions: the tenant API role cannot call them, the console role can and is left unstamped', async () => {
  for (const f of ['platform.tenant_health(ARRAY[]::uuid[], 24, 24)', "platform.tenant_usage(ARRAY[]::uuid[], '2026-01-01')"]) {
    await assert.rejects(appPool.query(`SELECT * FROM ${f}`), /permission denied/, `pos_app calls ${f}`);
  }
  // The function itself is closed to everyone but the console role, independent of schema access.
  for (const f of ['platform.tenant_health(uuid[], int, int)', 'platform.tenant_usage(uuid[], date)']) {
    // Asked from the console connection: pos_app cannot even resolve the schema, so it cannot ask for itself.
    const r = await platPool.query('SELECT has_function_privilege($3::name, $1, $2) ok', [f, 'EXECUTE', 'pos_app']);
    assert.equal(r.rows[0].ok, false, `pos_app may execute ${f}`);
    const p = await platPool.query('SELECT has_function_privilege(current_user, $1, $2) ok', [f, 'EXECUTE']);
    assert.equal(p.rows[0].ok, true, `app_platform may not execute ${f}`);
  }
  await rolledBack(platPool, async (c) => {
    const h = await c.query('SELECT * FROM platform.tenant_health(ARRAY[$1, $2]::uuid[], 24, 24)', [A, B]);
    assert.equal(h.rowCount, 2);
    // Counts, timestamps and version labels only: no column that could carry a customer's or a cashier's text.
    assert.deepEqual(h.fields.map((f) => f.name).sort(), [
      'app_versions', 'device_outbox_events', 'devices', 'devices_stale', 'devices_unsynced', 'integrations_enabled',
      'integrations_quiet', 'last_device_seen', 'last_sync_at', 'online_outbox_failed', 'online_outbox_oldest_pending',
      'online_outbox_pending', 'outlets', 'sync_applied_24h', 'sync_rejected_24h', 'tenant_id', 'webhook_rejected_24h']);
    const stamp = await c.query("SELECT coalesce(current_setting('app.tenant_id', true), '') s");
    assert.equal(stamp.rows[0].s, '', 'the function left a tenant stamp on the console connection');
    const u = await c.query("SELECT * FROM platform.tenant_usage(ARRAY[$1]::uuid[], '2026-01-01')", [A]);
    assert.ok(u.rowCount >= 1);
    const stamp2 = await c.query("SELECT coalesce(current_setting('app.tenant_id', true), '') s");
    assert.equal(stamp2.rows[0].s, '');
    // Still no direct route to the rows behind the counts.
    await assert.rejects(c.query('SELECT 1 FROM sync_event'), /permission denied/);
  });
});
