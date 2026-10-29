// Deterministic checks of the tablet's write path, against IndexedDB semantics (fake-indexeddb).
// The real-browser check covers the UI; these cover what a browser run cannot force: a failure
// half way through a sale, and the order of writes inside the PIN check.
import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, paise, renderShiftSlip, type MenuEntry, type Tender, DEFAULT_SETTINGS } from '@pos/shared';
import { closeShift, openShift } from '../src/shift.ts';
import { seedShift } from './helpers.ts';
import { db, type DeviceInfo } from '../src/db.ts';
import { createSale, payOrder, visibleOpenOrders, businessDate, type Actor } from '../src/sale.ts';
import { signInWithPin } from '../src/auth.ts';
import { hashPassword } from '../../api/src/security/password.ts';

const device: DeviceInfo = { credential: 'x.y.z', deviceId: 'd', tenantId: 't', outletId: 'o', counterId: 'c', counterCode: 'C1', outletName: 'Test', timezone: 'Asia/Kolkata' };
const cashier: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'Cash', role: 'cashier' };
const waiter: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'Wait', role: 'waiter' };
const other: Actor = { id: '33333333-3333-4333-8333-333333333333', name: 'Other', role: 'waiter' };
const tea: MenuEntry = { itemId: '44444444-4444-4444-8444-444444444444', categoryId: 'c', name: 'Tea', sortOrder: 0, hsnCode: null, pricePaise: paise(1000), gstRateBp: 500, available: true };
const cart = addItem([], tea, 2);
const cash = (n: number): Tender[] => [{ method: 'cash', amountPaise: paise(n), tenderedPaise: paise(n + 500) }];
const base = { device, cart, settings: DEFAULT_SETTINGS, menuVersion: 7 };
const state = async () => ({ sales: await db.sales.count(), outbox: await db.outbox.count(), counter: (await db.meta.get('receiptCounter'))?.value });

beforeEach(async () => {
  await Promise.all([db.sales.clear(), db.outbox.clear(), db.meta.clear(), db.pinState.clear()]);
  await seedShift(cashier);
});

test('no open shift: no payment, and nothing is saved or numbered', async () => {
  await db.shifts.clear();
  const before = await state();
  await assert.rejects(createSale({ ...base, actor: cashier, tenders: cash(2100) }), /Open a shift/);
  assert.deepEqual(await state(), before);
});

test('only the cashier who owns the open shift takes payment into it', async () => {
  const other_cashier: Actor = { id: '55555555-5555-4555-8555-555555555555', name: 'Cash2', role: 'cashier' };
  const open = await createSale({ ...base, actor: waiter });
  await assert.rejects(payOrder({ ...base, actor: other_cashier, saleId: open.id, tenders: cash(2100) }), /belongs to Cash/);
  assert.equal((await db.sales.get(open.id))!.status, 'open');
});

test('a shift: payments carry its id, the slip shows the variance, and a second open is refused', async () => {
  await db.shifts.clear();
  const s = await openShift({ actor: cashier, openingCashPaise: 50_000 });
  await assert.rejects(openShift({ actor: cashier, openingCashPaise: 0 }), /already open/);
  await assert.rejects(openShift({ actor: waiter, openingCashPaise: 0 }), /Only a cashier/);
  const paid = await createSale({ ...base, actor: cashier, tenders: cash(2100) });
  assert.equal(paid.shiftId, s.id);
  const pay = (await db.outbox.toArray()).map((r) => r.payload).find((p) => p.type === 'payment.taken');
  assert.equal(pay?.type === 'payment.taken' && pay.shiftId, s.id);

  await assert.rejects(closeShift({ device, actor: waiter, countedCashPaise: 0 }), /belongs to Cash/);
  const slip = await closeShift({ device, actor: cashier, countedCashPaise: 52_100 }); // 500.00 + 21.00 expected: exactly right
  assert.equal(slip.variancePaise, 0);
  assert.equal(slip.cashSalesPaise, 2100);
  assert.equal(slip.salesCount, 1);
  assert.ok(renderShiftSlip(slip).every((l) => l.length <= 32));
  await assert.rejects(closeShift({ device, actor: cashier, countedCashPaise: 0 }), /no open shift/);
  await assert.rejects(createSale({ ...base, actor: cashier, tenders: cash(2100) }), /Open a shift/);
});

test('a paid sale writes the sale, both events and the receipt counter together', async () => {
  const s = await createSale({ ...base, actor: cashier, tenders: cash(2100) });
  assert.equal(s.status, 'paid');
  assert.equal(s.totalPaise, 2100); // 2 x 10.00 + 5% GST
  assert.match(s.receiptNo!, /^C1-\d{8}-1$/);
  const st = await state();
  assert.equal(st.sales, 1);
  assert.equal(st.outbox, 2);
  assert.equal(st.counter?.seq, 1);
  assert.deepEqual((await db.outbox.toArray()).map((o) => o.payload.type), ['sale.created', 'payment.taken']);
});

test('a failure part-way through a sale leaves NOTHING behind (receipt number is not spent)', async () => {
  const add = db.outbox.add.bind(db.outbox);
  let calls = 0;
  (db.outbox as any).add = async (...a: any[]) => { if (++calls === 2) throw new Error('disk full'); return (add as any)(...a); };
  try {
    await assert.rejects(createSale({ ...base, actor: cashier, tenders: cash(2100) }), /disk full/);
  } finally {
    (db.outbox as any).add = add;
  }
  assert.deepEqual(await state(), { sales: 0, outbox: 0, counter: undefined });
  const next = await createSale({ ...base, actor: cashier, tenders: cash(2100) });
  assert.match(next.receiptNo!, /-1$/, 'the number the failed attempt would have used is still free');
});

test('receipt numbers continue across sales; an order paid after midnight takes the new date', async () => {
  const day1 = new Date('2026-03-01T10:00:00+05:30');
  const day2 = new Date('2026-03-02T00:10:00+05:30');
  const open = await createSale({ ...base, actor: waiter, now: new Date('2026-03-01T23:55:00+05:30') });
  const a = await createSale({ ...base, actor: cashier, tenders: cash(2100), now: day1 });
  const b = await createSale({ ...base, actor: cashier, tenders: cash(2100), now: day1 });
  assert.deepEqual([a.receiptNo, b.receiptNo], ['C1-20260301-1', 'C1-20260301-2']);
  const paid = await payOrder({ ...base, actor: cashier, saleId: open.id, tenders: cash(2100), now: day2 });
  assert.equal(paid.receiptNo, 'C1-20260302-1');
  assert.equal(paid.businessDate, '2026-03-02', 'the sale takes the receipt date so (device, date, seq) stays unique');
  const ev = (await db.outbox.toArray()).map((o) => o.payload).filter((p) => p.type === 'payment.taken').pop() as any;
  assert.equal(ev.businessDate, '2026-03-02');
  assert.equal(businessDate('Asia/Kolkata', new Date('2026-03-01T19:00:00Z')), '2026-03-02');
});

test('only a cashier takes payment, and nothing is written when a waiter tries', async () => {
  await assert.rejects(createSale({ ...base, actor: waiter, tenders: cash(2100) }), /only a cashier/);
  assert.deepEqual(await state(), { sales: 0, outbox: 0, counter: undefined });
  const open = await createSale({ ...base, actor: waiter });
  await assert.rejects(payOrder({ ...base, actor: waiter, saleId: open.id, tenders: cash(2100) }), /only a cashier/);
  assert.equal((await db.sales.get(open.id))?.status, 'open');
});

test('an order cannot be paid twice, and a wrong amount spends no receipt number', async () => {
  const open = await createSale({ ...base, actor: waiter });
  await assert.rejects(payOrder({ ...base, actor: cashier, saleId: open.id, tenders: cash(2000) }), /add up/);
  assert.equal((await state()).counter, undefined);
  await payOrder({ ...base, actor: cashier, saleId: open.id, tenders: cash(2100) });
  await assert.rejects(payOrder({ ...base, actor: cashier, saleId: open.id, tenders: cash(2100) }), /not open/);
  assert.equal((await state()).counter?.seq, 1);
  assert.equal((await state()).outbox, 2);
});

test('a failure while paying an open order spends no receipt number and leaves it open', async () => {
  const open = await createSale({ ...base, actor: waiter });
  const add = db.outbox.add.bind(db.outbox);
  (db.outbox as any).add = async () => { throw new Error('disk full'); };
  try {
    await assert.rejects(payOrder({ ...base, actor: cashier, saleId: open.id, tenders: cash(2100) }), /disk full/);
  } finally {
    (db.outbox as any).add = add;
  }
  assert.equal((await db.sales.get(open.id))?.status, 'open');
  assert.equal((await state()).counter, undefined);
  assert.equal((await state()).outbox, 1);
});

test('an empty cart is refused', async () => {
  await assert.rejects(createSale({ ...base, cart: [], actor: cashier }), /empty/);
});

test('scope: a waiter sees only their own open orders, a cashier sees all', async () => {
  const w = await createSale({ ...base, actor: waiter });
  const o = await createSale({ ...base, actor: other });
  const c = await createSale({ ...base, actor: cashier });
  assert.deepEqual((await visibleOpenOrders(waiter)).map((x) => x.id), [w.id]);
  assert.deepEqual((await visibleOpenOrders(other)).map((x) => x.id), [o.id]);
  assert.equal((await visibleOpenOrders(cashier)).length, 3);
  assert.ok(c.id);
});

test('PIN: the failure is recorded BEFORE the slow check, so killing the tab mid-check is not free', async () => {
  const verifier = await hashPassword('482913');
  const running = signInWithPin(waiter.id, verifier, '739150');
  let finished = false;
  void running.then(() => { finished = true; });
  let seen = 0;
  for (let i = 0; i < 400 && seen === 0 && !finished; i++) {
    const v = (await db.pinState.get(waiter.id))?.state.failures ?? 0;
    if (!finished) seen = v; // only counts if the check had not finished yet
    if (seen === 0) await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(seen, 1, 'failure count was visible while the check was still running');
  assert.equal((await running).kind, 'wrong');
  assert.equal((await db.pinState.get(waiter.id))?.state.failures, 1);
  assert.equal((await signInWithPin(waiter.id, verifier, '482913')).kind, 'ok');
  assert.equal((await db.pinState.get(waiter.id))?.state.failures, 0);
});

test('PIN: five wrong attempts lock, and the lock is stored', async () => {
  const verifier = await hashPassword('482913');
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) await signInWithPin(waiter.id, verifier, '739150', t0);
  assert.equal((await signInWithPin(waiter.id, verifier, '482913', t0 + 1000)).kind, 'locked');
  assert.ok(((await db.pinState.get(waiter.id))?.state.lockedUntil ?? 0) > t0);
});

test('pull: a page and its cursor commit together, so a failure cannot leave a cursor ahead of the data', async () => {
  (globalThis as any).__APP_VERSION__ = 'test';
  const { pull } = await import('../src/sync.ts');
  await Promise.all([db.entities.clear(), db.meta.clear()]);
  const page = { cursor: 5, hasMore: false, changes: [{ type: 'category', id: 'a', version: 5, deleted: false, data: { name: 'Snacks', sortOrder: 0 } }] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(page), { status: 200 })) as typeof fetch;
  const put = db.meta.put.bind(db.meta);
  (db.meta as any).put = async (row: any) => { if (row.key === 'cursor') throw new Error('crash before cursor'); return (put as any)(row); };
  try {
    await assert.rejects(pull(device), /crash before cursor/);
    assert.equal(await db.entities.count(), 0, 'rows from the failed page must not persist');
  } finally {
    (db.meta as any).put = put;
  }
  assert.equal(await pull(device), 1);
  assert.equal((await db.meta.get('cursor'))?.value, 5);
  // tombstones delete
  page.changes = [{ type: 'category', id: 'a', version: 6, deleted: true, data: {} }];
  page.cursor = 6;
  await pull(device);
  globalThis.fetch = realFetch;
  assert.equal(await db.entities.count(), 0);
});

test('logo: stored only if it matches the hash pull promised; refetched only when the hash changes; cleared on removal', async () => {
  const { syncLogo } = await import('../src/logo.ts');
  await Promise.all([db.entities.clear(), db.logo.clear()]);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sha = await hex(bytes);
  let served: Uint8Array = bytes;
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response(served as BodyInit, { status: 200 }); }) as typeof fetch;
  try {
    // no logo row: nothing is fetched, and any cached logo is dropped
    await db.logo.put({ sha: 'old', type: 'image/png', bytes: new ArrayBuffer(1) });
    await syncLogo();
    assert.equal(await db.logo.count(), 0);
    assert.equal(calls, 0);

    // a swapped or corrupted response is refused
    await db.entities.put({ type: 'tenant_logo', id: 't', data: { sha256: sha, contentType: 'image/png' } });
    served = new Uint8Array([9, 9, 9]);
    await syncLogo();
    assert.equal(await db.logo.count(), 0);

    // the right bytes are stored, once
    served = bytes;
    await syncLogo();
    assert.equal((await db.logo.get(sha))?.type, 'image/png');
    const before = calls;
    await syncLogo();
    assert.equal(calls, before, 'a cached logo is not fetched again');

    // a new hash replaces the old one
    const next = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6]);
    const sha2 = await hex(next);
    await db.entities.put({ type: 'tenant_logo', id: 't', data: { sha256: sha2, contentType: 'image/png' } });
    served = next;
    await syncLogo();
    assert.deepEqual((await db.logo.toArray()).map((l) => l.sha), [sha2]);

    // removal (tombstone deleted the row) clears the cache
    await db.entities.clear();
    await syncLogo();
    assert.equal(await db.logo.count(), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pull still succeeds when the logo cannot be fetched (cosmetic, never fatal)', async () => {
  (globalThis as any).__APP_VERSION__ = 'test';
  const { pull } = await import('../src/sync.ts');
  await Promise.all([db.entities.clear(), db.meta.clear(), db.logo.clear()]);
  const page = { cursor: 3, hasMore: false, changes: [{ type: 'tenant_logo', id: 't', version: 3, deleted: false, data: { sha256: 'a'.repeat(64), contentType: 'image/png' } }] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/branding/logo')) throw new TypeError('network down');
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await pull(device), 1);
    assert.equal((await db.meta.get('cursor'))?.value, 3, 'the cursor still advanced');
    assert.equal(await db.logo.count(), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
