import test from 'node:test';
import assert from 'node:assert/strict';
import { add, formatRupees, mul, paise, parseRupees, taxOn } from '../src/index.ts';

test('paise rejects non-integers, NaN, Infinity and unsafe integers', () => {
  for (const bad of [0.1, NaN, Infinity, -Infinity, 2 ** 53]) assert.throws(() => paise(bad), RangeError);
  assert.equal(paise(0), 0);
  assert.equal(paise(-5), -5);
});

test('arithmetic is exact where floats are not', () => {
  assert.equal(add(paise(10), paise(20)), 30); // 0.1 + 0.2 in floats is 0.30000000000000004
  assert.equal(mul(paise(1999), 3), 5997);
  assert.throws(() => mul(paise(10), 1.5), RangeError);
  assert.throws(() => mul(paise(10), -1), RangeError);
});

test('GST rounds half up, once', () => {
  assert.equal(taxOn(paise(10000), 500), 500); // 5% of 100.00
  assert.equal(taxOn(paise(1010), 500), 51); // 50.5 -> 51
  assert.equal(taxOn(paise(1009), 500), 50); // 50.45 -> 50
  assert.equal(taxOn(paise(0), 1800), 0);
  assert.throws(() => taxOn(paise(100), 5.5), RangeError);
});

test('format and parse round-trip without floats', () => {
  assert.equal(formatRupees(paise(12550)), '125.50');
  assert.equal(formatRupees(paise(5)), '0.05');
  assert.equal(formatRupees(paise(-5)), '-0.05');
  for (const p of [0, 1, 99, 100, 12550, 99999999]) assert.equal(parseRupees(formatRupees(paise(p))), p);
  assert.equal(parseRupees('125.5'), 12550);
  assert.equal(parseRupees('125'), 12500);
  for (const bad of ['', '1.234', '-1', '1e3', 'abc', '1,000', '.5']) assert.throws(() => parseRupees(bad), RangeError);
});
