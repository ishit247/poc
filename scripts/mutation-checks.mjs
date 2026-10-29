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
  // --- phase 4: push and ingest
  ...[
    ['ingest-no-duplicate-check', 'if (seen) {', 'if (false) {'],
    ['ingest-no-device-lock', "await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [p.deviceId]);", ''],
    ['ingest-defer-becomes-reject', 'throw new Defer();', "throw new Reject('sale_not_found');"],
    ['ingest-sale-rejected-waits', "if (refused.rowCount) throw new Reject('sale_rejected');", ''],
    ['ingest-pay-other-devices-sale', "if (sale.device_id !== p.deviceId) throw new Reject('wrong_device');", ''],
    ['ingest-after-revocation-accepted', 'if (p.revokedAt && new Date(e.createdAt) > p.revokedAt)', 'if (false)'],
    ['ingest-line-net-unchecked', "if (l.netPaise !== l.unitPaise * l.qty) throw new Reject('line_net_mismatch');", ''],
    ['ingest-line-tax-unchecked', "if (!taxes.includes(l.taxPaise)) throw new Reject('line_tax_mismatch');", ''],
    ['ingest-subtotal-unchecked', "if (net !== ev.subtotalPaise) throw new Reject('subtotal_mismatch');", ''],
    ['ingest-tax-unchecked', "if (tax !== ev.taxPaise) throw new Reject('tax_mismatch');", ''],
    ['ingest-round-off-unbounded', "if (Math.abs(ev.roundOffPaise) > 50) throw new Reject('round_off_too_large');", ''],
    ['ingest-channel-unchecked', "if (ev.channel !== 'counter') throw new Reject('channel_not_allowed');", ''],
    ['ingest-unknown-user-ok', "if (!who.rowCount) throw new Reject('unknown_user');", ''],
    ['ingest-unknown-item-ok', "if (items.rowCount !== ids.length) throw new Reject('unknown_item');", ''],
    ['ingest-payments-unchecked', "!== Number(sale.total_paise)) throw new Reject('payments_not_total');", '!== Number(sale.total_paise) && false) throw new Reject(\'payments_not_total\');'],
    ['ingest-receipt-no-unchecked', "if (ev.receiptNo !== `${code}-${ev.businessDate.replaceAll('-', '')}-${ev.receiptSeq}`) throw new Reject('bad_receipt_no');", ''],
    ['ingest-double-payment', "if (sale.status !== 'open') throw new Reject('already_paid');", ''],
    ['ingest-seq-reuse-ok', "throw new RejectUnrecorded('seq_reused');", 'void 0;'],
    ['ingest-unknown-type-ok', "throw new RejectUnrecorded('unknown_event_type');", 'void 0;'],
    ['ingest-future-schema-ok', "if (head?.schemaVersion !== EVENT_SCHEMA_VERSION) throw new RejectUnrecorded('unsupported_schema_version');", ''],
    ['ingest-event-id-other-device', "if (seen.device_id !== p.deviceId) return", 'if (false) return'],
    ['ingest-flag-over-cap', "flags.push('over_qty_cap')", 'void 0'],
    ['ingest-flag-settings', "flags.push('settings_differ')", 'void 0'],
    ['ingest-flag-unavailable', "flags.push('sold_unavailable')", 'void 0'],
    ['ingest-flag-clock', "flags.push('clock_ahead')", 'void 0'],
    ['ingest-flag-late-sale', "if (day.closed) flags.push('late_arrival');", ''],
    ['ingest-flag-late-payment', "CASE WHEN $6 AND NOT 'late_arrival' = ANY(flags)", 'CASE WHEN false'],
    ['ingest-business-date-from-sale', 'business_date = $4,', 'business_date = COALESCE(business_date, $4::date),'],
    ['ingest-no-audit-on-revoked', "if (p.revokedAt) {", 'if (false) {'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/ingest.ts', from, to, API_TESTS('sync-push.test.ts'))),
  M('push-revoked-everywhere', 'apps/api/src/auth.ts', '($2 OR revoked_at IS NULL)', 'true', API_TESTS('sync-push.test.ts')),
  M('push-route-body-unstrict', SYNC, '}).strict()).min(1).max(MAX_BATCH),\n}).strict();', '})).min(1).max(MAX_BATCH),\n});', API_TESTS('sync-push.test.ts')),
  M('push-no-batch-cap', SYNC, '.min(1).max(MAX_BATCH)', '.min(1)', API_TESTS('sync-push.test.ts')),
  M('push-ledger-updatable', TRADING, 'REVOKE UPDATE, DELETE, TRUNCATE ON sync_event FROM pos_app;', '', API_TESTS('sync-push.test.ts')),
  M('push-ledger-global-key', TRADING, 'PRIMARY KEY (tenant_id, id),\n  CHECK ((outcome', 'PRIMARY KEY (id),\n  CHECK ((outcome', API_TESTS('sync-push.test.ts')),
  M('push-ledger-no-rls', TRADING, "SELECT app.enable_tenant_rls('sync_event');", '', DB_TESTS),
  // --- phase 4: the tablet
  ...[
    ['tablet-deletes-rejected', "else if (res.status === 'rejected') { await db.outbox.update(seq, { rejected: res.reason ?? 'rejected' }); summary.parked++; }", "else if (res.status === 'rejected') { await db.outbox.delete(seq); summary.parked++; }"],
    ['tablet-deletes-deferred', "else summary.deferred++;", "else { await db.outbox.delete(seq); summary.deferred++; }"],
    ['tablet-resends-parked', '.filter((r) => !r.rejected)', ''],
    ['tablet-deletes-before-answer', "const r = await fetch('/api/sync/push', {", "await db.outbox.clear();\n    const r = await fetch('/api/sync/push', {"],
    ['tablet-ignores-http-error', "if (!r.ok) throw new Error(`push failed: ${r.status}`);", ''],
  ].map(([id, from, to]) => M(id, 'apps/counter/src/sync.ts', from, to, { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/push.test.ts'] })),
  // --- phase 5: receipts and reprints
  ...[
    ['receipt-odd-paisa-lost', 'cgstPaise: tax - Math.floor(tax / 2)', 'cgstPaise: Math.floor(tax / 2)'],
    ['receipt-tax-per-line-not-per-rate', 'byRate.set(l.gstRateBp, (byRate.get(l.gstRateBp) ?? 0) + l.taxPaise)', 'byRate.set(l.gstRateBp, l.taxPaise)'],
    ['receipt-always-tax-invoice', "centered(v.gstEnabled ? 'Tax Invoice' : 'Bill of Supply');", "centered('Tax Invoice');"],
    ['receipt-gstin-when-not-registered', 'if (v.gstEnabled && v.gstin) centered', 'if (v.gstin) centered'],
    ['receipt-no-reprint-mark', "if (v.reprint) centered('*** RE-PRINT ***');", ''],
    ['receipt-round-off-sign', "v.roundOffPaise < 0 ? '-' : '+'", "'+'"],
    ['receipt-long-word-dropped', 'out.push(line + word.slice(0, room));', 'out.push(line);'],
    ['receipt-fssai-missing', "if (v.fssaiNo) out.push(center(`FSSAI: ${v.fssaiNo}`, width));", ''],
    ['receipt-words-crore', "name === 'Crore' ? wholeInWords(q) : below1000(q)", 'below1000(q)'],
    ['receipt-words-paise', "return rupees === 0 ? `${below1000(ps)} Paise Only` : `${r} and ${below1000(ps)} Paise Only`;", 'return `${r} Only`;'],
    ['receipt-timezone-ignored', 'timeZone, day:', "timeZone: 'UTC', day:"],
  ].map(([id, from, to]) => M(id, 'packages/shared/src/receipt-text.ts', from, to, { cwd: 'packages/shared', cmd: ['node', '--import', 'tsx', '--test', 'test/receipt-text.test.ts'] })),
  ...[
    ['reprint-unpaid-ok', "if (sale.status !== 'paid' && sale.status !== 'refunded') throw new Reject('not_paid');", ''],
    ['reprint-other-device', "if (sale.device_id !== p.deviceId) throw new Reject('wrong_device');\n  return sale;", 'return sale;'],
    ['reprint-no-audit-trail', "action: 'sale.reprinted'", "action: 'sale.noop'"],
    ['reprint-unknown-user-ok', "[ev.reprintedBy, p.outletId]);\n  if (!who.rowCount) throw new Reject('unknown_user');", '[ev.reprintedBy, p.outletId]);'],
    ['reprint-type-not-accepted', "type !== 'payment.taken' && type !== 'print.reprinted'", "type !== 'payment.taken'"],
  ].map(([id, from, to]) => M(id, 'apps/api/src/ingest.ts', from, to, API_TESTS('sync-push.test.ts'))),
  ...[
    ['receipt-info-scope', "const b = receiptInfoBody.safeParse(req.body);\n    if (!ps.success || !b.success) return bad(reply);\n    const p = req.principal!;\n    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);", "const b = receiptInfoBody.safeParse(req.body);\n    if (!ps.success || !b.success) return bad(reply);\n    const p = req.principal!;\n    if (p.kind !== 'user') return notFound(reply);"],
    ['receipt-info-control-chars', '.regex(/^[^\\u0000-\\u001f\\u007f]+$/)', ''],
    ['receipt-info-fssai-format', 'fssaiNo: z.string().regex(/^[0-9]{14}$/).nullable()', 'fssaiNo: z.string().nullable()'],
    ['receipt-info-not-trimmed', 'address: z.string().trim().min(1)', 'address: z.string().min(1)'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/routes/outlets.ts', from, to, API_TESTS('outlets.test.ts'))),
  M('receipt-info-fssai-db-check', 'db/migrations/0003_menu.sql', "CHECK (fssai_no IS NULL OR fssai_no ~ '^[0-9]{14}$')", '', API_TESTS('outlets.test.ts')),
  M('receipt-info-not-pulled', SYNC, ", 'address', address, 'fssaiNo', fssai_no)", ')', API_TESTS('sync-push.test.ts')),
  ...[
    ['tablet-waiter-reprints', "if (args.actor.role !== 'cashier') throw new Error('only a cashier reprints a receipt');", ''],
    ['tablet-reprint-unpaid', "if (!sale || sale.status !== 'paid') throw new Error('only a paid sale has a receipt to reprint');", ''],
    ['tablet-recent-includes-open', "where('status').equals('paid')", "where('status').anyOf('paid', 'open')"],
  ].map(([id, from, to]) => M(id, 'apps/counter/src/sale.ts', from, to, { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/receipt.test.ts'] })),
];

const run =(cmd, cwd = '.') => spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
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
