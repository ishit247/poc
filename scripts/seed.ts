// Dev seed: two tenants (A, B) so isolation tests are meaningful. DEV ONLY:
// the shared password below must never reach a real environment.
// Runs as pos_owner; RLS is FORCEd, so each tenant is stamped like the app does.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { logoPng } from './png.ts';
import { GST_BP, HSN, menuCard } from './menu-card.ts';
import { paise, totals, type GstRounding } from '../packages/shared/src/index.ts';
import { catalogKey, closeObjects, putObject, tenantKey } from '../apps/api/src/objects.ts';
import { hashPassword } from '../apps/api/src/security/password.ts';
import { newSecret, sealSecret, sealWebhookSecret, sha256, totpSecretContext } from '../apps/api/src/security/crypto.ts';

export const DEV_PASSWORD = 'dev-password-123';
export const DEV_PIN = '482913'; // dev only
export const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // dev only, platform operators

const SEED = {
  A: { id: '00000000-0000-4000-8000-00000000000a', name: 'Taste Pure Veg', subdomain: 'taste-pure-veg', logo: [31, 110, 70] as const, key: 'a', outlets: ['Taste Pure Veg'], managerEmail: 'manager@taste.test', waiters: 1, vegOnly: true },
  B: { id: '00000000-0000-4000-8000-00000000000b', name: 'Jaika Restaurant', subdomain: 'jaika-restaurant', logo: [178, 48, 36] as const, key: 'b', outlets: ['Jaika Restaurant'], managerEmail: 'manager@jaika.test', waiters: 2, vegOnly: false },
};
// Menu items the trading rows below refer to; all three are on the menu card, veg, so both menus have them.
const SAMOSA = 'Veg Sandwich', TEA = 'Tea', COFFEE = 'Cold Drinks 200ml';

const url = process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos';
const client = new pg.Client({ connectionString: url });
await client.connect();
const passwordHash = await hashPassword(DEV_PASSWORD);
const pinHash = await hashPassword(DEV_PIN); // same slow hash as passwords; verifier format for PINs

for (const t of Object.values(SEED)) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
  await client.query('INSERT INTO tenant (id, name, subdomain) VALUES ($1, $2, $3)', [t.id, t.name, t.subdomain]);
  // Distinct logos per tenant (a lettered badge in the restaurant's colour), so a mix-up between tenants shows.
  const png = logoPng(t.logo, t.key === 'a' ? 'T' : 'J', t.key === 'a' ? 'veg' : 'ring');
  await client.query(
    "INSERT INTO tenant_logo (tenant_id, content_type, bytes, sha256) VALUES ($1, 'image/png', $2, $3)",
    [t.id, png, createHash('sha256').update(png).digest('hex')]);
  // Trading settings differ per tenant so a leak between them would show: A uses defaults, B rounds to the rupee.
  // Discounts are on in both (the column default is off), up to 10% in A and 20% in B.
  await client.query(
    'INSERT INTO tenant_setting (tenant_id, max_line_qty, gst_rounding, bill_round_to, offline_days, discount_max_bp) VALUES ($1, $2, $3, $4, 7, $5)',
    [t.id, t.key === 'a' ? 99 : 20, t.key === 'a' ? 'half_up' : 'down', t.key === 'a' ? 0 : 100, t.key === 'a' ? 1000 : 2000]);
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
    // GST provision (Q3): both restaurants are GST-enabled with a syntactically valid DEV GSTIN (checksum not verified).
    const gstin = { a1: '27ABCDE1234F1Z5', b1: '29PQRSX5678K1Z2' }[`${t.key}${i}`];
    if (gstin) await client.query('UPDATE outlet SET gst_enabled = true, gstin = $2 WHERE id = $1', [outletId, gstin]);
    // Receipt header/footer details (dev values).
    await client.query('UPDATE outlet SET address = $2, fssai_no = $3 WHERE id = $1',
      [outletId, `${o}, 12 Station Road, Pune 411001`, t.key === 'a' ? '11516034000797' : '11516034000798']);
    const counters = await client.query(
      "INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1'), ($1, $2, 'C2') RETURNING id", [t.id, outletId]);
    counterIds.push(counters.rows.map((r: { id: string }) => r.id));
    // Placeholder credential: this device cannot authenticate (no secret is known for it).
    const dev = await client.query(
      'INSERT INTO device (tenant_id, outlet_id, counter_id, credential_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [t.id, outletId, counters.rows[0].id, sha256(newSecret())]);
    deviceIds.push(dev.rows[0].id);
    // One manager per outlet, assigned to that outlet only: manager@taste.test (Taste Pure Veg), manager@jaika.test (Jaika Restaurant)
    const u = await client.query(
      `INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash)
       VALUES ($1, $2, 'seed-unset', 'manager', $3, $4) RETURNING id`,
      [t.id, 'Manager', t.managerEmail, passwordHash]);
    await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, u.rows[0].id, outletId]);
    await client.query("INSERT INTO login_lockout (tenant_id, user_id, kind) VALUES ($1, $2, 'password')", [t.id, u.rows[0].id]);
    // The invite this manager "accepted": spent, so no live link exists in the seed (the isolation test wants rows for both tenants).
    await client.query(
      `INSERT INTO manager_invite (tenant_id, user_id, token_hash, admin_id, created_at, expires_at, used_at)
       VALUES ($1, $2, $3, '00000000-0000-0000-0000-000000000000', now() - interval '1 day', now() + interval '2 days', now() - interval '1 hour')`,
      [t.id, u.rows[0].id, sha256(newSecret())]);
    // Cashier and waiters: PIN only, no web login (no email / password). Jaika has "waiter 1" and "waiter 2".
    // The trading rows below stay with the cashier and the first waiter.
    const staff: { role: 'cashier' | 'waiter'; name: string }[] = [{ role: 'cashier', name: 'Cashier' }];
    if (t.waiters === 1) staff.push({ role: 'waiter', name: 'Waiter' });
    else for (let w = 1; w <= t.waiters; w++) staff.push({ role: 'waiter', name: `Waiter ${w}` });
    for (const [si, p] of staff.entries()) {
      const s = await client.query(
        "INSERT INTO app_user (tenant_id, name, pin_verifier, role) VALUES ($1, $2, $3, $4) RETURNING id",
        [t.id, p.name, pinHash, p.role]);
      if (si === 0) cashierIds.push(s.rows[0].id);
      else if (si === 1) waiterIds.push(s.rows[0].id);
      await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, s.rows[0].id, outletId]);
      await client.query("INSERT INTO login_lockout (tenant_id, user_id, kind) VALUES ($1, $2, 'pin')", [t.id, s.rows[0].id]);
    }
    managerIds.push(u.rows[0].id);
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
  // The restaurant menu card (scripts/menu-card.ts): Taste Pure Veg sells the veg lines only, Jaika the whole card.
  const menu = menuCard(t.vegOnly);
  // Dish photos from the card (scripts/assets/menu) for every item that has one; each is stored once per tenant
  // (item_image is content-addressed), bytes in the object store and the index row in Postgres. Tea and the cold drink have none.
  const photoSha: Record<string, string> = {};
  for (const cat of menu) for (const it of cat.items) {
    if (!it.photo) continue;
    const bytes = readFileSync(new URL(`./assets/menu/${it.photo}.png`, import.meta.url));
    const sha = createHash('sha256').update(bytes).digest('hex');
    photoSha[it.name] = sha;
    if (Object.values(photoSha).filter((x) => x === sha).length > 1) continue;
    await putObject(tenantKey(t.id, sha), bytes, 'image/png');
    await client.query("INSERT INTO item_image (tenant_id, sha256, content_type, byte_size) VALUES ($1, $2, 'image/png', $3)", [t.id, sha, bytes.length]);
  }
  const blurb: Record<string, string> = { [SAMOSA]: `${t.name}: grilled, with chutney`, [TEA]: 'Hot masala chai' };
  // Diet marks come from the card, except Tea: no diet mark on purpose (unset is valid). Tenant-distinct tag sets so a leak shows.
  const tagNames = t.key === 'a' ? ['Snack', 'Hot'] : ['Quick bite', 'Spicy', 'Cold'];
  const tagsOf: Record<string, string[]> = t.key === 'a'
    ? { [SAMOSA]: ['Snack', 'Hot'], [TEA]: ['Hot'] }
    : { [SAMOSA]: ['Quick bite', 'Spicy'], [TEA]: ['Quick bite'], [COFFEE]: ['Cold'] };
  const tagIds: Record<string, string> = {};
  for (const [i, n] of tagNames.entries()) {
    tagIds[n] = (await client.query('INSERT INTO tag (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [t.id, n, i])).rows[0].id;
  }
  let sort = 0;
  for (const cat of menu) {
    const c = await client.query('INSERT INTO category (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [t.id, cat.name, sort++]);
    for (const { name, pricePaise, diet } of cat.items) {
      const it = await client.query('INSERT INTO item (tenant_id, category_id, name, description, diet, image_sha256) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [t.id, c.rows[0].id, name, blurb[name] ?? null, name === TEA ? null : diet, photoSha[name] ?? null]);
      itemIds[name] = it.rows[0].id;
      for (const tn of tagsOf[name] ?? []) await client.query('INSERT INTO item_tag (tenant_id, item_id, tag_id) VALUES ($1, $2, $3)', [t.id, it.rows[0].id, tagIds[tn]]);
      await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'counter', $3, $4)", [t.id, it.rows[0].id, pricePaise, GST_BP]);
      // Aggregator price differs from the counter price (Q10 is open; the model allows it).
      if (name === SAMOSA) {
        await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'zomato', $3, $4)", [t.id, it.rows[0].id, pricePaise + 500, GST_BP]);
      }
      // The cold drink is out of stock everywhere. listed stays NULL (no opinion): the manager has not chosen.
      for (const oid of outletIds) {
        await client.query('INSERT INTO outlet_item (tenant_id, outlet_id, item_id, available, listed) VALUES ($1, $2, $3, $4, NULL)', [t.id, oid, it.rows[0].id, name !== COFFEE]);
      }
    }
  }
  // Outlet pricing: every outlet has its own Zomato price for the sandwich.
  for (const [n, oid] of outletIds.entries()) {
    await client.query("INSERT INTO outlet_price (tenant_id, outlet_id, item_id, channel, price_paise) VALUES ($1, $2, $3, 'zomato', $4)", [t.id, oid, itemIds[SAMOSA], 12900 + n * 100]);
  }
  // Aggregator integration (phase 9) at each tenant's first outlet: dev store id and secret, Samosa mapped, Tea not.
  // Zomato only; the dev secret is public on purpose (tests sign with it).
  // The id is made here because the sealed secret is bound to it.
  const integrationId = randomUUID();
  await client.query(
    `INSERT INTO outlet_integration (id, tenant_id, outlet_id, channel, external_store_id, webhook_secret_sealed, service_user_id, device_id)
     VALUES ($1, $2, $3, 'zomato', $4, $5, $6, $7)`,
    [integrationId, t.id, outletIds[0], `dev-store-${t.key}1`, sealWebhookSecret(integrationId, `dev-webhook-secret-${t.key}1`), managerIds[0], deviceIds[0]]);
  await client.query(
    `INSERT INTO item_channel_map (tenant_id, outlet_id, channel, external_item_id, item_id) VALUES ($1, $2, 'zomato', $3, $4)`,
    [t.id, outletIds[0], `ZS-${t.key}-samosa`, itemIds[SAMOSA]]);
  await client.query(
    `INSERT INTO inbound_event (tenant_id, outlet_id, channel, result, detail, raw_payload) VALUES ($1, $2, 'zomato', 'rejected', 'seed sample', '{}')`,
    [t.id, outletIds[0]]);
  // One past, already-ended support session, so the tenant's "support access" list is not empty.
  await client.query(
    `INSERT INTO impersonation (tenant_id, admin_id, admin_name, reason, token_hash, created_at, expires_at, ended_at)
     VALUES ($1, gen_random_uuid(), 'Seed Operator', 'seed sample', $2, now() - interval '2 hours', now() - interval '90 minutes', now() - interval '100 minutes')`,
    [t.id, sha256(newSecret())]);
  // Counter-specific menus. Counter 1: whole menu, the sandwich cheaper here. Counter 2: drinks only.
  for (const [c1, c2] of counterIds) {
    await client.query('INSERT INTO counter_item (tenant_id, counter_id, item_id, listed, price_paise) VALUES ($1, $2, $3, true, 10900)', [t.id, c1, itemIds[SAMOSA]]);
    await client.query("UPDATE counter SET menu_mode = 'listed' WHERE id = $1", [c2]);
    for (const drink of [TEA, COFFEE]) {
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
       VALUES ($1, $2, $3, 'Veg Sandwich', 1500, 500, 2, 3000, 150)`, [t.id, sale.rows[0].id, itemIds[SAMOSA]]);
    await client.query(
      `INSERT INTO payment (tenant_id, sale_id, method, amount_paise, tendered_paise, change_paise)
       VALUES ($1, $2, 'cash', 3150, 3500, 350)`, [t.id, sale.rows[0].id]);
    // A UPI sale of the same shift, refunded by its cashier (docs/refunds-plan.md). UPI, so the drawer is untouched.
    const refunded = await client.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, shift_id, device_id, created_by, status,
                         receipt_no, receipt_seq, device_seq, menu_version, subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, $3, '2026-01-01', $4, $5, $6, 'refunded', 'C1-20260101-0002', 2, 4, 1, 1000, 50, 1050, '2026-01-01T09:30:00Z')
       RETURNING id`,
      [t.id, outletId, day.rows[0].id, shift.rows[0].id, deviceIds[n], cashierIds[n]]);
    await client.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1, $2, $3, 'Tea', 1000, 500, 1, 1000, 50)`, [t.id, refunded.rows[0].id, itemIds[TEA]]);
    await client.query("INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, 'upi', 1050)", [t.id, refunded.rows[0].id]);
    // Two discounted UPI sales of the same shift (docs/discounts-plan.md), each mixing 5% and 18% GST so the split and the
    // per-line rounding are exercised: 10% off, and a flat 5.55 off. Money from the shared rule, in the tenant's rounding.
    const rules = { gstRounding: (t.key === 'a' ? 'half_up' : 'down') as GstRounding, billRoundTo: (t.key === 'a' ? 0 : 100) as 0 | 100 };
    for (const [k, qtySamosa, discount] of [[3, 2, { kind: 'percent', value: 1000, reason: 'Staff meal' }], [4, 1, { kind: 'amount', value: 555, reason: 'Complaint' }]] as const) {
      const cart = [
        { itemId: itemIds[SAMOSA]!, name: SAMOSA, unitPaise: paise(1500), gstRateBp: 500, qty: qtySamosa },
        { itemId: itemIds[COFFEE]!, name: COFFEE, unitPaise: paise(6000), gstRateBp: 1800, qty: 1 },
      ];
      const m = totals(cart, rules, discount);
      const s = await client.query(
        `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, shift_id, device_id, created_by, status, receipt_no, receipt_seq,
                           device_seq, menu_version, subtotal_paise, discount_paise, discount_bp, discount_reason, tax_paise, round_off_paise, total_paise, created_at_device)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-01-01', $4, $5, $6, 'paid', $7, $8, $9, 1, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
        [t.id, outletId, day.rows[0].id, shift.rows[0].id, deviceIds[n], cashierIds[n], `C1-20260101-000${k}`, k, k + 2,
         m.subtotal, m.discount, discount.kind === 'percent' ? discount.value : null, discount.reason, m.tax, m.roundOff, m.total, `2026-01-01T10:0${k}:00Z`]);
      for (const l of m.lines) {
        await client.query(
          `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, discount_paise, tax_paise)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [t.id, s.rows[0].id, l.itemId, l.name, l.unitPaise, l.gstRateBp, l.qty, l.net, l.discount, l.tax]);
      }
      await client.query("INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, 'upi', $3)", [t.id, s.rows[0].id, m.total]);
    }
    await client.query(
      `INSERT INTO refund (tenant_id, sale_id, method, amount_paise, reason, shift_id, device_id, refunded_by, refunded_at)
       VALUES ($1, $2, 'upi', 1050, 'wrong item', $3, $4, $5, '2026-01-01T09:40:00Z')`,
      [t.id, refunded.rows[0].id, shift.rows[0].id, deviceIds[n], cashierIds[n]]);
    const open = await client.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, menu_version,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-01-02', $3, $4, 'open', 1, 1000, 50, 1050, '2026-01-02T09:00:00Z') RETURNING id`,
      [t.id, outletId, deviceIds[n], waiterIds[n]]);
    // A past table visit, voided (empty, so its money is zero): every tenant then has an order_visit row (phase 12
    // step 7), and no table is left occupied for the tests and browser runs that seat T1.
    await client.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, status, void_reason, menu_version, table_id, order_root_id,
                         subtotal_paise, tax_paise, total_paise, created_at_device)
       SELECT v.id, $1, $2, '2026-01-02', $3, $4, 'void', 'abandoned_at_shift_close', 1, dt.id, v.id, 0, 0, 0, '2026-01-02T08:00:00Z'
         FROM (SELECT gen_random_uuid() AS id) v, dining_table dt WHERE dt.outlet_id = $2 AND dt.is_default AND dt.deleted_at IS NULL`,
      [t.id, outletId, deviceIds[n], waiterIds[n]]);
    await client.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1, $2, $3, 'Tea', 1000, 500, 1, 1000, 50)`, [t.id, open.rows[0].id, itemIds[TEA]]);
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
         VALUES ($1, $2, $3, 'Tea', 1000, 500, 1, 1000, 50)`, [t.id, s.rows[0].id, itemIds[TEA]]);
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
  const adminId = randomUUID();
  await client.query(
    'INSERT INTO platform_admin (id, email, name, role, password_hash, totp_secret_sealed) VALUES ($1, $2, $3, $4, $5, $6)',
    [adminId, email, name, role, passwordHash, sealSecret(DEV_TOTP_SECRET, totpSecretContext(adminId))]);
}

// Operator catalog templates (docs/catalog-templates.md, docs/menu-template-seed-plan.md): the restaurant menu card, in two
// templates, with diet marks and the dish photos cropped from the card. Prices are tax-exclusive paise at 5% GST.
// The seeded tenants above keep their own menus and are not linked to them.
{
  const stored = new Set<string>(); // each picture once: the object store and catalog_image are content-addressed
  const photoSha = async (photo: string): Promise<string> => {
    const bytes = readFileSync(new URL(`./assets/menu/${photo}.png`, import.meta.url));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (!stored.has(sha)) {
      await putObject(catalogKey(sha), bytes, 'image/png');
      await client.query("INSERT INTO catalog_image (sha256, content_type, byte_size) VALUES ($1, 'image/png', $2)", [sha, bytes.length]);
      stored.add(sha);
    }
    return sha;
  };
  for (const [name, vegOnly] of [['Restaurant menu - veg only', true], ['Restaurant menu - veg and non-veg', false]] as const) {
    const tpl = await client.query('INSERT INTO catalog_template (name) VALUES ($1) RETURNING id', [name]);
    for (const [ci, cat] of menuCard(vegOnly).entries()) {
      const k = await client.query('INSERT INTO catalog_category (template_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id', [tpl.rows[0].id, cat.name, ci]);
      for (const [ii, it] of cat.items.entries()) {
        await client.query(
          `INSERT INTO catalog_item (template_id, category_id, name, hsn_code, diet, image_sha256, gst_rate_bp, price_paise, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [tpl.rows[0].id, k.rows[0].id, it.name, HSN, it.diet, it.photo ? await photoSha(it.photo) : null, GST_BP, it.pricePaise, ii]);
      }
    }
  }
}
await client.end();
closeObjects();
console.log('seeded Taste Pure Veg and Jaika Restaurant, two platform operators and two catalog templates (restaurant menu)');
