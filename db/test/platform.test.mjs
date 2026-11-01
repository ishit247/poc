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
