// Dev seed: two tenants (A, B) so isolation tests are meaningful. DEV ONLY:
// the shared password below must never reach a real environment.
// Runs as pos_owner; RLS is FORCEd, so each tenant is stamped like the app does.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { solidPng } from './png.ts';
import { hashPassword } from '../apps/api/src/security/password.ts';
import { newSecret, sha256 } from '../apps/api/src/security/crypto.ts';

export const DEV_PASSWORD = 'dev-password-123';
export const DEV_PIN = '482913'; // dev only
export const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // dev only, platform operators

const SEED = {
  A: { id: '00000000-0000-4000-8000-00000000000a', name: 'Tenant A Caterers', subdomain: 'tenant-a', logo: [31, 78, 61], key: 'a', outlets: ['School 1 Canteen', 'School 2 Canteen'] },
  B: { id: '00000000-0000-4000-8000-00000000000b', name: 'Tenant B School', subdomain: 'tenant-b', logo: [160, 60, 40], key: 'b', outlets: ['Main Canteen'] },
};

const url = process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos';
const client = new pg.Client({ connectionString: url });
await client.connect();
const passwordHash = await hashPassword(DEV_PASSWORD);
const pinHash = await hashPassword(DEV_PIN); // same slow hash as passwords; verifier format for PINs

for (const t of Object.values(SEED)) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
  await client.query('INSERT INTO tenant (id, name, subdomain) VALUES ($1, $2, $3)', [t.id, t.name, t.subdomain]);
  // Distinct logos per tenant, so a mix-up between tenants shows.
  const png = solidPng(...(t.logo as [number, number, number]));
  await client.query(
    "INSERT INTO tenant_logo (tenant_id, content_type, bytes, sha256) VALUES ($1, 'image/png', $2, $3)",
    [t.id, png, createHash('sha256').update(png).digest('hex')]);
  // Trading settings differ per tenant so a leak between them would show: A uses defaults, B rounds to the rupee.
  await client.query(
    'INSERT INTO tenant_setting (tenant_id, max_line_qty, gst_rounding, bill_round_to, offline_days) VALUES ($1, $2, $3, $4, 7)',
    [t.id, t.key === 'a' ? 99 : 20, t.key === 'a' ? 'half_up' : 'down', t.key === 'a' ? 0 : 100]);
  let i = 0;
  const outletIds: string[] = [];
  const counterIds: string[][] = [];
  const deviceIds: string[] = [];
  const cashierIds: string[] = [];
  const waiterIds: string[] = [];
  const managerIds: string[] = [];
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
    // Receipt header/footer details (dev values). The second A outlet has neither, so a receipt without them is exercised.
    if (`${t.key}${i}` !== 'a2') {
      await client.query('UPDATE outlet SET address = $2, fssai_no = $3 WHERE id = $1',
        [outletId, `${o}, 12 Station Road, Pune 411001`, t.key === 'a' ? '11516034000797' : '11516034000798']);
    }
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
    managerIds.push(u.rows[0].id);
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
  // Aggregator integration (phase 9) at each tenant's first outlet: dev store id and secret, Samosa mapped, Tea not.
  // Zomato only; the dev secret is public on purpose (tests sign with it).
  await client.query(
    `INSERT INTO outlet_integration (tenant_id, outlet_id, channel, external_store_id, webhook_secret, service_user_id, device_id)
     VALUES ($1, $2, 'zomato', $3, $4, $5, $6)`,
    [t.id, outletIds[0], `dev-store-${t.key}1`, `dev-webhook-secret-${t.key}1`, managerIds[0], deviceIds[0]]);
  await client.query(
    `INSERT INTO item_channel_map (tenant_id, outlet_id, channel, external_item_id, item_id) VALUES ($1, $2, 'zomato', $3, $4)`,
    [t.id, outletIds[0], `ZS-${t.key}-samosa`, itemIds['Samosa']]);
  await client.query(
    `INSERT INTO inbound_event (tenant_id, outlet_id, channel, result, detail, raw_payload) VALUES ($1, $2, 'zomato', 'rejected', 'seed sample', '{}')`,
    [t.id, outletIds[0]]);
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
    // The ledger entries those sales would have left (payloads are placeholders; seeds are not replayed).
    for (const [seq, type, saleId] of [[1, 'sale.created', sale.rows[0].id], [2, 'payment.taken', sale.rows[0].id], [3, 'sale.created', open.rows[0].id]] as const) {
      await client.query(
        `INSERT INTO sync_event (tenant_id, id, device_id, seq, type, entity_id, schema_version, created_at_device, outcome, payload)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 1, '2026-01-01T09:00:00Z', 'applied', '{}')`, [t.id, deviceIds[n], seq, type, saleId]);
    }

    // Online orders (PLAN 11): one Zomato order handed over and paid by the platform, one Swiggy order still waiting.
    // Neither is in a cashier's shift or has a receipt number. Order ids repeat across tenants on purpose.
    const online = async (channel: string, ext: string, saleStatus: string, orderStatus: string, date: string) => {
      const s = await client.query(
        `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, device_id, created_by, channel, status, menu_version,
                           subtotal_paise, tax_paise, total_paise, created_at_device)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, 1000, 50, 1050, $9) RETURNING id`,
        [t.id, outletId, saleStatus === 'paid' ? day.rows[0].id : null, date, deviceIds[n], cashierIds[n], channel, saleStatus, `${date}T10:00:00Z`]);
      await client.query(
        `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
         VALUES ($1, $2, $3, 'Tea', 1000, 500, 1, 1000, 50)`, [t.id, s.rows[0].id, itemIds['Tea']]);
      if (saleStatus === 'paid') {
        await client.query(`INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, 'aggregator', 1050)`, [t.id, s.rows[0].id]);
      }
      const o = await client.query(
        `INSERT INTO online_order (tenant_id, outlet_id, sale_id, provider, channel, external_order_id, status, accept_by, customer_label, received_at)
         VALUES ($1, $2, $3, 'manual', $4, $5, 'received', $6, 'Block B, Room 214', $7) RETURNING id`,
        [t.id, outletId, s.rows[0].id, channel, ext, `${date}T10:05:00Z`, `${date}T10:00:00Z`]);
      await client.query(
        `INSERT INTO online_order_event (tenant_id, online_order_id, from_status, to_status, actor_id, device_id, at)
         VALUES ($1, $2, NULL, 'received', $3, $4, $5)`, [t.id, o.rows[0].id, cashierIds[n], deviceIds[n], `${date}T10:00:00Z`]);
      if (orderStatus !== 'received') {
        for (const [from, to] of [['received', 'accepted'], ['accepted', 'ready'], ['ready', 'handed_over']]) {
          await client.query(`UPDATE online_order SET status = $2, status_at = $3 WHERE id = $1`, [o.rows[0].id, to, `${date}T10:30:00Z`]);
          await client.query(
            `INSERT INTO online_order_event (tenant_id, online_order_id, from_status, to_status, actor_id, device_id, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.id, o.rows[0].id, from, to, cashierIds[n], deviceIds[n], `${date}T10:30:00Z`]);
        }
        await client.query(
          `INSERT INTO integration_outbox (tenant_id, outlet_id, online_order_id, provider, action, dedupe_key, status, done_at)
           VALUES ($1, $2, $3, 'manual', 'handed_over', $4, 'done', now())`, [t.id, outletId, o.rows[0].id, `${o.rows[0].id}:handed_over`]);
      }
      return o.rows[0].id as string;
    };
    const zomatoId = `ZOM-${1001 + n}`;
    const delivered = await online('zomato', zomatoId, 'paid', 'handed_over', '2026-01-01');
    await online('swiggy', `SWG-${2001 + n}`, 'open', 'received', '2026-01-02');
    const imp = await client.query(
      `INSERT INTO settlement_import (tenant_id, outlet_id, channel, filename, period_from, period_to, uploaded_by)
       VALUES ($1, $2, 'zomato', 'zomato-jan-week1.csv', '2026-01-01', '2026-01-07', $3) RETURNING id`, [t.id, outletId, managerIds[n]]);
    await client.query(
      `INSERT INTO settlement_line (tenant_id, import_id, external_order_id, gross_paise, payout_paise, online_order_id, result)
       VALUES ($1, $2, $3, 1050, 840, $4, 'matched')`, [t.id, imp.rows[0].id, zomatoId, delivered]);
  }
  await client.query('COMMIT');
}

// Platform console operators (DEV ONLY: fixed password and authenticator secret, which tests use to compute codes).
for (const [email, name, role] of [['owner@platform.test', 'Platform Owner', 'owner'], ['support@platform.test', 'Platform Support', 'support']]) {
  await client.query(
    'INSERT INTO platform_admin (email, name, role, password_hash, totp_secret) VALUES ($1, $2, $3, $4, $5)',
    [email, name, role, passwordHash, DEV_TOTP_SECRET]);
}
await client.end();
console.log('seeded tenants A and B and two platform operators');
