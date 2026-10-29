// The tablet's side of push. The first tests script the server's answers; the last one connects the real
// tablet code to the real API and Postgres, so the event the tablet writes is the event the server reads.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, DEFAULT_SETTINGS, type MenuEntry, type Tender } from '@pos/shared';
import { db, type DeviceInfo } from '../src/db.ts';
import { createSale, type Actor } from '../src/sale.ts';
import { push } from '../src/sync.ts';
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

  const sale = await createSale({ device: real, actor, cart: addItem([], { ...tea, itemId: ids.item }, 3), settings: DEFAULT_SETTINGS, menuVersion: 1, tenders: cash(3150) });

  // The server applies the batch but the response never arrives.
  let applied: unknown;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const r = await app.inject({ method: 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    applied = r.json();
    throw new TypeError('connection dropped');
  }) as typeof fetch;
  await assert.rejects(push(real));
  assert.deepEqual((applied as any).results.map((r: any) => r.status), ['applied', 'applied']);
  assert.equal(await db.outbox.count(), 2, 'the tablet cannot know, so it keeps everything');

  // Back online: the retry is answered "duplicate", the outbox empties, the cloud has it once.
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const r = await app.inject({ method: 'POST', url: String(url).replace(/^\/api/, ''), headers: init.headers as Record<string, string>, payload: init.body as string });
    return new Response(r.body, { status: r.statusCode });
  }) as typeof fetch;
  assert.deepEqual(await push(real), { sent: 2, done: 2, parked: 0, deferred: 0 });
  assert.equal(await db.outbox.count(), 0);

  const server = await withTenant(A, async (c) => (await c.query(
    `SELECT s.status, s.receipt_no, s.total_paise::int total, s.flags, (SELECT count(*)::int FROM payment WHERE sale_id = s.id) payments
       FROM sale s WHERE s.id = $1`, [sale.id])).rows[0]);
  assert.deepEqual(server, { status: 'paid', receipt_no: sale.receiptNo, total: sale.totalPaise, flags: [], payments: 1 });
});
