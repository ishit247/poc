import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem, setQty, totals, validatePayments, PaymentError, nextReceipt, OutboxEvent, paise,
  attemptPin, verifyPinVerifier, FRESH_PIN_STATE, OFFLINE_PIN_LOCK_MS,
  type MenuEntry, type Cart, type Tender, type TradingSettings, DEFAULT_SETTINGS, roundOffFor, taxOn,
  TradingSettings as SettingsSchema,
} from '../src/index.ts';
import { hashPassword } from '../../../apps/api/src/security/password.ts';

const entry = (id: string, price: number, gst = 500, available = true): MenuEntry => ({
  itemId: id, categoryId: 'c', name: `item ${id}`, sortOrder: 0, hsnCode: null, pricePaise: paise(price), gstRateBp: gst, available,
});

test('cart: totals round GST once per line, not per unit', () => {
  // 3 x 1.10 at 5% -> net 330, tax 16.5 -> 17 (half up on the line). Per-unit rounding would give 3 x 6 = 18.
  let cart: Cart = [];
  cart = addItem(cart, entry('a', 110), 3);
  const t = totals(cart);
  assert.equal(t.subtotal, 330);
  assert.equal(t.tax, 17);
  assert.equal(t.total, 347);
});

test('cart: adding twice merges; qty 0 removes; limits and availability enforced', () => {
  let cart: Cart = addItem(addItem([], entry('a', 100)), entry('a', 100));
  assert.equal(cart.length, 1);
  assert.equal(cart[0]!.qty, 2);
  assert.equal(setQty(cart, 'a', 0).length, 0);
  assert.throws(() => setQty(cart, 'a', 100), RangeError);
  assert.throws(() => setQty(cart, 'a', 1.5), RangeError);
  assert.throws(() => addItem([], entry('b', 100, 0, false)), RangeError);
  assert.throws(() => addItem([], entry('b', 100), 0), RangeError);
  assert.throws(() => addItem([], entry('b', 100), -1), RangeError);
});

test('cart: totals are the sum of the lines', () => {
  const cart = addItem(addItem([], entry('a', 999, 1200), 2), entry('b', 333, 0), 3);
  const t = totals(cart);
  assert.equal(t.total, t.lines.reduce((s, l) => s + l.total, 0));
  assert.equal(t.total, t.subtotal + t.tax);
});

const cash = (amount: number, tendered: number): Tender => ({ method: 'cash', amountPaise: paise(amount), tenderedPaise: paise(tendered) });
const upi = (amount: number, ref?: string): Tender => ({ method: 'upi', amountPaise: paise(amount), ...(ref ? { upiRef: ref } : {}) });

test('payment: cash gives change, upi never does', () => {
  const [r] = validatePayments(paise(347), [cash(347, 500)]);
  assert.equal(r!.changePaise, 153);
  assert.equal(r!.tenderedPaise, 500);
  const [u] = validatePayments(paise(347), [upi(347, ' ref1 ')]);
  assert.equal(u!.changePaise, 0);
  assert.equal(u!.tenderedPaise, null);
  assert.equal(u!.upiRef, 'ref1');
});

test('payment: split must add up exactly', () => {
  const rs = validatePayments(paise(1000), [cash(400, 500), upi(600)]);
  assert.equal(rs.length, 2);
  for (const bad of [[cash(400, 400), upi(500)], [cash(400, 400), upi(700)], [cash(1000, 1000), upi(1)]])
    assert.throws(() => validatePayments(paise(1000), bad), (e) => e instanceof PaymentError && e.problem === 'mismatch');
});

test('payment: empty, non-positive and short cash are refused', () => {
  assert.throws(() => validatePayments(paise(100), []), (e) => e instanceof PaymentError && e.problem === 'empty');
  assert.throws(() => validatePayments(paise(100), [upi(0)]), (e) => e instanceof PaymentError && e.problem === 'amount');
  assert.throws(() => validatePayments(paise(100), [cash(100, 99)]), (e) => e instanceof PaymentError && e.problem === 'tendered');
});

test('receipt: format, sequence, new day restarts, clock going backwards never reuses', () => {
  const a = nextReceipt('C1', null, '2026-10-29');
  assert.equal(a.receiptNo, 'C1-20261029-1');
  const b = nextReceipt('C1', a.counter, '2026-10-29');
  assert.equal(b.receiptNo, 'C1-20261029-2');
  assert.equal(nextReceipt('C1', b.counter, '2026-10-30').receiptNo, 'C1-20261030-1');
  assert.equal(nextReceipt('C1', b.counter, '2026-10-28').receiptNo, 'C1-20261029-3');
  assert.throws(() => nextReceipt('C1', null, '29/10/2026'), RangeError);
  assert.throws(() => nextReceipt('C-1', null, '2026-10-29'), RangeError);
});

test('events: valid payloads parse, wrong version or shape does not', () => {
  const id = '3f2b8a52-0f6e-4c2e-9d57-0d2f4a1c9b11';
  const sale = {
    type: 'sale.created', schemaVersion: 1, saleId: id, channel: 'counter', createdBy: id, businessDate: '2026-10-29',
    createdAtDevice: '2026-10-29T10:00:00+05:30', menuVersion: 7,
    lines: [{ itemId: id, name: 'Tea', unitPaise: 1000, gstRateBp: 500, qty: 1, netPaise: 1000, taxPaise: 50 }],
    subtotalPaise: 1000, taxPaise: 50, roundOffPaise: 0, totalPaise: 1050,
  };
  assert.ok(OutboxEvent.safeParse(sale).success);
  assert.ok(!OutboxEvent.safeParse({ ...sale, schemaVersion: 2 }).success);
  assert.ok(!OutboxEvent.safeParse({ ...sale, lines: [] }).success);
  assert.ok(!OutboxEvent.safeParse({ ...sale, totalPaise: 10.5 }).success);
  assert.ok(!OutboxEvent.safeParse({ ...sale, totalPaise: 1051 }).success); // does not add up
  assert.ok(OutboxEvent.safeParse({ ...sale, roundOffPaise: -50, totalPaise: 1000 }).success);
  const pay = { type: 'payment.taken', schemaVersion: 1, saleId: id, businessDate: '2026-10-29', receiptNo: 'C1-20261029-1', receiptSeq: 1,
    payments: [{ method: 'upi', amountPaise: 1050, tenderedPaise: null, changePaise: 0, upiRef: null }] };
  assert.ok(OutboxEvent.safeParse(pay).success);
  assert.ok(!OutboxEvent.safeParse({ ...pay, payments: [] }).success);
});

test('offline PIN: verifies the server-format verifier; rejects wrong, malformed', async () => {
  const v = await hashPassword('482913'); // the server's own hasher
  assert.equal(await verifyPinVerifier('482913', v), true);
  assert.equal(await verifyPinVerifier('482914', v), false);
  assert.equal(await verifyPinVerifier('482913', 'garbage'), false);
});

test('offline PIN lockout: 5 failures lock for 5 minutes, even a right PIN waits, then resets', async () => {
  let s = FRESH_PIN_STATE;
  let now = 1_000_000;
  const bad = async () => false;
  const good = async () => true;
  for (let i = 1; i <= 4; i++) {
    const r = await attemptPin(s, now, bad);
    assert.equal(r.kind, 'wrong');
    s = r.state;
  }
  const fifth = await attemptPin(s, now, bad);
  assert.equal(fifth.kind, 'locked');
  s = fifth.state;
  let consulted = false;
  const during = await attemptPin(s, now + OFFLINE_PIN_LOCK_MS - 1, async () => ((consulted = true), true));
  assert.equal(during.kind, 'locked');
  assert.equal(consulted, false);
  now += OFFLINE_PIN_LOCK_MS;
  const after = await attemptPin(s, now, bad); // an expired lock starts a fresh count: 1 failure, not 6
  assert.equal(after.kind, 'wrong');
  assert.equal(after.state.failures, 1);
  const ok = await attemptPin(after.state, now, good);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.state.failures, 0);
});

const S = (o: Partial<TradingSettings>): TradingSettings => ({ ...DEFAULT_SETTINGS, ...o });

test('settings: quantity cap is configurable, in both directions', () => {
  const e = entry('a', 100);
  assert.throws(() => addItem([], e, 6, S({ maxLineQty: 5 })), RangeError);
  assert.equal(addItem([], e, 5, S({ maxLineQty: 5 }))[0]!.qty, 5);
  assert.throws(() => addItem(addItem([], e, 5, S({ maxLineQty: 5 })), e, 1, S({ maxLineQty: 5 })), RangeError); // merge also capped
  assert.equal(addItem([], e, 500, S({ maxLineQty: 999 }))[0]!.qty, 500);
  assert.throws(() => addItem([], e, 500), RangeError); // default stays 99
});

test('settings: GST rounding mode changes the tax on a fractional-paisa line', () => {
  assert.equal(taxOn(paise(330), 500, 'half_up'), 17); // 16.5
  assert.equal(taxOn(paise(330), 500, 'up'), 17);
  assert.equal(taxOn(paise(330), 500, 'down'), 16);
  assert.equal(taxOn(paise(301), 500, 'half_up'), 15); // 15.05
  assert.equal(taxOn(paise(301), 500, 'up'), 16);
  assert.equal(taxOn(paise(301), 500, 'down'), 15);
  for (const m of ['half_up', 'up', 'down'] as const) assert.equal(taxOn(paise(300), 500, m), 15, m); // exact stays exact
  const cart = addItem([], entry('a', 110), 3);
  assert.equal(totals(cart, S({ gstRounding: 'down' })).tax, 16);
  assert.equal(totals(cart, S({ gstRounding: 'half_up' })).tax, 17);
});

test('settings: bill round-off', () => {
  assert.equal(roundOffFor(paise(347), 0), 0);
  assert.equal(roundOffFor(paise(347), 100), -47); // 347 -> 300
  assert.equal(roundOffFor(paise(349), 100), -49);
  assert.equal(roundOffFor(paise(350), 100), 50); // half up: 350 -> 400
  assert.equal(roundOffFor(paise(362), 100), 38); // 362 -> 400
  assert.equal(roundOffFor(paise(347), 50), 3); // -> 350
  assert.equal(roundOffFor(paise(347), 10), 3); // -> 350
  assert.equal(roundOffFor(paise(1000), 100), 0);
  assert.equal(roundOffFor(paise(30), 100), 0); // would round to zero: left alone
  const cart = addItem([], entry('a', 110), 3); // 347
  const t = totals(cart, S({ billRoundTo: 100 }));
  assert.equal(t.roundOff, -47);
  assert.equal(t.total, 300);
  assert.equal(t.total, t.subtotal + t.tax + t.roundOff);
  assert.equal(totals(cart).roundOff, 0);
  // the rounded total is what payments must add up to
  assert.equal(validatePayments(t.total, [cash(300, 500)])[0]!.changePaise, 200);
  assert.throws(() => validatePayments(t.total, [cash(347, 347)]), PaymentError);
});

test('settings: schema accepts valid, refuses out-of-range and unknown keys', () => {
  assert.ok(SettingsSchema.safeParse(DEFAULT_SETTINGS).success);
  for (const bad of [{ maxLineQty: 0 }, { maxLineQty: 1000 }, { maxLineQty: 1.5 }, { gstRounding: 'banker' }, { billRoundTo: 25 }, { offlineDays: 0 }, { offlineDays: 61 }, { extra: 1 }])
    assert.ok(!SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...bad }).success, JSON.stringify(bad));
});
