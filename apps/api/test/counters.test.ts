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
const send = (app: App, method: 'PUT' | 'DELETE', url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(t), ...(payload === undefined ? {} : { payload: payload as object }) });
const getMenu = async (app: App, t: string, counterId: string) =>
  app.inject({ method: 'GET', url: `/counters/${counterId}/menu`, headers: bearer(t) });

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', payload: { tenantId, email, password: PW } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
/** Counters of the manager's outlet, by code (C1, C2), plus the outlet id. */
async function countersOf(tenantId: string, email: string) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT o.id AS outlet_id, c.id, c.code FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
       JOIN outlet o ON o.id = uo.outlet_id JOIN counter c ON c.outlet_id = o.id WHERE lower(u.email) = $1 ORDER BY c.code`, [email]));
  return { outletId: r.rows[0].outlet_id as string, c1: r.rows[0].id as string, c2: r.rows[1].id as string };
}
async function enrolAt(app: App, t: string, outletId: string, counterId: string) {
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(t), payload: { outletId, counterId } })).json().code as string;
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

test('seeded counters: C1 sells everything with a cheaper Samosa; C2 is drinks only; GST is the item\'s', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { c1, c2 } = await countersOf(A, 'a1@example.test');

  const m1 = (await getMenu(app, t, c1)).json();
  assert.equal(m1.mode, 'all');
  const samosa1 = m1.menu.find((e: any) => e.name === 'Samosa');
  assert.equal(samosa1.pricePaise, 1200, 'counter override');
  assert.equal(samosa1.gstRateBp, 500);
  assert.equal(m1.menu.find((e: any) => e.name === 'Tea').pricePaise, 1000, 'no override: catalogue price');

  const m2 = (await getMenu(app, t, c2)).json();
  assert.equal(m2.mode, 'listed');
  assert.deepEqual(m2.menu.map((e: any) => e.name).sort(), ['Cold Coffee', 'Tea']);
  assert.equal(m2.menu.find((e: any) => e.name === 'Cold Coffee').gstRateBp, 1800);
  assert.equal(m2.menu.find((e: any) => e.name === 'Cold Coffee').available, false, 'outlet stock still applies');
});

test('manager edits a counter menu; the change reaches only that counter\'s device', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { outletId, c1, c2 } = await countersOf(A, 'a1@example.test');
  const ids = await itemIds(app, t);
  const dev1 = await enrolAt(app, t, outletId, c1);
  const dev2 = await enrolAt(app, t, outletId, c2);
  const base1 = (await pullAll(app, dev1)).cursor;
  const base2 = (await pullAll(app, dev2)).cursor;

  try {
    assert.equal((await send(app, 'PUT', `/counters/${c1}/items/${ids['Tea']}`, t, { listed: true, pricePaise: 0 })).statusCode, 200);
    assert.equal((await send(app, 'PUT', `/counters/${c1}/items/${ids['Veg Sandwich']}`, t, { listed: false })).statusCode, 200);
    assert.equal((await send(app, 'PUT', `/counters/${c1}/menu-mode`, t, { mode: 'all' })).statusCode, 200);

    const menu = (await getMenu(app, t, c1)).json().menu;
    assert.equal(menu.find((e: any) => e.name === 'Tea').pricePaise, 0, 'override of 0 is a real price');
    assert.ok(!menu.some((e: any) => e.name === 'Veg Sandwich'), 'hidden at this counter');

    const got1 = await pullAll(app, dev1, base1);
    assert.ok(got1.changes.some((c) => c.type === 'counter_item' && c.id === ids['Tea'] && c.data.pricePaise === 0));
    assert.ok(got1.changes.some((c) => c.type === 'counter_item' && c.id === ids['Veg Sandwich'] && c.data.listed === false));
    assert.equal((await pullAll(app, dev2, base2)).changes.filter((c) => c.type === 'counter_item' || c.type === 'counter').length, 0,
      "counter 1's menu rules leaked to counter 2's device");

    // Clearing a rule is a tombstone; the item returns to the counter default.
    const cur = got1.cursor;
    assert.equal((await send(app, 'DELETE', `/counters/${c1}/items/${ids['Veg Sandwich']}`, t)).statusCode, 200);
    assert.equal((await send(app, 'DELETE', `/counters/${c1}/items/${ids['Veg Sandwich']}`, t)).statusCode, 404, 'already cleared');
    const tomb = await pullAll(app, dev1, cur);
    assert.ok(tomb.changes.some((c) => c.type === 'counter_item' && c.id === ids['Veg Sandwich'] && c.deleted));
    assert.ok((await getMenu(app, t, c1)).json().menu.some((e: any) => e.name === 'Veg Sandwich'));
  } finally {
    // Restore the seeded state for other tests.
    await send(app, 'DELETE', `/counters/${c1}/items/${ids['Veg Sandwich']}`, t);
    await send(app, 'DELETE', `/counters/${c1}/items/${ids['Tea']}`, t);
  }
});

test('mode change is pulled by that counter\'s device only', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { outletId, c1, c2 } = await countersOf(A, 'a1@example.test');
  const dev1 = await enrolAt(app, t, outletId, c1);
  const dev2 = await enrolAt(app, t, outletId, c2);
  const base1 = (await pullAll(app, dev1)).cursor;
  const base2 = (await pullAll(app, dev2)).cursor;
  try {
    await send(app, 'PUT', `/counters/${c2}/menu-mode`, t, { mode: 'all' });
    const g2 = await pullAll(app, dev2, base2);
    assert.deepEqual(g2.changes.filter((c) => c.type === 'counter').map((c) => [c.id, c.data.menuMode]), [[c2, 'all']]);
    assert.equal((await pullAll(app, dev1, base1)).changes.filter((c) => c.type === 'counter').length, 0);
  } finally {
    await send(app, 'PUT', `/counters/${c2}/menu-mode`, t, { mode: 'listed' });
  }
});

test('scope: a manager can only configure counters at their own outlets; foreign ids are 404', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const mine = await countersOf(A, 'a1@example.test');
  const sibling = await countersOf(A, 'a2@example.test');
  const foreign = await countersOf(B, 'b1@example.test');
  const ids = await itemIds(app, t1);
  const idsB = await itemIds(app, tb);

  for (const other of [sibling.c1, foreign.c1]) {
    assert.equal((await send(app, 'PUT', `/counters/${other}/menu-mode`, t1, { mode: 'all' })).statusCode, 404);
    assert.equal((await send(app, 'PUT', `/counters/${other}/items/${ids['Tea']}`, t1, { listed: true })).statusCode, 404);
    assert.equal((await send(app, 'DELETE', `/counters/${other}/items/${ids['Tea']}`, t1)).statusCode, 404);
    assert.equal((await getMenu(app, t1, other)).statusCode, 404);
  }
  // tenant B's manager cannot reach tenant A's counter, nor attach A's item to their own counter
  assert.equal((await send(app, 'PUT', `/counters/${mine.c1}/menu-mode`, tb, { mode: 'listed' })).statusCode, 404);
  assert.equal((await send(app, 'PUT', `/counters/${foreign.c1}/items/${ids['Tea']}`, tb, { listed: true })).statusCode, 404);
  assert.equal((await send(app, 'PUT', `/counters/${mine.c1}/items/${idsB['Tea']}`, t1, { listed: true })).statusCode, 404, "another tenant's item");
  const unchanged = await withTenant(A, (c) => c.query('SELECT menu_mode FROM counter WHERE id = $1', [mine.c1]));
  assert.equal(unchanged.rows[0].menu_mode, 'all');
});

test('validation and authentication', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const { outletId, c1 } = await countersOf(A, 'a1@example.test');
  const ids = await itemIds(app, t);
  const put = (body: unknown) => send(app, 'PUT', `/counters/${c1}/items/${ids['Tea']}`, t, body);
  for (const body of [
    { listed: true, pricePaise: 10.5 }, { listed: true, pricePaise: -1 }, { listed: true, pricePaise: '10' },
    { listed: 'yes' }, {}, { listed: true, gstRateBp: 0 }, { listed: true, pricePaise: 100_000_001 },
  ]) assert.equal((await put(body)).statusCode, 400, JSON.stringify(body));
  assert.equal((await send(app, 'PUT', `/counters/${c1}/menu-mode`, t, { mode: 'some' })).statusCode, 400);
  assert.equal((await send(app, 'PUT', '/counters/nope/menu-mode', t, { mode: 'all' })).statusCode, 400);
  assert.equal((await send(app, 'PUT', `/counters/${c1}/items/00000000-0000-4000-8000-0000000000ff`, t, { listed: true })).statusCode, 404, 'unknown item');

  assert.equal((await app.inject({ method: 'PUT', url: `/counters/${c1}/menu-mode`, payload: { mode: 'all' } })).statusCode, 401);
  const dev = await enrolAt(app, t, outletId, c1);
  assert.equal((await app.inject({ method: 'PUT', url: `/counters/${c1}/menu-mode`, headers: { authorization: `Device ${dev}` }, payload: { mode: 'all' } })).statusCode, 403);
});

test('counter menu changes are audited', async () => {
  const actions = await withTenant(A, (c) => c.query("SELECT DISTINCT action FROM audit WHERE action LIKE 'counter.%'"));
  const set = new Set(actions.rows.map((r) => r.action));
  for (const a of ['counter.menu_mode', 'counter.item_set', 'counter.item_clear']) assert.ok(set.has(a), `audit missing ${a}`);
});
