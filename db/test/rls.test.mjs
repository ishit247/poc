// Tenant isolation, against real Postgres, connected as the app role (pos_app).
// Tables are discovered from the catalog, so a new tenant table without RLS fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const appUrl = process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos';
const pool = new pg.Pool({ connectionString: appUrl });
test.after(() => pool.end());

/** Run fn in a transaction stamped with tenantId (or unstamped when null). Always rolls back. */
async function as(tenantId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

async function tenantTables() {
  const r = await pool.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migration'`);
  return r.rows;
}

test('app role cannot bypass RLS', async () => {
  const r = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false });
});

test('every table has RLS enabled and forced', async () => {
  for (const t of await tenantTables()) {
    assert.ok(t.relrowsecurity && t.relforcerowsecurity, `${t.relname}: RLS not enabled+forced`);
  }
});

test('unstamped connection sees nothing', async () => {
  for (const t of await tenantTables()) {
    const n = await as(null, (c) => c.query(`SELECT count(*)::int n FROM ${t.relname}`));
    assert.equal(n.rows[0].n, 0, `${t.relname}: rows visible without a tenant stamp`);
  }
});

test('tenant A cannot read or modify tenant B rows, on every table', async () => {
  for (const t of await tenantTables()) {
    const col = t.relname === 'tenant' ? 'id' : 'tenant_id';
    // The seed must give B data in every table, or the test below is vacuous.
    const bRows = await as(B, (c) => c.query(`SELECT count(*)::int n FROM ${t.relname}`));
    assert.ok(bRows.rows[0].n > 0, `${t.relname}: seed has no tenant B rows`);

    await as(A, async (c) => {
      const seen = await c.query(`SELECT count(*)::int n FROM ${t.relname} WHERE ${col} = $1`, [B]);
      assert.equal(seen.rows[0].n, 0, `${t.relname}: A can read B`);
      // Only attempt writes the app role is privileged to make; the rest are covered by the privilege tests.
      const priv = async (p) => (await c.query('SELECT has_table_privilege(current_user, $1, $2) ok', [t.relname, p])).rows[0].ok;
      if (await priv('DELETE')) {
        const del = await c.query(`DELETE FROM ${t.relname} WHERE ${col} = $1`, [B]);
        assert.equal(del.rowCount, 0, `${t.relname}: A can delete B`);
      }
      if (await priv('UPDATE')) {
        const upd = await c.query(`UPDATE ${t.relname} SET ${col} = ${col} WHERE ${col} = $1`, [B]);
        assert.equal(upd.rowCount, 0, `${t.relname}: A can update B`);
      }
    });
  }
});

test('versioned tables are soft-delete only; the version counter is not writable by the app role', async () => {
  for (const t of ['category', 'item', 'item_price', 'outlet_item']) {
    await as(A, async (c) => {
      await assert.rejects(c.query(`DELETE FROM ${t}`), /permission denied/, `${t}: app role can hard-delete`);
    });
  }
  for (const stmt of [
    'UPDATE tenant_version SET v = 0',
    'DELETE FROM tenant_version',
    `INSERT INTO tenant_version (tenant_id, v) VALUES ('${A}', 0)`,
  ]) {
    await as(A, async (c) => {
      await assert.rejects(c.query(stmt), /permission denied/, stmt);
    });
  }
});

test('version is assigned by the database, strictly increasing, and cannot be chosen by the client', async () => {
  await as(A, async (c) => {
    const first = (await c.query(
      "INSERT INTO category (tenant_id, name, version) VALUES ($1, 'v-test-1', 999999) RETURNING version::int v", [A])).rows[0].v;
    const second = (await c.query(
      "INSERT INTO category (tenant_id, name) VALUES ($1, 'v-test-2') RETURNING version::int v", [A])).rows[0].v;
    assert.notEqual(first, 999999, 'client-chosen version was accepted');
    assert.equal(second, first + 1);
    const upd = (await c.query("UPDATE category SET name = 'v-test-1b', version = 5 WHERE name = 'v-test-1' RETURNING version::int v")).rows[0].v;
    assert.equal(upd, second + 1);
    await assert.rejects(
      c.query(`UPDATE category SET tenant_id = '${B}' WHERE name = 'v-test-2'`), /row-level security|immutable/);
  });
});

test('tenant A cannot insert rows stamped for tenant B', async () => {
  await assert.rejects(
    as(A, (c) => c.query("INSERT INTO outlet (tenant_id, name) VALUES ($1, 'sneaky')", [B])),
    /row-level security/);
  await assert.rejects(
    as(A, (c) => c.query("INSERT INTO audit (tenant_id, actor_kind, action, entity) VALUES ($1, 'x', 'x', 'x')", [B])),
    /row-level security/);
});

test('audit is insert/select only for the app role', async () => {
  await as(A, async (c) => {
    await c.query("INSERT INTO audit (tenant_id, actor_kind, action, entity) VALUES ($1, 'test', 'x', 'x')", [A]);
    await c.query('SAVEPOINT s1');
    await assert.rejects(c.query("UPDATE audit SET action = 'y'"), /permission denied/);
    await c.query('ROLLBACK TO s1');
    await assert.rejects(c.query('DELETE FROM audit'), /permission denied/);
  });
});
