// Tables and quick codes over the API (PLAN D14, D16; phase 12 step 2), against real Postgres.
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
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const send = (app: App, method: Method, url: string, t: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(t), ...(payload === undefined ? {} : { payload: payload as object }) });
const uniq = () => `Z${String(Date.now() % 100000)}${Math.floor(Math.random() * 10)}`; // fits the 10-character code limit

async function token(app: App, tenantId: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenantId) }, payload: { email, password: 'dev-password-123' } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}
async function outletOf(tenantId: string, email: string) {
  return (await withTenant(tenantId, (c) => c.query(
    `SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id, o.name
       FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id JOIN outlet o ON o.id = uo.outlet_id WHERE lower(u.email) = $1`, [email]))).rows[0] as { id: string; counter_id: string; name: string };
}
async function enrol(app: App, mgrToken: string, o: { id: string; counter_id: string }) {
  const code = (await send(app, 'POST', '/enrolment-codes', mgrToken, { outletId: o.id, counterId: o.counter_id })).json().code as string;
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

test('a manager creates, lists, renames and removes tables at their own outlet', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  const code = uniq();

  const made = await send(app, 'POST', `/outlets/${o.id}/tables`, t, { code });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().code, code);
  assert.equal(made.json().isDefault, false);

  const list = (await send(app, 'GET', `/outlets/${o.id}/tables`, t)).json();
  assert.ok(['default', 'map'].includes(list.tableMode));
  const def = list.tables.filter((x: any) => x.isDefault);
  assert.equal(def.length, 1, 'exactly one default');
  assert.equal(def[0].code, 'T1');
  const ours = list.tables.find((x: any) => x.id === made.json().id);
  assert.equal(ours.hasOpenOrder, false);
  assert.ok(ours.sortOrder > def[0].sortOrder, 'a new table is appended after the others');

  // Same code in another case, or the default's code, is a conflict; the same code at the OTHER outlet is fine.
  assert.equal((await send(app, 'POST', `/outlets/${o.id}/tables`, t, { code: code.toLowerCase() })).statusCode, 409);
  assert.equal((await send(app, 'POST', `/outlets/${o.id}/tables`, t, { code: 'T1' })).statusCode, 409);
  const t2 = await token(app, A, 'a2@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  assert.equal((await send(app, 'POST', `/outlets/${o2.id}/tables`, t2, { code })).statusCode, 201);

  // Bad input.
  for (const bad of [{}, { code: '' }, { code: 'x'.repeat(11) }, { code: '-a' }, { code, extra: 1 }, { code: 5 }]) {
    assert.equal((await send(app, 'POST', `/outlets/${o.id}/tables`, t, bad)).statusCode, 400, JSON.stringify(bad));
  }

  const renamed = await send(app, 'PATCH', `/outlets/${o.id}/tables/${made.json().id}`, t, { code: `${code}b`, sortOrder: 5 });
  assert.deepEqual([renamed.statusCode, renamed.json().code, renamed.json().sortOrder], [200, `${code}b`, 5]);
  assert.equal((await send(app, 'PATCH', `/outlets/${o.id}/tables/${made.json().id}`, t, {})).statusCode, 400);
  // The default can be renamed (and renamed back).
  assert.equal((await send(app, 'PATCH', `/outlets/${o.id}/tables/${def[0].id}`, t, { code: 'Counter' })).statusCode, 200);
  assert.equal((await send(app, 'PATCH', `/outlets/${o.id}/tables/${def[0].id}`, t, { code: 'T1' })).statusCode, 200);

  assert.equal((await send(app, 'DELETE', `/outlets/${o.id}/tables/${made.json().id}`, t)).statusCode, 200);
  assert.equal((await send(app, 'DELETE', `/outlets/${o.id}/tables/${made.json().id}`, t)).statusCode, 404, 'already gone');
  const after = (await send(app, 'GET', `/outlets/${o.id}/tables`, t)).json().tables;
  assert.ok(!after.some((x: any) => x.id === made.json().id));
  // A removed table's code can be used again.
  assert.equal((await send(app, 'POST', `/outlets/${o.id}/tables`, t, { code: `${code}b` })).statusCode, 201);
});

test('the default table and a table with an open order cannot be removed', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  const def = (await send(app, 'GET', `/outlets/${o.id}/tables`, t)).json().tables.find((x: any) => x.isDefault);
  const gone = await send(app, 'DELETE', `/outlets/${o.id}/tables/${def.id}`, t);
  assert.deepEqual([gone.statusCode, gone.json().error], [409, 'the default table cannot be removed']);

  const mine = (await send(app, 'POST', `/outlets/${o.id}/tables`, t, { code: uniq() })).json();
  const sale = await withTenant(A, async (c) => {
    const x = (await c.query(
      `SELECT d.id AS device, (SELECT u.id FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
                                WHERE uo.outlet_id = $1 AND u.role = 'cashier' LIMIT 1) AS cashier
         FROM device d WHERE d.outlet_id = $1 LIMIT 1`, [o.id])).rows[0];
    return (await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, table_id, status, menu_version, subtotal_paise, tax_paise, total_paise, created_at_device)
       VALUES (gen_random_uuid(), $1, $2, '2026-03-01', $3, $4, $5, 'open', 1, 1000, 0, 1000, now()) RETURNING id`,
      [A, o.id, x.device, x.cashier, mine.id])).rows[0].id as string;
  });
  const busy = await send(app, 'DELETE', `/outlets/${o.id}/tables/${mine.id}`, t);
  assert.deepEqual([busy.statusCode, busy.json().error], [409, 'table has an open order']);
  assert.equal((await send(app, 'GET', `/outlets/${o.id}/tables`, t)).json().tables.find((x: any) => x.id === mine.id).hasOpenOrder, true);

  await withTenant(A, (c) => c.query("UPDATE sale SET status = 'void', void_reason = 'test' WHERE id = $1", [sale]));
  assert.equal((await send(app, 'DELETE', `/outlets/${o.id}/tables/${mine.id}`, t)).statusCode, 200, 'free again once the order is closed');
});

test('table mode is set per outlet and validated', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const o = await outletOf(A, 'a1@example.test');
  assert.equal((await send(app, 'PUT', `/outlets/${o.id}/table-mode`, t, { mode: 'map' })).statusCode, 200);
  assert.equal((await send(app, 'GET', `/outlets/${o.id}/tables`, t)).json().tableMode, 'map');
  for (const bad of [{ mode: 'grid' }, {}, { mode: 'map', x: 1 }]) assert.equal((await send(app, 'PUT', `/outlets/${o.id}/table-mode`, t, bad)).statusCode, 400);
  assert.equal((await send(app, 'PUT', `/outlets/${o.id}/table-mode`, t, { mode: 'default' })).statusCode, 200);
});

test('whose: another outlet, another tenant, staff and devices cannot touch an outlet\'s tables', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const tb = await token(app, B, 'b1@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const ob = await outletOf(B, 'b1@example.test');
  const mine = (await send(app, 'POST', `/outlets/${o1.id}/tables`, t1, { code: uniq() })).json();
  const theirs = (await send(app, 'POST', `/outlets/${o2.id}/tables`, t2, { code: uniq() })).json();

  const attempts = (outletId: string, tableId: string): [Method, string, unknown?][] => [
    ['GET', `/outlets/${outletId}/tables`],
    ['POST', `/outlets/${outletId}/tables`, { code: uniq() }],
    ['PATCH', `/outlets/${outletId}/tables/${tableId}`, { code: uniq() }],
    ['DELETE', `/outlets/${outletId}/tables/${tableId}`],
    ['PUT', `/outlets/${outletId}/table-mode`, { mode: 'map' }],
  ];
  // Sibling outlet's manager, other tenant's manager: not found, never "forbidden" (nothing is revealed).
  for (const [m, u, b] of attempts(o1.id, mine.id)) {
    assert.equal((await send(app, m, u, t2, b)).statusCode, 404, `sibling manager: ${m} ${u}`);
    assert.equal((await send(app, m, u, tb, b)).statusCode, 404, `other tenant manager: ${m} ${u}`);
  }
  // Own outlet in the path, but a table that belongs to the sibling outlet: not found, and untouched.
  assert.equal((await send(app, 'PATCH', `/outlets/${o1.id}/tables/${theirs.id}`, t1, { code: uniq() })).statusCode, 404);
  assert.equal((await send(app, 'DELETE', `/outlets/${o1.id}/tables/${theirs.id}`, t1)).statusCode, 404);
  assert.ok((await send(app, 'GET', `/outlets/${o2.id}/tables`, t2)).json().tables.some((x: any) => x.id === theirs.id), 'sibling table untouched');
  // Another tenant's outlet and table ids.
  assert.equal((await send(app, 'GET', `/outlets/${ob.id}/tables`, t1)).statusCode, 404);

  // No credential, a device, a cashier and a waiter: refused by permission before any lookup.
  for (const [m, u, b] of attempts(o1.id, mine.id)) {
    assert.equal((await app.inject({ method: m, url: u, ...(b === undefined ? {} : { payload: b as object }) })).statusCode, 401, `no credential: ${m} ${u}`);
  }
  const cred = await enrol(app, t1, o1);
  // Staff made here with a PIN of our own: the seeded PINs are changed and locked by other suites.
  const staff = async (role: 'cashier' | 'waiter') => {
    const made = await send(app, 'POST', '/users', t1, { name: `Table test ${role} ${uniq()}`, role, pin: PIN, outletIds: [o1.id] });
    assert.equal(made.statusCode, 201, made.body);
    const r = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: made.json().id, pin: PIN } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().token as string;
  };
  const cashier = await staff('cashier');
  const waiter = await staff('waiter');
  for (const [m, u, b] of attempts(o1.id, mine.id)) {
    assert.equal((await app.inject({ method: m, url: u, headers: { authorization: `Device ${cred}` }, ...(b === undefined ? {} : { payload: b as object }) })).statusCode, 403, `device: ${m} ${u}`);
    assert.equal((await send(app, m, u, cashier, b)).statusCode, 403, `cashier: ${m} ${u}`);
    assert.equal((await send(app, m, u, waiter, b)).statusCode, 403, `waiter: ${m} ${u}`);
  }
});

test('pull delivers an outlet\'s tables, its table mode and every code; a removal is a tombstone; sibling tables stay out', async () => {
  const app = buildApp();
  const t1 = await token(app, A, 'a1@example.test');
  const t2 = await token(app, A, 'a2@example.test');
  const o1 = await outletOf(A, 'a1@example.test');
  const o2 = await outletOf(A, 'a2@example.test');
  const cred = await enrol(app, t1, o1);

  const full = await pullAll(app, cred);
  const tables = full.changes.filter((c) => c.type === 'dining_table');
  assert.ok(tables.some((c) => c.data.isDefault && c.data.code === 'T1'));
  const dbIds = (await withTenant(A, (c) => c.query('SELECT id FROM dining_table WHERE outlet_id = $1', [o1.id]))).rows.map((r) => r.id).sort();
  assert.deepEqual(tables.map((c) => c.id).sort(), dbIds, 'exactly this outlet\'s tables');
  assert.ok(full.changes.filter((c) => c.type === 'category').every((c) => /^[0-9]{2}$/.test(c.data.code)));
  assert.ok(full.changes.filter((c) => c.type === 'item').every((c) => /^[0-9]{2}$/.test(c.data.code)));
  assert.ok(['default', 'map'].includes(full.changes.find((c) => c.type === 'outlet')!.data.tableMode));

  const made = (await send(app, 'POST', `/outlets/${o1.id}/tables`, t1, { code: uniq() })).json();
  await send(app, 'POST', `/outlets/${o2.id}/tables`, t2, { code: uniq() });
  const next = await pullAll(app, cred, full.cursor);
  assert.deepEqual(next.changes.map((c) => [c.type, c.id, c.deleted]), [['dining_table', made.id, false]], 'only this outlet\'s new table');
  await send(app, 'DELETE', `/outlets/${o1.id}/tables/${made.id}`, t1);
  const gone = await pullAll(app, cred, next.cursor);
  assert.deepEqual(gone.changes.map((c) => [c.type, c.id, c.deleted]), [['dining_table', made.id, true]]);

  const modeCursor = gone.cursor;
  await send(app, 'PUT', `/outlets/${o1.id}/table-mode`, t1, { mode: 'map' });
  const m = await pullAll(app, cred, modeCursor);
  assert.equal(m.changes.find((c) => c.type === 'outlet')?.data.tableMode, 'map');
  await send(app, 'PUT', `/outlets/${o1.id}/table-mode`, t1, { mode: 'default' });
});

test('categories and items: codes are handed out, typed codes are checked, conflicts are 409', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');

  const c1 = (await send(app, 'POST', '/categories', t, { name: 'Code cat 1' })).json();
  const c2 = (await send(app, 'POST', '/categories', t, { name: 'Code cat 2' })).json();
  assert.match(c1.code, /^[0-9]{2}$/);
  assert.equal(Number(c2.code), Number(c1.code) + 1);
  assert.ok((await send(app, 'GET', '/menu', t)).json().categories.every((c: any) => /^[0-9]{2}$/.test(c.code)));

  assert.equal((await send(app, 'POST', '/categories', t, { name: 'Dup', code: c1.code })).statusCode, 409);
  for (const bad of ['1', '001', 'ab', '1a', '']) assert.equal((await send(app, 'POST', '/categories', t, { name: 'Bad', code: bad })).statusCode, 400, bad);
  assert.equal((await send(app, 'PATCH', `/categories/${c2.id}`, t, { code: c1.code })).statusCode, 409);
  const free = String(Number(c2.code) + 40).padStart(2, '0');
  const set = await send(app, 'PATCH', `/categories/${c2.id}`, t, { code: free });
  assert.deepEqual([set.statusCode, set.json().code], [200, free]);

  const i1 = (await send(app, 'POST', '/items', t, { categoryId: c1.id, name: 'Code item 1' })).json();
  const i2 = (await send(app, 'POST', '/items', t, { categoryId: c1.id, name: 'Code item 2' })).json();
  assert.deepEqual([i1.code, i2.code], ['01', '02']);
  assert.equal((await send(app, 'POST', '/items', t, { categoryId: c1.id, name: 'Dup', code: '02' })).statusCode, 409);
  assert.equal((await send(app, 'PATCH', `/items/${i1.id}`, t, { code: '02' })).statusCode, 409);
  assert.equal((await send(app, 'PATCH', `/items/${i1.id}`, t, { code: '07' })).json().code, '07');

  // A move reports the code the item has NOW: kept when free in the new category, else the next free one.
  const other = (await send(app, 'POST', '/categories', t, { name: 'Code cat 3' })).json();
  await send(app, 'POST', '/items', t, { categoryId: other.id, name: 'Taken 01' }); // other/01
  const kept = await send(app, 'PATCH', `/items/${i1.id}`, t, { categoryId: other.id }); // was 07, free in other
  assert.deepEqual([kept.statusCode, kept.json().code, kept.json().categoryId], [200, '07', other.id]);
  const moved = await send(app, 'PATCH', `/items/${i2.id}`, t, { categoryId: other.id }); // was 02, free too
  assert.equal(moved.json().code, '02');
  const clash = (await send(app, 'POST', '/items', t, { categoryId: c1.id, name: 'Clash', code: '02' })).json(); // c1/02 again
  const bumped = await send(app, 'PATCH', `/items/${clash.id}`, t, { categoryId: other.id }); // 02 now taken in other
  assert.match(bumped.json().code, /^[0-9]{2}$/);
  assert.notEqual(bumped.json().code, '02');
  assert.equal('oldCode' in bumped.json(), false, 'only the new code is reported');
});

test('a category with 99 live items answers 409 "no free code" instead of a server error', async () => {
  const app = buildApp();
  const t = await token(app, A, 'a1@example.test');
  const cat = (await send(app, 'POST', '/categories', t, { name: 'Full cat' })).json();
  await withTenant(A, (c) => c.query("INSERT INTO item (tenant_id, category_id, name) SELECT $1, $2, 'f' || g FROM generate_series(1, 99) g", [A, cat.id]));
  const r = await send(app, 'POST', '/items', t, { categoryId: cat.id, name: 'One too many' });
  assert.deepEqual([r.statusCode, r.json().error], [409, 'no free code']);
});
