import test from 'node:test';
import assert from 'node:assert/strict';
import { pinProblem } from '../src/index.ts';

test('acceptable PINs', () => {
  for (const ok of ['482913', '907251', '13579246', '400125', '19840512']) assert.equal(pinProblem(ok), null, ok);
});

test('wrong shape', () => {
  for (const bad of ['', '12345', '123456789', '12a456', '12 456', '-48291', '48291.3', '٤٨٢٩١٣']) assert.equal(pinProblem(bad), 'format', JSON.stringify(bad));
});

test('obvious PINs are refused', () => {
  assert.equal(pinProblem('000000'), 'repeated');
  assert.equal(pinProblem('99999999'), 'repeated');
  assert.equal(pinProblem('123456'), 'sequence');
  assert.equal(pinProblem('654321'), 'sequence');
  assert.equal(pinProblem('01234567'), 'sequence');
  assert.equal(pinProblem('121212'), 'pattern');
  assert.equal(pinProblem('123123'), 'pattern');
  assert.equal(pinProblem('12121212'), 'pattern');
});

test('near misses of those patterns are allowed', () => {
  for (const ok of ['123457', '121213', '123124', '111112']) assert.equal(pinProblem(ok), null, ok);
});
