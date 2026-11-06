// Running orders (phase 12 step 4) through push and ingest, against a real Postgres. The properties under test:
// the server's open sale is the fold of the events it has, whatever order they came in and however often they were
// retried; two devices adding to one table both land; a paid sale never changes; nothing a waiter rang is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, foldOrder, liveLines, totals, paise, type OrderEnvelope, type TradingSettings } from '@pos/shared';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
interface Env { eventId: string; seq: number; createdAt: string; payload: any }
interface Res { eventId: string; status: string; reason?: string }
const statuses = (r: Res[]) => r.map((x) => (x.reason ? `${x.status}:${x.reason}` : x.status));
const DATE = '2026-05-20'; // a day no other suite closes

let clock = Date.now() - 3_600_000;
const tick = () => new Date((clock += 1000)).toISOString();

async function settings(): Promise<TradingSettings> {
  const r = await withTenant(A, async (c) => (await c.query('SELECT gst_rounding, bill_round_to FROM tenant_setting')).rows[0]);
  return r ? { ...DEFAULT_SETTINGS, gstRounding: r.gst_rounding, billRoundTo: r.bill_round_to } : DEFAULT_SETTINGS;
}
/** What the tenant's current settings make of these lines (unit price, qty), all at 5% GST. */
async function totalOf(lines: [number, number][]): Promise<number> {
  return totals(lines.map(([u, qty]) => ({ itemId: 'x', name: 'x', unitPaise: paise(u), gstRateBp: 500, qty })), await settings()).total;
}

class Tab {
  seq = 0;
  receipt = 0;
  constructor(readonly app: App, readonly cred: string, readonly deviceId: string, readonly outletId: string,
              readonly cashierId: string, readonly waiterId: string, readonly teaId: string, readonly tableId: string,
              readonly counterCode = 'C1') {}

  static async enrol(app: App, email = 'a1@example.test', outletName = 'School 1 Canteen', counterCode = 'C1'): Promise<Tab> {
    const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
    const o = await withTenant(A, async (c) =>
      (await c.query(`SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = $2) AS counter_id,
                             (SELECT id FROM dining_table WHERE outlet_id = o.id AND is_default AND deleted_at IS NULL) AS table_id
                        FROM outlet o WHERE o.name = $1`, [outletName, counterCode])).rows[0]);
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
    const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
    const id = (sql: string, args: unknown[]) => withTenant(A, async (c) => (await c.query(sql, args)).rows[0].id as string);
    return new Tab(app, cred, cred.split('.')[1]!, o.id,
      await id('SELECT id FROM app_user WHERE name = $1', [`${outletName} cashier`]),
      await id('SELECT id FROM app_user WHERE name = $1', [`${outletName} waiter`]),
      await id("SELECT id FROM item WHERE name = 'Tea'", []), o.table_id, counterCode);
  }
  /** A second tablet at the same outlet (another counter's device, or a waiter's). */
  static async second(app: App): Promise<Tab> { return Tab.enrol(app); }

  async newTable(): Promise<string> {
    return withTenant(A, async (c) => (await c.query(
      'INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, $3) RETURNING id', [A, this.outletId, `X${Math.random().toString(36).slice(2, 8)}`])).rows[0].id);
  }

  ev(payload: unknown): Env { return { eventId: crypto.randomUUID(), seq: ++this.seq, createdAt: new Date().toISOString(), payload }; }
  open(saleId: string, o: { tableId?: string; by?: string } = {}) {
    return this.ev({ type: 'order.opened', schemaVersion: 2, saleId, tableId: o.tableId ?? this.tableId, createdBy: o.by ?? this.waiterId,
      businessDate: DATE, createdAtDevice: tick(), menuVersion: 1 });
  }
  add(saleId: string, lineId: string, qty: number, o: { price?: number; itemId?: string; by?: string; at?: string } = {}) {
    return this.ev({ type: 'order.line_added', schemaVersion: 2, saleId, lineId, itemId: o.itemId ?? this.teaId, name: 'Tea',
      unitPaise: o.price ?? 1000, gstRateBp: 500, qty, by: o.by ?? this.waiterId, at: o.at ?? tick() });
  }
  change(saleId: string, lineId: string, qty: number, at = tick()) {
    return this.ev({ type: 'order.line_changed', schemaVersion: 2, saleId, lineId, qty, by: this.waiterId, at });
  }
  remove(saleId: string, lineId: string, at = tick()) {
    return this.ev({ type: 'order.line_removed', schemaVersion: 2, saleId, lineId, by: this.waiterId, at });
  }
  move(saleId: string, tableId: string, at = tick()) {
    return this.ev({ type: 'order.moved', schemaVersion: 2, saleId, tableId, by: this.waiterId, at });
  }
  pay(saleId: string, lines: [string, number][], totalPaise: number) {
    const n = ++this.receipt;
    return this.ev({ type: 'payment.taken', schemaVersion: 2, saleId, businessDate: DATE, receiptNo: `${this.counterCode}-${DATE.replaceAll('-', '')}-${n}`, receiptSeq: n,
      payments: [{ method: 'cash', amountPaise: totalPaise, tenderedPaise: totalPaise, changePaise: 0, upiRef: null }],
      lines: lines.map(([lineId, qty]) => ({ lineId, qty })), totalPaise });
  }

  async push(events: Env[]): Promise<Res[]> {
    const r = await this.app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${this.cred}` }, payload: { events } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().results;
  }
}

async function sale(id: string) {
  return withTenant(A, async (c) => (await c.query(
    `SELECT status, flags, total_paise::int AS total, subtotal_paise::int AS subtotal, table_id, order_root_id, receipt_no FROM sale WHERE id = $1`, [id])).rows[0]);
}
/** [lineId, qty, removed] of a sale, in a stable order. */
async function lines(id: string): Promise<[string, number, boolean][]> {
  return withTenant(A, async (c) => (await c.query(
    'SELECT line_id, qty, removed_at IS NOT NULL AS removed FROM sale_line WHERE sale_id = $1 ORDER BY line_id', [id])).rows.map((r) => [r.line_id, r.qty, r.removed]));
}
/** The visit's sales other than the root, oldest first. */
async function splits(rootId: string): Promise<string[]> {
  return withTenant(A, async (c) => (await c.query(
    'SELECT id FROM sale WHERE order_root_id = $1 AND id <> $1 ORDER BY received_at, id', [rootId])).rows.map((r) => r.id));
}
const sorted = (xs: [string, number, boolean][]) => [...xs].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

test('an order is opened, lines added, changed and removed: the open sale holds exactly that, priced from its live lines', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const [s, l1, l2, l3] = ids(4);
  const r = await t.push([t.open(s!), t.add(s!, l1!, 1), t.add(s!, l2!, 2, { price: 500 }), t.add(s!, l3!, 1), t.change(s!, l1!, 3), t.remove(s!, l3!)]);
  assert.deepEqual(statuses(r), Array(6).fill('applied'));
  const row = await sale(s!);
  assert.equal(row.status, 'open');
  assert.equal(row.order_root_id, s);
  assert.equal(row.table_id, t.tableId);
  assert.equal(row.total, await totalOf([[1000, 3], [500, 2]]));
  assert.deepEqual(await lines(s!), sorted([[l1!, 3, false], [l2!, 2, false], [l3!, 1, true]]));
  const versions = await withTenant(A, async (c) => (await c.query('SELECT DISTINCT schema_version FROM sync_event WHERE device_id = $1', [t.deviceId])).rows.map((x) => x.schema_version));
  assert.deepEqual(versions, [2], 'the ledger keeps each event\'s own version');
});

test('a retried or doubled batch of order events changes nothing the second time', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const [s, l1, l2] = ids(3);
  const batch = [t.open(s!), t.add(s!, l1!, 1), t.add(s!, l2!, 1), t.change(s!, l2!, 4)];
  const [r1, r2] = await Promise.all([t.push(batch), t.push(batch)]);
  const all = [...r1, ...r2].map((x) => x.status);
  assert.equal(all.filter((x) => x === 'applied').length, 4);
  assert.equal(all.filter((x) => x === 'duplicate').length, 4);
  assert.deepEqual(statuses(await t.push(batch)), Array(4).fill('duplicate'));
  assert.deepEqual(await lines(s!), sorted([[l1!, 1, false], [l2!, 4, false]]));
  assert.equal((await sale(s!)).total, await totalOf([[1000, 5]]));
});

test('out of order: line events before their order or their line wait (deferred), then apply in full', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app);
  const b = await Tab.second(app);
  const [s, l1] = ids(2);
  const open = a.open(s!);
  const add = a.add(s!, l1!, 1);
  const change = b.change(s!, l1!, 5);
  assert.deepEqual(statuses(await b.push([change])), ['deferred:sale_not_yet_received']);
  assert.deepEqual(statuses(await a.push([open])), ['applied']);
  assert.deepEqual(statuses(await b.push([change])), ['deferred:line_not_yet_received']);
  assert.deepEqual(statuses(await a.push([add])), ['applied']);
  assert.deepEqual(statuses(await b.push([change])), ['applied']);
  assert.deepEqual(await lines(s!), [[l1!, 5, false]]);
});

test('two devices add to one table while offline: both land (union); D18 lets any staff device here change the order', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app);
  const b = await Tab.second(app);
  const [s, la, lb] = ids(3);
  const fromA = [a.open(s!), a.add(s!, la!, 2)];
  const fromB = [b.add(s!, lb!, 1, { price: 700, by: b.cashierId })];
  // B's add reaches the server first, before the order itself: it waits, then lands.
  assert.deepEqual(statuses(await b.push(fromB)), ['deferred:sale_not_yet_received']);
  assert.deepEqual(statuses(await a.push(fromA)), ['applied', 'applied']);
  assert.deepEqual(statuses(await b.push(fromB)), ['applied']);
  // B (not the device that opened it) changes A's line.
  assert.deepEqual(statuses(await b.push([b.change(s!, la!, 3)])), ['applied']);
  assert.deepEqual(await lines(s!), sorted([[la!, 3, false], [lb!, 1, false]]));
  assert.equal((await sale(s!)).total, await totalOf([[1000, 3], [700, 1]]));

  // Concurrent pushes from both devices onto the same order: every line lands once.
  const more = [ids(5), ids(5)];
  const [ra, rb] = await Promise.all([a.push(more[0]!.map((l) => a.add(s!, l, 1))), b.push(more[1]!.map((l) => b.add(s!, l, 1, { by: b.cashierId })))]);
  assert.ok([...ra, ...rb].every((x) => x.status === 'applied'), JSON.stringify([...ra, ...rb]));
  assert.equal((await lines(s!)).length, 12);
});

test('who and what: another outlet\'s device, an unknown person, item or table, and a v1/v2 mix are refused', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const other = await Tab.enrol(app, 'a2@example.test', 'School 2 Canteen');
  const [s, l1, l2] = ids(3);
  assert.deepEqual(statuses(await t.push([t.open(s!), t.add(s!, l1!, 1)])), ['applied', 'applied']);
  assert.deepEqual(statuses(await other.push([other.add(s!, l2!, 1, { by: other.waiterId, itemId: t.teaId })])), ['rejected:wrong_outlet']);
  // The other outlet's waiter is not staff here.
  assert.deepEqual(statuses(await t.push([t.add(s!, l2!, 1, { by: other.waiterId })])), ['rejected:unknown_user']);
  assert.deepEqual(statuses(await t.push([t.add(s!, l2!, 1, { itemId: crypto.randomUUID() })])), ['rejected:unknown_item']);
  assert.deepEqual(statuses(await t.push([t.move(s!, crypto.randomUUID())])), ['rejected:unknown_table']);
  assert.deepEqual(statuses(await t.push([t.open(crypto.randomUUID(), { tableId: other.tableId })])), ['rejected:unknown_table']);
  assert.deepEqual(statuses(await t.push([t.open(crypto.randomUUID(), { by: other.waiterId })])), ['rejected:unknown_user']);
  // A line event whose add was refused can never apply: it is refused too, not left waiting.
  assert.deepEqual(statuses(await t.push([t.change(s!, l2!, 2)])), ['rejected:line_rejected']);

  // v1 payment for an order, v2 payment for a whole sale: neither is something a tablet writes.
  const total = await totalOf([[1000, 1]]);
  const v1 = t.pay(s!, [[l1!, 1]], total);
  v1.payload = { ...v1.payload, schemaVersion: 1, lines: undefined, totalPaise: undefined };
  delete v1.payload.lines; delete v1.payload.totalPaise;
  assert.deepEqual(statuses(await t.push([v1])), ['rejected:order_needs_v2_payment']);
  const whole = crypto.randomUUID();
  const net = 1000, tax = 50;
  const created = t.ev({ type: 'sale.created', schemaVersion: 1, saleId: whole, channel: 'counter', createdBy: t.cashierId, businessDate: DATE,
    createdAtDevice: tick(), menuVersion: 1, lines: [{ itemId: t.teaId, name: 'Tea', unitPaise: 1000, gstRateBp: 500, qty: 1, netPaise: net, taxPaise: tax }],
    subtotalPaise: net, taxPaise: tax, roundOffPaise: 0, totalPaise: net + tax });
  assert.deepEqual(statuses(await t.push([created, t.pay(whole, [[crypto.randomUUID(), 1]], net + tax)])), ['applied', 'rejected:not_an_order']);
  // Versions: an order event at v1, a payment at v3.
  const old = t.open(crypto.randomUUID());
  old.payload.schemaVersion = 1;
  const future = t.pay(s!, [[l1!, 1]], total);
  future.payload.schemaVersion = 3;
  assert.deepEqual(statuses(await t.push([old, future])), ['rejected:unsupported_schema_version', 'rejected:unsupported_schema_version']);
});

test('one order id, one order: a re-queued identical open or add is the same; a different one is refused', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const [s, l1] = ids(2);
  const open = t.open(s!);
  const add = t.add(s!, l1!, 2);
  assert.deepEqual(statuses(await t.push([open, add])), ['applied', 'applied']);
  // Same payloads under new outbox entries (new event id and seq): applied, and still one order with one line.
  assert.deepEqual(statuses(await t.push([t.ev(open.payload), t.ev(add.payload)])), ['applied', 'applied']);
  assert.deepEqual(await lines(s!), [[l1!, 2, false]]);
  // Same ids, different content.
  assert.deepEqual(statuses(await t.push([t.open(s!, { by: t.cashierId }), t.add(s!, l1!, 3)])), ['rejected:sale_exists', 'rejected:line_conflict']);
  assert.deepEqual(await lines(s!), [[l1!, 2, false]]);
  // A second order on a busy table is allowed, and flagged.
  const s2 = crypto.randomUUID();
  assert.deepEqual(statuses(await t.push([t.open(s2)])), ['applied']);
  assert.deepEqual((await sale(s2)).flags, ['table_shared']);
});

test('paid: the sale holds the paid lines; a line that arrives later splits off onto a new open order on the same table', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app);
  const b = await Tab.second(app);
  const [s, l1, l2, late1, late2] = ids(5);
  await a.push([a.open(s!), a.add(s!, l1!, 2), a.add(s!, l2!, 1, { price: 400 })]);
  const total = await totalOf([[1000, 2], [400, 1]]);
  assert.deepEqual(statuses(await a.push([a.pay(s!, [[l1!, 2], [l2!, 1]], total)])), ['applied']);
  const paid = await sale(s!);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.total, total);
  assert.deepEqual(await splits(s!), [], 'nothing was left over');

  // A waiter's line, rung up before the payment but delivered after it.
  assert.deepEqual(statuses(await b.push([b.add(s!, late1!, 1, { by: b.waiterId })])), ['applied']);
  const [x] = await splits(s!);
  assert.ok(x, 'a split was opened');
  const split = await sale(x!);
  assert.equal(split.status, 'open');
  assert.equal(split.table_id, a.tableId);
  assert.deepEqual(split.flags, ['late_lines']);
  assert.deepEqual(await lines(x!), [[late1!, 1, false]]);
  // The paid sale did not change.
  assert.deepEqual(await sale(s!), paid);
  assert.deepEqual(await lines(s!), sorted([[l1!, 2, false], [l2!, 1, false]]));
  // More late lines join the same split, whichever sale id they name.
  assert.deepEqual(statuses(await b.push([b.add(x!, late2!, 2, { by: b.waiterId })])), ['applied']);
  assert.deepEqual(await splits(s!), [x]);
  assert.deepEqual(await lines(x!), sorted([[late1!, 1, false], [late2!, 2, false]]));

  // The split is paid like any order (by the device that holds the visit), and is then closed too.
  const t2 = await totalOf([[1000, 3]]);
  assert.deepEqual(statuses(await a.push([a.pay(x!, [[late1!, 1], [late2!, 2]], t2)])), ['applied']);
  assert.equal((await sale(x!)).status, 'paid');
  const takings = await withTenant(A, async (c) => (await c.query(
    'SELECT sum(p.amount_paise)::int AS t FROM payment p JOIN sale s ON s.id = p.sale_id WHERE s.order_root_id = $1', [s])).rows[0].t);
  assert.equal(takings, total + t2, 'every line was paid for exactly once');
});

test('after payment: removing or changing a paid line is refused already_paid, and the paid sale stays as it was', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app);
  const b = await Tab.second(app);
  const [s, l1] = ids(2);
  await a.push([a.open(s!), a.add(s!, l1!, 2)]);
  const removeLate = b.remove(s!, l1!);
  const changeLate = b.change(s!, l1!, 5);
  assert.deepEqual(statuses(await a.push([a.pay(s!, [[l1!, 2]], await totalOf([[1000, 2]]))])), ['applied']);
  const before = await sale(s!);
  assert.deepEqual(statuses(await b.push([removeLate, changeLate])), ['rejected:already_paid', 'rejected:already_paid']);
  assert.deepEqual(await sale(s!), before);
  assert.deepEqual(await lines(s!), [[l1!, 2, false]]);
  assert.deepEqual(await splits(s!), []);
  const audited = await withTenant(A, async (c) => (await c.query(
    `SELECT count(*)::int AS n FROM audit WHERE action = 'sync.rejected' AND entity_id IN ($1, $2)`, [removeLate.eventId, changeLate.eventId])).rows[0].n);
  assert.equal(audited, 2, 'each refusal is recorded');
});

test('the payment wins: a removal or a lowering that got there first is overridden and audited; a raise leaves the excess open', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app);
  const b = await Tab.second(app);
  const [s, l1, l2, l3, l4] = ids(5);
  await a.push([a.open(s!), a.add(s!, l1!, 2), a.add(s!, l2!, 1, { price: 500 }), a.add(s!, l3!, 3, { price: 300 })]);
  // The cashier totals 2 x l1, 1 x l2, 3 x l3. Meanwhile another device removes l1, raises l2 to 4, lowers l3 to 1,
  // and adds l4, all reaching the server before the payment does.
  const total = await totalOf([[1000, 2], [500, 1], [300, 3]]);
  const payment = a.pay(s!, [[l1!, 2], [l2!, 1], [l3!, 3]], total);
  assert.deepEqual(statuses(await b.push([b.remove(s!, l1!), b.change(s!, l2!, 4), b.change(s!, l3!, 1), b.add(s!, l4!, 1, { price: 200 })])),
    ['applied', 'applied', 'applied', 'applied']);
  assert.deepEqual(statuses(await a.push([payment])), ['applied']);

  const paid = await sale(s!);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.total, total, 'paid as listed');
  assert.ok(paid.flags.includes('payment_overrode'));
  assert.deepEqual(await lines(s!), sorted([[l1!, 2, false], [l2!, 1, false], [l3!, 3, false]]));
  const audit = await withTenant(A, async (c) => (await c.query(
    `SELECT detail->>'lineId' AS line, detail->>'kind' AS kind FROM audit WHERE action = 'order.payment_overrode' AND entity_id = $1 ORDER BY 1`, [s])).rows);
  assert.deepEqual(audit, [{ line: l1, kind: 'removed' }, { line: l3, kind: 'reduced' }].sort((x, y) => (x.line! < y.line! ? -1 : 1)));
  // The 3 extra of l2 (under the same line id) and the unpaid l4 are not lost: they are open on a split.
  const [x] = await splits(s!);
  assert.deepEqual(await lines(x!), sorted([[l2!, 3, false], [l4!, 1, false]]));
  assert.equal((await sale(x!)).total, await totalOf([[500, 3], [200, 1]]));
});

test('payment arithmetic: a wrong total is refused; a total under other rounding settings is accepted and flagged', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const [s, l1, l9] = ids(3);
  await t.push([t.open(s!), t.add(s!, l1!, 1)]);
  const right = await totalOf([[1000, 1]]);
  assert.deepEqual(statuses(await t.push([t.pay(s!, [[l1!, 1]], right + 1)])), ['rejected:payment_total_mismatch']);
  // A payment for a line this server has not seen waits for it.
  assert.deepEqual(statuses(await t.push([t.pay(s!, [[l1!, 1], [l9!, 1]], right * 2)])), ['deferred:line_not_yet_received']);
  // The tablet rounded the bill to 1.00 under settings the manager has since changed.
  const s0 = await settings();
  const other = s0.billRoundTo === 100 ? 0 : 100;
  const theirs = totals([{ itemId: 'x', name: 'x', unitPaise: paise(1050), gstRateBp: 500, qty: 1 }], { ...s0, billRoundTo: other }).total;
  const [s2, m1] = ids(2);
  await t.push([t.open(s2!), t.add(s2!, m1!, 1, { price: 1050 })]);
  const mine = await totalOf([[1050, 1]]);
  assert.notEqual(theirs, mine, 'the fixture must differ between the two settings');
  t.receipt = 5; // the refused payments above used receipt numbers that were never issued
  assert.deepEqual(statuses(await t.push([t.pay(s2!, [[m1!, 1]], theirs)])), ['applied']);
  const row = await sale(s2!);
  assert.equal(row.total, theirs);
  assert.ok(row.flags.includes('settings_differ'));
});

test('void: an order voided before payment takes no more lines', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const [s, l1, l2] = ids(3);
  await t.push([t.open(s!), t.add(s!, l1!, 1)]);
  const v = t.ev({ type: 'sale.voided', schemaVersion: 1, saleId: s, reason: 'abandoned_at_shift_close', at: tick() });
  assert.deepEqual(statuses(await t.push([v])), ['applied']);
  assert.deepEqual(statuses(await t.push([t.add(s!, l2!, 1), t.remove(s!, l1!), t.move(s!, t.tableId)])), ['rejected:sale_void', 'rejected:sale_void', 'rejected:sale_void']);
  assert.deepEqual(await lines(s!), [[l1!, 1, false]]);
  assert.deepEqual(await splits(s!), []);
});

test('moving an order changes its table; a move after it was settled is refused', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const t2 = await t.newTable();
  const [s, l1] = ids(2);
  assert.deepEqual(statuses(await t.push([t.open(s!), t.add(s!, l1!, 1), t.move(s!, t2)])), ['applied', 'applied', 'applied']);
  assert.equal((await sale(s!)).table_id, t2);
  await t.push([t.pay(s!, [[l1!, 1]], await totalOf([[1000, 1]]))]);
  assert.deepEqual(statuses(await t.push([t.move(s!, t.tableId)])), ['rejected:not_open']);
  assert.equal((await sale(s!)).table_id, t2);
});

// --- property: the server's open sale is the fold, whatever the delivery order

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: any delivery order, with retries, leaves the server\'s order equal to the fold of its events', async () => {
  const app = buildApp();
  const devs = [await Tab.enrol(app), await Tab.second(app)];
  const tables = [devs[0]!.tableId, await devs[0]!.newTable()];
  const s0 = await settings();
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const s = crypto.randomUUID();
    // Each device has its own clock (skewed up to a minute) and keeps it non-decreasing, as the tablet must.
    const clocks = devs.map(() => Date.now() - 600_000 + Math.floor(r() * 60_000));
    const at = (d: number) => new Date((clocks[d]! += 1000 + Math.floor(r() * 5000))).toISOString();
    const sent: { d: number; e: Env }[] = [{ d: 0, e: devs[0]!.open(s) }];
    const known: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = Math.floor(r() * 2);
      const t = devs[d]!;
      const roll = r();
      if (!known.length || roll < 0.45) {
        const l = crypto.randomUUID();
        known.push(l);
        sent.push({ d, e: t.add(s, l, 1 + Math.floor(r() * 3), { price: 100 * (1 + Math.floor(r() * 20)), at: at(d) }) });
      } else if (roll < 0.75) sent.push({ d, e: t.change(s, pick(known), 1 + Math.floor(r() * 5), at(d)) });
      else if (roll < 0.9) sent.push({ d, e: t.remove(s, pick(known), at(d)) });
      else sent.push({ d, e: t.move(s, pick(tables), at(d)) });
    }
    // Deliver in a random order, a few at a time, sometimes twice; retry whatever was deferred until nothing is.
    let pending = [...sent].sort(() => r() - 0.5);
    for (let round = 0; pending.length && round < 40; round++) {
      const next: typeof pending = [];
      for (const d of [0, 1]) {
        const mine = pending.filter((x) => x.d === d);
        if (!mine.length) continue;
        const take = mine.slice(0, 1 + Math.floor(r() * mine.length));
        const res = await devs[d]!.push(take.map((x) => x.e));
        if (r() < 0.3) await devs[d]!.push(take.map((x) => x.e)); // a lost response: the same events again
        // Results come back in seq order, not in the order sent: match them by event id.
        for (const x of res) {
          assert.notEqual(x.status, 'rejected', `seed ${seed}: ${x.reason}`);
          if (x.status === 'deferred') next.push(take.find((y) => y.e.eventId === x.eventId)!);
        }
        next.push(...mine.slice(take.length));
      }
      pending = next;
    }
    assert.equal(pending.length, 0, `seed ${seed}: events still deferred`);

    const envs: OrderEnvelope[] = sent.map(({ d, e }) => ({ deviceId: devs[d]!.deviceId, seq: e.seq, payload: e.payload }));
    const f = foldOrder(s, envs);
    const want = sorted(f.lines.map((l) => [l.lineId, l.qty, l.removedAt !== null]));
    assert.deepEqual(await lines(s), want, `seed ${seed}: lines`);
    const row = await sale(s);
    assert.equal(row.table_id, f.tableId, `seed ${seed}: table`);
    assert.equal(row.total, totals(liveLines(f), s0).total, `seed ${seed}: total`);
  }
});

// --- Step 7b: a table order paid on another device of its outlet.
const shiftOpened = (t: Tab, shiftId: string) =>
  t.ev({ type: 'shift.opened', schemaVersion: 1, shiftId, userId: t.cashierId, openingCashPaise: 0, at: tick() });
const shiftClosed = (t: Tab, shiftId: string, countedCashPaise: number) =>
  t.ev({ type: 'shift.closed', schemaVersion: 1, shiftId, countedCashPaise, at: tick() });
/** `t.pay`, in `shiftId`'s drawer. */
const payIn = (t: Tab, shiftId: string, saleId: string, ls: [string, number][], total: number) => {
  const e = t.pay(saleId, ls, total);
  e.payload.shiftId = shiftId;
  return e;
};

test('7b: a table order is paid on another device of its outlet: that device\'s receipt, shift and cash; void stays with the opener, reprint with the payer', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app);
  const table = await a.newTable();
  const [s, l1, s2, sh] = ids(4);
  assert.deepEqual(statuses(await a.push([a.open(s!, { tableId: table }), a.add(s!, l1!, 2), a.open(s2!, { tableId: await a.newTable() })])), ['applied', 'applied', 'applied']);
  const total = await totalOf([[1000, 2]]);

  assert.deepEqual(statuses(await b.push([shiftOpened(b, sh!), payIn(b, sh!, s!, [[l1!, 2]], total)])), ['applied', 'applied']);
  const row = await withTenant(A, async (c) => (await c.query(
    'SELECT status, device_id, paid_device_id, shift_id, receipt_seq FROM sale WHERE id = $1', [s])).rows[0]);
  assert.deepEqual(row, { status: 'paid', device_id: a.deviceId, paid_device_id: b.deviceId, shift_id: sh, receipt_seq: 1 });
  assert.deepEqual(await splits(s!), [], 'paid in full');

  // The cash is in B's drawer: B's count of exactly that balances.
  assert.deepEqual(statuses(await b.push([shiftClosed(b, sh!, total)])), ['applied']);
  const shift = await withTenant(A, async (c) => (await c.query('SELECT expected_cash_paise::int AS e, variance_paise::int AS v FROM shift WHERE id = $1', [sh])).rows[0]);
  assert.deepEqual(shift, { e: total, v: 0 });

  // The receipt is B's: B reprints it, A cannot. Voiding A's other open order stays with A.
  const reprint = (t: Tab) => t.ev({ type: 'print.reprinted', schemaVersion: 1, saleId: s, reprintedBy: t.cashierId, at: tick() });
  assert.deepEqual(statuses(await a.push([reprint(a)])), ['rejected:wrong_device']);
  assert.deepEqual(statuses(await b.push([reprint(b)])), ['applied']);
  const voidIt = (t: Tab) => t.ev({ type: 'sale.voided', schemaVersion: 1, saleId: s2, reason: 'abandoned_at_shift_close', at: tick() });
  assert.deepEqual(statuses(await b.push([voidIt(b)])), ['rejected:wrong_device']);
  assert.deepEqual(statuses(await a.push([voidIt(a)])), ['applied']);

  // The opener, not knowing, pays too: refused, the first payment stands.
  assert.deepEqual(statuses(await a.push([a.pay(s!, [[l1!, 2]], total)])), ['rejected:already_paid']);
  assert.equal((await sale(s!)).status, 'paid');
});

test('7b: receipt numbers run per paying device: one series across the orders it pays, and the opener\'s own series is untouched', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app), c = await Tab.second(app);
  const [s1, l1, s2, l2, s3, l3, s4, l4] = ids(8);
  await a.push([a.open(s1!, { tableId: await a.newTable() }), a.add(s1!, l1!, 1), a.open(s4!, { tableId: await a.newTable() }), a.add(s4!, l4!, 1)]);
  await c.push([c.open(s2!, { tableId: await c.newTable() }), c.add(s2!, l2!, 1), c.open(s3!, { tableId: await c.newTable() }), c.add(s3!, l3!, 1)]);
  const total = await totalOf([[1000, 1]]);

  // B pays A's order (B's #1) and C's (B's #2): no gap in B's series, none charged to A or C.
  assert.deepEqual(statuses(await b.push([b.pay(s1!, [[l1!, 1]], total), b.pay(s2!, [[l2!, 1]], total)])), ['applied', 'applied']);
  // A's own #1 is A's: not a clash with B's #1 although both are on A's orders.
  assert.deepEqual(statuses(await a.push([a.pay(s4!, [[l4!, 1]], total)])), ['applied']);
  // B's #2 again, on C's other order: the same receipt twice in B's series, refused.
  b.receipt = 1;
  const dup = await b.push([b.pay(s3!, [[l3!, 1]], total)]);
  assert.match(dup[0]!.reason ?? '', /^database:sale_receipt_uq$/);

  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const dc = await app.inject({ method: 'GET', url: `/outlets/${a.outletId}/day-close?date=${DATE}`, headers: bearer(mgr) });
  assert.equal(dc.statusCode, 200, dc.body);
  const gaps = (dc.json().receiptGaps as { deviceId: string; missing: number[] }[]).filter((g) => [a.deviceId, b.deviceId, c.deviceId].includes(g.deviceId));
  assert.deepEqual(gaps, [], 'each device\'s series is whole');
});

test('7b: the sales-by-counter report credits the counter that took the money', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), c2 = await Tab.enrol(app, 'a1@example.test', 'School 1 Canteen', 'C2');
  const [s, l1] = ids(2);
  await a.push([a.open(s!, { tableId: await a.newTable() }), a.add(s!, l1!, 7, { price: 1300 })]);
  const total = await totalOf([[1300, 7]]);
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const byCounter = async () => {
    const r = await app.inject({ method: 'GET', url: `/reports/sales?${new URLSearchParams({ from: DATE, to: DATE, outletId: a.outletId, by: 'counter' })}`, headers: bearer(mgr) });
    assert.equal(r.statusCode, 200, r.body);
    return Object.fromEntries((r.json().rows as { label: string; gross: number }[]).map((x) => [x.label, Number(x.gross)]));
  };
  const before = await byCounter();
  assert.deepEqual(statuses(await c2.push([c2.pay(s!, [[l1!, 7]], total)])), ['applied']);
  const after = await byCounter();
  assert.equal((after.C2 ?? 0) - (before.C2 ?? 0), total, 'C2 took the money');
  assert.equal((after.C1 ?? 0) - (before.C1 ?? 0), 0, 'not C1, where the order was rung up');
});

test('7b: a device of another outlet cannot pay the order', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), far = await Tab.enrol(app, 'a2@example.test', 'School 2 Canteen');
  const [s, l1] = ids(2);
  await a.push([a.open(s!, { tableId: await a.newTable() }), a.add(s!, l1!, 1)]);
  assert.deepEqual(statuses(await far.push([far.pay(s!, [[l1!, 1]], await totalOf([[1000, 1]]))])), ['rejected:wrong_outlet']);
  assert.equal((await sale(s!)).status, 'open');
});

// --- Step 7c: an open table order voided from any device of its outlet (`order.voided` v2).
const voidBy = (t: Tab, saleId: string, voidedBy: string, reason = 'guest left') =>
  t.ev({ type: 'order.voided', schemaVersion: 2, saleId, voidedBy, reason, at: tick() });
async function voidRow(id: string) {
  return withTenant(A, async (c) => (await c.query('SELECT status, void_reason FROM sale WHERE id = $1', [id])).rows[0]);
}

test('7c: a cashier on another device voids the order: audited with reason, device and user; a retry is a duplicate; nothing lands after it', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app);
  const [s, l1, l2, sh] = ids(4);
  await a.push([a.open(s!, { tableId: await a.newTable() }), a.add(s!, l1!, 2)]);

  const v = voidBy(b, s!, b.cashierId, 'wrong table, rung again');
  assert.deepEqual(statuses(await b.push([v])), ['applied']);
  assert.deepEqual(await voidRow(s!), { status: 'void', void_reason: 'wrong table, rung again' });
  const audit = await withTenant(A, async (c) => (await c.query(
    `SELECT actor_kind, actor_id, detail FROM audit WHERE action = 'order.voided' AND entity_id = $1`, [s])).rows);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_kind, 'user');
  assert.equal(audit[0].actor_id, b.cashierId);
  assert.equal(audit[0].detail.reason, 'wrong table, rung again');
  assert.equal(audit[0].detail.deviceId, b.deviceId);
  assert.equal(audit[0].detail.openedOnDeviceId, a.deviceId);

  // The same event again (a lost response): a duplicate, no second audit row. A second void: already void.
  assert.deepEqual(statuses(await b.push([v])), ['duplicate']);
  assert.deepEqual(statuses(await a.push([voidBy(a, s!, a.cashierId)])), ['rejected:already_void']);
  assert.equal(await withTenant(A, async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit WHERE action = 'order.voided' AND entity_id = $1`, [s])).rows[0].n), 1);

  // The opener, not knowing yet: its new line and its payment are refused (a payment after a void loses).
  assert.deepEqual(statuses(await a.push([a.add(s!, l2!, 1), shiftOpened(a, sh!), payIn(a, sh!, s!, [[l1!, 2]], await totalOf([[1000, 2]]))])),
    ['rejected:sale_void', 'applied', 'rejected:sale_void']);
  assert.equal((await sale(s!)).status, 'void');
});

test('7c: a waiter voids only an order they opened, from any device; another\'s order is refused', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app);
  const [mine, theirs, l1, l2] = ids(4);
  await a.push([a.open(mine!, { tableId: await a.newTable() }), a.add(mine!, l1!, 1),
    a.open(theirs!, { tableId: await a.newTable(), by: a.cashierId }), a.add(theirs!, l2!, 1)]);

  assert.deepEqual(statuses(await b.push([voidBy(b, theirs!, b.waiterId)])), ['rejected:not_own_order']);
  assert.equal((await sale(theirs!)).status, 'open');
  assert.deepEqual(statuses(await b.push([voidBy(b, mine!, b.waiterId)])), ['applied']);
  assert.equal((await sale(mine!)).status, 'void');
});

test('7c: the payment wins: a void arriving after it is refused; a split made after it is voidable', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app);
  const [s, l1, l2] = ids(3);
  await a.push([a.open(s!, { tableId: await a.newTable() }), a.add(s!, l1!, 1)]);
  assert.deepEqual(statuses(await b.push([b.pay(s!, [[l1!, 1]], await totalOf([[1000, 1]]))])), ['applied']);
  assert.deepEqual(statuses(await a.push([voidBy(a, s!, a.cashierId)])), ['rejected:not_open']);
  assert.equal((await sale(s!)).status, 'paid');

  // A late line splits off; the split (named by its own id, as a payment names it) is voided, the paid root untouched.
  await a.push([a.add(s!, l2!, 1)]);
  const [split] = await splits(s!);
  assert.ok(split);
  assert.deepEqual(statuses(await b.push([voidBy(b, split!, b.cashierId)])), ['applied']);
  assert.equal((await sale(split!)).status, 'void');
  assert.equal((await sale(s!)).status, 'paid');
});

test('7c: another outlet\'s device, or a person who does not work here, cannot void the order', async () => {
  const app = buildApp();
  const a = await Tab.enrol(app), b = await Tab.second(app), far = await Tab.enrol(app, 'a2@example.test', 'School 2 Canteen');
  const [s, l1] = ids(2);
  await a.push([a.open(s!, { tableId: await a.newTable() }), a.add(s!, l1!, 1)]);
  assert.deepEqual(statuses(await far.push([voidBy(far, s!, far.cashierId)])), ['rejected:wrong_outlet']);
  assert.deepEqual(statuses(await b.push([voidBy(b, s!, far.cashierId)])), ['rejected:unknown_user']);
  assert.equal((await sale(s!)).status, 'open');
});
