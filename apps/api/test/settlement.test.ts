import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';
import { amountToPaise, parseCsv, parseSettlement } from '../src/settlement.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PIN = '482913';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (app: App, tenant: string, email: string) =>
  (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;

// ---- the parser alone ----

test('amounts become exact paise: commas, currency marks, brackets and minus', () => {
  assert.equal(amountToPaise('1,050.50'), 105050);
  assert.equal(amountToPaise('₹ 99'), 9900);
  assert.equal(amountToPaise('Rs. 0.5'), 50);
  assert.equal(amountToPaise('-12.5'), -1250);
  assert.equal(amountToPaise('(40.00)'), -4000);
  assert.throws(() => amountToPaise('abc'));
  assert.throws(() => amountToPaise('1.234'));
  assert.throws(() => amountToPaise(''));
});

test('CSV: quotes, doubled quotes, commas and newlines inside quotes, CRLF, BOM, blank lines', () => {
  const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\n"two\nlines",z\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
});

test('a statement is read by header name, in any column order', () => {
  const r = parseSettlement('Payout Amount,Order ID,Gross Amount,Notes\n"1,000.00",Z1,"1,200.00",x\n80,Z2,100,y\n');
  assert.ok(r.ok);
  assert.deepEqual(r.lines.map((l) => [l.externalOrderId, l.grossPaise, l.payoutPaise]), [['Z1', 120000, 100000], ['Z2', 10000, 8000]]);
});

test('a bad statement is refused whole, with the row of each fault', () => {
  const noCol = parseSettlement('order id,gross\nZ1,10\n');
  assert.ok(!noCol.ok);
  assert.equal(noCol.errors[0]!.row, 1);
  assert.match(noCol.errors[0]!.message, /header row has no column for: payout/);
  const bad = parseSettlement('order id,gross,payout\nZ1,10,8\nZ1,10,8\n,10,8\nZ3,ten,8\nZ4,-5,1\n');
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors.map((e) => e.row), [3, 4, 5, 6]);
  assert.ok(!parseSettlement('').ok);
  assert.ok(!parseSettlement('order id,gross,payout\n').ok);
});

// ---- the routes, on real Postgres ----

async function handOver(app: App, tenant: string, email: string, outletName: string, ext: string, channel: 'zomato' | 'swiggy' = 'zomato') {
  const mgr = await login(app, tenant, email);
  const o = (await withTenant(tenant, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]));
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const userId = (await withTenant(tenant, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [`${outletName} cashier`])).rows[0].id)) as string;
  const t = (await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } })).json().token as string;
  const item = (await withTenant(tenant, async (c) =>
    (await c.query(`SELECT i.id FROM item i JOIN item_price ip ON ip.item_id = i.id AND ip.channel = $1 AND ip.deleted_at IS NULL WHERE i.deleted_at IS NULL ORDER BY i.name LIMIT 1`, [channel])).rows[0])).id as string;
  const order = (await app.inject({ method: 'POST', url: '/online-orders', headers: bearer(t), payload: { channel, externalOrderId: ext, lines: [{ itemId: item, qty: 1 }] } })).json();
  for (const to of ['accepted', 'ready', 'handed_over']) assert.equal((await app.inject({ method: 'POST', url: `/online-orders/${order.id}/transition`, headers: bearer(t), payload: { to } })).statusCode, 200);
  return { mgr, outletId: o.id as string, total: Number(order.totalPaise), orderId: order.id as string };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);
// A window around today, wide enough for the outlet's local date to fall inside it whatever the timezone.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const upload = (app: App, token: string, outletId: string, csv: string, over: object = {}) =>
  app.inject({ method: 'POST', url: `/outlets/${outletId}/settlement-imports`, headers: bearer(token),
    payload: { channel: 'zomato', filename: 'week.csv', periodFrom: day(-2), periodTo: day(2), csv, ...over } });

test('matching reports matched, amount mismatch, unknown order and missing, and edits no sale', async () => {
  const app = buildApp();
  const tag = randomUUID().slice(0, 6);
  const [ok, off, gone] = [`OK-${tag}`, `OFF-${tag}`, `GONE-${tag}`];
  const w1 = await handOver(app, A, 'a1@example.test', 'School 1 Canteen', ok);
  const w2 = await handOver(app, A, 'a1@example.test', 'School 1 Canteen', off);
  await handOver(app, A, 'a1@example.test', 'School 1 Canteen', gone);
  const before = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n, sum(total_paise)::bigint AS t FROM sale')).rows[0]);

  const csv = ['order id,gross amount,payout',
    `${ok},${rupees(w1.total)},${rupees(w1.total - 100)}`,
    `${off},${rupees(w2.total + 500)},${rupees(w2.total)}`,
    `NOPE-${tag},50.00,40.00`].join('\n');
  const r = await upload(app, w1.mgr, w1.outletId, csv);
  assert.equal(r.statusCode, 201);
  const rep = r.json();
  const by = Object.fromEntries(rep.lines.map((l: { externalOrderId: string; result: string }) => [l.externalOrderId, l.result]));
  assert.equal(by[ok], 'matched');
  assert.equal(by[off], 'amount_mismatch');
  assert.equal(by[`NOPE-${tag}`], 'unknown_order');
  assert.ok(rep.missing.some((m: { externalOrderId: string }) => m.externalOrderId === gone));
  assert.ok(!rep.missing.some((m: { externalOrderId: string }) => m.externalOrderId === ok));
  assert.equal(rep.summary.commissionPaise, rep.summary.grossPaise - rep.summary.payoutPaise);
  // The same statement for a period that has not happened yet: our orders are outside it, so none is "missing".
  const past = (await upload(app, w1.mgr, w1.outletId, csv, { periodFrom: day(-40), periodTo: day(-30) })).json();
  assert.equal(past.missing.length, 0);
  const trail = await withTenant(A, async (c) => (await c.query("SELECT count(*)::int AS n FROM audit WHERE action = 'settlement.import' AND entity_id = $1", [rep.id])).rows[0].n);
  assert.equal(trail, 1);

  const after = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n, sum(total_paise)::bigint AS t FROM sale')).rows[0]);
  assert.deepEqual(after, before);

  const again = await app.inject({ method: 'GET', url: `/outlets/${w1.outletId}/settlement-imports/${rep.id}`, headers: bearer(w1.mgr) });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json().summary, rep.summary);
  const list = (await app.inject({ method: 'GET', url: `/outlets/${w1.outletId}/settlement-imports`, headers: bearer(w1.mgr) })).json();
  assert.ok(list.some((i: { id: string; problems: number }) => i.id === rep.id && i.problems === 2));
});

test('an order at another outlet or on another platform does not match', async () => {
  const app = buildApp();
  const id = `X-${randomUUID().slice(0, 6)}`;
  const w2 = await handOver(app, A, 'a2@example.test', 'School 2 Canteen', id);
  const mgr1 = await login(app, A, 'a1@example.test');
  const outlet1 = (await withTenant(A, async (c) => (await c.query("SELECT id FROM outlet WHERE name = 'School 1 Canteen'")).rows[0].id)) as string;
  const r = await upload(app, mgr1, outlet1, `order id,gross,payout\n${id},${rupees(w2.total)},1\n`);
  assert.equal(r.json().lines[0].result, 'unknown_order');
  // Left out of the statement on purpose: only then could a wrongly unscoped "missing" query list it.
  const other = (await upload(app, mgr1, outlet1, 'order id,gross,payout\nUNRELATED,1,1\n')).json();
  assert.ok(!other.missing.some((m: { externalOrderId: string }) => m.externalOrderId === id), "another outlet's order is not missing here");
  const sw = await upload(app, w2.mgr, w2.outletId, `order id,gross,payout\n${id},${rupees(w2.total)},1\n`, { channel: 'swiggy' });
  assert.equal(sw.json().lines[0].result, 'unknown_order');
});

test('a faulty file writes nothing and says which rows', async () => {
  const app = buildApp();
  const mgr = await login(app, A, 'a1@example.test');
  const outlet = (await withTenant(A, async (c) => (await c.query("SELECT id FROM outlet WHERE name = 'School 1 Canteen'")).rows[0].id)) as string;
  const n0 = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n FROM settlement_import')).rows[0].n);
  const r = await upload(app, mgr, outlet, 'order id,gross,payout\nA,1,1\nA,1,1\nB,x,1\n');
  assert.equal(r.statusCode, 422);
  assert.deepEqual(r.json().errors.map((e: { row: number }) => e.row), [3, 4]);
  assert.equal((await upload(app, mgr, outlet, 'order id,gross,payout\nA,1,1\n', { periodFrom: '2026-02-01', periodTo: '2026-01-01' })).statusCode, 400);
  assert.equal((await upload(app, mgr, outlet, 'order id,gross,payout\nA,1,1\n', { periodFrom: '2020-01-01', periodTo: day(0) })).statusCode, 400);
  const n1 = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n FROM settlement_import')).rows[0].n);
  assert.equal(n1, n0);
});

test('whose: another outlet, another tenant, and a non-manager are all refused', async () => {
  const app = buildApp();
  const tag = randomUUID().slice(0, 6);
  const w = await handOver(app, A, 'a1@example.test', 'School 1 Canteen', `S-${tag}`);
  const rep = (await upload(app, w.mgr, w.outletId, `order id,gross,payout\nS-${tag},${rupees(w.total)},1\n`)).json();
  const outlet2 = (await withTenant(A, async (c) => (await c.query("SELECT id FROM outlet WHERE name = 'School 2 Canteen'")).rows[0].id)) as string;
  const mgr2 = await login(app, A, 'a2@example.test');
  const mgrB = await login(app, B, 'b1@example.test');
  const csv = 'order id,gross,payout\nQ,1,1\n';

  // a2 manages School 2 only
  assert.equal((await upload(app, mgr2, w.outletId, csv)).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/outlets/${w.outletId}/settlement-imports`, headers: bearer(mgr2) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/outlets/${w.outletId}/settlement-imports/${rep.id}`, headers: bearer(mgr2) })).statusCode, 404);
  // the import belongs to outlet 1: asking for it through outlet 2 finds nothing
  assert.equal((await app.inject({ method: 'GET', url: `/outlets/${outlet2}/settlement-imports/${rep.id}`, headers: bearer(mgr2) })).statusCode, 404);
  // tenant B
  assert.equal((await upload(app, mgrB, w.outletId, csv)).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/outlets/${w.outletId}/settlement-imports/${rep.id}`, headers: bearer(mgrB) })).statusCode, 404);
  // a cashier
  const cashier = await (async () => {
    const o = w.outletId;
    const counter = (await withTenant(A, async (c) => (await c.query("SELECT id FROM counter WHERE outlet_id = $1 AND code = 'C1'", [o])).rows[0].id)) as string;
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(w.mgr), payload: { outletId: o, counterId: counter } })).json().code;
    const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
    const userId = (await withTenant(A, async (c) => (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'")).rows[0].id)) as string;
    return (await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId, pin: PIN } })).json().token as string;
  })();
  assert.equal((await upload(app, cashier, w.outletId, csv)).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/outlets/${w.outletId}/settlement-imports`, headers: bearer(cashier) })).statusCode, 403);
});
