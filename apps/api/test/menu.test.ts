import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PW = 'dev-password-123';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const device = (c: string) => ({ authorization: `Device ${c}` });
const send = (app: App, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(t), ...(payload === undefined ? {} : { payload: payload as object }) });

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', payload: { tenantId, email, password: PW } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function outletOf(tenantId: string, email: string) {
  return (await withTenant(tenantId, (c) => c.query(
    `SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id
       FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id JOIN outlet o ON o.id = uo.outlet_id WHERE lower(u.email) = $1`, [email]))).rows[0] as { id: string; counter_id: string };
}
async function enrol(app: App, mgrToken: string, tenantId: string, email: string) {
  const o = await outletOf(tenantId, email);
  const code = (await send(app, 'POST', '/enrolment-codes', mgrToken, { outletId: o.id, counterId: o.counter_id })).json().code as string;
  return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
}
const pull = async (app: App, cred: string, cursor: number) => {
  const r = await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: device(cred) });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { cursor: number; hasMore: boolean; changes: { type: string; id: string; version: number; deleted: boolean; data: any }[] };
};

/** Follows hasMore to the end; returns the final cursor and everything delivered. */
async function pullAll(app: App, cred: string, from = 0) {
  const changes: Awaited<ReturnType<typeof pull>>['changes'] = [];
  let cursor = from;
  for (let i = 0; i < 100; i++) {
    const r = await pull(app, cred, cursor);
    changes.push(...r.changes);
    cursor = r.cursor;
    if (!r.hasMore) return { cursor, changes };
  }
  throw new Error('pull did not terminate');
}

test('catalogue CRUD, tombstones, and in-use protection', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');

  const cat = (await send(app, 'POST', '/categories', t, { name: 'Test Cat' })).json();
  assert.equal((await send(app, 'PATCH', `/categories/${cat.id}`, t, { name: 'Test Cat 2', sortOrder: 7 })).json().sortOrder, 7);
  const item = (await send(app, 'POST', '/items', t, { categoryId: cat.id, name: 'Test Item' })).json();
  assert.equal((await send(app, 'PUT', `/items/${item.id}/prices/counter`, t, { pricePaise: 2500, gstRateBp: 500 })).statusCode, 200);
  // Upsert, not duplicate
  assert.equal((await send(app, 'PUT', `/items/${item.id}/prices/counter`, t, { pricePaise: 3000, gstRateBp: 500 })).json().pricePaise, 3000);

  const menu = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(t) })).json();
  assert.equal(menu.prices.filter((p: any) => p.itemId === item.id).length, 1);

  assert.equal((await send(app, 'PATCH', `/items/${item.id}`, t, { name: 'Renamed' })).json().name, 'Renamed');
  assert.equal((await send(app, 'DELETE', `/categories/${cat.id}`, t)).statusCode, 409, 'category with live items');
  assert.equal((await send(app, 'DELETE', `/items/${item.id}`, t)).statusCode, 200);
  assert.equal((await send(app, 'DELETE', `/items/${item.id}`, t)).statusCode, 404, 'already deleted');
  assert.equal((await send(app, 'DELETE', `/categories/${cat.id}`, t)).statusCode, 200);

  const rows = await withTenant(A, (c) => c.query('SELECT deleted_at FROM item_price WHERE item_id = $1', [item.id]));
  assert.ok(rows.rows.every((r) => r.deleted_at), 'prices tombstoned with their item');
  const gone = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(t) })).json();
  assert.ok(!gone.items.some((i: any) => i.id === item.id));
});

test('manager B cannot see or touch tenant A catalogue; foreign ids are 404/400', async () => {
  const app = buildApp();
  const ta = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const cat = (await send(app, 'POST', '/categories', ta, { name: 'A only' })).json();
  const item = (await send(app, 'POST', '/items', ta, { categoryId: cat.id, name: 'A item' })).json();

  const seenByB = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(tb) })).json();
  assert.ok(!seenByB.categories.some((c: any) => c.id === cat.id));
  assert.ok(!seenByB.items.some((i: any) => i.id === item.id));

  assert.equal((await send(app, 'PATCH', `/categories/${cat.id}`, tb, { name: 'hijack' })).statusCode, 404);
  assert.equal((await send(app, 'DELETE', `/categories/${cat.id}`, tb)).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/items/${item.id}`, tb, { name: 'hijack' })).statusCode, 404);
  assert.equal((await send(app, 'DELETE', `/items/${item.id}`, tb)).statusCode, 404);
  assert.equal((await send(app, 'PUT', `/items/${item.id}/prices/counter`, tb, { pricePaise: 1, gstRateBp: 0 })).statusCode, 404);
  assert.equal((await send(app, 'POST', '/items', tb, { categoryId: cat.id, name: 'smuggled' })).statusCode, 400);
  const after = (await withTenant(A, (c) => c.query('SELECT name FROM category WHERE id = $1', [cat.id]))).rows[0];
  assert.equal(after.name, 'A only');
});

test('validation: money must be integer paise in range; unknown fields and channels rejected', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const cat = (await send(app, 'POST', '/categories', t, { name: 'Val' })).json();
  const item = (await send(app, 'POST', '/items', t, { categoryId: cat.id, name: 'ValItem' })).json();
  const put = (ch: string, body: unknown) => send(app, 'PUT', `/items/${item.id}/prices/${ch}`, t, body);
  for (const body of [
    { pricePaise: 12.5, gstRateBp: 0 }, { pricePaise: -1, gstRateBp: 0 }, { pricePaise: '100', gstRateBp: 0 },
    { pricePaise: 100_000_001, gstRateBp: 0 }, { pricePaise: 100, gstRateBp: 4001 }, { pricePaise: 100, gstRateBp: 5.5 },
    { pricePaise: 100, gstRateBp: 0, extra: 1 }, { pricePaise: 1e400, gstRateBp: 0 },
  ]) assert.equal((await put('counter', body)).statusCode, 400, JSON.stringify(body));
  assert.equal((await put('uber', { pricePaise: 100, gstRateBp: 0 })).statusCode, 400);
  assert.equal((await send(app, 'POST', '/categories', t, { name: '' })).statusCode, 400);
  assert.equal((await send(app, 'POST', '/categories', t, { name: 'x'.repeat(101) })).statusCode, 400);
  assert.equal((await send(app, 'PATCH', `/items/${item.id}`, t, {})).statusCode, 400, 'empty patch');
  assert.equal((await send(app, 'PATCH', '/items/not-a-uuid', t, { name: 'x' })).statusCode, 400);
});

test('catalogue admin requires a manager session: none 401, device 403', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const cred = await enrol(app, t, A, 'a1@example.test');
  assert.equal((await app.inject({ method: 'POST', url: '/categories', payload: { name: 'x' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/categories', headers: device(cred), payload: { name: 'x' } })).statusCode, 403);
  // and a manager session is not a device
  assert.equal((await app.inject({ method: 'GET', url: '/sync/pull', headers: bearer(t) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/sync/pull' })).statusCode, 401);
});

test('pull: full sync, then only changes and tombstones; cursor is stable; tenant-isolated', async () => {
  const app = buildApp();
  const ta = await token(app, A, 'a1@example.test');
  const credA = await enrol(app, ta, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const credB = await enrol(app, tb, B, 'b1@example.test');

  const full = await pullAll(app, credA);
  assert.ok(full.changes.length > 0);
  for (let i = 1; i < full.changes.length; i++) assert.ok(full.changes[i]!.version > full.changes[i - 1]!.version, 'strictly increasing');
  const aIds = new Set(full.changes.map((c) => c.id));
  const fullB = await pullAll(app, credB);
  assert.ok(fullB.changes.every((c) => !aIds.has(c.id)), 'B pulled one of A\'s rows');
  assert.ok(fullB.changes.length > 0);

  const idle = await pull(app, credA, full.cursor);
  assert.deepEqual({ ...idle, changes: [] }, { cursor: full.cursor, hasMore: false, changes: [] });
  assert.equal(idle.changes.length, 0);

  const cat = (await send(app, 'POST', '/categories', ta, { name: 'Pull Cat' })).json();
  const item = (await send(app, 'POST', '/items', ta, { categoryId: cat.id, name: 'Pull Item' })).json();
  await send(app, 'PUT', `/items/${item.id}/prices/counter`, ta, { pricePaise: 4200, gstRateBp: 500 });
  const delta = await pull(app, credA, full.cursor);
  assert.deepEqual(delta.changes.map((c) => c.type), ['category', 'item', 'item_price']);
  assert.equal(delta.changes[2]!.data.pricePaise, 4200);
  assert.ok(delta.cursor > full.cursor);

  await send(app, 'DELETE', `/items/${item.id}`, ta);
  const tomb = await pull(app, credA, delta.cursor);
  assert.ok(tomb.changes.some((c) => c.type === 'item' && c.id === item.id && c.deleted), 'item tombstone delivered');
  assert.ok(tomb.changes.some((c) => c.type === 'item_price' && c.deleted), 'price tombstone delivered');

  // Tenant B never sees A's changes.
  const bAfter = await pull(app, credB, fullB.cursor);
  assert.equal(bAfter.changes.length, 0);
});

test('pull pages without gaps or duplicates across the page boundary', async () => {
  const app = buildApp();
  const ta = await token(app, A, 'a1@example.test');
  const cred = await enrol(app, ta, A, 'a1@example.test');
  await withTenant(A, (c) => c.query("INSERT INTO category (tenant_id, name) SELECT $1, 'bulk ' || g FROM generate_series(1, 1100) g", [A]));

  const seen: number[] = [];
  let cursor = 0;
  let pages = 0;
  for (;;) {
    const r = await pull(app, cred, cursor);
    pages++;
    seen.push(...r.changes.map((c) => c.version));
    cursor = r.cursor;
    if (!r.hasMore) break;
    assert.ok(pages < 50);
  }
  assert.ok(pages >= 3, `expected multiple pages, got ${pages}`);
  assert.equal(new Set(seen).size, seen.length, 'duplicate versions across pages');
  const outlet = await outletOf(A, 'a1@example.test');
  const expected = await withTenant(A, (c) => c.query(`
    SELECT version::int FROM category UNION ALL SELECT version::int FROM item UNION ALL SELECT version::int FROM item_price
    UNION ALL SELECT version::int FROM outlet_item WHERE outlet_id = $1
    UNION ALL SELECT version::int FROM outlet WHERE id = $1
    UNION ALL SELECT version::int FROM tenant_setting
    UNION ALL SELECT version::int FROM outlet_price WHERE outlet_id = $1
    UNION ALL SELECT version::int FROM counter WHERE id = $2
    UNION ALL SELECT version::int FROM counter_item WHERE counter_id = $2
    UNION ALL SELECT GREATEST(u.version, uo.version)::int FROM user_outlet uo JOIN app_user u ON u.id = uo.user_id
               WHERE uo.outlet_id = $1 AND u.role IN ('cashier', 'waiter')
    ORDER BY 1`, [outlet.id, outlet.counter_id]));
  assert.deepEqual(seen, expected.rows.map((r) => r.version), 'pages must equal the full ordered set');
});

test('pull is scoped to the device outlet: another outlet\'s stock changes are not delivered', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const cred1 = await enrol(app, t1, A, 'a1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const itemId = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(t1) })).json().items.find((i: any) => i.name === 'Samosa').id as string;

  const base = (await pullAll(app, cred1)).cursor;
  assert.equal((await send(app, 'PUT', `/outlets/${o2.id}/items/${itemId}`, t2, { available: false })).statusCode, 200);
  assert.equal((await pull(app, cred1, base)).changes.length, 0, 'outlet 2 change leaked to outlet 1 device');

  assert.equal((await send(app, 'PUT', `/outlets/${o1.id}/items/${itemId}`, t1, { available: false })).statusCode, 200);
  const mine = await pull(app, cred1, base);
  assert.deepEqual(mine.changes.map((c) => [c.type, c.id, c.data.available]), [['outlet_item', itemId, false]]);
});

test('stock toggle: only at your own outlet, only for your tenant\'s items', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const ob = await outletOf(B, 'b1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const itemA = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(t1) })).json().items[0].id as string;
  const itemB = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(tb) })).json().items[0].id as string;

  assert.equal((await send(app, 'PUT', `/outlets/${o2.id}/items/${itemA}`, t1, { available: true })).statusCode, 404, 'sibling outlet');
  assert.equal((await send(app, 'PUT', `/outlets/${ob.id}/items/${itemA}`, t1, { available: true })).statusCode, 404, 'other tenant outlet');
  assert.equal((await send(app, 'PUT', `/outlets/${o1.id}/items/${itemB}`, t1, { available: true })).statusCode, 404, 'other tenant item');
  assert.equal((await send(app, 'PUT', `/outlets/${o1.id}/items/${itemA}`, t1, { available: 'yes' })).statusCode, 400);
  assert.equal((await send(app, 'PUT', `/outlets/${o1.id}/items/${itemA}`, t1, { available: true })).statusCode, 200);
});

test('versions commit in order: a second writer waits for the first to commit', async () => {
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    for (const c of [c1, c2]) {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    }
    const v1 = (await c1.query("INSERT INTO category (tenant_id, name) VALUES ($1, 'ord-1') RETURNING version::int v", [A])).rows[0].v;
    let second: number | undefined;
    const p2 = c2.query("INSERT INTO category (tenant_id, name) VALUES ($1, 'ord-2') RETURNING version::int v", [A]).then((r) => { second = r.rows[0].v; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(second, undefined, 'second writer must block until the first commits (else versions can commit out of order)');
    await c1.query('COMMIT');
    await p2;
    assert.equal(second, v1 + 1);
    await c2.query('COMMIT');
  } finally {
    c1.release();
    c2.release();
  }
});

test('menu mutations are audited', async () => {
  const actions = await withTenant(A, (c) => c.query("SELECT DISTINCT action FROM audit WHERE action LIKE ANY (ARRAY['category.%','item.%','price.%','stock.%'])"));
  const set = new Set(actions.rows.map((r) => r.action));
  for (const a of ['category.create', 'category.update', 'category.delete', 'item.create', 'item.update', 'item.delete', 'price.set', 'stock.set']) {
    assert.ok(set.has(a), `audit missing ${a}`);
  }
});
