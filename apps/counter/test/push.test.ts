// The tablet's side of push. The first tests script the server's answers; the last one connects the real
// tablet code to the real API and Postgres, so the event the tablet writes is the event the server reads.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, DEFAULT_SETTINGS, type MenuEntry, type Tender } from '@pos/shared';
import { currentShift, db, type DeviceInfo } from '../src/db.ts';
import { createSale, type Actor } from '../src/sale.ts';
import { pull, push } from '../src/sync.ts';
import { closeShift, openShift } from '../src/shift.ts';
import { seedShift } from './helpers.ts';
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
  const own = (await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: { authorization: `Device ${real.credential}` } })).json();
  assert.deepEqual(own.changes.filter((c: { type: string }) => c.type === 'shift').map((c: { id: string }) => c.id).sort(), [first.id, second.id].sort());
  assert.ok(!own.changes.some((c: { id: string }) => c.id === third.id));

  // Another tablet is not told about this one's shifts.
  const code2 = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
  const cred2 = (await app.inject({ method: 'POST', url: '/enrol', payload: { code: code2 } })).json().credential as string;
  const feed = (await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: { authorization: `Device ${cred2}` } })).json();
  assert.deepEqual(feed.changes.filter((c: { type: string }) => c.type === 'shift'), []);
});
