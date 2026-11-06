// The tablet's side of push. The first tests script the server's answers; the last one connects the real
// tablet code to the real API and Postgres, so the event the tablet writes is the event the server reads.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, totals, DEFAULT_SETTINGS, type MenuEntry, type Tender } from '@pos/shared';
import { currentShift, db, type DeviceInfo } from '../src/db.ts';
import { createSale, type Actor } from '../src/sale.ts';
import { pull, pullOrders, push } from '../src/sync.ts';
import { closeShift, openShift } from '../src/shift.ts';
import { addToOrder, moveOrder, openOrder, orderById, removeLine, setLineQty, tableStates, tables } from '../src/order.ts';
import { loadMenu } from '../src/menu.ts';
import { payOrder } from '../src/sale.ts';
import { seedShift } from './helpers.ts';
import { acknowledgeRefused, unacknowledgedRefused } from '../src/refused.ts';
import { buildApp } from '../../api/src/app.ts';
import { pool, withTenant } from '../../api/src/db.ts';

(globalThis as any).__APP_VERSION__ = 'test';
test.after(() => pool.end());

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'd', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const tea: MenuEntry = { itemId: '44444444-4444-4444-8444-444444444444', categoryId: 'c', name: 'Tea', sortOrder: 0, hsnCode: null, pricePaise: paise(1000), gstRateBp: 500, available: true };
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n) }];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear()]);
  await seedShift(cashier);
  globalThis.fetch = realFetch;
});

/** A scripted server: `answer` maps each event of a request to a status. */
function scripted(answer: (e: { eventId: string }, call: number) => { status: string; reason?: string }) {
  const calls: { eventId: string }[][] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const events = JSON.parse(init.body as string).events as { eventId: string }[];
    calls.push(events);
    return new Response(JSON.stringify({ results: events.map((e) => ({ eventId: e.eventId, ...answer(e, calls.length) })) }), { status: 200 });
  }) as typeof fetch;
  return calls;
}
async function ring(actor: Actor, qty = 2) {
  return createSale({ device, actor, cart: addItem([], tea, qty), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: cash(1050 * qty) });
}
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };

test('events leave the outbox only when applied or duplicate, and are sent in device order', async () => {
  await ring(cashier);
  const calls = scripted((e) => ({ status: 'applied' }));
  const s = await push(device);
  assert.equal(await db.outbox.count(), 0);
  assert.deepEqual(s, { sent: 2, done: 2, parked: 0, deferred: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.map((e: any) => e.payload.type), ['sale.created', 'payment.taken']);
});

test('a failed or unreachable server loses nothing', async () => {
  await ring(cashier);
  globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
  await assert.rejects(push(device));
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  await assert.rejects(push(device), /500/);
  assert.equal(await db.outbox.count(), 2);
});

test('a rejected event is parked, kept, and not sent again; a deferred one is retried', async () => {
  await ring(cashier);
  const events = await db.outbox.orderBy('seq').toArray();
  const calls = scripted((e) => (e.eventId === events[0]!.eventId ? { status: 'rejected', reason: 'unknown_item' } : { status: 'deferred', reason: 'sale_not_yet_received' }));
  assert.deepEqual(await push(device), { sent: 2, done: 0, parked: 1, deferred: 1 });
  assert.equal(await db.outbox.count(), 2, 'nothing is deleted');
  assert.equal((await db.outbox.get(events[0]!.seq!))!.rejected, 'unknown_item');
  await push(device);
  assert.deepEqual(calls[1]!.map((e) => e.eventId), [events[1]!.eventId], 'only the deferred one is resent');
});

test('contract: the real tablet sale is accepted by the real server, once, even when a response is lost', async () => {
  const app = buildApp();
  const hostLogin = await app.inject({ method: 'POST', url: '/login', headers: { host: 'tenant-a.localhost' }, payload: { email: 'a1@example.test', password: 'dev-password-123' } });
  const mgr = hostLogin.json().token as string;
  const A = '00000000-0000-4000-8000-00000000000a';
  const o = await withTenant(A, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = 'School 1 Canteen'")).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const credential = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const ids = await withTenant(A, async (c) => ({
    user: (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'")).rows[0].id as string,
    item: (await c.query("SELECT id FROM item WHERE name = 'Tea'")).rows[0].id as string,
  }));
  const real: DeviceInfo = { ...device, credential, deviceId: credential.split('.')[1]!, tenantId: A, outletId: o.id, counterId: o.counter_id };
  const actor: Actor = { id: ids.user, name: 'Cashier', role: 'cashier' };

  await db.shifts.clear(); // the real shift, with its real events, replaces the seeded one
  await openShift({ actor, openingCashPaise: 50_000 });
  const sale = await createSale({ device: real, actor, cart: addItem([], { ...tea, itemId: ids.item }, 3), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: cash(3150) });
  const slip = await closeShift({ device: real, actor, countedCashPaise: 53_000 }); // ₹1.50 short of 500.00 + 31.50 = 531.50
  assert.equal(slip.variancePaise, -150);

  // The server applies the batch but the response never arrives.
  let applied: unknown;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const r = await app.inject({ method: 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    applied = r.json();
    throw new TypeError('connection dropped');
  }) as typeof fetch;
  await assert.rejects(push(real));
  assert.deepEqual((applied as any).results.map((r: any) => r.status), ['applied', 'applied', 'applied', 'applied']);
  assert.equal(await db.outbox.count(), 4, 'the tablet cannot know, so it keeps everything');

  // Back online: the retry is answered "duplicate", the outbox empties, the cloud has it once.
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const r = await app.inject({ method: 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  assert.deepEqual(await push(real), { sent: 4, done: 4, parked: 0, deferred: 0 });
  assert.equal(await db.outbox.count(), 0);

  // The server worked out the same expected cash as the tablet's slip, from the payments it holds.
  const shift = await withTenant(A, async (c) => (await c.query(
    'SELECT expected_cash_paise::int expected, counted_cash_paise::int counted, variance_paise::int variance FROM shift WHERE device_id = $1', [real.deviceId])).rows[0]);
  assert.deepEqual(shift, { expected: 53_150, counted: 53_000, variance: -150 });

  const server = await withTenant(A, async (c) => (await c.query(
    `SELECT s.status, s.receipt_no, s.total_paise::int total, s.flags, (SELECT count(*)::int FROM payment WHERE sale_id = s.id) payments
       FROM sale s WHERE s.id = $1`, [sale.id])).rows[0]);
  assert.deepEqual(server, { status: 'paid', receipt_no: sale.receiptNo, total: sale.totalPaise, flags: [], payments: 1 });
});

test('contract: a drawer a manager closed reaches the tablet by pull, and the tablet\'s own late close is acknowledged, not parked', async () => {
  const app = buildApp();
  const A = '00000000-0000-4000-8000-00000000000a';
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: 'tenant-a.localhost' }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(A, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = 'School 1 Canteen'")).rows[0]);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const credential = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  const user = (await withTenant(A, async (c) => (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'")).rows[0].id)) as string;
  const real: DeviceInfo = { ...device, credential, deviceId: credential.split('.')[1]!, tenantId: A, outletId: o.id, counterId: o.counter_id };
  const actor: Actor = { id: user, name: 'Cashier', role: 'cashier' };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const r = await app.inject({ method: (init.method ?? 'GET') as 'GET' | 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  const forceClose = async (shiftId: string, counted: number) =>
    app.inject({ method: 'POST', url: `/outlets/${o.id}/shifts/${shiftId}/force-close`, headers: { authorization: `Bearer ${mgr}` }, payload: { countedCashPaise: counted } });

  // A: the tablet is still open when the manager closes it; the next pull closes it here, with the manager's count.
  await db.shifts.clear();
  const first = await openShift({ actor, openingCashPaise: 50_000 });
  await push(real);
  assert.equal((await forceClose(first.id, 49_000)).statusCode, 200);
  await pull(real);
  const closed = (await db.shifts.get(first.id))!;
  assert.deepEqual([closed.closedAt !== null, closed.countedCashPaise, closed.closedByManager], [true, 49_000, { expectedCashPaise: 50_000, variancePaise: -1_000 }]);
  assert.equal(await currentShift(), undefined, 'no drawer is open on the tablet any more');

  // B: the cashier closes offline while the manager closes online. Pushing is not a failure; their own count stays on the tablet.
  const second = await openShift({ actor, openingCashPaise: 20_000 });
  await push(real);
  await closeShift({ device: real, actor, countedCashPaise: 20_500 });
  assert.equal((await forceClose(second.id, 20_000)).statusCode, 200);
  assert.deepEqual(await push(real), { sent: 1, done: 1, parked: 0, deferred: 0 });
  assert.equal(await db.outbox.count(), 0);
  await pull(real);
  const both = (await db.shifts.get(second.id))!;
  assert.deepEqual([both.countedCashPaise, both.closedByManager?.variancePaise], [20_500, 0], "the cashier's figure is not overwritten; the server's variance is attached");

  // C: a drawer the cashier closed normally is not in the feed (the tablet already knows about it).
  const third = await openShift({ actor, openingCashPaise: 10_000 });
  await closeShift({ device: real, actor, countedCashPaise: 10_000 });
  await push(real);
  // Follow every page, as a real tablet does: on a database that other suites have filled, the shift rows are not on page one.
  const own = { changes: [] as { type: string; id: string }[] };
  for (let cursor = 0, more = true; more;) {
    const page = (await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: { authorization: `Device ${real.credential}` } })).json();
    own.changes.push(...page.changes);
    more = page.hasMore;
    cursor = page.cursor;
  }
  assert.deepEqual(own.changes.filter((c: { type: string }) => c.type === 'shift').map((c: { id: string }) => c.id).sort(), [first.id, second.id].sort());
  assert.ok(!own.changes.some((c: { id: string }) => c.id === third.id));

  // Another tablet is not told about this one's shifts.
  const code2 = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred2 = (await app.inject({ method: 'POST', url: '/enrol', payload: { code: code2 } })).json().credential as string;
  const feed = (await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: { authorization: `Device ${cred2}` } })).json();
  assert.deepEqual(feed.changes.filter((c: { type: string }) => c.type === 'shift'), []);
});

/** The real API in-process, a tablet enrolled at School 1 Canteen's C1, and the tablet's fetch wired to that API. */
async function realTablet() {
  const app = buildApp();
  const A = '00000000-0000-4000-8000-00000000000a';
  const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: 'tenant-a.localhost' }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
  const o = await withTenant(A, async (c) =>
    (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = 'School 1 Canteen'")).rows[0]);
  const enrol = async () => {
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
    return (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  };
  const credential = await enrol();
  const user = (await withTenant(A, async (c) => (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'")).rows[0].id)) as string;
  const real: DeviceInfo = { ...device, credential, deviceId: credential.split('.')[1]!, tenantId: A, outletId: o.id, counterId: o.counter_id };
  const actor: Actor = { id: user, name: 'Cashier', role: 'cashier' };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const r = await app.inject({ method: (init.method ?? 'GET') as 'GET' | 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  await Promise.all([db.entities.clear(), db.orderEvents.clear(), db.shifts.clear(), db.visits.clear()]);
  return { app, A, mgr, o, real, actor, enrol };
}

test('contract: a running order written by the real tablet code is the order the real server holds, paid with v2', async () => {
  const { app, A, mgr, o, real, actor } = await realTablet();
  // Two tables of its own: the API suite leaves open orders on the outlet's default table (and others), and a second
  // open order on a table is flagged table_shared.
  const newTable = async (code: string) => {
    const r = await app.inject({ method: 'POST', url: `/outlets/${o.id}/tables`, headers: { authorization: `Bearer ${mgr}` }, payload: { code } });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const [from, to] = [await newTable(`M${Date.now() % 100000}`), await newTable(`N${Date.now() % 100000}`)];
  await pull(real); // the tables, the menu and the settings, as a real tablet gets them
  const menu = await loadMenu();
  const [e1, e2] = menu.entries.filter((e) => e.available);
  const tablesHere = await tables();
  assert.ok(tablesHere.some((t) => t.isDefault), 'pull brought the default table');
  const opts = { device: real, actor, settings: menu.settings };
  await openShift({ actor, openingCashPaise: 0 });

  // Opened on a table, then edited the way a counter does: add, bump, add, change, remove, move.
  let s = await openOrder({ ...opts, menuVersion: menu.menuVersion, tableId: from });
  s = await addToOrder({ ...opts, saleId: s.id, entry: e1! });
  s = await addToOrder({ ...opts, saleId: s.id, entry: e1!, qty: 2 });
  s = await addToOrder({ ...opts, saleId: s.id, entry: e2! });
  s = await setLineQty({ ...opts, saleId: s.id, lineId: s.lines[1]!.lineId!, qty: 2 });
  s = await addToOrder({ ...opts, saleId: s.id, entry: e2! }); // merges: this device added that line
  assert.deepEqual(s.lines.map((l) => l.qty), [3, 3]);
  s = await moveOrder({ ...opts, saleId: s.id, tableId: to });

  // Sent while open: the server's open sale is the tablet's row, line for line.
  assert.equal((await push(real)).parked, 0);
  const server = async () => withTenant(A, async (c) => ({
    sale: (await c.query('SELECT status, table_id, subtotal_paise::int sub, tax_paise::int tax, total_paise::int total, receipt_no, flags FROM sale WHERE id = $1', [s.id])).rows[0],
    lines: (await c.query('SELECT line_id, qty FROM sale_line WHERE sale_id = $1 AND removed_at IS NULL ORDER BY line_id', [s.id])).rows,
  }));
  const open = await server();
  assert.deepEqual(open.sale, { status: 'open', table_id: s.tableId, sub: s.subtotalPaise, tax: s.taxPaise, total: s.totalPaise, receipt_no: null, flags: [] });
  const byId = (ls: { lineId?: string; qty: number }[]) => ls.map((l) => ({ line_id: l.lineId, qty: l.qty })).sort((a, b) => a.line_id!.localeCompare(b.line_id!));
  assert.deepEqual(open.lines, byId(s.lines));

  // One more change offline, then paid: the payment carries the lines as shown, and the server pays exactly those.
  s = await removeLine({ ...opts, saleId: s.id, lineId: s.lines[0]!.lineId! });
  const paid = await payOrder({ device: real, actor, saleId: s.id, tenders: [{ method: 'cash', amountPaise: paise(s.totalPaise), tenderedPaise: paise(s.totalPaise) }] });
  assert.deepEqual(await push(real), { sent: 2, done: 2, parked: 0, deferred: 0 });
  const after = await server();
  assert.deepEqual(after.sale, { status: 'paid', table_id: s.tableId, sub: s.subtotalPaise, tax: s.taxPaise, total: paid.totalPaise, receipt_no: paid.receiptNo, flags: [] });
  assert.deepEqual(after.lines, byId(paid.lines));
  assert.equal(await db.orderEvents.count(), 0);
});

test('contract (12b, 7b): two devices at one table, each sees and adds to the other\'s order; either pays, on its own receipt and drawer', async () => {
  const { app, A, mgr, o, real, actor, enrol } = await realTablet();
  const tableCode = `W${Date.now() % 100000}`;
  const made = await app.inject({ method: 'POST', url: `/outlets/${o.id}/tables`, headers: { authorization: `Bearer ${mgr}` }, payload: { code: tableCode } });
  assert.equal(made.statusCode, 201, made.body);
  const tableId = made.json().id as string;
  await pull(real);
  const menu = await loadMenu();
  const [e1, e2] = menu.entries.filter((e) => e.available);
  const opts = { device: real, actor, settings: menu.settings };
  await openShift({ actor, openingCashPaise: 0 });

  // Device B (a waiter's tablet), written as raw events through the same API.
  const bCred = await enrol();
  const bId = bCred.split('.')[1]!;
  const waiter = (await withTenant(A, async (c) => (await c.query("SELECT id FROM app_user WHERE name = 'School 1 Canteen waiter'")).rows[0].id)) as string;
  let bSeq = 0;
  const bPush = async (...payloads: unknown[]) => {
    const r = await app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${bCred}` },
      payload: { events: payloads.map((payload) => ({ eventId: crypto.randomUUID(), seq: ++bSeq, createdAt: new Date().toISOString(), payload })) } });
    return (r.json().results as { status: string }[]).map((x) => x.status);
  };
  const at = () => new Date().toISOString();
  const add = (saleId: string, lineId: string, e: MenuEntry, qty = 1) =>
    ({ type: 'order.line_added', schemaVersion: 2, saleId, lineId, itemId: e.itemId, name: e.name, unitPaise: e.pricePaise, gstRateBp: e.gstRateBp, qty, by: waiter, at: at() });
  const serverLines = async (saleId: string) => withTenant(A, async (c) =>
    (await c.query('SELECT line_id, qty FROM sale_line WHERE sale_id = $1 AND removed_at IS NULL ORDER BY line_id', [saleId])).rows.map((r) => [r.line_id, r.qty]));
  const shownLines = (s: { lines: { lineId?: string; qty: number }[] } | undefined) => (s?.lines ?? []).map((l) => [l.lineId, l.qty]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const onTable = async () => (await tableStates()).find((t) => t.table.id === tableId)!.orders;

  // B opens the table and rings a line. The tablet pulls: B's order is on the table, as a view.
  const bRoot = crypto.randomUUID(), bLine = crypto.randomUUID();
  assert.deepEqual(await bPush({ type: 'order.opened', schemaVersion: 2, saleId: bRoot, tableId, createdBy: waiter, businessDate: '2026-05-23', createdAtDevice: at(), menuVersion: menu.menuVersion },
    add(bRoot, bLine, e1!, 2)), ['applied', 'applied']);
  await pullOrders(real);
  let theirs = (await onTable()).find((s) => s.id === bRoot);
  assert.equal(theirs?.ownerDeviceId, bId);
  assert.deepEqual(shownLines(theirs), await serverLines(bRoot));

  // The tablet adds to B's order and pushes: the server's open sale is what the tablet shows.
  theirs = await addToOrder({ ...opts, saleId: bRoot, entry: e2! });
  assert.equal((await push(real)).parked, 0);
  assert.deepEqual(shownLines(theirs), await serverLines(bRoot));

  // B changes its own line; the tablet's next pull shows it, still equal to the server.
  assert.deepEqual(await bPush({ type: 'order.line_changed', schemaVersion: 2, saleId: bRoot, lineId: bLine, qty: 5, by: waiter, at: at() }), ['applied']);
  await pullOrders(real);
  assert.deepEqual(shownLines(await orderById(bRoot)), await serverLines(bRoot));

  // The other way round: the tablet's own order on the same table, and B adds to it. The row the tablet pays from has B's line.
  let mine = await openOrder({ ...opts, menuVersion: menu.menuVersion, tableId });
  mine = await addToOrder({ ...opts, saleId: mine.id, entry: e1! });
  await push(real);
  assert.deepEqual(await bPush(add(mine.id, crypto.randomUUID(), e2!, 3)), ['applied']);
  await pullOrders(real);
  const row = (await orderById(mine.id))!;
  assert.equal(row.lines.length, 2);
  assert.deepEqual(shownLines(row), await serverLines(mine.id));
  assert.equal((await onTable()).length, 2, 'both orders are on the table');
  const paid = await payOrder({ device: real, actor, saleId: mine.id, tenders: cash(row.totalPaise) });
  assert.equal((await push(real)).parked, 0);
  const s = await withTenant(A, async (c) => (await c.query('SELECT status, total_paise::int AS total, flags FROM sale WHERE id = $1', [mine.id])).rows[0]);
  assert.deepEqual(s, { status: 'paid', total: paid.totalPaise, flags: ['table_shared'] }, 'paid in full, nothing split off or overridden');
  assert.equal(await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n FROM sale WHERE order_root_id = $1', [mine.id])).rows[0].n), 1, 'no split');

  // 7b: the tablet takes payment for B's order. The server records it as paid HERE: this device, its receipt series,
  // its shift; both devices' lines, nothing split off.
  const view = (await orderById(bRoot))!;
  const theirsPaid = await payOrder({ device: real, actor, saleId: bRoot, tenders: cash(view.totalPaise) });
  assert.equal((await push(real)).parked, 0);
  const shiftId = (await db.shifts.toArray()).find((x) => !x.closedAt)!.id;
  const rec = await withTenant(A, async (c) => (await c.query(
    `SELECT status, total_paise::int AS total, receipt_no, receipt_seq, device_id, paid_device_id, shift_id FROM sale WHERE id = $1`, [bRoot])).rows[0]);
  assert.deepEqual(rec, { status: 'paid', total: theirsPaid.totalPaise, receipt_no: theirsPaid.receiptNo, receipt_seq: theirsPaid.receiptSeq,
    device_id: bId, paid_device_id: real.deviceId, shift_id: shiftId });
  assert.equal(theirsPaid.receiptSeq, paid.receiptSeq! + 1, 'the next number in this device\'s series');
  assert.deepEqual(shownLines(theirsPaid), await serverLines(bRoot), 'the receipt lists what the server holds');
  assert.equal(await withTenant(A, async (c) => (await c.query('SELECT count(*)::int AS n FROM sale WHERE order_root_id = $1', [bRoot])).rows[0].n), 1, 'no split');
  await pullOrders(real);
  assert.deepEqual(await onTable(), [], 'both paid: the table is free');
  assert.equal(await db.visits.get(bRoot), undefined);

  // B, not knowing yet, tries to take payment too: refused, the first payment stands.
  const lines = (await serverLines(bRoot)).map(([lineId, qty]) => ({ lineId, qty }));
  const late = await app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${bCred}` },
    payload: { events: [{ eventId: crypto.randomUUID(), seq: ++bSeq, createdAt: at(), payload: { type: 'payment.taken', schemaVersion: 2, saleId: bRoot, businessDate: '2026-05-23',
      receiptNo: 'C1-20260523-1', receiptSeq: 1, payments: [{ method: 'cash', amountPaise: rec.total, tenderedPaise: rec.total, changePaise: 0, upiRef: null }], lines, totalPaise: rec.total } }] } });
  assert.equal(late.json().results[0].reason, 'already_paid');
});

test('contract (7d): the tablet loses both races against the real server: refused rows, an honest slip equal to the server\'s, no receipt gap, acknowledged', async () => {
  const { app, A, mgr, o, real, actor, enrol } = await realTablet();
  const newTable = async () => {
    const r = await app.inject({ method: 'POST', url: `/outlets/${o.id}/tables`, headers: { authorization: `Bearer ${mgr}` }, payload: { code: `R${Math.random().toString(36).slice(2, 7)}` } });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const [t1, t2] = [await newTable(), await newTable()];
  await pull(real);
  const menu = await loadMenu();
  const e1 = menu.entries.find((e) => e.available)!;
  const opts = { device: real, actor, settings: menu.settings };
  await openShift({ actor, openingCashPaise: 0 });

  // Device B, another cashier's tablet at the outlet, as raw events.
  const bCred = await enrol();
  let bSeq = 0;
  const bPush = async (...payloads: unknown[]) => {
    const r = await app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${bCred}` },
      payload: { events: payloads.map((payload) => ({ eventId: crypto.randomUUID(), seq: ++bSeq, createdAt: new Date().toISOString(), payload })) } });
    return (r.json().results as { status: string; reason?: string }[]).map((x) => x.reason ? `${x.status}:${x.reason}` : x.status);
  };
  const cashierId = actor.id;

  // Two orders of this tablet, on the server.
  let paidThere = await openOrder({ ...opts, menuVersion: menu.menuVersion, tableId: t1 });
  paidThere = await addToOrder({ ...opts, saleId: paidThere.id, entry: e1 });
  let voidedThere = await openOrder({ ...opts, menuVersion: menu.menuVersion, tableId: t2 });
  voidedThere = await addToOrder({ ...opts, saleId: voidedThere.id, entry: e1, });
  assert.equal((await push(real)).parked, 0);

  // B pays the first and voids the second, while this tablet is offline.
  const date = paidThere.businessDate.replaceAll('-', '');
  const lines = paidThere.lines.map((l) => ({ lineId: l.lineId, qty: l.qty }));
  assert.deepEqual(await bPush(
    { type: 'payment.taken', schemaVersion: 2, saleId: paidThere.id, businessDate: paidThere.businessDate, receiptNo: `C1-${date}-1`, receiptSeq: 1,
      payments: [{ method: 'cash', amountPaise: paidThere.totalPaise, tenderedPaise: paidThere.totalPaise, changePaise: 0, upiRef: null }], lines, totalPaise: paidThere.totalPaise },
    { type: 'order.voided', schemaVersion: 2, saleId: voidedThere.id, voidedBy: cashierId, reason: 'rung twice', at: new Date().toISOString() }), ['applied', 'applied']);

  // Offline, this tablet takes cash for both, then rings an ordinary sale. All three receipts are printed.
  const p1 = await payOrder({ device: real, actor, saleId: paidThere.id, tenders: cash(paidThere.totalPaise) });
  const p2 = await payOrder({ device: real, actor, saleId: voidedThere.id, tenders: cash(voidedThere.totalPaise) });
  const cart = addItem([], e1, 1);
  const p3 = await createSale({ device: real, actor, cart, settings: menu.settings, menuVersion: menu.menuVersion, tenders: cash(totals(cart, menu.settings).total) });

  // Reconnect: both payments refused, the ordinary sale applied.
  const res = await push(real);
  assert.equal(res.parked, 2);
  assert.deepEqual([(await db.sales.get(p1.id))?.status, (await db.sales.get(p1.id))?.refused?.reason], ['refused', 'already_paid']);
  assert.deepEqual([(await db.sales.get(p2.id))?.status, (await db.sales.get(p2.id))?.refused?.reason], ['refused', 'sale_void']);
  assert.equal((await db.sales.get(p3.id))?.status, 'paid');

  // A pull afterwards neither brings them back as open orders nor deletes them.
  await pullOrders(real);
  assert.equal((await db.sales.get(p1.id))?.status, 'refused');
  assert.equal((await db.sales.get(p2.id))?.status, 'refused');
  const states = await tableStates();
  assert.equal(states.find((s) => s.table.id === t1)!.orders.length, 0);
  assert.equal(states.find((s) => s.table.id === t2)!.orders.length, 0);

  // Shift close with the whole drawer counted: the tablet's slip and the server agree, and the refused cash is named.
  const counted = p1.totalPaise + p2.totalPaise + p3.totalPaise;
  const slip = await closeShift({ device: real, actor, countedCashPaise: counted });
  assert.equal(slip.variancePaise, 0);
  assert.deepEqual(slip.refused, { count: 2, cashPaise: p1.totalPaise + p2.totalPaise, upiPaise: 0 });
  assert.equal(slip.salesCount, 1);
  assert.equal((await push(real)).parked, 0);
  const shiftId = (await db.shifts.toArray()).find((s) => s.closedAt)!.id;
  const srv = await withTenant(A, async (c) => (await c.query(
    'SELECT expected_cash_paise::int AS e, variance_paise::int AS v, refused_cash_paise::int AS r FROM shift WHERE id = $1', [shiftId])).rows[0]);
  assert.deepEqual(srv, { e: counted, v: 0, r: p1.totalPaise + p2.totalPaise });

  // Day close: this tablet's three numbers are used (none missing); the two refused are listed.
  const dc = (await app.inject({ method: 'GET', url: `/outlets/${o.id}/day-close?date=${p1.businessDate}`, headers: { authorization: `Bearer ${mgr}` } })).json();
  assert.deepEqual(dc.receiptGaps.filter((g: { deviceId: string }) => g.deviceId === real.deviceId), []);
  assert.deepEqual(dc.refusedReceipts.filter((x: { deviceId: string }) => x.deviceId === real.deviceId).map((x: { receiptNo: string; reason: string }) => [x.receiptNo, x.reason]),
    [[p1.receiptNo, 'already_paid'], [p2.receiptNo, 'sale_void']]);

  // The manager acknowledges both on this tablet: the banner list empties, the parked copies go, the server records it.
  for (const id of [p1.id, p2.id]) await acknowledgeRefused({ token: mgr, outletId: o.id, saleId: id });
  assert.deepEqual(await unacknowledgedRefused(), []);
  assert.equal(await db.outbox.filter((r) => !!r.rejected).count(), 0);
  const acked = (await app.inject({ method: 'GET', url: `/outlets/${o.id}/day-close?date=${p1.businessDate}`, headers: { authorization: `Bearer ${mgr}` } })).json()
    .refusedReceipts.filter((x: { deviceId: string }) => x.deviceId === real.deviceId);
  assert.ok(acked.every((x: { acknowledgedAt: string | null }) => x.acknowledgedAt), 'both acknowledged on the server');
});
