// Online-order schema guards (0004 receipt rule, 0005), against real Postgres as the app role.
// Each test runs in a rolled-back transaction stamped with tenant A.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const A = '00000000-0000-4000-8000-00000000000a';
const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos' });
test.after(() => pool.end());

async function inTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    const base = (await c.query(
      `SELECT d.outlet_id, d.id AS device_id, (SELECT id FROM app_user WHERE role = 'cashier' AND id IN (SELECT user_id FROM user_outlet WHERE outlet_id = d.outlet_id) LIMIT 1) AS user_id
         FROM device d ORDER BY d.enrolled_at LIMIT 1`)).rows[0];
    return await fn(c, base);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const newSale = (c, b, { channel = 'zomato', status = 'open', receipt = null } = {}) => c.query(
  `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, channel, status, receipt_no, receipt_seq, menu_version,
                     subtotal_paise, tax_paise, total_paise, created_at_device)
   VALUES (gen_random_uuid(), $1, $2, '2026-02-01', $3, $4, $5, $6, $7, $8, 1, 1000, 50, 1050, now()) RETURNING id`,
  [A, b.outlet_id, b.device_id, b.user_id, channel, status, receipt, receipt ? 1 : null]).then((r) => r.rows[0].id);

const newOrder = (c, b, saleId, ext, channel = 'zomato') => c.query(
  `INSERT INTO online_order (tenant_id, outlet_id, sale_id, provider, channel, external_order_id) VALUES ($1, $2, $3, 'manual', $4, $5) RETURNING id`,
  [A, b.outlet_id, saleId, channel, ext]).then((r) => r.rows[0].id);

test('an online sale never carries a receipt number; a paid counter sale must', async () => {
  await inTx(async (c, b) => {
    await c.query('SAVEPOINT s');
    await assert.rejects(newSale(c, b, { channel: 'swiggy', receipt: 'X-1' }), /sale_check|check constraint/);
    await c.query('ROLLBACK TO s');
    await assert.rejects(newSale(c, b, { channel: 'counter', status: 'paid' }), /check constraint/, 'paid counter sale without receipt');
    await c.query('ROLLBACK TO s');
    assert.ok(await newSale(c, b, { channel: 'swiggy' }));
  });
});

test('an order id is unique per platform and tenant, but may repeat across platforms', async () => {
  await inTx(async (c, b) => {
    await newOrder(c, b, await newSale(c, b), 'DUP-1', 'zomato');
    await newOrder(c, b, await newSale(c, b, { channel: 'swiggy' }), 'DUP-1', 'swiggy');
    await c.query('SAVEPOINT s');
    await assert.rejects(newOrder(c, b, await newSale(c, b), 'DUP-1', 'zomato'), /unique|duplicate/);
  });
});

test('the lifecycle only moves forward; terminal states are final; a rejection needs a reason', async () => {
  await inTx(async (c, b) => {
    const id = await newOrder(c, b, await newSale(c, b), 'LIFE-1');
    const move = async (to, extra = '') => {
      await c.query('SAVEPOINT m');
      try { await c.query(`UPDATE online_order SET status = $2 ${extra} WHERE id = $1`, [id, to]); } catch (e) { await c.query('ROLLBACK TO m'); throw e; }
    };
    await assert.rejects(move('ready'), /cannot go from received to ready/);
    await assert.rejects(move('handed_over'), /cannot go from received to handed_over/);
    await assert.rejects(move('rejected'), /check constraint/, 'rejection without a reason');
    await move('accepted');
    await assert.rejects(move('received'), /cannot go from accepted to received/);
    await move('ready');
    await move('handed_over');
    await assert.rejects(move('cancelled', ", reason = 'late'"), /cannot go from handed_over/);
    await assert.rejects(move('accepted'), /cannot go from handed_over/);
  });
});

test('an order cannot be re-pointed at another sale, platform or id', async () => {
  await inTx(async (c, b) => {
    const id = await newOrder(c, b, await newSale(c, b), 'IDENT-1');
    await c.query('SAVEPOINT s');
    await assert.rejects(c.query(`UPDATE online_order SET external_order_id = 'IDENT-2' WHERE id = $1`, [id]), /identity is immutable/);
    await c.query('ROLLBACK TO s');
    await assert.rejects(c.query(`UPDATE online_order SET channel = 'swiggy' WHERE id = $1`, [id]), /identity is immutable/);
  });
});

test('events, settlement imports and lines are append-only; orders and outbox cannot be deleted', async () => {
  await inTx(async (c) => {
    const denied = async (sql) => { await c.query('SAVEPOINT p'); await assert.rejects(c.query(sql), /permission denied/, sql); await c.query('ROLLBACK TO p'); };
    await denied('UPDATE online_order_event SET to_status = to_status');
    await denied('DELETE FROM online_order_event');
    await denied('UPDATE settlement_import SET filename = filename');
    await denied('DELETE FROM settlement_import');
    await denied('UPDATE settlement_line SET result = result');
    await denied('DELETE FROM settlement_line');
    await denied('DELETE FROM online_order');
    await denied('DELETE FROM integration_outbox');
  });
});

test('one outbox message per order and action', async () => {
  await inTx(async (c, b) => {
    const id = await newOrder(c, b, await newSale(c, b), 'OUT-1');
    const put = () => c.query(
      `INSERT INTO integration_outbox (tenant_id, outlet_id, online_order_id, provider, action, dedupe_key) VALUES ($1, $2, $3, 'manual', 'accept', $4)`,
      [A, b.outlet_id, id, `${id}:accept`]);
    await put();
    await assert.rejects(put(), /unique|duplicate/);
  });
});
