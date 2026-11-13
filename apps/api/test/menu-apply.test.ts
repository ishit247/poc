// POST /menu/apply: the manager menu editor's one-transaction Save (docs/manager-menu-editor-plan.md, step 2),
// against real Postgres.
import test from 'node:test';
import { hostFor } from './hosts.js';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
const NOWHERE = '00000000-0000-4000-8000-0000000000ff';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const send = (app: App, method: Method, url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
const apply = (app: App, t: string, diff: unknown) => send(app, 'POST', '/menu/apply', t, diff);
const uniq = () => `T${Date.now() % 1000000}${Math.floor(Math.random() * 1000)}`;

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenantId) }, payload: { email, password: 'dev-password-123' } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function outletOf(tenantId: string, email: string) {
  return (await withTenant(tenantId, (c) => c.query(
    `SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id
       FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id JOIN outlet o ON o.id = uo.outlet_id WHERE lower(u.email) = $1`, [email]))).rows[0] as { id: string; counter_id: string };
}
const auditFor = async (tenantId: string, ids: string[]) =>
  (await withTenant(tenantId, (c) => c.query('SELECT action, entity_id FROM audit WHERE entity_id = ANY($1::uuid[])', [ids]))).rows as { action: string; entity_id: string }[];
const itemRow = async (tenantId: string, id: string) =>
  (await withTenant(tenantId, (c) => c.query('SELECT name, category_id, deleted_at FROM item WHERE id = $1', [id]))).rows[0];

/** A fresh category with one item priced on the counter, made through the single routes. */
async function seedItem(app: App, t: string) {
  const cat = (await send(app, 'POST', '/categories', t, { name: uniq() })).json();
  const item = (await send(app, 'POST', '/items', t, { categoryId: cat.id, name: uniq() })).json();
  assert.equal((await send(app, 'PUT', `/items/${item.id}/prices/counter`, t, { pricePaise: 2000, gstRateBp: 500 })).statusCode, 200);
  return { cat, item };
}

test('apply creates tag, category, item, three prices and tags in one go; refs map to ids; one audit row each', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const [tagName, catName, itemName] = [uniq(), uniq(), uniq()];
  const r = await apply(app, t, {
    tags: { create: [{ ref: 'tmp-t1', name: tagName }] },
    categories: { create: [{ ref: 'tmp-c1', name: catName }] },
    items: { create: [{ ref: 'tmp-i1', categoryId: 'tmp-c1', name: itemName, hsnCode: '2106', diet: 'veg', tagIds: ['tmp-t1'] }] },
    prices: { set: (['counter', 'zomato', 'swiggy'] as const).map((channel, n) => ({ itemId: 'tmp-i1', channel, pricePaise: 4000 + n * 500, gstRateBp: 500 })) },
  });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  const { 'tmp-t1': tagId, 'tmp-c1': catId, 'tmp-i1': itemId } = out.refs;
  const item = out.items.find((i: any) => i.id === itemId);
  assert.equal(item.name, itemName);
  assert.equal(item.categoryId, catId);
  assert.equal(item.code, '01', 'first code in a new category');
  assert.deepEqual(item.tagIds, [tagId]);
  assert.ok(out.categories.some((c: any) => c.id === catId && c.name === catName));
  assert.ok(out.tags.some((x: any) => x.id === tagId));
  assert.deepEqual(out.prices.filter((p: any) => p.itemId === itemId).map((p: any) => `${p.channel}:${p.pricePaise}`).sort(),
    ['counter:4000', 'swiggy:5000', 'zomato:4500']);
  const actions = (await auditFor(A, [tagId, catId, itemId])).map((a) => a.action).sort();
  assert.deepEqual(actions, ['category.create', 'item.create', 'item.tags', 'price.set', 'price.set', 'price.set', 'tag.create']);
});

test('apply moves, renames, empties a price, deletes an item and the category this change emptied', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const a = await seedItem(app, t);
  const b = await seedItem(app, t);
  assert.equal((await send(app, 'PUT', `/items/${a.item.id}/prices/zomato`, t, { pricePaise: 2500, gstRateBp: 500 })).statusCode, 200);
  const r = await apply(app, t, {
    items: { update: [{ id: a.item.id, name: 'Moved', categoryId: b.cat.id }], delete: [b.item.id] },
    prices: { delete: [{ itemId: a.item.id, channel: 'zomato' }, { itemId: a.item.id, channel: 'swiggy' }] },
    categories: { delete: [a.cat.id] },
  });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  const moved = out.items.find((i: any) => i.id === a.item.id);
  assert.equal(moved.name, 'Moved');
  assert.equal(moved.categoryId, b.cat.id);
  assert.deepEqual(out.prices.filter((p: any) => p.itemId === a.item.id).map((p: any) => p.channel), ['counter'], 'zomato gone; swiggy was never there');
  assert.ok(!out.items.some((i: any) => i.id === b.item.id), 'deleted item not in the menu');
  assert.ok(!out.categories.some((c: any) => c.id === a.cat.id), 'emptied category deleted');
  assert.ok((await itemRow(A, b.item.id)).deleted_at, 'tombstoned, not removed');
});

test('apply is all or nothing: one failing op rolls back every op before it and writes no audit', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { item } = await seedItem(app, t);
  const catName = uniq();
  const before = (await auditFor(A, [item.id])).length;
  const r = await apply(app, t, {
    categories: { create: [{ ref: 'tmp-c', name: catName }] },
    items: { update: [{ id: item.id, name: 'Should not stick' }] },
    prices: { set: [{ itemId: item.id, channel: 'counter', pricePaise: 9900, gstRateBp: 500 }, { itemId: NOWHERE, channel: 'counter', pricePaise: 1, gstRateBp: 0 }] },
  });
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json(), { error: 'not found', op: { list: 'prices.set', index: 1 } });
  assert.notEqual((await itemRow(A, item.id)).name, 'Should not stick');
  const cats = await withTenant(A, (c) => c.query('SELECT 1 FROM category WHERE name = $1', [catName]));
  assert.equal(cats.rowCount, 0, 'category create rolled back');
  const price = await withTenant(A, (c) => c.query("SELECT price_paise::int AS p FROM item_price WHERE item_id = $1 AND channel = 'counter' AND deleted_at IS NULL", [item.id]));
  assert.equal(price.rows[0].p, 2000);
  assert.equal((await auditFor(A, [item.id])).length, before, 'no audit rows from a rolled-back change');

  // A typed code clash inside the change names the op and also rolls back.
  const clash = await apply(app, t, {
    categories: { create: [{ ref: 'tmp-c', name: catName }] },
    items: { create: [{ ref: 'tmp-1', categoryId: 'tmp-c', name: uniq(), code: '07' }, { ref: 'tmp-2', categoryId: 'tmp-c', name: uniq(), code: '07' }] },
  });
  assert.equal(clash.statusCode, 409, clash.body);
  assert.deepEqual(clash.json(), { error: 'code in use', op: { list: 'items.create', index: 1 } });
  assert.equal((await withTenant(A, (c) => c.query('SELECT 1 FROM category WHERE name = $1', [catName]))).rowCount, 0);
});

test('apply cannot touch another tenant: their ids are not found (RLS), and nothing of theirs changes', async () => {
  const app = buildApp();
  const ta = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const theirs = await seedItem(app, tb);
  const theirTag = (await send(app, 'POST', '/tags', tb, { name: uniq() })).json();
  const mine = await seedItem(app, ta);
  const cases: [unknown, string, string][] = [
    [{ items: { update: [{ id: theirs.item.id, name: 'Hijack' }] } }, 'items.update', 'not found'],
    [{ items: { delete: [theirs.item.id] } }, 'items.delete', 'not found'],
    [{ items: { create: [{ ref: 'tmp-x', categoryId: theirs.cat.id, name: uniq() }] } }, 'items.create', 'category not found'],
    [{ items: { update: [{ id: mine.item.id, categoryId: theirs.cat.id }] } }, 'items.update', 'category not found'],
    [{ items: { update: [{ id: mine.item.id, tagIds: [theirTag.id] }] } }, 'items.update', 'tag not found'],
    [{ categories: { update: [{ id: theirs.cat.id, name: 'Hijack' }] } }, 'categories.update', 'not found'],
    [{ categories: { delete: [theirs.cat.id] } }, 'categories.delete', 'not found'],
    [{ prices: { set: [{ itemId: theirs.item.id, channel: 'counter', pricePaise: 1, gstRateBp: 0 }] } }, 'prices.set', 'not found'],
    [{ prices: { delete: [{ itemId: theirs.item.id, channel: 'counter' }] } }, 'prices.delete', 'not found'],
  ];
  for (const [diff, list, error] of cases) {
    const r = await apply(app, ta, diff);
    assert.equal(r.statusCode, 409, `${list}: ${r.body}`);
    assert.deepEqual(r.json(), { error, op: { list, index: 0 } });
  }
  const row = await itemRow(B, theirs.item.id);
  assert.equal(row.name, theirs.item.name);
  assert.equal(row.deleted_at, null);
  const price = await withTenant(B, (c) => c.query("SELECT price_paise::int AS p FROM item_price WHERE item_id = $1 AND channel = 'counter' AND deleted_at IS NULL", [theirs.item.id]));
  assert.equal(price.rows[0].p, 2000);
});

test('apply answers 409 for a row someone else removed, and for a category that still has items', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { cat, item } = await seedItem(app, t);
  const r1 = await apply(app, t, { categories: { delete: [cat.id] } });
  assert.equal(r1.statusCode, 409);
  assert.deepEqual(r1.json(), { error: 'category has items', op: { list: 'categories.delete', index: 0 } });
  assert.equal((await send(app, 'DELETE', `/items/${item.id}`, t)).statusCode, 200);
  const r2 = await apply(app, t, { items: { update: [{ id: item.id, name: uniq() }] } });
  assert.equal(r2.statusCode, 409);
  assert.deepEqual(r2.json(), { error: 'not found', op: { list: 'items.update', index: 0 } });
  const r3 = await apply(app, t, { prices: { set: [{ itemId: item.id, channel: 'counter', pricePaise: 100, gstRateBp: 0 }] } });
  assert.deepEqual(r3.json(), { error: 'not found', op: { list: 'prices.set', index: 0 } });
});

test('apply refuses malformed changes with 400: unknown or duplicate ref, empty, too many, unknown keys', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const r1 = await apply(app, t, { items: { create: [{ ref: 'tmp-i', categoryId: 'tmp-nope', name: uniq() }] } });
  assert.equal(r1.statusCode, 400);
  assert.deepEqual(r1.json(), { error: 'unknown ref', op: { list: 'items.create', index: 0 } });
  const r2 = await apply(app, t, { categories: { create: [{ ref: 'tmp-c', name: uniq() }, { ref: 'tmp-c', name: uniq() }] } });
  assert.equal(r2.statusCode, 400);
  assert.deepEqual(r2.json(), { error: 'duplicate ref', op: { list: 'categories.create', index: 1 } });
  assert.equal((await apply(app, t, {})).json().error, 'nothing to apply');
  const many = Array.from({ length: 251 }, () => NOWHERE);
  assert.equal((await apply(app, t, { items: { delete: many }, categories: { delete: many } })).json().error, 'too many changes');
  for (const diff of [
    { items: { update: [{ id: NOWHERE }] } },                              // changes nothing
    { items: { update: [{ id: NOWHERE, tenantId: B }] } },                 // unknown key
    { menus: {} },
    { items: { create: [{ ref: 'not-a-ref', categoryId: NOWHERE, name: 'x' }] } },
    { prices: { set: [{ itemId: NOWHERE, channel: 'counter', pricePaise: 1, gstRateBp: 4001 }] } },
  ]) assert.equal((await apply(app, t, diff)).statusCode, 400, JSON.stringify(diff));
});

test('only a manager may apply: none 401; device, cashier, waiter 403', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  const code = (await send(app, 'POST', '/enrolment-codes', t, { outletId: o.id, counterId: o.counter_id })).json().code as string;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const staff = async (role: 'cashier' | 'waiter') => {
    const made = await send(app, 'POST', '/users', t, { name: `Apply test ${role} ${uniq()}`, role, pin: PIN, outletIds: [o.id] });
    assert.equal(made.statusCode, 201, made.body);
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: made.json().id, pin: PIN } });
    return r.json().token as string;
  };
  const diff = { categories: { create: [{ ref: 'tmp-c', name: uniq() }] } };
  assert.equal((await app.inject({ method: 'POST', url: '/menu/apply', payload: diff })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/menu/apply', headers: { authorization: `Device ${cred}` }, payload: diff })).statusCode, 403);
  assert.equal((await apply(app, await staff('cashier'), diff)).statusCode, 403);
  assert.equal((await apply(app, await staff('waiter'), diff)).statusCode, 403);
});
