// Bill discounts (docs/discounts-plan.md): before GST, split over the lines by their nets with the paise left over by
// largest remainder, GST rounded once per line on the discounted net, round-off last.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPayment, discountLines, discountOn, discountOverCap, OutboxEvent, paise, taxOn, totals, DEFAULT_SETTINGS,
  type Cart, type FoldedLine, type OrderFold,
} from '../src/index.ts';

const line = (id: string, unit: number, gst: number, qty = 1) => ({ itemId: id, name: id, unitPaise: paise(unit), gstRateBp: gst, qty });
const ps = (xs: number[]) => xs.map(paise);

test('discount split: adds up exactly, by largest remainder, ties to the earlier line, never above a line', () => {
  // 100 over 333 + 667: 33.3 and 66.7, one paisa left, to the larger remainder (the second line).
  assert.deepEqual(discountLines(ps([333, 667]), paise(100)), [33, 67]);
  // Three equal lines, 100 paise: 33 each, one left; equal remainders go to the first line.
  assert.deepEqual(discountLines(ps([500, 500, 500]), paise(100)), [34, 33, 33]);
  assert.deepEqual(discountLines(ps([0, 1000]), paise(10)), [0, 10]);
  assert.deepEqual(discountLines(ps([100, 200]), paise(0)), [0, 0]);
  assert.throws(() => discountLines(ps([100, 200]), paise(300)), RangeError); // nothing left to pay
  // Large bills do not lose precision (the product goes through BigInt).
  const big = ps([4_000_000_123, 3_999_999_877, 1]);
  assert.equal(discountLines(big, paise(7_999_999_999)).reduce((a, b) => a + b, 0), 7_999_999_999);

  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let k = 0; k < 2000; k++) {
    const nets = ps(Array.from({ length: 1 + rnd(6) }, () => rnd(5000)));
    const sum = nets.reduce((a, b) => a + b, 0);
    if (sum < 2) continue;
    const d = paise(1 + rnd(sum - 1));
    const shares = discountLines(nets, d);
    assert.equal(shares.reduce((a, b) => a + b, 0), d, `split of ${d} over ${nets}`);
    shares.forEach((s, i) => {
      assert.ok(s >= 0 && s <= nets[i]!, `share ${s} of line ${nets[i]}`);
      // Within one paisa of the exact proportion.
      assert.ok(Math.abs(s - (nets[i]! * d) / sum) < 1, `share ${s} vs exact ${(nets[i]! * d) / sum}`);
    });
  }
});

test('discount: mixed GST rates are each taxed on their own discounted net', () => {
  const cart: Cart = [line('a', 10000, 500), line('b', 5000, 1800)];
  const t = totals(cart, DEFAULT_SETTINGS, { kind: 'percent', value: 1000 }); // 10%
  assert.equal(t.subtotal, 15000);
  assert.equal(t.discount, 1500);
  assert.deepEqual(t.lines.map((l) => [l.net, l.discount, l.tax, l.total]), [[10000, 1000, 450, 9450], [5000, 500, 810, 5310]]);
  assert.equal(t.tax, 1260);
  assert.equal(t.total, 14760); // 15000 - 1500 + 1260
  assert.equal(t.total, t.lines.reduce((a, l) => a + l.total, 0));
});

test('discount: GST rounded once per line on the discounted net, in all three modes', () => {
  // Shares 33 and 67 (see the split test): nets after discount 300 at 2.1% (6.3) and 600 at 12.25% (73.5).
  const cart: Cart = [line('a', 333, 210), line('b', 667, 1225)];
  const want = { half_up: [6, 74], up: [7, 74], down: [6, 73] } as const;
  for (const mode of ['half_up', 'up', 'down'] as const) {
    const t = totals(cart, { ...DEFAULT_SETTINGS, gstRounding: mode }, { kind: 'amount', value: 100 });
    assert.deepEqual(t.lines.map((l) => l.tax), [...want[mode]], mode);
    assert.equal(t.total, 1000 - 100 + want[mode][0] + want[mode][1], mode);
    // Not the tax on the gross line.
    assert.notEqual(t.tax, taxOn(paise(333), 210, mode) + taxOn(paise(667), 1225, mode), mode);
  }
});

test('discount: a percentage and the same paise as a flat amount give the same bill', () => {
  const cart: Cart = [line('a', 1234, 500, 3), line('b', 999, 1200), line('c', 50, 0, 7)];
  const pct = totals(cart, DEFAULT_SETTINGS, { kind: 'percent', value: 1250 });
  const flat = totals(cart, DEFAULT_SETTINGS, { kind: 'amount', value: pct.discount });
  assert.deepEqual(flat, pct);
  // A percentage is turned into paise once, half up, on the subtotal: 12.5% of 5051 = 631.375 -> 631.
  assert.equal(pct.subtotal, 5051);
  assert.equal(pct.discount, 631);
  assert.equal(discountOn(paise(10), { kind: 'percent', value: 2500 }), 3); // 2.5 -> 3, half up
});

test('discount: round-off comes last, on subtotal - discount + GST', () => {
  // 100.50 at 0% less 0.30 = 100.20, to the rupee -> 100.00 (-0.20). Rounding before the discount would give 100.70.
  const t = totals([line('a', 10050, 0)], { ...DEFAULT_SETTINGS, billRoundTo: 100 }, { kind: 'amount', value: 30 });
  assert.equal(t.roundOff, -20);
  assert.equal(t.total, 10000);
});

test('discount: the bill stays above zero; a discount that comes to nothing is refused', () => {
  const cart: Cart = [line('a', 1000, 500)];
  assert.throws(() => totals(cart, DEFAULT_SETTINGS, { kind: 'amount', value: 1000 }), RangeError);
  assert.throws(() => totals(cart, DEFAULT_SETTINGS, { kind: 'percent', value: 10000 }), RangeError);
  assert.throws(() => discountOn(paise(49), { kind: 'percent', value: 1 }), RangeError); // 0.0049 paise
  assert.throws(() => discountOn(paise(1000), { kind: 'percent', value: 10001 }), RangeError);
  assert.throws(() => discountOn(paise(1000), { kind: 'amount', value: 0 }), RangeError);
  const t = totals(cart, DEFAULT_SETTINGS, { kind: 'amount', value: 999 });
  assert.equal(t.total, 1 + taxOn(paise(1), 500));
  assert.ok(t.total > 0);
  assert.equal(totals(cart).discount, 0); // no discount: as before
});

test('discount cap: a percentage by its rate, a flat amount by its share of the subtotal', () => {
  assert.equal(discountOverCap(paise(10000), { kind: 'percent', value: 1000 }, 1000), false);
  assert.equal(discountOverCap(paise(10000), { kind: 'percent', value: 1001 }, 1000), true);
  assert.equal(discountOverCap(paise(10000), { kind: 'amount', value: 1000 }, 1000), false);
  assert.equal(discountOverCap(paise(10000), { kind: 'amount', value: 1001 }, 1000), true);
  // 10% of 10.05 is 1.005, rounded to 1.01 paise: still within a 10% cap, because the rate is what was given.
  assert.equal(discountOverCap(paise(1005), { kind: 'percent', value: 1000 }, 1000), false);
  assert.equal(discountOverCap(paise(10000), { kind: 'amount', value: 1 }, 0), true); // cap 0 = discounts off
});

const folded = (lineId: string, unit: number, gst: number, qty: number): FoldedLine => ({
  ...line(lineId, unit, gst, qty), lineId, addedBy: 'u', addedAt: '2026-11-15T10:00:00Z', removedBy: null, removedAt: null,
});
const foldOf = (lines: FoldedLine[]): OrderFold => ({ saleId: 's', opened: null, tableId: null, lines, discount: null, anomalies: [] });

test('checkPayment: totals the paid lines with the payment discount, and checks each line share', () => {
  const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
  const f = foldOf([folded(ids[0]!, 500, 500, 1), folded(ids[1]!, 500, 500, 1), folded(ids[2]!, 500, 1800, 1)]);
  const d = { kind: 'amount', value: 100 } as const;
  // In the payment's order (c, a, b): equal remainders, so c, listed first, takes the extra paisa.
  const order = [ids[2]!, ids[0]!, ids[1]!];
  const t = totals(order.map((id) => f.lines.find((l) => l.lineId === id)!), DEFAULT_SETTINGS, d);
  assert.deepEqual(t.lines.map((l) => l.discount), [34, 33, 33]);
  const paid = order.map((lineId, i) => ({ lineId, qty: 1, discountPaise: t.lines[i]!.discount }));

  const ok = checkPayment(f, paid, t.total, DEFAULT_SETTINGS, d);
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') assert.equal(ok.totals.discount, 100);
  // A tampered share (the bill total unchanged) is refused.
  const moved = paid.map((p, i) => ({ ...p, discountPaise: p.discountPaise + (i === 0 ? -1 : i === 1 ? 1 : 0) }));
  assert.equal(checkPayment(f, moved, t.total, DEFAULT_SETTINGS, d).kind, 'mismatch');
  // A discounted total paid without its discount (or the other way) is refused.
  assert.equal(checkPayment(f, paid, t.total, DEFAULT_SETTINGS, null).kind, 'mismatch');
  assert.equal(checkPayment(f, paid.map((p) => ({ ...p, discountPaise: 0 })), t.total + 100, DEFAULT_SETTINGS, d).kind, 'mismatch');
  // A discount that leaves nothing to pay.
  assert.equal(checkPayment(f, paid, 1, DEFAULT_SETTINGS, { kind: 'amount', value: 1500 }).kind, 'bad_discount');
});

test('events: a discount travels on sale.created and v2 payment.taken; absent means none', () => {
  const base = {
    type: 'sale.created', schemaVersion: 1, saleId: crypto.randomUUID(), channel: 'counter', createdBy: crypto.randomUUID(),
    businessDate: '2026-11-15', createdAtDevice: '2026-11-15T10:00:00+05:30', menuVersion: 1,
    lines: [{ itemId: crypto.randomUUID(), name: 'Tea', unitPaise: 1000, gstRateBp: 500, qty: 1, netPaise: 1000, taxPaise: 50 }],
    subtotalPaise: 1000, taxPaise: 50, roundOffPaise: 0, totalPaise: 1050,
  };
  const plain = OutboxEvent.parse(base);
  assert.ok(plain.type === 'sale.created' && plain.discount === null && plain.discountPaise === 0 && plain.lines[0]!.discountPaise === 0);

  const discounted = {
    ...base, discount: { kind: 'percent', value: 1000, reason: 'Staff meal' }, discountPaise: 100,
    lines: [{ ...base.lines[0]!, discountPaise: 100, taxPaise: 45 }], taxPaise: 45, totalPaise: 945,
  };
  assert.ok(OutboxEvent.safeParse(discounted).success);
  assert.ok(!OutboxEvent.safeParse({ ...discounted, totalPaise: 1045 }).success); // total ignores the discount
  assert.ok(!OutboxEvent.safeParse({ ...discounted, discount: null, discountPaise: 100 }).success); // amount without a discount
  assert.ok(!OutboxEvent.safeParse({ ...discounted, discount: { kind: 'percent', value: 1000, reason: ' ' } }).success); // no reason
  assert.ok(!OutboxEvent.safeParse({ ...discounted, discount: { kind: 'percent', value: 10001, reason: 'x' } }).success);
});
