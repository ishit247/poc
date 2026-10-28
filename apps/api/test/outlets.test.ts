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
const send = (app: App, method: 'PUT' | 'DELETE' | 'POST', url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(t), ...(payload === undefined ? {} : { payload: payload as object }) });
const outletMenu = async (app: App, t: string, outletId: string, channel = 'counter') =>
  app.inject({ method: 'GET', url: `/outlets/${outletId}/menu?channel=${channel}`, headers: bearer(t) });
const counterMenu = async (app: App, t: string, counterId: string) =>
  (await app.inject({ method: 'GET', url: `/counters/${counterId}/menu`, headers: bearer(t) })).json().menu as any[];

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', payload: { tenantId, email, password: PW } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function placeOf(tenantId: string, email: string) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT o.id AS outlet_id, c.id, c.code FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
       JOIN outlet o ON o.id = uo.outlet_id JOIN counter c ON c.outlet_id = o.id WHERE lower(u.email) = $1 ORDER BY c.code`, [email]));
  return { outletId: r.rows[0].outlet_id as string, c1: r.rows[0].id as string, c2: r.rows[1].id as string };
}
async function enrolAt(app: App, t: string, outletId: string, counterId: string) {
  const code = (await send(app, 'POST', '/enrolment-codes', t, { outletId, counterId })).json().code as string;
  return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
}
const pullAll = async (app: App, cred: string, from = 0) => {
  const changes: { type: string; id: string; deleted: boolean; data: any }[] = [];
  let cursor = from;
  for (let i = 0; i < 100; i++) {
    const r = await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: { authorization: `Device ${cred}` } });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    changes.push(...j.changes);
    cursor = j.cursor;
    if (!j.hasMore) return { cursor, changes };
  }
  throw new Error('no termination');
};
async function itemIds(app: App, t: string) {
  const items = (await app.inject({ method: 'GET', url: '/menu', headers: bearer(t) })).json().items as { id: string; name: string }[];
  return Object.fromEntries(items.map((i) => [i.name, i.id])) as Record<string, string>;
}
const named = (menu: any[], name: string) => menu.find((e) => e.name === name);

test('seeded outlets have their own menu, prices and GST', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const o2 = await placeOf(A, 'a2@example.test');

  const m1 = await counterMenu(app, t1, o1.c1);
  assert.equal(named(m1, 'Samosa').pricePaise, 1200, 'counter override');
  assert.equal(named(m1, 'Tea').pricePaise, 1000);
  assert.equal(named(m1, 'Tea').gstRateBp, 500, 'A1 is GST-enabled');
  assert.ok(named(m1, 'Veg Sandwich'));

  const m2 = await counterMenu(app, t2, o2.c1);
  assert.equal(named(m2, 'Tea').pricePaise, 900, 'outlet 2 prices Tea differently');
  assert.equal(named(m2, 'Tea').gstRateBp, 0, 'A2 is not GST-registered: 0% whatever the item rate');
  assert.ok(!named(m2, 'Veg Sandwich'), 'outlet 2 does not sell Veg Sandwich');

  // Aggregator price differs per outlet (Q10)
  assert.equal(named((await outletMenu(app, t1, o1.outletId, 'zomato')).json().menu, 'Samosa').pricePaise, 2500);
  assert.equal(named((await outletMenu(app, t2, o2.outletId, 'zomato')).json().menu, 'Samosa').pricePaise, 2600);
  assert.ok(!named((await outletMenu(app, t1, o1.outletId, 'zomato')).json().menu, 'Tea'), 'no zomato price: not sellable there');
});

test('a manager changes their outlet menu, prices and listing; other outlets are unaffected', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const o2 = await placeOf(A, 'a2@example.test');
  const ids = await itemIds(app, t1);
  try {
    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1, { pricePaise: 800 })).statusCode, 200);
    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1, { pricePaise: 850 })).statusCode, 200, 'upsert');
    assert.equal(named(await counterMenu(app, t1, o1.c1), 'Tea').pricePaise, 850);
    assert.equal(named(await counterMenu(app, t2, o2.c1), 'Tea').pricePaise, 900, 'outlet 2 untouched');

    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/menu/items/${ids['Tea']}`, t1, { listed: false })).statusCode, 200);
    assert.ok(!named(await counterMenu(app, t1, o1.c1), 'Tea'));
    // A counter that lists Tea still cannot show what its outlet hides.
    await send(app, 'PUT', `/counters/${o1.c2}/items/${ids['Tea']}`, t1, { listed: true });
    assert.ok(!named(await counterMenu(app, t1, o1.c2), 'Tea'), 'counter widened the outlet menu');
    assert.ok(named(await counterMenu(app, t2, o2.c1), 'Tea'), 'outlet 2 still sells Tea');

    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/menu-mode`, t1, { mode: 'listed' })).statusCode, 200);
    assert.equal((await outletMenu(app, t1, o1.outletId)).json().menu.length, 0, "'listed' outlet with nothing listed sells nothing");
    // A stock toggle writes the same table; it must not list the item as a side effect.
    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/items/${ids['Samosa']}`, t1, { available: true })).statusCode, 200);
    assert.equal((await outletMenu(app, t1, o1.outletId)).json().menu.length, 0, 'stock toggle listed an item');
    assert.equal((await send(app, 'PUT', `/outlets/${o1.outletId}/menu/items/${ids['Samosa']}`, t1, { listed: true })).statusCode, 200);
    assert.deepEqual((await outletMenu(app, t1, o1.outletId)).json().menu.map((e: any) => e.name), ['Samosa']);
  } finally {
    await send(app, 'PUT', `/outlets/${o1.outletId}/menu-mode`, t1, { mode: 'all' });
    await withTenant(A, (c) => c.query('UPDATE outlet_item SET listed = NULL WHERE outlet_id = $1', [o1.outletId])); // back to "no opinion"
    await send(app, 'DELETE', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1);
    await send(app, 'DELETE', `/counters/${o1.c2}/items/${ids['Tea']}`, t1);
  }
  assert.equal(named(await counterMenu(app, t1, o1.c1), 'Tea').pricePaise, 1000, 'restored to catalogue price');
  assert.equal((await send(app, 'DELETE', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1)).statusCode, 404, 'already cleared');
});

test('GST provision: enabling needs a well-formed GSTIN; disabling charges 0%; DB enforces it too', async () => {
  const app = buildApp();
  const t2 = await token(app, A, 'a2@example.test');
  const o2 = await placeOf(A, 'a2@example.test');
  const put = (body: unknown) => send(app, 'PUT', `/outlets/${o2.outletId}/gst`, t2, body);
  try {
    for (const body of [
      { enabled: true }, { enabled: true, gstin: null }, { enabled: true, gstin: 'not-a-gstin' },
      { enabled: true, gstin: '27abcde1234f1z5' }, { enabled: true, gstin: '27ABCDE1234F0Z5' }, { enabled: 'yes' }, { enabled: true, gstin: '27ABCDE1234F1Z5', rate: 1 },
    ]) assert.equal((await put(body)).statusCode, 400, JSON.stringify(body));

    assert.equal((await put({ enabled: true, gstin: '27ABCDE1234F1Z5' })).statusCode, 200);
    assert.equal(named(await counterMenu(app, t2, o2.c1), 'Tea').gstRateBp, 500, 'now charges the item rate');
    assert.equal((await put({ enabled: false, gstin: null })).statusCode, 200);
    assert.equal(named(await counterMenu(app, t2, o2.c1), 'Tea').gstRateBp, 0);

    // Even bypassing the API, the database refuses GST-on without a GSTIN.
    await assert.rejects(
      withTenant(A, (c) => c.query('UPDATE outlet SET gst_enabled = true, gstin = NULL WHERE id = $1', [o2.outletId])),
      /outlet_gst_needs_gstin/);
    await assert.rejects(
      withTenant(A, (c) => c.query("UPDATE outlet SET gstin = 'bad' WHERE id = $1", [o2.outletId])),
      /outlet_gstin_format/);
  } finally {
    await put({ enabled: false, gstin: null });
  }
});

test('HSN code on items: validated, stored, returned and pulled', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await placeOf(A, 'a1@example.test');
  const dev = await enrolAt(app, t, o.outletId, o.c1);
  const base = (await pullAll(app, dev)).cursor;
  const cat = (await send(app, 'POST', '/categories', t, { name: 'HSN cat' })).json();
  for (const bad of ['12', '123456789', 'abcd', '19 05', 1905]) {
    assert.equal((await send(app, 'POST', '/items', t, { categoryId: cat.id, name: 'x', hsnCode: bad })).statusCode, 400, String(bad));
  }
  const item = (await send(app, 'POST', '/items', t, { categoryId: cat.id, name: 'HSN item', hsnCode: '190590' })).json();
  assert.equal(item.hsnCode, '190590');
  const got = await pullAll(app, dev, base);
  assert.equal(got.changes.find((c) => c.type === 'item' && c.id === item.id)!.data.hsnCode, '190590');
});

test('pull delivers outlet settings and overrides to that outlet\'s devices only', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const o1 = await placeOf(A, 'a1@example.test');
  const o2 = await placeOf(A, 'a2@example.test');
  const ids = await itemIds(app, t1);
  const d1 = await enrolAt(app, t1, o1.outletId, o1.c1);
  const d2 = await enrolAt(app, t2, o2.outletId, o2.c1);

  const full1 = await pullAll(app, d1);
  const outletRow = full1.changes.find((c) => c.type === 'outlet')!;
  assert.deepEqual([outletRow.id, outletRow.data.gstEnabled, outletRow.data.gstin, outletRow.data.menuMode], [o1.outletId, true, '27ABCDE1234F1Z5', 'all']);
  assert.ok(full1.changes.filter((c) => c.type === 'outlet').length === 1, "only the device's own outlet");
  const own = new Set((await withTenant(A, (c) => c.query('SELECT id FROM outlet_price WHERE outlet_id = $1', [o1.outletId]))).rows.map((r) => r.id));
  const pulledPrices = full1.changes.filter((c) => c.type === 'outlet_price');
  assert.ok(pulledPrices.length > 0);
  assert.ok(pulledPrices.every((c) => own.has(c.id)), "another outlet's price leaked");
  const base1 = full1.cursor;
  const base2 = (await pullAll(app, d2)).cursor;

  try {
    await send(app, 'PUT', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1, { pricePaise: 777 });
    await send(app, 'PUT', `/outlets/${o1.outletId}/menu-mode`, t1, { mode: 'listed' });
    const g1 = await pullAll(app, d1, base1);
    assert.ok(g1.changes.some((c) => c.type === 'outlet_price' && c.data.pricePaise === 777));
    assert.ok(g1.changes.some((c) => c.type === 'outlet' && c.data.menuMode === 'listed'));
    assert.equal((await pullAll(app, d2, base2)).changes.length, 0, "outlet 1's changes leaked to outlet 2's device");

    await send(app, 'DELETE', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1);
    const tomb = await pullAll(app, d1, g1.cursor);
    assert.ok(tomb.changes.some((c) => c.type === 'outlet_price' && c.deleted), 'price override tombstone delivered');
  } finally {
    await send(app, 'PUT', `/outlets/${o1.outletId}/menu-mode`, t1, { mode: 'all' });
    await send(app, 'DELETE', `/outlets/${o1.outletId}/prices/${ids['Tea']}/counter`, t1);
  }
});

test('scope: a manager can only configure their own outlets; foreign ids are 404 and nothing changes', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const sibling = await placeOf(A, 'a2@example.test');
  const mine = await placeOf(A, 'a1@example.test');
  const foreign = await placeOf(B, 'b1@example.test');
  const ids = await itemIds(app, t1);
  const idsB = await itemIds(app, tb);

  for (const o of [sibling.outletId, foreign.outletId]) {
    assert.equal((await send(app, 'PUT', `/outlets/${o}/menu-mode`, t1, { mode: 'listed' })).statusCode, 404);
    assert.equal((await send(app, 'PUT', `/outlets/${o}/gst`, t1, { enabled: false, gstin: null })).statusCode, 404);
    assert.equal((await send(app, 'PUT', `/outlets/${o}/menu/items/${ids['Tea']}`, t1, { listed: false })).statusCode, 404);
    assert.equal((await send(app, 'PUT', `/outlets/${o}/prices/${ids['Tea']}/counter`, t1, { pricePaise: 1 })).statusCode, 404);
    assert.equal((await send(app, 'DELETE', `/outlets/${o}/prices/${ids['Tea']}/counter`, t1)).statusCode, 404);
    assert.equal((await outletMenu(app, t1, o)).statusCode, 404);
  }
  assert.equal((await send(app, 'PUT', `/outlets/${mine.outletId}/menu-mode`, tb, { mode: 'listed' })).statusCode, 404, 'B manager on A outlet');
  assert.equal((await send(app, 'PUT', `/outlets/${mine.outletId}/prices/${idsB['Tea']}/counter`, t1, { pricePaise: 1 })).statusCode, 404, "another tenant's item");
  assert.equal((await send(app, 'PUT', `/outlets/${mine.outletId}/menu/items/${idsB['Tea']}`, t1, { listed: false })).statusCode, 404);

  const rows = await withTenant(A, (c) => c.query('SELECT id, menu_mode FROM outlet WHERE id = ANY($1)', [[sibling.outletId, mine.outletId]]));
  assert.ok(rows.rows.every((r) => r.menu_mode === 'all'));
  const prices = await withTenant(A, (c) => c.query('SELECT 1 FROM outlet_price WHERE price_paise = 1'));
  assert.equal(prices.rowCount, 0);
});

test('validation and authentication', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await placeOf(A, 'a1@example.test');
  const ids = await itemIds(app, t);
  const price = (ch: string, body: unknown) => send(app, 'PUT', `/outlets/${o.outletId}/prices/${ids['Tea']}/${ch}`, t, body);
  for (const body of [{ pricePaise: 1.5 }, { pricePaise: -1 }, { pricePaise: '5' }, {}, { pricePaise: 5, extra: 1 }, { pricePaise: 100_000_001 }]) {
    assert.equal((await price('counter', body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await price('uber', { pricePaise: 5 })).statusCode, 400);
  assert.equal((await send(app, 'PUT', `/outlets/${o.outletId}/menu-mode`, t, { mode: 'x' })).statusCode, 400);
  assert.equal((await send(app, 'PUT', `/outlets/${o.outletId}/menu/items/${ids['Tea']}`, t, { listed: 'no' })).statusCode, 400);
  assert.equal((await outletMenu(app, t, o.outletId, 'uber')).statusCode, 400);
  assert.equal((await send(app, 'PUT', '/outlets/nope/menu-mode', t, { mode: 'all' })).statusCode, 400);

  assert.equal((await app.inject({ method: 'PUT', url: `/outlets/${o.outletId}/menu-mode`, payload: { mode: 'all' } })).statusCode, 401);
  const dev = await enrolAt(app, t, o.outletId, o.c1);
  assert.equal((await app.inject({ method: 'PUT', url: `/outlets/${o.outletId}/menu-mode`, headers: { authorization: `Device ${dev}` }, payload: { mode: 'all' } })).statusCode, 403);
});

test('outlet changes are audited', async () => {
  const actions = await withTenant(A, (c) => c.query("SELECT DISTINCT action FROM audit WHERE action LIKE 'outlet.%'"));
  const set = new Set(actions.rows.map((r) => r.action));
  for (const a of ['outlet.menu_mode', 'outlet.gst', 'outlet.item_listed', 'outlet.price_set', 'outlet.price_clear']) assert.ok(set.has(a), `audit missing ${a}`);
});
