import test from 'node:test';
import { hostFor } from './hosts.js';
import assert from 'node:assert/strict';
import { allowed } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import type { Permission, Principal, Role } from '../src/scope.js';

const A = '00000000-0000-4000-8000-00000000000a';
test.after(() => pool.end());

const user = (role: Role): Principal => ({ kind: 'user', tenantId: A, userId: 'u', role, outletIds: [], sessionId: 's', deviceId: null });
const device: Principal = { kind: 'device', tenantId: A, deviceId: 'd', outletId: 'o', counterId: 'c' };

// What each principal may do. Waiters take orders but never payment or management.
const MATRIX: Record<Permission, { manager: boolean; cashier: boolean; waiter: boolean; device: boolean }> = {
  manager: { manager: true, cashier: false, waiter: false, device: false },
  till: { manager: true, cashier: true, waiter: false, device: false },
  staff: { manager: true, cashier: true, waiter: true, device: false },
  device: { manager: false, cashier: false, waiter: false, device: true },
};

test('permission matrix: waiter takes orders only', () => {
  for (const [perm, row] of Object.entries(MATRIX) as [Permission, (typeof MATRIX)[Permission]][]) {
    for (const role of ['manager', 'cashier', 'waiter'] as const) {
      assert.equal(allowed(perm, user(role)), row[role], `${role} on '${perm}'`);
    }
    assert.equal(allowed(perm, device), row.device, `device on '${perm}'`);
  }
});

test('only managers can use web login: a waiter or cashier with credentials set is refused', async () => {
  const app = buildApp();
  const hash = (await withTenant(A, (c) => c.query("SELECT password_hash FROM app_user WHERE lower(email) = 'a1@example.test'"))).rows[0].password_hash;
  for (const role of ['waiter', 'cashier']) {
    const email = `${role}-web@example.test`;
    await withTenant(A, (c) =>
      c.query("UPDATE app_user SET email = $1, password_hash = $2 WHERE role = $3 AND name LIKE 'School 1%'", [email, hash, role]));
    const r = await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email, password: 'dev-password-123' } });
    assert.equal(r.statusCode, 401, `${role} must not get a web session`);
    await withTenant(A, (c) => c.query("UPDATE app_user SET email = NULL, password_hash = NULL WHERE role = $1 AND name LIKE 'School 1%'", [role]));
  }
});
