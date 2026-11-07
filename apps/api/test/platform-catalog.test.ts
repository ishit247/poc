// Catalog templates (docs/catalog-templates.md): HSN and GST live in the operator's template, are copied into a
// tenant once, and can then be overridden by that tenant. Real Postgres, both pools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { platformPool, pool, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // scripts/seed.ts DEV_TOTP_SECRET
const PW = 'dev-password-123';
const OWNER = 'owner@platform.test';
const SUPPORT = 'support@platform.test';
const A = '00000000-0000-4000-8000-00000000000a';
test.after(() => Promise.all([pool.end(), platformPool.end()]));

type App = ReturnType<typeof buildApp>;
const plat = (t: string) => ({ authorization: `Platform ${t}` });
async function signIn(app: App, email: string): Promise<string> {
  await platformPool.query(
    'UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL, active = true WHERE lower(email) = $1', [email]);
  const r = await app.inject({ method: 'POST', url: '/platform/login', payload: { email, password: PW, code: totpCode(SECRET, totpStep(Date.now())) } });
  assert.equal(r.statusCode, 200, `platform login ${email}`);
  return r.json().token as string;
}
const get = (app: App, url: string, t: string) => app.inject({ method: 'GET', url, headers: plat(t) });
const send = (app: App, method: 'POST' | 'DELETE', url: string, t: string, payload?: object) =>
  app.inject({ method, url, headers: plat(t), ...(payload ? { payload } : {}) });
const uniq = () => randomBytes(4).toString('hex');

const body = (name: string) => ({
  name,
  categories: [
    { name: 'Snacks', items: [
      { name: 'Samosa', hsnCode: '21069099', gstRateBp: 500, pricePaise: 1500 },
      { name: 'Plain Roll', gstRateBp: 0, pricePaise: 2500 },
    ] },
    { name: 'Drinks', items: [{ name: 'Cold Coffee', hsnCode: '21011190', gstRateBp: 1800, pricePaise: 6000 }] },
  ],
});

async function newTenant(app: App, owner: string): Promise<string> {
  const r = await send(app, 'POST', '/platform/tenants', owner, { name: `Catalog ${uniq()}` });
  assert.equal(r.statusCode, 201);
  return r.json().id as string;
}

test('owner creates a template keeping HSN and GST per item; support can read but not write', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const made = await send(app, 'POST', '/platform/catalog-templates', owner, body(`T ${uniq()}`));
  assert.equal(made.statusCode, 201);
  const tpl = made.json();
  assert.deepEqual(tpl.categories.map((c: { name: string }) => c.name), ['Snacks', 'Drinks']);
  const samosa = tpl.categories[0].items[0];
  assert.equal(samosa.hsnCode, '21069099');
  assert.equal(samosa.gstRateBp, 500);
  assert.equal(tpl.categories[0].items[1].hsnCode, null, 'HSN is optional');

  const support = await signIn(app, SUPPORT);
  assert.equal((await get(app, '/platform/catalog-templates', support)).statusCode, 200);
  assert.equal((await get(app, `/platform/catalog-templates/${tpl.id}`, support)).statusCode, 200);
  assert.equal((await send(app, 'POST', '/platform/catalog-templates', support, body(`S ${uniq()}`))).statusCode, 403);
  assert.equal((await send(app, 'DELETE', `/platform/catalog-templates/${tpl.id}`, support)).statusCode, 403);
  const tenantId = await newTenant(app, owner);
  assert.equal((await send(app, 'POST', `/platform/tenants/${tenantId}/seed-catalog`, support, { templateId: tpl.id })).statusCode, 403);
});

test('HSN codes and GST rates outside the allowed ranges are refused', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const mk = (item: object) => send(app, 'POST', '/platform/catalog-templates', owner,
    { name: `Bad ${uniq()}`, categories: [{ name: 'C', items: [{ name: 'X', pricePaise: 100, gstRateBp: 500, ...item }] }] });
  for (const bad of [{ hsnCode: '123' }, { hsnCode: '123456789' }, { hsnCode: 'ABCD' }, { gstRateBp: 4001 }, { gstRateBp: -1 }, { gstRateBp: 5.5 }, { pricePaise: -1 }]) {
    assert.equal((await mk(bad)).statusCode, 400, JSON.stringify(bad));
  }
  const dup = `Dup ${uniq()}`;
  assert.equal((await send(app, 'POST', '/platform/catalog-templates', owner, body(dup))).statusCode, 201);
  assert.equal((await send(app, 'POST', '/platform/catalog-templates', owner, body(dup.toUpperCase()))).statusCode, 409);
});

test('seeding copies HSN, GST and counter price into the tenant, which can then override them', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const tpl = (await send(app, 'POST', '/platform/catalog-templates', owner, body(`Seed ${uniq()}`))).json();
  const tenantId = await newTenant(app, owner);

  const seeded = await send(app, 'POST', `/platform/tenants/${tenantId}/seed-catalog`, owner, { templateId: tpl.id });
  assert.equal(seeded.statusCode, 201);
  assert.deepEqual(seeded.json(), { categories: 2, items: 3 });

  const rows = await withTenant(tenantId, async (c) => (await c.query(
    `SELECT i.name, i.hsn_code, i.source_catalog_item_id, p.channel, p.price_paise::int AS price, p.gst_rate_bp AS gst
       FROM item i JOIN item_price p ON p.item_id = i.id ORDER BY i.name`)).rows);
  assert.deepEqual(rows.map((r) => [r.name, r.hsn_code, r.channel, r.price, r.gst]), [
    ['Cold Coffee', '21011190', 'counter', 6000, 1800],
    ['Plain Roll', null, 'counter', 2500, 0],
    ['Samosa', '21069099', 'counter', 1500, 500],
  ]);
  const sourceIds = new Set(tpl.categories.flatMap((c: { items: { id: string }[] }) => c.items.map((i) => i.id)));
  for (const r of rows) assert.ok(sourceIds.has(r.source_catalog_item_id), `${r.name}: provenance recorded`);

  // The tenant owns its copy: overriding HSN and GST changes nothing in the template.
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE item SET hsn_code = '19059090' WHERE name = 'Samosa'");
    await c.query("UPDATE item_price SET gst_rate_bp = 1200 WHERE item_id = (SELECT id FROM item WHERE name = 'Samosa')");
  });
  const after = (await get(app, `/platform/catalog-templates/${tpl.id}`, owner)).json();
  assert.equal(after.categories[0].items[0].hsnCode, '21069099');
  assert.equal(after.categories[0].items[0].gstRateBp, 500);

  const actions = (await platformPool.query('SELECT action FROM platform_audit WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows.map((r) => r.action);
  assert.ok(actions.includes('catalog.seed'));
  const tenantAudit = await withTenant(tenantId, async (c) => (await c.query("SELECT 1 FROM audit WHERE action = 'platform.catalog.seed'")).rowCount);
  assert.equal(tenantAudit, 1);
});

test('seeding is refused for a tenant that already has a menu, and writes nothing', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const tpl = (await send(app, 'POST', '/platform/catalog-templates', owner, body(`Twice ${uniq()}`))).json();
  const before = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int n FROM item')).rows[0].n);
  assert.ok(before > 0, 'seeded tenant A has a menu');
  assert.equal((await send(app, 'POST', `/platform/tenants/${A}/seed-catalog`, owner, { templateId: tpl.id })).statusCode, 409);
  assert.equal(await withTenant(A, async (c) => (await c.query('SELECT count(*)::int n FROM item')).rows[0].n), before);

  const tenantId = await newTenant(app, owner);
  assert.equal((await send(app, 'POST', `/platform/tenants/${tenantId}/seed-catalog`, owner, { templateId: tpl.id })).statusCode, 201);
  assert.equal((await send(app, 'POST', `/platform/tenants/${tenantId}/seed-catalog`, owner, { templateId: tpl.id })).statusCode, 409);
  assert.equal(await withTenant(tenantId, async (c) => (await c.query('SELECT count(*)::int n FROM item')).rows[0].n), 3);
});

test('a deleted template cannot be seeded, and tenants already seeded keep their menu', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const tpl = (await send(app, 'POST', '/platform/catalog-templates', owner, body(`Gone ${uniq()}`))).json();
  const seededTenant = await newTenant(app, owner);
  assert.equal((await send(app, 'POST', `/platform/tenants/${seededTenant}/seed-catalog`, owner, { templateId: tpl.id })).statusCode, 201);

  assert.equal((await send(app, 'DELETE', `/platform/catalog-templates/${tpl.id}`, owner)).statusCode, 200);
  assert.equal((await send(app, 'DELETE', `/platform/catalog-templates/${tpl.id}`, owner)).statusCode, 404);
  assert.equal((await get(app, `/platform/catalog-templates/${tpl.id}`, owner)).statusCode, 404);
  const listed = (await get(app, '/platform/catalog-templates', owner)).json() as { id: string }[];
  assert.ok(!listed.some((t) => t.id === tpl.id));

  const emptyTenant = await newTenant(app, owner);
  assert.equal((await send(app, 'POST', `/platform/tenants/${emptyTenant}/seed-catalog`, owner, { templateId: tpl.id })).statusCode, 404);
  assert.equal(await withTenant(seededTenant, async (c) => (await c.query('SELECT count(*)::int n FROM item')).rows[0].n), 3);
});

test('the tenant API role cannot read or write the catalog', async () => {
  for (const t of ['catalog_template', 'catalog_category', 'catalog_item']) {
    await assert.rejects(pool.query(`SELECT 1 FROM ${t}`), /permission denied/, t);
  }
});

test('an edit retires the old version and returns the new one; support, unknown ids and taken names are refused', async () => {
  const app = buildApp();
  const owner = await signIn(app, OWNER);
  const name = `Edit ${uniq()}`;
  const made = (await send(app, 'POST', '/platform/catalog-templates', owner, body(name))).json();
  const put = (id: string, t: string, payload: object) => app.inject({ method: 'PUT', url: `/platform/catalog-templates/${id}`, headers: plat(t), payload });

  const edited = { ...body(name), categories: [{ name: 'Snacks', items: [{ name: 'Samosa XL', hsnCode: '21069099', gstRateBp: 500, pricePaise: 1800 }] }] };
  const r = await put(made.id, owner, edited);
  assert.equal(r.statusCode, 200);
  const next = r.json();
  assert.notEqual(next.id, made.id, 'the edit is a new version');
  assert.equal(next.categories[0].items[0].name, 'Samosa XL');
  assert.equal((await get(app, `/platform/catalog-templates/${made.id}`, owner)).statusCode, 404, 'the old version is retired');
  const listed = (await get(app, '/platform/catalog-templates', owner)).json() as { id: string; name: string }[];
  assert.equal(listed.filter((t) => t.name === name).length, 1, 'one live template under that name');

  assert.equal((await put(made.id, owner, edited)).statusCode, 404, 'the retired id cannot be edited again');
  const other = (await send(app, 'POST', '/platform/catalog-templates', owner, body(`Other ${uniq()}`))).json();
  assert.equal((await put(other.id, owner, { ...edited, name })).statusCode, 409, 'renaming onto a live name is refused');
  assert.equal((await get(app, `/platform/catalog-templates/${other.id}`, owner)).statusCode, 200, 'a refused edit leaves the template as it was');

  const support = await signIn(app, SUPPORT);
  assert.equal((await put(next.id, support, edited)).statusCode, 403);
  assert.equal((await put(next.id, owner, { name, categories: [] })).statusCode, 400);
});
