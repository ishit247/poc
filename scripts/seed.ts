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
  for (const o of t.outlets) {
    i++;
    const out = await client.query('INSERT INTO outlet (tenant_id, name) VALUES ($1, $2) RETURNING id', [t.id, o]);
    const outletId = out.rows[0].id;
    outletIds.push(outletId);
    const counters = await client.query(
      "INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1'), ($1, $2, 'C2') RETURNING id", [t.id, outletId]);
    // Placeholder credential: this device cannot authenticate (no secret is known for it).
    await client.query(
      'INSERT INTO device (tenant_id, outlet_id, counter_id, credential_hash) VALUES ($1, $2, $3, $4)',
      [t.id, outletId, counters.rows[0].id, sha256(newSecret())]);
    // One manager per outlet, assigned to that outlet only: a1@example.test, a2@..., b1@...
    const u = await client.query(
      `INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash)
       VALUES ($1, $2, 'seed-unset', 'manager', $3, $4) RETURNING id`,
      [t.id, `${o} manager`, `${t.key}${i}@example.test`, passwordHash]);
    await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, u.rows[0].id, outletId]);
    // Cashier and waiter: PIN only, no web login (no email / password).
    for (const role of ['cashier', 'waiter'] as const) {
      const s = await client.query(
        "INSERT INTO app_user (tenant_id, name, pin_verifier, role) VALUES ($1, $2, $3, $4) RETURNING id",
        [t.id, `${o} ${role}`, pinHash, role]);
      await client.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [t.id, s.rows[0].id, outletId]);
    }
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
      await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'counter', $3, $4)", [t.id, it.rows[0].id, price, gst]);
      // Aggregator price differs from the counter price (Q10 is open; the model allows it).
      if (name === 'Samosa') {
        await client.query("INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1, $2, 'zomato', $3, $4)", [t.id, it.rows[0].id, price + 500, gst]);
      }
      for (const oid of outletIds) {
        await client.query('INSERT INTO outlet_item (tenant_id, outlet_id, item_id, available) VALUES ($1, $2, $3, $4)', [t.id, oid, it.rows[0].id, name !== 'Cold Coffee']);
      }
    }
  }
  await client.query('COMMIT');
}
await client.end();
console.log('seeded tenants A and B');
