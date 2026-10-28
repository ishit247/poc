import test from 'node:test';
import assert from 'node:assert/strict';
import { exclusiveLine, paise, resolveMenu, type CounterRule, type OutletPriceOverride, type OutletRule } from '../src/index.ts';

const items = [
  { id: 'tea', categoryId: 'c', name: 'Tea', sortOrder: 1 },
  { id: 'samosa', categoryId: 'c', name: 'Samosa', sortOrder: 0, hsnCode: '1905' },
  { id: 'special', categoryId: 'c', name: 'Special', sortOrder: 2 },
];
const prices = [
  { itemId: 'tea', channel: 'counter', pricePaise: 1000, gstRateBp: 500 },
  { itemId: 'samosa', channel: 'counter', pricePaise: 1500, gstRateBp: 500 },
  { itemId: 'samosa', channel: 'zomato', pricePaise: 2000, gstRateBp: 500 },
  { itemId: 'special', channel: 'zomato', pricePaise: 9900, gstRateBp: 1800 }, // no counter price
];
type Opts = { channel?: string; gstEnabled?: boolean; omode?: 'all' | 'listed'; orules?: OutletRule[]; oprices?: OutletPriceOverride[]; counter?: { mode: 'all' | 'listed'; rules: CounterRule[] } };
const run = (o: Opts = {}) =>
  resolveMenu({
    channel: o.channel ?? 'counter', gstEnabled: o.gstEnabled ?? true, items, prices,
    outlet: { mode: o.omode ?? 'all', rules: o.orules ?? [], prices: o.oprices ?? [] },
    ...(o.counter ? { counter: o.counter } : {}),
  });
const ids = (m: { itemId: string }[]) => m.map((e) => e.itemId);
const by = (m: ReturnType<typeof run>, id: string) => m.find((e) => e.itemId === id)!;
const orule = (itemId: string, listed: boolean | null = true, available = true): OutletRule => ({ itemId, listed, available });

test('channel: only items with a catalogue price for the channel are sellable on it', () => {
  assert.deepEqual(ids(run()), ['samosa', 'tea']);
  assert.deepEqual(ids(run({ channel: 'zomato' })), ['samosa', 'special']);
});

test("outlet mode 'all' hides listed=false; 'listed' shows only listed=true", () => {
  assert.deepEqual(ids(run({ orules: [orule('tea', false)] })), ['samosa']);
  assert.deepEqual(ids(run({ omode: 'listed', orules: [orule('tea')] })), ['tea']);
  assert.deepEqual(ids(run({ omode: 'listed' })), []);
  assert.deepEqual(ids(run({ omode: 'listed', orules: [orule('tea', false)] })), []);
});

test("a row with no listing opinion (stock toggle only) never lists an item in a 'listed' outlet", () => {
  assert.deepEqual(ids(run({ omode: 'listed', orules: [orule('tea', null, false)] })), []);
  assert.deepEqual(ids(run({ omode: 'all', orules: [orule('tea', null, false)] })), ['samosa', 'tea'], "and doesn't hide it in 'all'");
});

test('a counter can only narrow what its outlet shows, never widen it', () => {
  const allow = (itemId: string): CounterRule => ({ itemId, listed: true, pricePaise: null });
  // outlet hides tea; a counter that lists tea still cannot show it
  assert.deepEqual(ids(run({ orules: [orule('tea', false)], counter: { mode: 'listed', rules: [allow('tea'), allow('samosa')] } })), ['samosa']);
  // counter narrows an outlet that shows everything
  assert.deepEqual(ids(run({ counter: { mode: 'listed', rules: [allow('tea')] } })), ['tea']);
  assert.deepEqual(ids(run({ counter: { mode: 'all', rules: [{ itemId: 'tea', listed: false, pricePaise: null }] } })), ['samosa']);
});

test('price precedence: counter override > outlet override > catalogue', () => {
  const counter = { mode: 'all' as const, rules: [{ itemId: 'samosa', listed: true, pricePaise: 1200 }] };
  const oprices = [{ itemId: 'samosa', channel: 'counter', pricePaise: 1300 }, { itemId: 'tea', channel: 'counter', pricePaise: 900 }];
  const m = run({ oprices, counter });
  assert.equal(by(m, 'samosa').pricePaise, 1200, 'counter wins');
  assert.equal(by(m, 'tea').pricePaise, 900, 'outlet beats catalogue');
  assert.equal(by(run(), 'tea').pricePaise, 1000, 'catalogue default');
});

test('outlet overrides are per channel: aggregator price differs per outlet (Q10)', () => {
  const oprices = [{ itemId: 'samosa', channel: 'zomato', pricePaise: 2500 }];
  assert.equal(by(run({ channel: 'zomato', oprices }), 'samosa').pricePaise, 2500);
  assert.equal(by(run({ channel: 'counter', oprices }), 'samosa').pricePaise, 1500, 'zomato override must not touch counter price');
  assert.equal(by(run({ channel: 'zomato' }), 'samosa').pricePaise, 2000);
});

test('counter rules apply to the counter channel only', () => {
  const counter = { mode: 'listed' as const, rules: [{ itemId: 'tea', listed: true, pricePaise: 100 }] };
  assert.deepEqual(ids(run({ channel: 'zomato', counter })), ['samosa', 'special']);
  assert.equal(by(run({ channel: 'zomato', counter }), 'samosa').pricePaise, 2000);
});

test('an override of 0 is a real price; no override can make an unpriced item sellable', () => {
  assert.equal(by(run({ oprices: [{ itemId: 'tea', channel: 'counter', pricePaise: 0 }] }), 'tea').pricePaise, 0);
  assert.equal(by(run({ counter: { mode: 'all', rules: [{ itemId: 'tea', listed: true, pricePaise: 0 }] } }), 'tea').pricePaise, 0);
  assert.ok(!ids(run({ oprices: [{ itemId: 'special', channel: 'counter', pricePaise: 500 }] })).includes('special'));
});

test('GST: item rate, but 0 when the outlet is not GST-enabled; overrides never change it', () => {
  const oprices = [{ itemId: 'samosa', channel: 'counter', pricePaise: 1300 }];
  assert.equal(by(run({ oprices }), 'samosa').gstRateBp, 500);
  assert.equal(by(run({ oprices, gstEnabled: false }), 'samosa').gstRateBp, 0);
  assert.equal(by(run({ gstEnabled: false }), 'tea').gstRateBp, 0);
});

test('HSN code passes through for receipts; stock absent means available', () => {
  assert.equal(by(run(), 'samosa').hsnCode, '1905');
  assert.equal(by(run(), 'tea').hsnCode, null);
  assert.equal(by(run({ orules: [orule('tea', true, false)] }), 'tea').available, false);
  assert.equal(by(run({ orules: [orule('tea', true, false)] }), 'samosa').available, true);
});

test('tax-exclusive line: GST added on the line total, rounded once', () => {
  assert.deepEqual(exclusiveLine(paise(1500), 1, 500), { net: 1500, tax: 75, total: 1575 });
  assert.deepEqual(exclusiveLine(paise(333), 3, 500), { net: 999, tax: 50, total: 1049 });
  assert.deepEqual(exclusiveLine(paise(1000), 2, 0), { net: 2000, tax: 0, total: 2000 });
  assert.throws(() => exclusiveLine(paise(100), 1.5, 500), RangeError);
});
