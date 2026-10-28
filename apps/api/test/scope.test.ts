import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

test('every registered route declares a scope', async () => {
  const app = buildApp();
  const seen: { id: string; scope?: string; permission?: string }[] = [];
  app.addHook('onRoute', (r) => {
    seen.push({ id: `${r.method} ${r.url}`, scope: r.config?.scope, permission: r.config?.permission });
  });
  await app.ready();
  assert.ok(seen.length >= 6, `expected the full route table, saw ${seen.length}`);
  for (const r of seen) {
    assert.ok(r.scope, `${r.id}: no scope`);
    if (r.scope !== 'public') assert.ok(r.permission, `${r.id}: non-public route has no permission`);
  }
  // Routes taking an :id must not be public: an id is exactly where "whose" matters.
  for (const r of seen.filter((x) => x.id.includes(':'))) assert.notEqual(r.scope, 'public', `${r.id}: id route is public`);
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
