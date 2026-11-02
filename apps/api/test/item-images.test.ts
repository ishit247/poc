// Item descriptions and pictures (0003 item_image, 0011 catalog_image). Pictures are content-addressed, kept out of pull
// (only the hash travels), shared by hash, cleaned up when unreferenced, and copied from a template once per distinct hash.
// Real Postgres, both pools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { platformPool, pool, withTenant } from '../src/db.js';
import { totpCode, totpStep } from '../src/security/totp.js';
import { solidPng } from '../../../scripts/png.ts';
import { catalogKey, closeObjects, getObject, objectExists, tenantKey } from '../src/objects.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PW = 'dev-password-123';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
test.after(() => Promise.all([pool.end(), platformPool.end()]).then(closeObjects));

type App = ReturnType<typeof buildApp>;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const uniq = () => randomBytes(4).toString('hex');
/** A distinct, valid PNG each call. */
const picture = () => solidPng(randomBytes(1)[0]!, randomBytes(1)[0]!, randomBytes(1)[0]!, 8 + (randomBytes(1)[0]! % 8));

async function login(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenantId) }, payload: { email, password: PW } });
  assert.equal(r.statusCode, 200);
  return { authorization: `Bearer ${r.json().token}` };
}
async function enrolDevice(app: App, mgr: { authorization: string }, tenantId: string, email: string) {
  const o = (await withTenant(tenantId, (c) => c.query(
    `SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id
       FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id JOIN outlet o ON o.id = uo.outlet_id WHERE lower(u.email) = $1`, [email]))).rows[0];
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: mgr, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  return { authorization: `Device ${(await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential}` };
}
const putImage = (app: App, mgr: Record<string, string>, itemId: string, bytes: Buffer, type = 'image/png') =>
  app.inject({ method: 'PUT', url: `/items/${itemId}/image`, headers: { ...mgr, 'content-type': type }, payload: bytes });
/** Follows pull pages (the dev tenants accumulate items across runs) until the item turns up; returns its row and every page body. */
async function pullItem(app: App, dev: Record<string, string>, itemId: string) {
  const bodies: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    const r = await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: dev });
    assert.equal(r.statusCode, 200);
    bodies.push(r.body);
    const j = r.json();
    const row = j.changes.find((c: { id: string; type: string }) => c.id === itemId && c.type === 'item');
    if (row) return { row, bodies };
    if (!j.hasMore) break;
    cursor = j.cursor;
  }
  throw new Error('item never arrived in pull');
}
const imageRows = (tenantId: string, hash: string) =>
  withTenant(tenantId, async (c) => (await c.query('SELECT count(*)::int n FROM item_image WHERE sha256 = $1', [hash])).rows[0].n as number);

async function newItem(app: App, mgr: Record<string, string>, extra: object = {}) {
  const cat = (await app.inject({ method: 'POST', url: '/categories', headers: mgr, payload: { name: `Pic ${uniq()}` } })).json();
  const item = await app.inject({ method: 'POST', url: '/items', headers: mgr, payload: { categoryId: cat.id, name: `Pic item ${uniq()}`, ...extra } });
  assert.equal(item.statusCode, 201);
  return item.json() as { id: string; description: string | null; imageSha256: string | null };
}

test('description: set, cleared, bounded, and delivered by pull', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const item = await newItem(app, mgr, { description: '  Crisp and hot  ' });
  assert.equal(item.description, 'Crisp and hot');
  assert.equal((await app.inject({ method: 'PATCH', url: `/items/${item.id}`, headers: mgr, payload: { description: 'x'.repeat(301) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/items/${item.id}`, headers: mgr, payload: { description: '' } })).statusCode, 400);

  const dev = await enrolDevice(app, mgr, A, 'a1@example.test');
  assert.equal((await pullItem(app, dev, item.id)).row.data.description, 'Crisp and hot');

  const cleared = await app.inject({ method: 'PATCH', url: `/items/${item.id}`, headers: mgr, payload: { description: null } });
  assert.equal(cleared.json().description, null);
});

test('a picture is stored by hash, kept out of pull, served immutably, and walled off per tenant', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const item = await newItem(app, mgr);
  const png = picture();
  const hash = sha(png);

  const put = await putImage(app, mgr, item.id, png);
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().imageSha256, hash);

  const dev = await enrolDevice(app, mgr, A, 'a1@example.test');
  const { row, bodies } = await pullItem(app, dev, item.id);
  assert.equal(row.data.imageSha256, hash, 'pull carries the hash');
  for (const b of bodies) {
    assert.ok(!b.includes(png.toString('base64')), 'pull does not carry the bytes');
    assert.ok(!b.includes(png.toString('hex')) && !b.includes('\\\\x89504e47'), 'nor as hex');
  }

  const got = await app.inject({ method: 'GET', url: `/device/item-images/${hash}`, headers: dev });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(String(got.headers['cache-control']), /immutable/);
  assert.equal(sha(got.rawPayload), hash, 'served bytes match the address');
  // The bytes are in the object store, under this tenant's prefix, and not in Postgres.
  assert.deepEqual(await getObject(tenantKey(A, hash)), png);
  assert.equal(await objectExists(tenantKey(B, hash)), false, 'nothing under another tenant');
  assert.equal(await objectExists(catalogKey(hash)), false);
  const cols = (await withTenant(A, (c) => c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'item_image'"))).rows.map((r) => r.column_name);
  assert.ok(!cols.includes('bytes'), 'the index table holds no bytes');
  const again = await app.inject({ method: 'GET', url: `/device/item-images/${hash}`, headers: { ...dev, 'if-none-match': `"${hash}"` } });
  assert.equal(again.statusCode, 304);
  assert.equal((await app.inject({ method: 'GET', url: `/item-images/${hash}`, headers: mgr })).statusCode, 200);

  // Tenant B knows the hash and still cannot read A's picture, with either credential.
  const mgrB = await login(app, B, 'b1@example.test');
  const devB = await enrolDevice(app, mgrB, B, 'b1@example.test');
  assert.equal((await app.inject({ method: 'GET', url: `/device/item-images/${hash}`, headers: devB })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/item-images/${hash}`, headers: mgrB })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/device/item-images/${hash}` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/device/item-images/not-a-hash', headers: dev })).statusCode, 400);
});

test('only real, small pictures are accepted; the bytes decide, not the header', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const item = await newItem(app, mgr);
  assert.equal((await putImage(app, mgr, item.id, Buffer.from('<svg onload="x"/>'), 'image/png')).statusCode, 400, 'not an image');
  assert.equal((await putImage(app, mgr, item.id, picture(), 'image/jpeg')).statusCode, 400, 'declared type differs from the bytes');
  assert.equal((await putImage(app, mgr, item.id, Buffer.concat([solidPng(1, 2, 3, 8), Buffer.alloc(70_000)]))).statusCode, 413, 'over 64 KB');
  assert.equal((await putImage(app, mgr, '00000000-0000-4000-8000-0000000000ff', picture())).statusCode, 404);
  // A cashier-level or device credential is not a manager.
  const dev = await enrolDevice(app, mgr, A, 'a1@example.test');
  const asDevice = await app.inject({ method: 'PUT', url: `/items/${item.id}/image`, headers: { ...dev, 'content-type': 'image/png' }, payload: picture() });
  assert.ok([401, 403].includes(asDevice.statusCode));
});

test('a picture shared by two items is stored once and deleted with its last user', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const [one, two] = [await newItem(app, mgr), await newItem(app, mgr)];
  const png = picture();
  const hash = sha(png);
  await putImage(app, mgr, one.id, png);
  await putImage(app, mgr, two.id, png);
  assert.equal(await imageRows(A, hash), 1);
  assert.equal(await objectExists(tenantKey(A, hash)), true);

  assert.equal((await app.inject({ method: 'DELETE', url: `/items/${one.id}/image`, headers: mgr })).statusCode, 200);
  assert.equal(await imageRows(A, hash), 1, 'still used by the other item');
  assert.equal(await objectExists(tenantKey(A, hash)), true, 'and its object stays');
  // Replacing the picture releases the old one: row and object.
  const replacement = picture();
  await putImage(app, mgr, two.id, replacement);
  assert.equal(await imageRows(A, hash), 0, 'nothing refers to it any more');
  assert.equal(await objectExists(tenantKey(A, hash)), false, 'object removed with the last reference');
  assert.equal(await imageRows(A, sha(replacement)), 1);
  assert.equal(await objectExists(tenantKey(A, sha(replacement))), true);
  // Deleting the item releases its picture.
  await app.inject({ method: 'DELETE', url: `/items/${two.id}`, headers: mgr });
  assert.equal(await imageRows(A, sha(replacement)), 0);
  assert.equal(await objectExists(tenantKey(A, sha(replacement))), false);
});

test('a tenant cannot store more than the picture limit', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const item = await newItem(app, mgr);
  const before = (await withTenant(A, async (c) => (await c.query('SELECT count(*)::int n FROM item_image')).rows[0].n)) as number;
  const filler = `filler-${uniq()}`;
  try {
    await withTenant(A, (c) => c.query(
      `INSERT INTO item_image (tenant_id, sha256, content_type, byte_size)
       SELECT $1, md5($2 || g::text) || md5($2 || g::text || 'x'), 'image/png', 1 FROM generate_series(1, $3::int) g`,
      [A, filler, 500 - before]));
    assert.equal((await putImage(app, mgr, item.id, picture())).statusCode, 409);
  } finally {
    await withTenant(A, (c) => c.query("DELETE FROM item_image WHERE byte_size = 1"));
  }
  assert.equal((await putImage(app, mgr, item.id, picture())).statusCode, 200, 'fits again once room is made');
});

// ---- operator side --------------------------------------------------------------------------------------------------
const plat = (t: string) => ({ authorization: `Platform ${t}` });
async function platformLogin(app: App, email: string) {
  await platformPool.query('UPDATE platform_admin SET totp_last_step = 0, failed_logins = 0, locked_until = NULL, active = true WHERE lower(email) = $1', [email]);
  const r = await app.inject({ method: 'POST', url: '/platform/login', payload: { email, password: PW, code: totpCode(SECRET, totpStep(Date.now())) } });
  assert.equal(r.statusCode, 200);
  return plat(r.json().token);
}

test('template pictures: uploaded once, referenced by hash, copied to the tenant once per distinct picture', async () => {
  const app = buildApp();
  const owner = await platformLogin(app, 'owner@platform.test');
  const png = picture();
  const hash = sha(png);
  const up = () => app.inject({ method: 'PUT', url: '/platform/catalog-images', headers: { ...owner, 'content-type': 'image/png' }, payload: png });
  assert.equal((await up()).json().sha256, hash);
  assert.equal((await up()).statusCode, 200, 'idempotent');
  assert.equal((await platformPool.query('SELECT count(*)::int n FROM catalog_image WHERE sha256 = $1', [hash])).rows[0].n, 1);

  const unknown = sha(Buffer.from('never uploaded'));
  const mk = (items: object[]) => app.inject({ method: 'POST', url: '/platform/catalog-templates', headers: owner,
    payload: { name: `Pics ${uniq()}`, categories: [{ name: 'C', items }] } });
  assert.equal((await mk([{ name: 'Ghost', gstRateBp: 0, pricePaise: 100, imageSha256: unknown }])).statusCode, 400, 'a picture that was never uploaded');
  assert.equal((await mk([{ name: 'Long', gstRateBp: 0, pricePaise: 100, description: 'x'.repeat(301) }])).statusCode, 400);

  const made = await mk([
    { name: 'Samosa', gstRateBp: 500, pricePaise: 1500, description: 'Crisp potato samosa', imageSha256: hash },
    { name: 'Kachori', gstRateBp: 500, pricePaise: 2000, imageSha256: hash },
    { name: 'Plain', gstRateBp: 0, pricePaise: 500 },
  ]);
  assert.equal(made.statusCode, 201, made.body);
  const tpl = made.json();
  assert.equal(tpl.categories[0].items[0].description, 'Crisp potato samosa');
  assert.equal(tpl.categories[0].items[0].imageSha256, hash);
  assert.equal(tpl.categories[0].items[2].imageSha256, null);

  const fetched = await app.inject({ method: 'GET', url: `/platform/catalog-images/${hash}`, headers: owner });
  assert.equal(fetched.statusCode, 200);
  assert.equal(sha(fetched.rawPayload), hash);

  const tenant = (await app.inject({ method: 'POST', url: '/platform/tenants', headers: owner, payload: { name: `Pics ${uniq()}` } })).json().id as string;
  assert.equal((await app.inject({ method: 'POST', url: `/platform/tenants/${tenant}/seed-catalog`, headers: owner, payload: { templateId: tpl.id } })).statusCode, 201);
  const items = await withTenant(tenant, async (c) => (await c.query('SELECT name, description, image_sha256 FROM item ORDER BY name')).rows);
  assert.deepEqual(items.map((r) => [r.name, r.description, r.image_sha256]), [
    ['Kachori', null, hash], ['Plain', null, null], ['Samosa', 'Crisp potato samosa', hash],
  ]);
  assert.equal(await imageRows(tenant, hash), 1, 'one stored picture for two items');
  assert.deepEqual(await getObject(tenantKey(tenant, hash)), png, 'copied into the tenant prefix');
  assert.deepEqual(await getObject(catalogKey(hash)), png, 'the template keeps its own');
});

test('template pictures: operator-only writes, nothing for the tenant role or support', async () => {
  const app = buildApp();
  const support = await platformLogin(app, 'support@platform.test');
  const png = picture();
  assert.equal((await app.inject({ method: 'PUT', url: '/platform/catalog-images', headers: { ...support, 'content-type': 'image/png' }, payload: png })).statusCode, 403);
  const owner = await platformLogin(app, 'owner@platform.test');
  assert.equal((await app.inject({ method: 'PUT', url: '/platform/catalog-images', headers: { ...owner, 'content-type': 'image/png' }, payload: Buffer.from('nope') })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/platform/catalog-images/${sha(png)}`, headers: support })).statusCode, 404, 'support may read; nothing there');
  await assert.rejects(pool.query('SELECT 1 FROM catalog_image'), /permission denied/);
  // item_image rows never change: the tenant role cannot UPDATE them.
  await assert.rejects(withTenant(A, (c) => c.query("UPDATE item_image SET content_type = 'image/webp'")), /permission denied/);
});

test('re-using a picture while its last user releases it never leaves an item pointing at nothing', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  for (let round = 0; round < 12; round++) {
    const [one, two] = [await newItem(app, mgr), await newItem(app, mgr)];
    const png = picture();
    const hash = sha(png);
    assert.equal((await putImage(app, mgr, one.id, png)).statusCode, 200);
    // One request drops the only reference while another starts using the same picture.
    const [drop, take] = await Promise.all([
      app.inject({ method: 'DELETE', url: `/items/${one.id}/image`, headers: mgr }),
      putImage(app, mgr, two.id, png),
    ]);
    assert.equal(drop.statusCode, 200);
    assert.equal(take.statusCode, 200);
    assert.equal(await imageRows(A, hash), 1, `round ${round}: index row kept for the item that uses it`);
    assert.equal(await objectExists(tenantKey(A, hash)), true, `round ${round}: object kept`);
    const served = await app.inject({ method: 'GET', url: `/item-images/${hash}`, headers: mgr });
    assert.equal(served.statusCode, 200, `round ${round}: still served`);
    await app.inject({ method: 'DELETE', url: `/items/${two.id}`, headers: mgr });
  }
});
