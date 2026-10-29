// Trading invariants (PLAN section 8), against real Postgres as the app role.
// Each test runs in a rolled-back transaction as tenant A. A statement that must fail runs under a
// SAVEPOINT so the transaction survives to run the next one.
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
    const ctx = (await c.query(
      `SELECT d.id AS device, d.outlet_id AS outlet,
              (SELECT id FROM app_user WHERE role = 'cashier' AND name LIKE 'School 1%') AS cashier,
              (SELECT id FROM item LIMIT 1) AS item
         FROM device d JOIN outlet o ON o.id = d.outlet_id WHERE o.name = 'School 1 Canteen' LIMIT 1`)).rows[0];
    return await fn(c, ctx);
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
const newSale = (c, x, { status = 'open', total = 1050, seq = null, no = null, date = '2026-03-01' } = {}) =>
  c.query(
    `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                       subtotal_paise, tax_paise, total_paise, created_at_device, void_reason)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 0, $9, now(), CASE WHEN $6 = 'void' THEN 'x' END) RETURNING id`,
    [A, x.outlet, date, x.device, x.cashier, status, no, seq, total]).then((r) => r.rows[0].id);
const pay = (c, sale, amount, { method = 'cash', tendered = null, change = 0 } = {}) =>
  c.query('INSERT INTO payment (tenant_id, sale_id, method, amount_paise, tendered_paise, change_paise) VALUES ($1,$2,$3,$4,$5,$6)', [A, sale, method, amount, tendered, change]);

test('payments must sum to the total of a paid sale (invariant 3), checked at commit', async () => {
  await inTx(async (c, x) => {
    // Underpaid: refuses at COMMIT time, so force the deferred check.
    const short = await newSale(c, x, { status: 'paid', seq: 10, no: 'C1-20260301-0010' });
    await pay(c, short, 1000);
    await c.query('SAVEPOINT chk');
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), /do not equal its total/);
    await c.query('ROLLBACK TO chk');
  });
  await inTx(async (c, x) => {
    const over = await newSale(c, x, { status: 'paid', seq: 11, no: 'C1-20260301-0011' });
    await pay(c, over, 1100);
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), /do not equal its total/, 'overpaid');
  });
  await inTx(async (c, x) => {
    // Marked paid with NO payment at all: no payment row ever queues a check, so the sale's own trigger must catch it.
    const s = await newSale(c, x, { status: 'open' });
    await c.query("UPDATE sale SET status = 'paid', receipt_no = 'C1-20260301-0014', receipt_seq = 14 WHERE id = $1", [s]);
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), /do not equal its total/, 'open->paid with no payments');
  });
  await inTx(async (c, x) => {
    // A correct paid sale, then one more payment slipped in: only the payment's own trigger is queued for it.
    const s = await newSale(c, x, { status: 'paid', seq: 15, no: 'C1-20260301-0015' });
    await pay(c, s, 1050);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await pay(c, s, 100);
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), /do not equal its total/, 'extra payment on a paid sale');
  });
  await inTx(async (c, x) => {
    // Cash tendered 2000 for 1050: the payment is 1050 and the change is 950; split cash+UPI also sums.
    const ok = await newSale(c, x, { status: 'paid', seq: 12, no: 'C1-20260301-0012' });
    await pay(c, ok, 1050, { tendered: 2000, change: 950 });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('SET CONSTRAINTS ALL DEFERRED'); // the next paid insert comes before its payments
    const split = await newSale(c, x, { status: 'paid', seq: 13, no: 'C1-20260301-0013' });
    await pay(c, split, 500, { method: 'upi' });
    await pay(c, split, 550, { tendered: 600, change: 50 });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
});

test('payment rows: change only on cash, tendered = amount + change', async () => {
  await inTx(async (c, x) => {
    const s = await newSale(c, x);
    await fails(c, 'INSERT INTO payment (tenant_id, sale_id, method, amount_paise, change_paise) VALUES ($1,$2,$3,$4,$5)', [A, s, 'upi', 1050, 50], /check constraint/);
    await fails(c, 'INSERT INTO payment (tenant_id, sale_id, method, amount_paise, tendered_paise, change_paise) VALUES ($1,$2,$3,$4,$5,$6)', [A, s, 'cash', 1050, 1500, 100], /check constraint/);
    await fails(c, 'INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1,$2,$3,$4)', [A, s, 'cash', 0], /check constraint/);
  });
});

test('a paid sale cannot be edited, deleted or have its lines/payments changed (invariant 4)', async () => {
  await inTx(async (c, x) => {
    const s = await newSale(c, x, { status: 'open' });
    await c.query(`INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
                   VALUES ($1,$2,$3,'Tea',1050,0,1,1050,0)`, [A, s, x.item]);
    await pay(c, s, 1050);
    await c.query("UPDATE sale SET status = 'paid', receipt_no = 'C1-20260301-0020', receipt_seq = 20 WHERE id = $1", [s]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');

    await fails(c, 'UPDATE sale SET total_paise = 1, subtotal_paise = 1 WHERE id = $1', [s], /cannot be edited/);
    await fails(c, 'UPDATE sale SET receipt_seq = 21 WHERE id = $1', [s], /cannot be edited/);
    await fails(c, "UPDATE sale SET status = 'open' WHERE id = $1", [s], /cannot go from paid to open/);
    await fails(c, 'UPDATE sale SET created_by = (SELECT id FROM app_user WHERE role = \'waiter\' LIMIT 1) WHERE id = $1', [s], /identity is immutable/);
    await fails(c, 'DELETE FROM sale WHERE id = $1', [s], /permission denied/);
    await fails(c, 'UPDATE sale_line SET qty = 9 WHERE sale_id = $1', [s], /permission denied/);
    await fails(c, 'DELETE FROM sale_line WHERE sale_id = $1', [s], /permission denied/);
    await fails(c, 'UPDATE payment SET amount_paise = 1 WHERE sale_id = $1', [s], /permission denied/);
    await fails(c, 'DELETE FROM payment WHERE sale_id = $1', [s], /permission denied/);
    // The allowed moves: paid -> refunded, and open -> void.
    await c.query("UPDATE sale SET status = 'refunded' WHERE id = $1", [s]);
    const o = await newSale(c, x);
    await c.query("UPDATE sale SET status = 'void', void_reason = 'cancelled' WHERE id = $1", [o]);
    await fails(c, "UPDATE sale SET status = 'paid' WHERE id = $1", [o], /cannot go from void to paid/);
  });
});

test('receipt numbers are unique per device per business day (invariant 5); abandoned carts carry none', async () => {
  await inTx(async (c, x) => {
    await newSale(c, x, { status: 'paid', seq: 30, no: 'C1-20260301-0030' }).then((s) => pay(c, s, 1050));
    await fails(c, `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                    subtotal_paise, tax_paise, total_paise, created_at_device) VALUES (gen_random_uuid(), $1,$2,'2026-03-01',$3,$4,'paid','C1-20260301-0030',30,1,1050,0,1050,now())`,
      [A, x.outlet, x.device, x.cashier], /sale_receipt_uq/);
    // Same number on another business day is fine.
    await newSale(c, x, { status: 'paid', seq: 30, no: 'C1-20260302-0030', date: '2026-03-02' }).then((s) => pay(c, s, 1050));
    // Open and void-from-open sales carry no number; a paid one must.
    await fails(c, `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, receipt_no, receipt_seq, menu_version,
                    subtotal_paise, tax_paise, total_paise, created_at_device) VALUES (gen_random_uuid(), $1,$2,'2026-03-01',$3,$4,'open','C1-20260301-0031',31,1,1050,0,1050,now())`,
      [A, x.outlet, x.device, x.cashier], /check constraint/);
    await fails(c, `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, menu_version,
                    subtotal_paise, tax_paise, total_paise, created_at_device) VALUES (gen_random_uuid(), $1,$2,'2026-03-01',$3,$4,'paid',1,1050,0,1050,now())`,
      [A, x.outlet, x.device, x.cashier], /check constraint/);
  });
});

test('sale arithmetic: total = subtotal + tax, and money is never negative', async () => {
  await inTx(async (c, x) => {
    await fails(c, `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, menu_version,
                    subtotal_paise, tax_paise, total_paise, created_at_device) VALUES (gen_random_uuid(), $1,$2,'2026-03-01',$3,$4,1,1000,50,1000,now())`,
      [A, x.outlet, x.device, x.cashier], /check constraint/);
    await fails(c, `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, menu_version,
                    subtotal_paise, tax_paise, total_paise, created_at_device) VALUES (gen_random_uuid(), $1,$2,'2026-03-01',$3,$4,1,-1,51,50,now())`,
      [A, x.outlet, x.device, x.cashier], /check constraint/);
  });
});

test('shift and business_day rows are never hard-deleted', async () => {
  await inTx(async (c) => {
    await fails(c, 'DELETE FROM shift', [], /permission denied/);
    await fails(c, 'DELETE FROM business_day', [], /permission denied/);
  });
});
