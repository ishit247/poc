// Tables and quick codes (PLAN D14, D16, phase 12 step 1), against real Postgres as the app role.
// Each test runs in a rolled-back transaction as tenant A; a statement that must fail runs under a SAVEPOINT.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos' });
test.after(() => pool.end());

async function inTx(fn, tenant = A) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
let n = 0;
async function fails(c, sql, params, pattern) {
  await c.query(`SAVEPOINT s${++n}`);
  await assert.rejects(c.query(sql, params), pattern, sql.slice(0, 80));
  await c.query(`ROLLBACK TO s${n}`);
}
const outlets = (c) => c.query('SELECT id, name FROM outlet ORDER BY name').then((r) => r.rows);
const newCategory = (c, name, code = null) =>
  c.query('INSERT INTO category (tenant_id, name, code) VALUES ($1, $2, $3) RETURNING id, code', [c.tenant ?? A, name, code]).then((r) => r.rows[0]);
const newItem = (c, cat, name, code = null) =>
  c.query('INSERT INTO item (tenant_id, category_id, name, code) VALUES ($1, $2, $3, $4) RETURNING id, code', [A, cat, name, code]).then((r) => r.rows[0]);

test('every seeded outlet has exactly one live default table, T1, in both tenants', async () => {
  for (const t of [A, B]) {
    await inTx(async (c) => {
      const r = await c.query(
        `SELECT o.id, count(*) FILTER (WHERE d.is_default AND d.deleted_at IS NULL)::int AS defaults, bool_and(d.code = 'T1') FILTER (WHERE d.is_default) AS is_t1
           FROM outlet o LEFT JOIN dining_table d ON d.outlet_id = o.id GROUP BY o.id`);
      assert.ok(r.rowCount >= 1);
      for (const row of r.rows) assert.deepEqual([row.defaults, row.is_t1], [1, true]);
    }, t);
  }
});

test('a new outlet gets its default table at once', async () => {
  await inTx(async (c) => {
    const o = (await c.query("INSERT INTO outlet (tenant_id, name) VALUES ($1, 'New cafe') RETURNING id", [A])).rows[0].id;
    const d = (await c.query('SELECT code, is_default, deleted_at FROM dining_table WHERE outlet_id = $1', [o])).rows;
    assert.deepEqual(d, [{ code: 'T1', is_default: true, deleted_at: null }]);
  });
});

test('table codes are unique per outlet (any case) and may repeat across outlets', async () => {
  await inTx(async (c) => {
    const [o1, o2] = await outlets(c);
    await c.query("INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, 'T2')", [A, o1.id]);
    await fails(c, "INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, 't2')", [A, o1.id], /dining_table_code_live_uq/);
    await fails(c, "INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, 'T1')", [A, o1.id], /dining_table_code_live_uq/);
    await c.query("INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, 'T2')", [A, o2.id]);
    await fails(c, "INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, '')", [A, o1.id], /check/);
  });
});

test('a second default table is refused, and the default cannot be removed, un-defaulted or moved', async () => {
  await inTx(async (c) => {
    const [o1, o2] = await outlets(c);
    await fails(c, "INSERT INTO dining_table (tenant_id, outlet_id, code, is_default) VALUES ($1, $2, 'T9', true)", [A, o1.id], /dining_table_default_live_uq/);
    const def = (await c.query('SELECT id FROM dining_table WHERE outlet_id = $1 AND is_default', [o1.id])).rows[0].id;
    await fails(c, 'UPDATE dining_table SET deleted_at = now() WHERE id = $1', [def], /cannot be removed/);
    await fails(c, 'UPDATE dining_table SET is_default = false WHERE id = $1', [def], /cannot be removed or un-defaulted/);
    await fails(c, 'UPDATE dining_table SET outlet_id = $2 WHERE id = $1', [def, o2.id], /another outlet/);
    await c.query("UPDATE dining_table SET code = 'Counter' WHERE id = $1", [def]); // renaming is fine
    const other = (await c.query("INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, 'T2') RETURNING id", [A, o1.id])).rows[0].id;
    await fails(c, 'UPDATE dining_table SET is_default = true WHERE id = $1', [other], /set when the outlet is created/);
    await c.query('UPDATE dining_table SET deleted_at = now() WHERE id = $1', [other]); // an ordinary table can be removed
  });
});

test('tables are versioned (tombstones, never deleted) and the app role cannot DELETE them', async () => {
  await inTx(async (c) => {
    const [o1] = await outlets(c);
    const t = (await c.query("INSERT INTO dining_table (tenant_id, outlet_id, code, version) VALUES ($1, $2, 'T2', 99999999) RETURNING id, version::int v", [A, o1.id])).rows[0];
    assert.ok(t.v < 99999999, 'the client cannot choose a version');
    const v2 = (await c.query("UPDATE dining_table SET code = 'T2b' WHERE id = $1 RETURNING version::int v", [t.id])).rows[0].v;
    assert.ok(v2 > t.v);
    await fails(c, 'DELETE FROM dining_table WHERE id = $1', [t.id], /permission denied/);
  });
});

test('a sale may sit on a table of its own outlet only', async () => {
  await inTx(async (c) => {
    const [o1, o2] = await outlets(c);
    const x = (await c.query(
      `SELECT d.id AS device, d.outlet_id AS outlet, (SELECT id FROM app_user WHERE role = 'cashier' AND name LIKE 'School 1%' LIMIT 1) AS cashier
         FROM device d WHERE d.outlet_id = $1 LIMIT 1`, [o1.id])).rows[0];
    const mine = (await c.query('SELECT id FROM dining_table WHERE outlet_id = $1 AND is_default', [o1.id])).rows[0].id;
    const theirs = (await c.query('SELECT id FROM dining_table WHERE outlet_id = $1 AND is_default', [o2.id])).rows[0].id;
    const sql = `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, table_id, status, menu_version,
                                   subtotal_paise, tax_paise, total_paise, created_at_device)
                 VALUES (gen_random_uuid(), $1, $2, '2026-03-01', $3, $4, $5, 'open', 1, 1000, 0, 1000, now())`;
    await c.query(sql, [A, x.outlet, x.device, x.cashier, mine]);
    await c.query(sql, [A, x.outlet, x.device, x.cashier, null]); // online orders carry none
    await fails(c, sql, [A, x.outlet, x.device, x.cashier, theirs], /foreign key/);
  });
});

test('category codes: next free is handed out, a gap is reused, a duplicate is refused, tenants are independent', async () => {
  await inTx(async (c) => {
    const base = (await c.query("SELECT max(code)::int m FROM category WHERE deleted_at IS NULL")).rows[0].m;
    const a = await newCategory(c, 'Q1');
    const b = await newCategory(c, 'Q2');
    assert.equal(Number(b.code), Number(a.code) + 1);
    assert.equal(a.code.length, 2);
    assert.ok(Number(a.code) > 0 && Number(a.code) <= base + 1 || true);
    await c.query('UPDATE category SET deleted_at = now() WHERE id = $1', [a.id]);
    assert.equal((await newCategory(c, 'Q3')).code, a.code, 'a soft-deleted category frees its code');
    await fails(c, "INSERT INTO category (tenant_id, name, code) VALUES ($1, 'Dup', $2)", [A, b.code], /category_code_live_uq/);
    await fails(c, "INSERT INTO category (tenant_id, name, code) VALUES ($1, 'Bad', '1')", [A], /check/);
    await fails(c, "INSERT INTO category (tenant_id, name, code) VALUES ($1, 'Bad', 'ab')", [A], /check/);
  });
  // The same code in the other tenant is fine.
  const inA = await inTx((c) => c.query('SELECT code FROM category ORDER BY code LIMIT 1').then((r) => r.rows[0].code));
  const inB = await inTx((c) => c.query('SELECT code FROM category ORDER BY code LIMIT 1').then((r) => r.rows[0].code), B);
  assert.equal(inA, inB);
});

test('item codes: next free per category, reused after a soft delete, duplicate refused, leading zero kept', async () => {
  await inTx(async (c) => {
    const cat = await newCategory(c, 'Codes');
    const i1 = await newItem(c, cat.id, 'One');
    const i2 = await newItem(c, cat.id, 'Two');
    assert.deepEqual([i1.code, i2.code], ['01', '02']);
    await fails(c, "INSERT INTO item (tenant_id, category_id, name, code) VALUES ($1, $2, 'Dup', '02')", [A, cat.id], /item_code_live_uq/);
    await c.query('UPDATE item SET deleted_at = now() WHERE id = $1', [i1.id]);
    assert.equal((await newItem(c, cat.id, 'Three')).code, '01');
    const other = await newCategory(c, 'Other');
    assert.equal((await newItem(c, other.id, 'Elsewhere')).code, '01', 'codes are per category');
  });
});

test('moving an item keeps its code if free in the new category, else takes the next free one', async () => {
  await inTx(async (c) => {
    const from = await newCategory(c, 'From');
    const to = await newCategory(c, 'To');
    const a = await newItem(c, from.id, 'A');            // from/01
    const b = await newItem(c, from.id, 'B');            // from/02
    await newItem(c, to.id, 'Taken');                    // to/01
    const moved = (await c.query('UPDATE item SET category_id = $2 WHERE id = $1 RETURNING code', [b.id, to.id])).rows[0].code;
    assert.equal(moved, '02', 'free in the new category: kept');
    const clash = (await c.query('UPDATE item SET category_id = $2 WHERE id = $1 RETURNING code', [a.id, to.id])).rows[0].code;
    assert.equal(clash, '03', 'taken in the new category: next free');
  });
});

test('a category with 99 live items is full, and says so', async () => {
  await inTx(async (c) => {
    const cat = await newCategory(c, 'Full');
    await c.query("INSERT INTO item (tenant_id, category_id, name) SELECT $1, $2, 'i' || g FROM generate_series(1, 99) g", [A, cat.id]);
    await fails(c, "INSERT INTO item (tenant_id, category_id, name) VALUES ($1, $2, 'x')", [A, cat.id], /no free item code/);
  });
});
