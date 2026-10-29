// Mutation checks for the phase 3 guards: remove or weaken ONE guard, rebuild a fresh database,
// run the tests that are meant to protect it, and require at least one to fail.
//   node scripts/mutation-checks.mjs [id ...]      (no ids = all)
// Each run is on a fresh database (a failing test can leave state that corrupts later results).
// The mutated file is always restored, including on Ctrl-C. A mutant whose schema or code does not
// load is reported BROKEN, not "caught": it proves nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const API_TESTS = (...f) => ({ cwd: 'apps/api', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', ...f.map((x) => `test/${x}`)] });
const DB_TESTS = { cwd: '.', cmd: ['node', '--test', 'db/test/rls.test.mjs', 'db/test/trading.test.mjs'] };

const AUTH = 'apps/api/src/routes/auth.ts';
const ADMIN = 'apps/api/src/routes/admin.ts';
const SYNC = 'apps/api/src/routes/sync.ts';
const ORDERS = 'apps/api/src/routes/orders.ts';
const TRADING = 'db/migrations/0004_trading.sql';
const M = (id, file, from, to, tests, all = false) => ({ id, file, from, to, tests, all });

const staff = API_TESTS('staff.test.ts');
const orders = API_TESTS('orders.test.ts');
const MUTANTS = [
  // --- PIN sign-in and lockout
  M('pin-lock-ignored', AUTH, "if (state.locked) return { kind: 'locked' as const, until: state.lockedUntil };", '', staff),
  M('pin-threshold', AUTH, 'const PIN_MAX_FAILED = 5;', 'const PIN_MAX_FAILED = 50;', staff),
  M('pin-lock-per-lockstate', 'apps/api/src/lockout.ts', 'const lock = state.failed + 1 >= max;', 'const lock = state.failed + 1 >= max + 100;', API_TESTS('staff.test.ts', 'auth.test.ts')),
  M('pin-manager-allowed', AUTH, "u.role IN ('cashier', 'waiter')", "u.role IN ('cashier', 'waiter', 'manager')", staff),
  M('pin-outlet-scope', AUTH, 'uo.deleted_at IS NULL AND uo.outlet_id = $2', 'uo.deleted_at IS NULL AND $2::uuid IS NOT NULL', staff),
  M('pin-inactive-user', AUTH, 'WHERE u.id = $1 AND u.active AND', 'WHERE u.id = $1 AND', staff),
  M('unlock-no-scope', ADMIN, "if (!(await manageable(c, ps.data.id, p.outletIds))) return false;\n      await clearLockout(c, ps.data.id, 'pin');", "await clearLockout(c, ps.data.id, 'pin');", staff),
  M('unlock-any-staff', ADMIN, "app.post('/users/:id/unlock', { config: { ...cfg,", "app.post('/users/:id/unlock', { config: { scope: 'outlet', permission: 'staff',", staff),
  M('session-ignores-revoked-device', 'apps/api/src/auth.ts', 'AND (s.device_id IS NULL OR d.revoked_at IS NULL)', 'AND true', staff),
  M('app-version-unvalidated', 'apps/api/src/auth.ts', 'APP_VERSION.test(reported) ? reported : null', 'reported ? String(reported) : null', staff),
  // --- users in the pull
  M('pull-tombstone-leaks-verifier', SYNC, "CASE WHEN uo.deleted_at IS NOT NULL OR NOT u.active THEN '{}'::jsonb", "CASE WHEN false THEN '{}'::jsonb", staff),
  M('pull-managers', SYNC, "u.role IN ('cashier', 'waiter') AND GREATEST", "u.role IN ('cashier', 'waiter', 'manager') AND GREATEST", staff),
  M('pull-other-outlets', SYNC, 'WHERE uo.outlet_id = $2 AND u.role', 'WHERE $2::uuid IS NOT NULL AND u.role', staff),
  M('pull-membership-version-ignored', SYNC, 'GREATEST(u.version, uo.version)', 'u.version', staff, true),
  M('membership-noop-reversioned', ADMIN, 'DO UPDATE SET deleted_at = NULL WHERE user_outlet.deleted_at IS NOT NULL', 'DO UPDATE SET deleted_at = NULL', staff),
  M('user-not-versioned', 'db/migrations/0003_menu.sql', "SELECT app.add_versioning('app_user');", '', API_TESTS('staff.test.ts')),
  // --- order scope
  M('orders-waiter-any-order', ORDERS, "OR ($1 = 'waiter' AND sale.created_by = $2 AND sale.status = 'open'))", "OR ($1 = 'waiter' AND sale.status = 'open'))", orders),
  M('orders-waiter-sees-paid', ORDERS, "OR ($1 = 'waiter' AND sale.created_by = $2 AND sale.status = 'open'))", "OR ($1 = 'waiter' AND sale.created_by = $2))", orders),
  M('orders-outlet-scope', ORDERS, 'sale.outlet_id = ANY($3::uuid[]) AND (', '$3::uuid[] IS NOT NULL AND (', orders),
  M('orders-cashier-any-shift', ORDERS, 'sale.shift_id IN (SELECT id FROM shift WHERE user_id = $2)', 'sale.shift_id IS NOT NULL', orders),
  M('orders-void-paid', ORDERS, "WHERE sale.id = $4 AND sale.status = 'open' AND ${ORDER_SCOPE} RETURNING", 'WHERE sale.id = $4 AND ${ORDER_SCOPE} RETURNING', orders),
  M('orders-route-scope-undeclared', ORDERS, "app.post('/orders/:id/void', { config: cfg }", "app.post('/orders/:id/void', { config: { scope: 'tenant', permission: 'staff' } }", orders),
  // --- trading schema
  M('sale-edit-after-paid', TRADING, "IF OLD.status <> 'open' AND (NEW.subtotal_paise", "IF false AND (NEW.subtotal_paise", DB_TESTS),
  M('sale-reopen', TRADING, "OR (OLD.status = 'paid' AND NEW.status IN ('refunded', 'void'))) THEN", "OR (OLD.status = 'paid' AND NEW.status IN ('refunded', 'void', 'open'))) THEN", DB_TESTS),
  M('payments-overpay-ok', TRADING, 'IF paid <> s.total_paise THEN', 'IF paid < s.total_paise THEN', DB_TESTS),
  M('sale-trigger-missing', TRADING, 'CREATE CONSTRAINT TRIGGER sale_payments_ck AFTER INSERT OR UPDATE ON sale', 'CREATE CONSTRAINT TRIGGER sale_payments_ck AFTER DELETE ON sale', DB_TESTS),
  M('payment-trigger-missing', TRADING, 'CREATE CONSTRAINT TRIGGER payment_sale_ck AFTER INSERT ON payment', 'CREATE CONSTRAINT TRIGGER payment_sale_ck AFTER DELETE ON payment', DB_TESTS),
  M('sale-deletable', TRADING, 'REVOKE DELETE, TRUNCATE ON sale FROM pos_app;', '', DB_TESTS),
  M('sale-line-editable', TRADING, 'REVOKE UPDATE, DELETE, TRUNCATE ON sale_line FROM pos_app;', '', DB_TESTS),
  M('payment-editable', TRADING, 'REVOKE UPDATE, DELETE, TRUNCATE ON payment FROM pos_app;', '', DB_TESTS),
  M('receipt-not-unique', TRADING, 'CREATE UNIQUE INDEX sale_receipt_uq', 'CREATE INDEX sale_receipt_uq', DB_TESTS),
  M('sale-total-unchecked', TRADING, 'CHECK (total_paise = subtotal_paise + tax_paise),', '', DB_TESTS),
  M('payment-change-on-upi', TRADING, "CHECK (method = 'cash' OR change_paise = 0),", '', DB_TESTS),
  M('open-sale-with-receipt', TRADING, "(status IN ('paid', 'refunded')) = (receipt_no IS NOT NULL AND receipt_seq IS NOT NULL)", 'true', DB_TESTS),
  M('shift-deletable', TRADING, 'REVOKE DELETE, TRUNCATE ON shift FROM pos_app;', '', DB_TESTS),
  M('sale-line-no-rls', TRADING, "SELECT app.enable_tenant_rls('sale_line');", '', DB_TESTS),
  M('lockout-no-rls', 'db/migrations/0002_auth.sql', "SELECT app.enable_tenant_rls('login_lockout');", '', DB_TESTS),
  M('user-outlet-deletable', 'db/migrations/0003_menu.sql', "SELECT app.add_versioning('user_outlet');", '', API_TESTS('staff.test.ts')),
];

const run = (cmd, cwd = '.') => spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
const want = new Set(process.argv.slice(2));
const todo = MUTANTS.filter((m) => !want.size || want.has(m.id));
let original = null;
let current = null;
const restore = () => { if (current && original !== null) writeFileSync(current, original); };
process.on('SIGINT', () => { restore(); process.exit(130); });

const results = [];
for (const m of todo) {
  original = readFileSync(m.file, 'utf8');
  current = m.file;
  const count = original.split(m.from).length - 1;
  if (count === 0 || (count > 1 && !m.all)) { results.push([m.id, 'INVALID', `pattern found ${count}x`]); continue; }
  try {
    writeFileSync(m.file, m.all ? original.split(m.from).join(m.to) : original.replace(m.from, () => m.to));
    const up = run(['node', 'scripts/up-fresh.mjs']);
    if (up.status !== 0) { results.push([m.id, 'BROKEN', 'fresh start failed under the mutation']); continue; }
    const t = run(m.tests.cmd, m.tests.cwd);
    const out = `${t.stdout}\n${t.stderr}`;
    const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
    const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
    if (Number.isNaN(fail)) results.push([m.id, 'BROKEN', 'tests did not report']);
    else if (fail > 0) results.push([m.id, 'caught', failed[0] ?? '(failure)']);
    else results.push([m.id, 'SURVIVED', 'all tests passed with the guard removed']);
  } finally {
    restore();
  }
  console.log(results.at(-1).join(' | '));
}
// Leave the database matching the restored source.
run(['node', 'scripts/up-fresh.mjs']);
console.log('\n' + results.map((r) => r.join(' | ')).join('\n'));
const bad = results.filter((r) => r[1] !== 'caught');
console.log(`\n${results.length - bad.length}/${results.length} caught`);
process.exit(bad.length ? 1 : 0);
