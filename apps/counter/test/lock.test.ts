import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { CLOCK_SLACK_MS, DAY_MS, lastContact, offlineLock } from '../src/lock.ts';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

test('open until the last day, warned during it, locked once the days are up', () => {
  assert.deepEqual(offlineLock(at(T0), T0, 7), { state: 'ok' });
  assert.deepEqual(offlineLock(at(T0), T0 + 6 * DAY_MS - 1, 7), { state: 'ok' });
  assert.deepEqual(offlineLock(at(T0), T0 + 6 * DAY_MS, 7), { state: 'warn', leftMs: DAY_MS });
  assert.deepEqual(offlineLock(at(T0), T0 + 7 * DAY_MS - 1, 7), { state: 'warn', leftMs: 1 });
  assert.deepEqual(offlineLock(at(T0), T0 + 7 * DAY_MS, 7), { state: 'locked', reason: 'too_long' });
  assert.deepEqual(offlineLock(at(T0), T0 + 2 * DAY_MS, 1), { state: 'locked', reason: 'too_long' }, 'the setting is honoured');
});

test('no contact on record locks (fails closed)', () => {
  assert.deepEqual(offlineLock(undefined, T0, 7), { state: 'locked', reason: 'never' });
  assert.deepEqual(offlineLock('not a date', T0, 7), { state: 'locked', reason: 'never' });
});

test('a clock set back past the last contact locks; a small correction does not', () => {
  assert.deepEqual(offlineLock(at(T0), T0 - CLOCK_SLACK_MS, 7), { state: 'ok' });
  assert.deepEqual(offlineLock(at(T0), T0 - CLOCK_SLACK_MS - 1, 7), { state: 'locked', reason: 'clock' });
  assert.deepEqual(offlineLock(at(T0), T0 - 30 * DAY_MS, 7), { state: 'locked', reason: 'clock' }, 'winding back a month does not skip the lock');
});

beforeEach(() => db.meta.clear());

test('contact is the later of the last pull and the last push', async () => {
  assert.equal(await lastContact(), undefined);
  await db.meta.put({ key: 'lastPull', value: at(T0) });
  assert.equal(await lastContact(), at(T0));
  await db.meta.put({ key: 'lastPush', value: at(T0 + DAY_MS) });
  assert.equal(await lastContact(), at(T0 + DAY_MS));
  await db.meta.put({ key: 'lastPull', value: at(T0 + 2 * DAY_MS) });
  assert.equal(await lastContact(), at(T0 + 2 * DAY_MS));
});
