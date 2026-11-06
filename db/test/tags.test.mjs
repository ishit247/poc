// Diet and tags (PLAN D17, phase 12 step 2b), against real Postgres as the app role.
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
const newItem = async (c, tenant = A) => {
  const cat = (await c.query('INSERT INTO category (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant, 'Tag cat'])).rows[0].id;
  return (await c.query('INSERT INTO item (tenant_id, category_id, name) VALUES ($1, $2, $3) RETURNING id', [tenant, cat, 'Tag item'])).rows[0].id;
};
const newTag = (c, name, tenant = A) => c.query('INSERT INTO tag (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant, name]).then((r) => r.rows[0].id);

test('diet accepts veg, egg, non_veg and unset, and nothing else', async () => {
  await inTx(async (c) => {
    const item = await newItem(c);
    for (const d of ['veg', 'egg', 'non_veg', null]) {
      await c.query('UPDATE item SET diet = $2 WHERE id = $1', [item, d]);
      assert.equal((await c.query('SELECT diet FROM item WHERE id = $1', [item])).rows[0].diet, d);
    }
    await fails(c, "UPDATE item SET diet = 'vegan' WHERE id = $1", [item], /check/);
    await fails(c, "UPDATE item SET diet = 'Veg' WHERE id = $1", [item], /check/);
  });
});

test('tag names are unique per tenant (any case) among live tags, a removed name is free, both tenants may share a name', async () => {
  await inTx(async (c) => {
    const t = await newTag(c, 'Spicy');
    await fails(c, "INSERT INTO tag (tenant_id, name) VALUES ($1, 'spicy')", [A], /tag_name_live_uq/);
    await c.query('UPDATE tag SET deleted_at = now() WHERE id = $1', [t]);
    await newTag(c, 'spicy');
    await fails(c, "INSERT INTO tag (tenant_id, name) VALUES ($1, '')", [A], /check/);
    await fails(c, "INSERT INTO tag (tenant_id, name) VALUES ($1, ' padded ')", [A], /check/);
  });
  await inTx(async (c) => { await newTag(c, 'Jain-only', A); }, A);
  await inTx(async (c) => { await newTag(c, 'Jain-only', B); }, B);
});

test('an item has a tag once while the link is live; a tenant cannot tag across tenants', async () => {
  await inTx(async (c) => {
    const item = await newItem(c);
    const tag = await newTag(c, 'South Indian');
    await c.query('INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [A, item, tag]);
    await fails(c, 'INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [A, item, tag], /item_tag_live_uq/);
    await c.query('UPDATE item_tag SET deleted_at = now() WHERE item_id = $1', [item]);
    await c.query('INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [A, item, tag]); // re-tagging is fine
  });
  // Tenant B's session cannot link its own tag to tenant A's item (RLS hides the item; the composite key refuses it).
  const aItem = await inTx((c) => c.query("SELECT id FROM item LIMIT 1").then((r) => r.rows[0].id), A);
  // Tenant B's own item, tenant A's tag: only the composite (tenant_id, tag_id) key can refuse this (foreign-key checks skip RLS).
  const tagA = await inTx((c) => c.query('SELECT id FROM tag LIMIT 1').then((r) => r.rows[0]?.id), A);
  assert.ok(tagA, 'tenant A has a seeded tag');
  await inTx(async (c) => {
    const bItem = await newItem(c, B);
    await fails(c, 'INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [B, bItem, tagA], /foreign key/);
  }, B);
  await inTx(async (c) => {
    const tag = await newTag(c, 'B tag', B);
    await fails(c, 'INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [B, aItem, tag], /foreign key|row-level/);
    await fails(c, 'INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [A, aItem, tag], /row-level/);
  }, B);
});

test('tags and links are versioned (stamped, never deleted) and tenant-isolated', async () => {
  await inTx(async (c) => {
    const item = await newItem(c);
    const tag = await newTag(c, 'Versioned');
    const v1 = Number((await c.query('SELECT version FROM tag WHERE id = $1', [tag])).rows[0].version);
    await c.query("UPDATE tag SET name = 'Versioned 2' WHERE id = $1", [tag]);
    assert.ok(Number((await c.query('SELECT version FROM tag WHERE id = $1', [tag])).rows[0].version) > v1);
    await c.query('INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [A, item, tag]);
    assert.ok(Number((await c.query('SELECT version FROM item_tag WHERE item_id = $1', [item])).rows[0].version) > 0);
    await fails(c, 'DELETE FROM tag WHERE id = $1', [tag], /permission denied/);
    await fails(c, 'DELETE FROM item_tag WHERE item_id = $1', [item], /permission denied/);
  });
  const seen = await inTx(async (c) => (await c.query('SELECT count(*)::int AS n FROM tag')).rows[0].n, B);
  const mine = await inTx(async (c) => (await c.query('SELECT count(*)::int AS n FROM tag WHERE tenant_id <> $1', [B])).rows[0].n, B);
  assert.ok(seen >= 0);
  assert.equal(mine, 0, 'tenant B sees no tag of another tenant');
});
