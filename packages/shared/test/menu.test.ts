import test from 'node:test';
import assert from 'node:assert/strict';
import { exclusiveLine, paise, resolveCounterMenu } from '../src/index.ts';

const items = [
  { id: 'tea', categoryId: 'c', name: 'Tea', sortOrder: 1 },
  { id: 'samosa', categoryId: 'c', name: 'Samosa', sortOrder: 0 },
  { id: 'special', categoryId: 'c', name: 'Special', sortOrder: 2 },
];
const prices = [
  { itemId: 'tea', channel: 'counter', pricePaise: 1000, gstRateBp: 500 },
  { itemId: 'samosa', channel: 'counter', pricePaise: 1500, gstRateBp: 500 },
  { itemId: 'samosa', channel: 'zomato', pricePaise: 2000, gstRateBp: 500 },
  { itemId: 'special', channel: 'zomato', pricePaise: 9900, gstRateBp: 1800 }, // no counter price
];
const base = { items, prices, stock: [], rules: [] };
const ids = (m: { itemId: string }[]) => m.map((e) => e.itemId);

test("mode 'all': everything with a counter price, sorted; aggregator-only items are not sellable", () => {
  assert.deepEqual(ids(resolveCounterMenu({ ...base, mode: 'all' })), ['samosa', 'tea']);
});

test("mode 'all': a listed=false rule hides an item", () => {
  const m = resolveCounterMenu({ ...base, mode: 'all', rules: [{ itemId: 'tea', listed: false, pricePaise: null }] });
  assert.deepEqual(ids(m), ['samosa']);
});

test("mode 'listed': only listed items; no rule means not shown", () => {
  const m = resolveCounterMenu({ ...base, mode: 'listed', rules: [{ itemId: 'tea', listed: true, pricePaise: null }] });
  assert.deepEqual(ids(m), ['tea']);
  assert.deepEqual(ids(resolveCounterMenu({ ...base, mode: 'listed' })), []);
  assert.deepEqual(ids(resolveCounterMenu({ ...base, mode: 'listed', rules: [{ itemId: 'tea', listed: false, pricePaise: null }] })), []);
});

test('price override applies at this counter, uses the counter channel, and never changes GST', () => {
  const m = resolveCounterMenu({ ...base, mode: 'all', rules: [{ itemId: 'samosa', listed: true, pricePaise: 1200 }] });
  const samosa = m.find((e) => e.itemId === 'samosa')!;
  assert.equal(samosa.pricePaise, 1200);
  assert.equal(samosa.gstRateBp, 500);
  assert.equal(m.find((e) => e.itemId === 'tea')!.pricePaise, 1000, 'other items keep the catalogue price');
});

test('an override of 0 is a real price (free), not "no override"', () => {
  const m = resolveCounterMenu({ ...base, mode: 'all', rules: [{ itemId: 'tea', listed: true, pricePaise: 0 }] });
  assert.equal(m.find((e) => e.itemId === 'tea')!.pricePaise, 0);
});

test('an override cannot make an unpriced item sellable', () => {
  const m = resolveCounterMenu({ ...base, mode: 'all', rules: [{ itemId: 'special', listed: true, pricePaise: 500 }] });
  assert.ok(!ids(m).includes('special'));
});

test('stock: absent means available; false is shown but unavailable', () => {
  const m = resolveCounterMenu({ ...base, mode: 'all', stock: [{ itemId: 'tea', available: false }] });
  assert.equal(m.find((e) => e.itemId === 'tea')!.available, false);
  assert.equal(m.find((e) => e.itemId === 'samosa')!.available, true);
});

test('tax-exclusive line: GST added on the line total, rounded once', () => {
  assert.deepEqual(exclusiveLine(paise(1500), 1, 500), { net: 1500, tax: 75, total: 1575 });
  // 3 x 3.33 = 9.99 -> 5% = 49.95 -> 50 (rounded once on the line, not 3 x round(16.65))
  assert.deepEqual(exclusiveLine(paise(333), 3, 500), { net: 999, tax: 50, total: 1049 });
  assert.deepEqual(exclusiveLine(paise(1000), 2, 0), { net: 2000, tax: 0, total: 2000 });
  assert.throws(() => exclusiveLine(paise(100), 1.5, 500), RangeError);
});
