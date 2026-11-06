// Diet and tags over the API (PLAN D17; phase 12 step 2b), against real Postgres.
import test from 'node:test';
import { hostFor } from './hosts.js';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const send = (app: App, method: Method, url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
const uniq = () => `T${Date.now() % 1000000}${Math.floor(Math.random() * 100)}`;

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
async function enrol(app: App, mgr: string, o: { id: string; counter_id: string }) {
  const code = (await send(app, 'POST', '/enrolment-codes', mgr, { outletId: o.id, counterId: o.counter_id })).json().code as string;
  return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
}
const pullAll = async (app: App, cred: string, from = 0) => {
  const changes: { type: string; id: string; deleted: boolean; data: any }[] = [];
  let cursor = from;
  for (let i = 0; i < 100; i++) {
    const r = await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: { authorization: `Device ${cred}` } });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    changes.push(...j.changes);
    cursor = j.cursor;
    if (!j.hasMore) return { cursor, changes };
  }
  throw new Error('pull did not terminate');
};
async function newItem(app: App, t: string) {
  const cat = (await send(app, 'POST', '/categories', t, { name: `Tag cat ${uniq()}` })).json();
  return (await send(app, 'POST', '/items', t, { categoryId: cat.id, name: `Tag item ${uniq()}` })).json();
}

test('diet is set, changed, cleared and validated; items list their tag ids', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const item = await newItem(app, t);
  assert.equal(item.diet, null);
  assert.deepEqual(item.tagIds, []);
  for (const d of ['veg', 'egg', 'non_veg', null]) {
    const r = await send(app, 'PATCH', `/items/${item.id}`, t, { diet: d });
    assert.deepEqual([r.statusCode, r.json().diet], [200, d]);
  }
  for (const bad of ['vegan', 'VEG', '', 1]) assert.equal((await send(app, 'PATCH', `/items/${item.id}`, t, { diet: bad })).statusCode, 400, String(bad));
  const made = await send(app, 'POST', '/items', t, { categoryId: item.categoryId, name: `Dot ${uniq()}`, diet: 'non_veg' });
  assert.deepEqual([made.statusCode, made.json().diet], [201, 'non_veg']);
});

test('a manager creates, renames, lists and removes tags; names are unique per tenant; a removed tag leaves its items', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const name = uniq();
  const tag = await send(app, 'POST', '/tags', t, { name });
  assert.equal(tag.statusCode, 201, tag.body);
  assert.equal((await send(app, 'POST', '/tags', t, { name: name.toLowerCase() })).statusCode, 409);
  for (const bad of ['', '   ', 'x'.repeat(31)]) assert.equal((await send(app, 'POST', '/tags', t, { name: bad })).statusCode, 400, bad);
  const renamed = await send(app, 'PATCH', `/tags/${tag.json().id}`, t, { name: `${name}x` });
  assert.deepEqual([renamed.statusCode, renamed.json().name], [200, `${name}x`]);
  assert.ok((await send(app, 'GET', '/tags', t)).json().tags.some((x: any) => x.id === tag.json().id));
  assert.ok((await send(app, 'GET', '/menu', t)).json().tags.some((x: any) => x.id === tag.json().id));

  const item = await newItem(app, t);
  const put = await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [tag.json().id] });
  assert.deepEqual([put.statusCode, put.json().tagIds], [200, [tag.json().id]]);
  assert.equal((await send(app, 'DELETE', `/tags/${tag.json().id}`, t)).statusCode, 200);
  assert.equal((await send(app, 'DELETE', `/tags/${tag.json().id}`, t)).statusCode, 404);
  const after = (await send(app, 'GET', '/menu', t)).json().items.find((i: any) => i.id === item.id);
  assert.deepEqual(after.tagIds, [], 'the removed tag is gone from the item');
  assert.equal((await send(app, 'POST', '/tags', t, { name })).statusCode, 201, 'a removed tag name is free again');
});

test('PUT /items/:id/tags replaces the whole set, ignores duplicates, and refuses unknown, removed or foreign tags', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const item = await newItem(app, t);
  const mk = async (tok: string) => (await send(app, 'POST', '/tags', tok, { name: uniq() })).json().id as string;
  const [x, y, z] = [await mk(t), await mk(t), await mk(t)];
  const foreign = await mk(tb);

  assert.deepEqual((await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [x, y, x] })).json().tagIds.sort(), [x, y].sort());
  assert.deepEqual((await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [y, z] })).json().tagIds.sort(), [y, z].sort());
  assert.deepEqual((await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [] })).json().tagIds, []);
  await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [x] });
  for (const bad of [[foreign], ['00000000-0000-4000-8000-0000000000ff'], ['not-a-uuid']]) {
    assert.equal((await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: bad })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await send(app, 'GET', '/menu', t)).json().items.find((i: any) => i.id === item.id).tagIds, [x], 'a refused request changes nothing');
  await send(app, 'DELETE', `/tags/${z}`, t);
  assert.equal((await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [z] })).statusCode, 400, 'a removed tag cannot be attached');
  assert.equal((await send(app, 'PUT', `/items/00000000-0000-4000-8000-0000000000ff/tags`, t, { tagIds: [] })).statusCode, 404);
  // Another tenant's manager cannot touch this tenant's item or tag.
  assert.equal((await send(app, 'PUT', `/items/${item.id}/tags`, tb, { tagIds: [] })).statusCode, 404);
  assert.equal((await send(app, 'PATCH', `/tags/${x}`, tb, { name: uniq() })).statusCode, 404);
  assert.equal((await send(app, 'DELETE', `/tags/${x}`, tb)).statusCode, 404);
  assert.ok(!(await send(app, 'GET', '/tags', tb)).json().tags.some((q: any) => q.id === x));
});

test('only a manager manages tags: no credential 401; device, cashier, waiter 403', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  const item = await newItem(app, t);
  const tag = (await send(app, 'POST', '/tags', t, { name: uniq() })).json();
  const cred = await enrol(app, t, o);
  const staff = async (role: 'cashier' | 'waiter') => {
    const made = await send(app, 'POST', '/users', t, { name: `Tag test ${role} ${uniq()}`, role, pin: PIN, outletIds: [o.id] });
    assert.equal(made.statusCode, 201, made.body);
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: made.json().id, pin: PIN } });
    return r.json().token as string;
  };
  const cashier = await staff('cashier');
  const waiter = await staff('waiter');
  const calls: [Method, string, unknown][] = [
    ['GET', '/tags', undefined], ['POST', '/tags', { name: uniq() }], ['PATCH', `/tags/${tag.id}`, { name: uniq() }],
    ['DELETE', `/tags/${tag.id}`, undefined], ['PUT', `/items/${item.id}/tags`, { tagIds: [] }],
  ];
  for (const [m, u, b] of calls) {
    assert.equal((await app.inject({ method: m, url: u, ...(b === undefined ? {} : { payload: b as object }) })).statusCode, 401, `none ${m} ${u}`);
    assert.equal((await app.inject({ method: m, url: u, headers: { authorization: `Device ${cred}` }, ...(b === undefined ? {} : { payload: b as object }) })).statusCode, 403, `device ${m} ${u}`);
    assert.equal((await send(app, m, u, cashier, b)).statusCode, 403, `cashier ${m} ${u}`);
    assert.equal((await send(app, m, u, waiter, b)).statusCode, 403, `waiter ${m} ${u}`);
  }
});

test('pull delivers diet, tags and links; changes and removals are versioned rows; another tenant\'s tags stay out', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  const cred = await enrol(app, t, o);
  await send(app, 'POST', '/tags', tb, { name: uniq() }); // tenant B noise

  const full = await pullAll(app, cred);
  const tagRows = full.changes.filter((c) => c.type === 'tag');
  const dbTags = (await withTenant(A, (c) => c.query('SELECT id FROM tag WHERE deleted_at IS NULL'))).rows.map((r) => r.id).sort();
  assert.deepEqual(tagRows.filter((c) => !c.deleted).map((c) => c.id).sort(), dbTags, 'exactly this tenant\'s live tags');
  assert.ok(full.changes.filter((c) => c.type === 'item').every((c) => 'diet' in c.data));
  assert.ok(full.changes.some((c) => c.type === 'item_tag'), 'the seed links items to tags');

  const item = await newItem(app, t);
  const tag = (await send(app, 'POST', '/tags', t, { name: uniq() })).json();
  await send(app, 'PATCH', `/items/${item.id}`, t, { diet: 'egg' });
  await send(app, 'PUT', `/items/${item.id}/tags`, t, { tagIds: [tag.id] });
  const next = await pullAll(app, cred, full.cursor);
  assert.equal(next.changes.find((c) => c.type === 'item' && c.id === item.id)?.data.diet, 'egg');
  assert.ok(next.changes.some((c) => c.type === 'tag' && c.id === tag.id && !c.deleted));
  const link = next.changes.find((c) => c.type === 'item_tag' && !c.deleted && c.data.itemId === item.id);
  assert.equal(link?.data.tagId, tag.id);

  await send(app, 'DELETE', `/tags/${tag.id}`, t);
  const gone = await pullAll(app, cred, next.cursor);
  assert.ok(gone.changes.some((c) => c.type === 'tag' && c.id === tag.id && c.deleted), 'tag tombstone');
  assert.ok(gone.changes.some((c) => c.type === 'item_tag' && c.id === link!.id && c.deleted), 'link tombstone in the same pull');
});
