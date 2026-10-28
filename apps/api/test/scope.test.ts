import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

test('every registered route declares a scope', async () => {
  const app = buildApp();
  const seen: string[] = [];
  app.addHook('onRoute', (r) => {
    seen.push(`${r.method} ${r.url} ${r.config?.scope}`);
  });
  await app.ready();
  const routes = app.printRoutes({ commonPrefix: false });
  assert.match(routes, /health/);
  assert.ok(!seen.some((s) => s.endsWith('undefined')));
});

test('a route without a scope declaration is rejected at registration', async () => {
  const app = buildApp();
  app.register(async (inst) => {
    inst.get('/oops', async () => 'x');
  });
  await assert.rejects(async () => { await app.ready(); }, /no config\.scope/);
});

test('withTenant stamps the transaction and does not leak through the pool', async () => {
  const a = await withTenant(A, (c) => c.query('SELECT name FROM outlet'));
  const b = await withTenant(B, (c) => c.query('SELECT name FROM outlet'));
  assert.equal(a.rows.length, 2);
  assert.equal(b.rows.length, 1);
  const unstamped = await pool.query('SELECT name FROM outlet');
  assert.equal(unstamped.rows.length, 0);
});
