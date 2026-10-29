// Dev seed: two tenants (A, B) so isolation tests are meaningful. DEV ONLY:
// the shared password below must never reach a real environment.
// Runs as pos_owner; RLS is FORCEd, so each tenant is stamped like the app does.
import pg from 'pg';
import { hashPassword } from '../apps/api/src/security/password.ts';
import { newSecret, sha256 } from '../apps/api/src/security/crypto.ts';

export const DEV_PASSWORD = 'dev-password-123';
export const DEV_PIN = '482913'; // dev only

const SEED = {
  A: { id: '00000000-0000-4000-8000-00000000000a', name: 'Tenant A Caterers', key: 'a', outlets: ['School 1 Canteen', 'School 2 Canteen'] },
  B: { id: '00000000-0000-4000-8000-00000000000b', name: 'Tenant B School', key: 'b', outlets: ['Main Canteen'] },
};

const url = process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos';
const client = new pg.Client({ connectionString: url });
await client.connect();
const passwordHash = await hashPassword(DEV_PASSWORD);
const pinHash = await hashPassword(DEV_PIN); // same slow hash as passwords; verifier format for PINs

for (const t of Object.values(SEED)) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
  await client.query('INSERT INTO tenant (id, name) VALUES ($1, $2)', [t.id, t.name]);
  let i = 0;
  const outletIds: string[] = [];
  const counterIds: string[][] = [];
  const deviceIds: string[] = [];
  const cashierIds: string[] = [];
  const waiterIds: string[] = [];
  const itemIds: Record<string, string> = {};
  for (const o of t.outlets) {
    i++;
    const out = await client.query('INSERT INTO outlet (tenant_id, name) VALUES ($1, $2) RETURNING id', [t.id, o]);
    const outletId = out.rows[0].id;
    outletIds.push(outletId);
    // GST provision (Q3): A1 and B1 are GST-enabled with a syntactically valid DEV GSTIN
    // (checksum not verified); A2 is not registered, so it must charge 0%.
    const gstin = { a1: '27ABCDE1234F1Z5', b1: '29PQRSX5678K1Z2' }[`${t.key}${i}`];
    if (gstin) await client.query('UPDATE outlet SET gst_enabled = true, gstin = $2 WHERE id = $1', [outletId, gstin]);
    const counters = await client.query(
      "INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1'), ($1, $2, 'C2') RETURNING id", [t.id, outletId]);
    counterIds.push(counters.rows.map((r: { id: string }) => r.id));
    // Placeholder credential: this device cannot authenticate (no secret is known for it).
    const dev = await client.query(
      'INSERT INTO device (tenant_id, outlet_id, counter_id, credential_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [t.id, outletId, counters.rows[0].id, sha256(newSecret())]);
    deviceIds.push(dev.rows[0].id);
    // One manager per outlet, assigned to that outlet only: a1@example.test, a2@..., b1@...
    const u = await client.query(
      `INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash)
       VALUES ($1, $2, 'seed-unset', 'manager', $3, $4) RETURNING id`,
      [t.id, `${o} manager`, `${t.key}${i}@example.test`, passwordHash]);
    await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, u.rows[0].id, outletId]);
    await client.query("INSERT INTO login_lockout (tenant_id, user_id, kind) VALUES ($1, $2, 'password')", [t.id, u.rows[0].id]);
    // Cashier and waiter: PIN only, no web login (no email / password).
    const staff: Record<string, string> = {};
    for (const role of ['cashier', 'waiter'] as const) {
      const s = await client.query(
        "INSERT INTO app_user (tenant_id, name, pin_verifier, role) VALUES ($1, $2, $3, $4) RETURNING id",
        [t.id, `${o} ${role}`, pinHash, role]);
      staff[role] = s.rows[0].id;
      await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, s.rows[0].id, outletId]);
      await client.query("INSERT INTO login_lockout (tenant_id, user_id, kind) VALUES ($1, $2, 'pin')", [t.id, s.rows[0].id]);
    }
    cashierIds.push(staff['cashier']!);
    waiterIds.push(staff['waiter']!);
    // Rows in every table so isolation tests are not vacuous: a revoked session, a used code, an audit row.
    await client.query(
      "INSERT INTO session (tenant_id, user_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, $3, now(), now())",
      [t.id, u.rows[0].id, sha256(newSecret())]);
    await client.query(
      "INSERT INTO enrolment_code (tenant_id, outlet_id, counter_id, code_hash, created_by, expires_at, used_at) VALUES ($1, $2, $3, $4, $5, now(), now())",
      [t.id, outletId, counters.rows[0].id, sha256(newSecret()), u.rows[0].id]);
    await client.query(
      "INSERT INTO audit (tenant_id, actor_kind, action, entity, entity_id) VALUES ($1, 'system', 'seed', 'outlet', $2)",
      [t.id, outletId]);
  }
  // Menu: tenant-wide catalogue; prices per channel (paise); availability per outlet.
  const menu = {
    Snacks: [['Samosa', 1500, 500], ['Veg Sandwich', 4000, 500]],
    Drinks: [['Tea', 1000, 500], ['Cold Coffee', 6000, 1800]],
  } as const;
  let sort = 0;
  for (const [cat, items] of Object.entries(menu)) {
    const c = await client.query('INSERT INTO category (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [t.id, cat, sort++]);
    for (const [name, price, gst] of items) {
      const it = await client.query('INSERT INTO item (tenant_id, category_id, name) VALUES ($1, $2, $3) RETURNING id', [t.id, c.rows[0].id, name]);
      itemIds[name] = it.rows[0].id;
      await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'counter', $3, $4)", [t.id, it.rows[0].id, price, gst]);
      // Aggregator price differs from the counter price (Q10 is open; the model allows it).
      if (name === 'Samosa') {
        await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'zomato', $3, $4)", [t.id, it.rows[0].id, price + 500, gst]);
      }
      for (const [n, oid] of outletIds.entries()) {
        // Outlet 2 does not sell Veg Sandwich (menu is per outlet); Cold Coffee is out of stock everywhere.
        // listed stays NULL (no opinion) unless the manager chose: only this one is an explicit decision.
        const listed = n === 1 && name === 'Veg Sandwich' ? false : null;
        await client.query('INSERT INTO outlet_item (tenant_id, outlet_id, item_id, available, listed) VALUES ($1, $2, $3, $4, $5)', [t.id, oid, it.rows[0].id, name !== 'Cold Coffee', listed]);
      }
    }
  }
  // Outlet pricing: every outlet has its own Zomato price for Samosa; outlet 2 also sells Tea cheaper at the counter.
  for (const [n, oid] of outletIds.entries()) {
    await client.query("INSERT INTO outlet_price (tenant_id, outlet_id, item_id, channel, price_paise) VALUES ($1, $2, $3, 'zomato', $4)", [t.id, oid, itemIds['Samosa'], 2500 + n * 100]);
    if (n === 1) await client.query("INSERT INTO outlet_price (tenant_id, outlet_id, item_id, channel, price_paise) VALUES ($1, $2, $3, 'counter', 900)", [t.id, oid, itemIds['Tea']]);
  }
  // Counter-specific menus. Counter 1: whole menu, Samosa cheaper here. Counter 2: drinks only.
  for (const [c1, c2] of counterIds) {
    await client.query('INSERT INTO counter_item (tenant_id, counter_id, item_id, listed, price_paise) VALUES ($1, $2, $3, true, 1200)', [t.id, c1, itemIds['Samosa']]);
    await client.query("UPDATE counter SET menu_mode = 'listed' WHERE id = $1", [c2]);
    for (const drink of ['Tea', 'Cold Coffee']) {
      await client.query('INSERT INTO counter_item (tenant_id, counter_id, item_id, listed) VALUES ($1, $2, $3, true)', [t.id, c2, itemIds[drink]]);
    }
  }
  // Trading rows for every outlet, so isolation and ownership tests are not vacuous:
  // a business day with one cash-paid sale by the cashier, and one open order by the waiter.
  // Seed rows are in the past on purpose; the amounts follow exclusiveLine (5% GST on 1500 and 1000).
  for (const [n, outletId] of outletIds.entries()) {
    const day = await client.query("INSERT INTO business_day (tenant_id, outlet_id, date) VALUES ($1, $2, '2026-01-01') RETURNING id", [t.id, outletId]);
    const shift = await client.query(
      `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-01-01T08:00:00Z', 50000) RETURNING id`,
      [t.id, outletId, deviceIds[n], cashierIds[n]]);
    const sale = await client.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, shift_id, device_id, created_by, status,
                         receipt_no, receipt_seq, device_seq, menu_version, subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, $3, '2026-01-01', $4, $5, $6, 'paid', 'C1-20260101-0001', 1, 1, 1, 3000, 150, 3150, '2026-01-01T09:00:00Z')
       RETURNING id`,
      [t.id, outletId, day.rows[0].id, shift.rows[0].id, deviceIds[n], cashierIds[n]]);
    await client.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1, $2, $3, 'Samosa', 1500, 500, 2, 3000, 150)`, [t.id, sale.rows[0].id, itemIds['Samosa']]);
    await client.query(
      `INSERT INTO payment (tenant_id, sale_id, method, amount_paise, tendered_paise, change_paise)
       VALUES ($1, $2, 'cash', 3150, 3500, 350)`, [t.id, sale.rows[0].id]);
    const open = await client.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-01-02', $3, $4, 'open', 1, 1000, 50, 1050, '2026-01-02T09:00:00Z') RETURNING id`,
      [t.id, outletId, deviceIds[n], waiterIds[n]]);
    await client.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1, $2, $3, 'Tea', 1000, 500, 1, 1000, 50)`, [t.id, open.rows[0].id, itemIds['Tea']]);
  }
  await client.query('COMMIT');
}
await client.end();
console.log('seeded tenants A and B');
