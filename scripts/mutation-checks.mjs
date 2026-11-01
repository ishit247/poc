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

const ONLINE = 'db/migrations/0005_online.sql';
const ONLINE_DB_TESTS = { cwd: '.', cmd: ['node', '--test', 'db/test/online.test.mjs'] };

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
  M('sale-total-unchecked', TRADING, 'CHECK (total_paise = subtotal_paise + tax_paise + round_off_paise),', '', DB_TESTS),
  M('payment-change-on-upi', TRADING, "CHECK (method = 'cash' OR change_paise = 0),", '', DB_TESTS),
  M('open-sale-with-receipt', TRADING, "(status IN ('paid', 'refunded')) = (receipt_no IS NOT NULL AND receipt_seq IS NOT NULL)", 'true', DB_TESTS),
  M('shift-deletable', TRADING, "SELECT app.add_versioning('shift');", '', DB_TESTS),
  M('sale-line-no-rls', TRADING, "SELECT app.enable_tenant_rls('sale_line');", '', DB_TESTS),
  M('lockout-no-rls', 'db/migrations/0002_auth.sql', "SELECT app.enable_tenant_rls('login_lockout');", '', DB_TESTS),
  M('user-outlet-deletable', 'db/migrations/0003_menu.sql', "SELECT app.add_versioning('user_outlet');", '', API_TESTS('staff.test.ts')),
  // --- phase 4: push and ingest
  ...[
    ['ingest-no-duplicate-check', 'if (seen) {', 'if (false) {'],
    ['ingest-no-device-lock', "await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [p.deviceId]);", ''],
    ['ingest-defer-becomes-reject', 'throw new Defer();', "throw new Reject('sale_not_found');", true],
    ['ingest-sale-rejected-waits', "if (refused.rowCount) throw new Reject('sale_rejected');", ''],
    ['ingest-pay-other-devices-sale', "if (sale.device_id !== p.deviceId) throw new Reject('wrong_device');", ''],
    ['ingest-after-revocation-accepted', 'if (p.revokedAt && new Date(e.createdAt) > p.revokedAt)', 'if (false)'],
    ['ingest-line-net-unchecked', "if (l.netPaise !== l.unitPaise * l.qty) throw new Reject('line_net_mismatch');", ''],
    ['ingest-line-tax-unchecked', "if (!taxes.includes(l.taxPaise)) throw new Reject('line_tax_mismatch');", ''],
    ['ingest-subtotal-unchecked', "if (net !== ev.subtotalPaise) throw new Reject('subtotal_mismatch');", ''],
    ['ingest-tax-unchecked', "if (tax !== ev.taxPaise) throw new Reject('tax_mismatch');", ''],
    ['ingest-round-off-unbounded', "if (Math.abs(ev.roundOffPaise) > 50) throw new Reject('round_off_too_large');", ''],
    ['ingest-channel-unchecked', "if (ev.channel !== 'counter') throw new Reject('channel_not_allowed');", ''],
    ['ingest-unknown-user-ok', "if (!who.rowCount) throw new Reject('unknown_user');", '', true],
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
  ].map(([id, from, to, all]) => M(id, 'apps/api/src/ingest.ts', from, to, API_TESTS('sync-push.test.ts'), all)),
  M('push-revoked-everywhere', 'apps/api/src/auth.ts', '($2 OR revoked_at IS NULL)', 'true', API_TESTS('sync-push.test.ts')),
  M('push-route-body-unstrict', SYNC, '}).strict()).min(1).max(MAX_BATCH),\n}).strict();', '})).min(1).max(MAX_BATCH),\n});', API_TESTS('sync-push.test.ts')),
  M('push-no-batch-cap', SYNC, '.min(1).max(MAX_BATCH)', '.min(1)', API_TESTS('sync-push.test.ts')),
  M('push-ledger-updatable', TRADING, 'REVOKE UPDATE, DELETE, TRUNCATE ON sync_event FROM pos_app;', '', API_TESTS('sync-push.test.ts')),
  M('push-ledger-global-key', TRADING, /PRIMARY KEY \(tenant_id, id\),(\r?\n\s*CHECK \(\(outcome)/, 'PRIMARY KEY (id),$1', API_TESTS('sync-push.test.ts')),
  M('push-ledger-no-rls', TRADING, "SELECT app.enable_tenant_rls('sync_event');", '', DB_TESTS),
  // --- phase 4: the tablet
  ...[
    ['tablet-deletes-rejected', "else if (res.status === 'rejected') { await db.outbox.update(seq, { rejected: res.reason ?? 'rejected' }); summary.parked++; }", "else if (res.status === 'rejected') { await db.outbox.delete(seq); summary.parked++; }"],
    ['tablet-deletes-deferred', "else summary.deferred++;", "else { await db.outbox.delete(seq); summary.deferred++; }"],
    ['tablet-resends-parked', ".orderBy('seq').toArray()).filter((r) => !r.rejected)", ".orderBy('seq').toArray())"],
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
    ['reprint-type-not-accepted', "'payment.taken', 'print.reprinted', 'shift.opened'", "'payment.taken', 'shift.opened'"],
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
  // --- phase 6: day close
  ...[
    ['dayclose-open-shift-ignored', 'if (bl.openShifts.length || bl.openSales || unacked.length)', 'if (bl.openSales || unacked.length)'],
    ['dayclose-open-sale-ignored', 'if (bl.openShifts.length || bl.openSales || unacked.length)', 'if (bl.openShifts.length || unacked.length)'],
    ['dayclose-unsent-ignored', 'if (bl.openShifts.length || bl.openSales || unacked.length)', 'if (bl.openShifts.length || bl.openSales)'],
    ['dayclose-ack-any-device', '!acknowledgedDeviceIds.includes(d.id));\n      if (bl.', 'false);\n      if (bl.'],
    ['dayclose-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    const { date,", "if (p.kind !== 'user') return notFound(reply);\n    const { date,"],
    ['dayclose-preview-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    return withTenant(p.tenantId, async (c) => {\n      const day", "if (p.kind !== 'user') return notFound(reply);\n    return withTenant(p.tenantId, async (c) => {\n      const day"],
    ['dayclose-reclose', 'if (day.closed_at) return reply.code(409)', 'if (false) return reply.code(409)'],
    ['dayclose-future-day', "if (date > (await today(c, ps.data.id)))", 'if (false)'],
    ['dayclose-not-frozen', 'SET closed_at = now(), closed_by = $2, totals = $3 WHERE id = $1 AND closed_at IS NULL', "SET closed_at = now(), closed_by = $2, totals = '{}'::jsonb || $3::jsonb - 'grossPaise' WHERE id = $1 AND closed_at IS NULL"],
    ['dayclose-late-seen-twice', 'AND e.received_at > $3)', 'AND e.received_at > $3 - interval \'100 years\')'],
    ['dayclose-gaps-hidden', 'WHERE NOT n = ANY(g.have)', 'WHERE false AND NOT n = ANY(g.have)'],
    ['dayclose-upi-as-cash', "cashPaise: by.cash ?? 0", 'cashPaise: (by.cash ?? 0) + (by.upi ?? 0)'],
    ['forceclose-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    return withTenant(p.tenantId, async (c) => {\n      // Lock", "if (p.kind !== 'user') return notFound(reply);\n    return withTenant(p.tenantId, async (c) => {\n      // Lock"],
    ['forceclose-shift-of-other-outlet', 'AND outlet_id = $2 FOR UPDATE', 'AND $2::uuid IS NOT NULL FOR UPDATE'],
    ['forceclose-twice', 'if (s.closed_at) return reply.code(409).send({ error: \'already closed\' });\n      const pays', 'const pays'],
    ['forceclose-expected-ignores-sales', 'expectedCash(s.opening, pays.rows)', 'expectedCash(s.opening, [])'],
    ['forceclose-no-audit', "action: 'shift.force_close'", "action: 'shift.noop'"],
    ['forceclose-negative-count', 'countedCashPaise: z.number().int().min(0).max(100_000_000)', 'countedCashPaise: z.number().int().max(100_000_000)'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/routes/dayclose.ts', from, to, API_TESTS('sync-push.test.ts'))),
  // --- phase 7 step 6: settlement import
  ...[
    ['settle-upload-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    const { channel,", "if (p.kind !== 'user') return notFound(reply);\n    const { channel,"],
    ['settle-list-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    return withTenant(p.tenantId, async (c) => (await c.query(", "if (p.kind !== 'user') return notFound(reply);\n    return withTenant(p.tenantId, async (c) => (await c.query("],
    ['settle-read-any-outlet', "if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);\n    return withTenant(p.tenantId, async (c) => (await report(", "if (p.kind !== 'user') return notFound(reply);\n    return withTenant(p.tenantId, async (c) => (await report("],
    ['settle-report-other-outlet', 'WHERE i.id = $1 AND i.outlet_id = $2', 'WHERE i.id = $1 AND $2::uuid IS NOT NULL'],
    ['settle-match-other-outlet', 'WHERE o.outlet_id = $1 AND o.channel = $2 AND o.external_order_id = ANY', 'WHERE $1::uuid IS NOT NULL AND o.channel = $2 AND o.external_order_id = ANY'],
    ['settle-match-other-channel', 'AND o.channel = $2 AND o.external_order_id = ANY', 'AND $2::text IS NOT NULL AND o.external_order_id = ANY'],
    ['settle-amount-ignored', "o.total === l.grossPaise ? 'matched'", "true ? 'matched'"],
    ['settle-missing-hidden', "AND o.status = 'handed_over' AND s.business_date BETWEEN", "AND false AND s.business_date BETWEEN"],
    ['settle-missing-other-outlet', 'WHERE o.outlet_id = $1 AND o.channel = $2 AND o.status', 'WHERE $1::uuid IS NOT NULL AND o.channel = $2 AND o.status'],
    ['settle-missing-undated', 'AND s.business_date BETWEEN $3 AND $4', 'AND $3::date IS NOT NULL AND $4::date IS NOT NULL'],
    ['settle-period-uncapped', 'days(periodFrom, periodTo) > MAX_PERIOD_DAYS', 'false'],
    ['settle-no-audit', "action: 'settlement.import'", "action: 'settlement.noop'"],
    ['settle-commission-wrong', 'commissionPaise: sum(\'grossPaise\', L) - sum(\'payoutPaise\', L)', 'commissionPaise: sum(\'payoutPaise\', L)'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/routes/settlement.ts', from, to, API_TESTS('settlement.test.ts'))),
  ...[
    ['settle-parse-duplicate-ids', 'if (first) return void errors.push', 'if (false) return void errors.push'],
    ['settle-parse-header-optional', 'if (missing.length) return', 'if (false) return'],
    ['settle-parse-negative-gross', 'if (gross < 0) return void', 'if (false) return void'],
    ['settle-parse-float-money', 'const p = parseRupees(body) as number;', 'const p = Math.round(parseFloat(body) * 100);'],
    ['settle-parse-bom', "text.replace(/^\\u{FEFF}/u, '')", 'text'],
    ['settle-parse-quote-escape', "if (src[i + 1] === '\"') { field += '\"'; i++; } else quoted = false;", 'quoted = false;'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/settlement.ts', from, to, API_TESTS('settlement.test.ts'))),
  ...[
    ['void-paid-sale', "if (sale.status !== 'open') throw new Reject(sale.status === 'void' ? 'already_void' : 'not_open');", ''],
    ['void-twice-silent', "throw new Reject(sale.status === 'void' ? 'already_void' : 'not_open')", "throw new Reject('not_open')"],
    ['void-no-audit', "action: 'sale.voided'", "action: 'sale.noop'"],
    ['void-reason-not-stored', "SET status = 'void', void_reason = $2 WHERE id = $1`, [ev.saleId, ev.reason]", "SET status = 'void', void_reason = 'x' WHERE id = $1 AND $2::text IS NOT NULL`, [ev.saleId, ev.reason]"],
  ].map(([id, from, to]) => M(id, 'apps/api/src/ingest.ts', from, to, API_TESTS('sync-push.test.ts'))),
  M('void-reason-open-ended', 'packages/shared/src/events.ts', "reason: z.enum(['abandoned_at_shift_close'])", 'reason: z.string()', API_TESTS('sync-push.test.ts')),
  ...[
    ['tablet-abandoned-not-voided', "for (const s of await db.sales.filter((x) => x.status === 'open').toArray())", 'for (const s of [] as LocalSale[])'],
    ['tablet-void-paid-too', "db.sales.filter((x) => x.status === 'open')", "db.sales.filter((x) => x.status !== 'void')"],
  ].map(([id, from, to]) => M(id, 'apps/counter/src/shift.ts', from, to, { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/sale.test.ts'] })),
  // --- tablet learns of a manager's force-close
  ...[
    ['forcepull-any-device', 'AND device_id = $4 AND closed_by IS NOT NULL', 'AND $4::uuid IS NOT NULL AND closed_by IS NOT NULL'],
    ['forcepull-own-closes-too', 'AND device_id = $4 AND closed_by IS NOT NULL', 'AND device_id = $4 AND closed_at IS NOT NULL'],
  ].map(([id, from, to]) => M(id, 'apps/api/src/routes/sync.ts', from, to, { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/push.test.ts'] })),
  M('forceclose-reason-indistinct', 'apps/api/src/ingest.ts', "shift.closed_by ? 'shift_force_closed' : 'shift_already_closed'", "'shift_already_closed'", { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/push.test.ts'] }),
  ...[
    ['tablet-force-reason-parked', "res.status === 'rejected' && res.reason === 'shift_force_closed'", "false"],
    ['tablet-pull-ignores-shift', "if (c.type === 'shift') {", "if (false) {"],
    ['tablet-pull-overwrites-own-close', 'if (s && !s.closedAt) {', 'if (s) {'],
    ['tablet-pull-no-server-figures', '} else if (s && !s.closedByManager) {', '} else if (false) {'],
  ].map(([id, from, to]) => M(id, 'apps/counter/src/sync.ts', from, to, { cwd: 'apps/counter', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'test/push.test.ts'] })),
  M('dayclose-outbox-header-ignored', 'apps/api/src/auth.ts', 'outbox_pending = COALESCE($3, outbox_pending)', 'outbox_pending = outbox_pending', API_TESTS('sync-push.test.ts')),
  // --- phase 7: online orders (schema guards)
  ...[
    ['online-receipt-rule', TRADING, 'ELSE receipt_no IS NULL AND receipt_seq IS NULL END', 'ELSE true END'],
    ['online-lifecycle-any-move', ONLINE, 'IF NOT (\n       (OLD.status = \'received\'', 'IF false AND NOT (\n       (OLD.status = \'received\''],
    ['online-identity-editable', ONLINE, 'IF (NEW.tenant_id, NEW.outlet_id, NEW.sale_id,', 'IF false AND (NEW.tenant_id, NEW.outlet_id, NEW.sale_id,'],
    ['online-id-unique-per-platform', ONLINE, 'UNIQUE (tenant_id, channel, external_order_id),', 'UNIQUE (tenant_id, channel, external_order_id, id),'],
    ['online-reason-optional', ONLINE, "CHECK (status NOT IN ('rejected', 'cancelled') OR reason IS NOT NULL),", 'CHECK (true),'],
    ['online-event-editable', ONLINE, 'REVOKE UPDATE, DELETE, TRUNCATE ON online_order_event FROM pos_app;', 'REVOKE TRUNCATE ON online_order_event FROM pos_app;'],
    ['online-settlement-line-editable', ONLINE, 'REVOKE UPDATE, DELETE, TRUNCATE ON settlement_line FROM pos_app;', 'REVOKE TRUNCATE ON settlement_line FROM pos_app;'],
    ['online-order-deletable', ONLINE, 'REVOKE DELETE, TRUNCATE ON online_order FROM pos_app;', 'REVOKE TRUNCATE ON online_order FROM pos_app;'],
    ['online-outbox-no-dedupe', ONLINE, 'UNIQUE (tenant_id, dedupe_key),', 'UNIQUE (tenant_id, id),'],
  ].map(([id, file, from, to]) => M(id, file, from, to, ONLINE_DB_TESTS)),
  // --- phase 7: the online order API
  ...[
    ['online-api-scope-ignored', "const SCOPE = 'o.outlet_id = ANY($1::uuid[])';", "const SCOPE = '(o.outlet_id = ANY($1::uuid[]) OR true)';"],
    ['online-api-waiter-allowed', "const cfg = { scope: 'outlet', permission: 'till' } as const;", "const cfg = { scope: 'outlet', permission: 'staff' } as const;"],
    ['online-api-any-move', "if (!(NEXT[from] ?? []).includes(to) && !(to === 'expired' && from === 'received')) return", "if (false) return"],
    ['online-api-reason-optional', "&& !extra.reason) return { kind: 'reason_required' as const };", "&& false) return { kind: 'reason_required' as const };"],
    ['online-api-no-void-on-reject', "await c.query(`UPDATE sale SET status = 'void', void_reason = $2 WHERE id = $1`", "await c.query(`SELECT $2::text, $1::uuid`"],
    ['online-api-no-payment', "await c.query(`INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1,$2,'aggregator',$3)`, [a.tenantId, o.sale_id, sale.total_paise]);", ''],
    ['online-api-duplicate-creates', "if (existing) return { kind: 'existing' as const, id: existing.id as string };", ''],
    ['online-api-override-unflagged', 'if (unit !== it.price) overridden = true;', ''],
    ['online-api-tax-dropped', 'tax += amt.tax as number;', 'tax += 0;'],
    ['online-api-no-event-row', "`INSERT INTO online_order_event (tenant_id, online_order_id, from_status, to_status, actor_id, device_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,\n    [a.tenantId, id, from, to, a.userId, a.deviceId, { reason: extra.reason ?? null }]);", "`SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::text`,\n    [a.tenantId, id, from, to, a.userId, a.deviceId, '']);"],
  ].map(([id, from, to]) => M(id, 'apps/api/src/routes/online.ts', from, to, API_TESTS('online.test.ts'))),
  // --- phase 7: the stream
  M('stream-wakes-every-outlet', 'apps/api/src/hub.ts', 'for (const fn of byOutlet.get(outletId) ?? []) fn();', 'for (const set of byOutlet.values()) for (const fn of set) fn();', API_TESTS('online.test.ts')),
  M('stream-silent-on-create', 'apps/api/src/routes/online.ts', "case 'created': publish(r.order.outletId); return", "case 'created': return", API_TESTS('online.test.ts')),
  // --- phase 7: the expiry job
  M('expiry-ignores-deadline', 'db/migrations/0005_online.sql', 'AND accept_by IS NOT NULL AND accept_by < now());', 'AND accept_by IS NOT NULL);', API_TESTS('online.test.ts')),
  M('expiry-takes-accepted', 'db/migrations/0005_online.sql', "app.job', true) = 'expire_online' AND status = 'received'", "app.job', true) = 'expire_online' AND status IN ('received', 'accepted')", API_TESTS('online.test.ts')),
  M('expiry-scan-open-to-all', 'db/migrations/0005_online.sql', "USING (current_setting('app.job', true) = 'expire_online' AND", 'USING (', API_TESTS('online.test.ts')),
  M('expiry-one-tenant-only', 'apps/api/src/jobs/expireOnline.ts', 'for (const d of due) {', 'for (const d of due.filter((x) => x.tenant_id.endsWith("a"))) {', API_TESTS('online.test.ts')),
  // Outbox: queueing, dedupe, retry, the scan window, the delete revoke.
  M('outbox-not-queued', 'apps/api/src/routes/online.ts', 'if (action) {', 'if (action && false) {', API_TESTS('outbox.test.ts')),
  M('outbox-no-dedupe', 'db/migrations/0005_online.sql', '  UNIQUE (tenant_id, dedupe_key),\n  CHECK ((status', '  CHECK ((status', API_TESTS('outbox.test.ts')),
  M('outbox-failure-forgotten', 'apps/api/src/jobs/outbox.ts', 'const attempts = m.attempts + 1;', 'const attempts = m.attempts;', API_TESTS('outbox.test.ts')),
  M('outbox-no-backoff', 'apps/api/src/jobs/outbox.ts', 'return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);', 'return 0;', API_TESTS('outbox.test.ts')),
  M('outbox-retries-failed', 'apps/api/src/jobs/outbox.ts', "CASE WHEN $2::int >= $4::int THEN 'failed' ELSE 'pending' END", "'pending'", API_TESTS('outbox.test.ts')),
  M('outbox-done-without-sending', 'apps/api/src/jobs/outbox.ts', 'await send(m);', '', API_TESTS('outbox.test.ts')),
  M('outbox-scan-open-to-all', 'db/migrations/0005_online.sql', "USING (current_setting('app.job', true) = 'outbox' AND", 'USING (', API_TESTS('outbox.test.ts')),
  M('outbox-scan-ignores-due', 'db/migrations/0005_online.sql', "status = 'pending' AND next_attempt_at <= now());", "status = 'pending');", API_TESTS('outbox.test.ts')),
  M('outbox-delete-granted', 'db/migrations/0005_online.sql', 'REVOKE DELETE, TRUNCATE ON integration_outbox FROM pos_app;', '', API_TESTS('outbox.test.ts')),
  // --- phase 9: inbound webhooks and the platform senders
  ...[
    ['webhook-signature-unchecked', 'apps/api/src/routes/webhooks.ts', ' || !provider.verifySignature(integ.secret, ts, raw, sig)', ''],
    ['webhook-signature-any-same-length', 'apps/api/src/providers/index.ts', 'return got.length === want.length && timingSafeEqual(got, want);', 'return got.length === want.length;'],
    ['webhook-replay-window-off', 'apps/api/src/providers/index.ts', 'Math.abs(nowMs - ts * 1000) > MAX_SKEW_MS', 'false'],
    ['webhook-unmapped-dropped', 'apps/api/src/routes/webhooks.ts', '{ provider: ch, rawPayload: raw, unmapped }', '{ provider: ch, rawPayload: raw, unmapped: [] }'],
    ['webhook-raw-not-kept', 'apps/api/src/routes/webhooks.ts', '{ provider: ch, rawPayload: raw, unmapped }', '{ provider: ch, rawPayload: null as unknown as string, unmapped }'],
    ['webhook-platform-price-ignored', 'apps/api/src/routes/webhooks.ts', 'qty: l.qty, unitPaise: l.unitPaise }));', 'qty: l.qty }));'],
    ['webhook-rejection-not-recorded', 'apps/api/src/routes/webhooks.ts', 'await c.query(`INSERT INTO inbound_event', 'await c.query(`SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text -- INSERT INTO inbound_event'],
    ['webhook-sender-pretends-success', 'apps/api/src/jobs/outbox.ts', "async () => { throw new Error(`${provider}: partner API not configured`); }", 'async () => {}'],
  ].map(([id, file, from, to]) => M(id, file, from, to, API_TESTS('webhooks.test.ts'))),
  M('webhook-event-editable', 'db/migrations/0006_integrations.sql', 'REVOKE UPDATE, DELETE, TRUNCATE ON inbound_event FROM pos_app;', '', API_TESTS('webhooks.test.ts')),
  // --- phase 8: reports
  ...[
    ['rep-named-outlet-unchecked', 'apps/api/src/routes/reports.ts', 'if (outletId && !p.outletIds.includes(outletId)) return', 'if (false) return'],
    ['rep-everyone-allowed', 'apps/api/src/routes/reports.ts', "permission: 'manager' } as const;", "permission: 'till' } as const;"],
    ['rep-range-uncapped', 'apps/api/src/routes/reports.ts', '>= MAX_DAYS) return', '>= 1e9) return'],
    ['rep-impossible-date', 'apps/api/src/routes/reports.ts', '&& new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s', ''],
    ['rep-today-final', 'apps/api/src/reports.ts', "$2::date >= (now() AT TIME ZONE timezone)::date", "$2::date > (now() AT TIME ZONE timezone)::date"],
    ['rep-sales-any-outlet', 'apps/api/src/reports.ts', "WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'", "WHERE $1::uuid[] IS NOT NULL AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'"],
    ['rep-sales-counts-voids', 'apps/api/src/reports.ts', "AND s.status = 'paid'`;", "AND s.status IN ('paid', 'void')`;"],
    ['rep-sales-undated', 'apps/api/src/reports.ts', "AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'", "AND $2::date IS NOT NULL AND $3::date IS NOT NULL AND s.status = 'paid'"],
    ['rep-sales-from-only', 'apps/api/src/reports.ts', "AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'", "AND s.business_date >= $2::date AND s.status = 'paid'"],
    ['rep-sales-to-only', 'apps/api/src/reports.ts', "AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'", "AND s.business_date <= $3::date AND s.status = 'paid'"],
    ['rep-cash-is-upi', 'apps/api/src/reports.ts', "FILTER (WHERE method = 'cash'), 0) AS cash", "FILTER (WHERE method = 'upi'), 0) AS cash"],
    ['rep-hour-in-server-zone', 'apps/api/src/reports.ts', 'b.created_at_device AT TIME ZONE b.timezone)::int', 'b.created_at_device)::int'],
    ['rep-voids-any-outlet', 'apps/api/src/reports.ts', "WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.status IN", "WHERE $1::uuid[] IS NOT NULL AND s.business_date BETWEEN $2::date AND $3::date AND s.status IN"],
    ['rep-voids-undated', 'apps/api/src/reports.ts', "AND s.business_date BETWEEN $2::date AND $3::date AND s.status IN ('void', 'refunded')", "AND s.status IN ('void', 'refunded')"],
    ['rep-variance-any-outlet', 'apps/api/src/reports.ts', 'WHERE sh.outlet_id = ANY($1::uuid[])', 'WHERE $1::uuid[] IS NOT NULL'],
    ['rep-variance-open-shifts', 'apps/api/src/reports.ts', 'AND sh.closed_at IS NOT NULL\n        AND (sh.opened_at', 'AND (sh.opened_at'],
    ['rep-variance-undated', 'apps/api/src/reports.ts', "AND (sh.opened_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date", ''],
    ['rep-unavailable-any-outlet', 'apps/api/src/reports.ts', "WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date\n        AND 'sold_unavailable'", "WHERE $1::uuid[] IS NOT NULL AND s.business_date BETWEEN $2::date AND $3::date\n        AND 'sold_unavailable'"],
    ['rep-unavailable-wrong-flag', 'apps/api/src/reports.ts', "AND 'sold_unavailable' = ANY(s.flags)", "AND 'late_arrival' = ANY(s.flags)"],
    ['rep-online-any-outlet', 'apps/api/src/reports.ts', 'WHERE oo.outlet_id = ANY($1::uuid[])', 'WHERE $1::uuid[] IS NOT NULL'],
    ['rep-online-undated', 'apps/api/src/reports.ts', "AND (oo.received_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date", ''],
    ['rep-online-gross-counts-all', 'apps/api/src/reports.ts', "sum(s.total_paise) FILTER (WHERE oo.status = 'handed_over')", 'sum(s.total_paise)'],
    ['rep-settlement-any-outlet', 'apps/api/src/reports.ts', 'WHERE i.outlet_id = ANY($1::uuid[]) AND l.result', 'WHERE $1::uuid[] IS NOT NULL AND l.result'],
    ['rep-settlement-shows-matched', 'apps/api/src/reports.ts', "AND l.result <> 'matched'", ''],
    ['rep-settlement-period-ignored', 'apps/api/src/reports.ts', 'AND i.period_to >= $2::date AND i.period_from <= $3::date', ''],
    ['rep-sync-any-outlet', 'apps/api/src/reports.ts', 'WHERE d.outlet_id = ANY($1::uuid[])', 'WHERE $1::uuid[] IS NOT NULL'],
    ['rep-sync-rejected-undated', 'apps/api/src/reports.ts', "AND (e.received_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date)::int AS rejected", ")::int AS rejected"],
    ['rep-sync-late-undated', 'apps/api/src/reports.ts', "AND s.business_date BETWEEN $2::date AND $3::date)::int AS late", ")::int AS late"],
    ['rep-csv-formula-live', 'apps/api/src/reports.ts', "/^[=+\\-@\\t\\r]/.test(s) ? `'${s}` : s", 's'],
    ['rep-csv-float-money', 'apps/api/src/reports.ts', 'return `${n < 0 ?', 'return String(n / 100) || `${n < 0 ?'],
    ['rep-csv-no-total', 'apps/api/src/reports.ts', 'if (r.totals) {', 'if (false) {'],
  ].map(([id, file, from, to]) => M(id, file, from, to, API_TESTS('zz-reports.test.ts'))),
  // --- platform console walls (0007)
  ...[
    ['plat-audit-editable', 'GRANT SELECT, INSERT ON platform_audit TO app_platform;', 'GRANT SELECT, INSERT, UPDATE, DELETE ON platform_audit TO app_platform;'],
    ['plat-pos-app-reads-admins', 'REVOKE ALL ON platform_admin, platform_session, platform_audit FROM pos_app;', ''],
    ['plat-device-writable', 'GRANT SELECT ON outlet, device TO app_platform;', 'GRANT SELECT, UPDATE ON outlet, device TO app_platform;'],
    ['plat-reads-sales', 'GRANT SELECT ON outlet, device TO app_platform;', 'GRANT SELECT ON outlet, device, sale, payment TO app_platform;'],
    ['plat-tenant-deletable', 'GRANT SELECT, INSERT, UPDATE ON tenant TO app_platform;', 'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant TO app_platform;'],
    ['plat-tenant-policy-for-all-roles', 'CREATE POLICY platform_console ON tenant TO app_platform USING', 'CREATE POLICY platform_console ON tenant USING'],
    ['plat-device-policy-for-all-roles', 'CREATE POLICY platform_console ON device FOR SELECT TO app_platform USING', 'CREATE POLICY platform_console ON device FOR SELECT USING'],
  ].map(([id, from, to]) => M(id, 'db/migrations/0007_platform.sql', from, to, { cwd: '.', cmd: ['node', '--test', 'db/test/platform.test.mjs'] })),
  // --- platform console auth, roles, suspension (step 2)
  ...[
    ['plat-login-skips-totp', 'apps/api/src/routes/platform.ts', 'const codeOk = step !== null && step > Number(a.totp_last_step);', 'const codeOk = true;'],
    ['plat-totp-replay-ok', 'apps/api/src/routes/platform.ts', 'step !== null && step > Number(a.totp_last_step)', 'step !== null'],
    ['plat-lockout-ignored', 'apps/api/src/routes/platform.ts', 'if (!a || a.locked) return null;', 'if (!a) return null;'],
    ['plat-lockout-threshold', 'apps/api/src/routes/platform.ts', 'const MAX_FAILED_LOGINS = 5;', 'const MAX_FAILED_LOGINS = 500;'],
    ['plat-owner-routes-open-to-support', 'apps/api/src/routes/platform.ts', "const owner = { scope: 'platform', permission: 'platform-owner' } as const;", "const owner = { scope: 'platform', permission: 'platform-any' } as const;"],
    ['plat-admin-permission-unjudged', 'apps/api/src/auth.ts', "case 'platform-owner': return a.role === 'owner';", "case 'platform-owner': return true;"],
    ['plat-session-secret-unchecked', 'apps/api/src/auth.ts', "if (!row || !safeEqualHex(row.token_hash, sha256(m[2]!))) return null;", "if (!row) return null;"],
    ['plat-session-expiry-ignored', 'apps/api/src/auth.ts', 'AND s.revoked_at IS NULL AND s.expires_at > now()`, [sessionId]', 'AND s.revoked_at IS NULL`, [sessionId]'],
    ['plat-session-revoke-ignored', 'apps/api/src/auth.ts', 'AND s.revoked_at IS NULL AND s.expires_at > now()`, [sessionId]', 'AND s.expires_at > now()`, [sessionId]'],
    ['plat-inactive-admin-session', 'apps/api/src/auth.ts', 'JOIN platform_admin a ON a.id = s.admin_id AND a.active', 'JOIN platform_admin a ON a.id = s.admin_id'],
    ['plat-host-unchecked', 'apps/api/src/auth.ts', 'wrongPlatformHost(req)) return reply', 'false) return reply'],
    ['plat-suspended-bearer-ok', 'apps/api/src/auth.ts', "if (await isSuspended(c, p.tenantId)) return 'suspended' as const;\r\n      return { kind: 'user'", "return { kind: 'user'"],
    ['plat-suspended-device-ok', 'apps/api/src/auth.ts', "if (await isSuspended(c, p.tenantId)) return 'suspended' as const;\r\n    // The tablet", "// The tablet"],
    ['plat-suspended-login-ok', 'apps/api/src/routes/auth.ts', "if ((await c.query('SELECT suspended_at FROM tenant WHERE id = $1', [tenantId])).rows[0]?.suspended_at) return 'suspended' as const;", ''],
    ['plat-suspend-reason-optional', 'apps/api/src/routes/platform.ts', 'reason: z.string().trim().min(3).max(200) })', 'reason: z.string().trim().min(3).max(200).optional() })'],
    ['plat-suspend-state-unchecked', 'apps/api/src/routes/platform.ts', 'WHERE id = $1 AND (suspended_at IS NULL) = $2 RETURNING id', 'WHERE id = $1 AND $2::boolean IS NOT NULL RETURNING id'],
    ['plat-manager-weak-password', 'apps/api/src/routes/platform.ts', 'password: z.string().min(MIN_PASSWORD_LENGTH)', 'password: z.string().min(1)'],
    ['plat-manager-no-tenant-audit', 'apps/api/src/routes/platform.ts', "action: 'platform.manager.create'", "action: 'x.noop'"],
    ['plat-create-unaudited', 'apps/api/src/routes/platform.ts', "action: 'tenant.create'", "action: 'x.noop'"],
  ].map(([id, file, from, to]) => M(id, file, from, to, API_TESTS('platform.test.ts'))),
  // --- platform health and usage (step 3)
  ...[
    ['plat-health-leaves-stamp', 'db/migrations/0008_platform_metrics.sql', "PERFORM set_config('app.tenant_id', '', true); -- leave the caller's connection unstamped", '', 'db'],
    ['plat-health-executable-by-all', 'db/migrations/0008_platform_metrics.sql', 'REVOKE EXECUTE ON FUNCTION platform.tenant_health(uuid[], int, int), platform.tenant_usage(uuid[], date) FROM PUBLIC;', '', 'db'],
    ['plat-health-no-stamp', 'db/migrations/0008_platform_metrics.sql', "PERFORM set_config('app.tenant_id', t::text, true);\n    RETURN QUERY SELECT\n", "RETURN QUERY SELECT\n", 'api'],
    ['plat-health-rejected-as-applied', 'db/migrations/0008_platform_metrics.sql', "e.outcome = 'rejected' AND e.received_at > now() - interval '24 hours'),\n      (SELECT max(e.received_at)", "e.outcome = 'applied' AND e.received_at > now() - interval '24 hours'),\n      (SELECT max(e.received_at)", 'api'],
    ['plat-health-unsynced', 'db/migrations/0008_platform_metrics.sql', 'AND d.outbox_pending > 0),', 'AND d.outbox_pending < 0),', 'api'],
    ['plat-health-stale-window-fixed', 'db/migrations/0008_platform_metrics.sql', 'make_interval(hours => stale_hours)', 'make_interval(hours => 24)', 'api'],
    ['plat-health-quiet-window-fixed', 'db/migrations/0008_platform_metrics.sql', 'make_interval(hours => quiet_hours)', 'make_interval(hours => 24)', 'api'],
    ['plat-usage-counts-open-sales', 'db/migrations/0008_platform_metrics.sql', "s.status IN ('paid', 'refunded') AND s.business_date", "s.status IN ('paid', 'refunded', 'open', 'void') AND s.business_date", 'api'],
    ['plat-usage-since-ignored', 'db/migrations/0008_platform_metrics.sql', "AND s.business_date >= date_trunc('month', since)::date", '', 'api'],
    ['plat-health-route-open', 'apps/api/src/routes/platform.ts', "app.get('/platform/health', { config: any }", "app.get('/platform/health', { config: { scope: 'public' } }", 'api'],
    ['plat-warning-severity', 'apps/api/src/platformHealth.ts', "add('sync-rejected', 'alert'", "add('sync-rejected', 'warn'", 'api'],
  ].map(([id, file, from, to, kind]) => M(id, file, from, to, kind === 'db'
    ? { cwd: '.', cmd: ['node', '--test', 'db/test/platform.test.mjs'] } : API_TESTS('platform-health.test.ts'))),
  // --- support impersonation (step 4)
  ...[
    ['imp-method-gate-removed', 'apps/api/src/auth.ts', "if (req.method !== 'GET' && req.method !== 'HEAD') return reply", "if (false) return reply"],
    ['imp-db-not-readonly', 'apps/api/src/db.ts', "if (requestMode.getStore()?.readOnly) await c.query('SET TRANSACTION READ ONLY');", ''],
    ['imp-readonly-flag-not-set', 'apps/api/src/auth.ts', 'mode.readOnly = true;', 'mode.readOnly = false;'],
    ['imp-expiry-ignored', 'apps/api/src/auth.ts', "WHERE id = $1 AND ended_at IS NULL AND expires_at > now()'", "WHERE id = $1 AND ended_at IS NULL'"],
    ['imp-end-ignored', 'apps/api/src/auth.ts', "WHERE id = $1 AND ended_at IS NULL AND expires_at > now()'", "WHERE id = $1 AND expires_at > now()'"],
    ['imp-limit-not-in-db', 'db/migrations/0009_impersonation.sql', "CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')", 'CHECK (expires_at > created_at)'],
    ['imp-app-role-can-write', 'db/migrations/0009_impersonation.sql', 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON impersonation FROM pos_app;', ''],
    ['imp-support-role-may-start', 'apps/api/src/routes/platform.ts', "'/platform/tenants/:id/impersonate', { config: { ...owner", "'/platform/tenants/:id/impersonate', { config: { ...any"],
    ['imp-no-tenant-audit', 'db/migrations/0009_impersonation.sql', "'support.access.start'", "'support.access.x'"],
  ].map(([id, file, from, to]) => M(id, file, from, to, API_TESTS('platform-impersonation.test.ts'))),
  // --- operator onboarding: outlets, manager invite (step 5)
  ...[
    ['onb-invite-reusable', AUTH, 'WHERE id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()', 'WHERE id = $1 AND token_hash = $2 AND expires_at > now()'],
    ['onb-invite-expiry-ignored', AUTH, 'WHERE id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()', 'WHERE id = $1 AND token_hash = $2 AND used_at IS NULL'],
    ['onb-invite-secret-unchecked', AUTH, 'WHERE id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()', 'WHERE id = $1 AND $2::text IS NOT NULL AND used_at IS NULL AND expires_at > now()'],
    ['onb-invite-suspended-consumed', AUTH, /AND NOT EXISTS \(SELECT 1 FROM tenant WHERE id = \$3 AND suspended_at IS NOT NULL\)\r?\n\s+RETURNING user_id/, 'RETURNING user_id'],
    ['onb-invite-weak-password', AUTH, 'token: z.string().max(200), password: z.string().min(MIN_PASSWORD_LENGTH)', 'token: z.string().max(200), password: z.string().min(1)'],
    ['onb-invite-known-password', 'apps/api/src/routes/platform.ts', 'body.data.password ?? newSecret()', "body.data.password ?? 'dev-password-123'"],
    ['onb-outlet-support-may-create', 'apps/api/src/routes/platform.ts', "app.post('/platform/tenants/:id/outlets', { config: { ...owner", "app.post('/platform/tenants/:id/outlets', { config: { ...any"],
    ['onb-manager-foreign-outlet', 'apps/api/src/routes/platform.ts', 'if (n !== outletIds.length) return null;', ''],
    ['onb-reinvite-keeps-old-link', 'apps/api/src/routes/platform.ts', "await c.query('UPDATE manager_invite SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [uid]);", ''],
    ['onb-reinvite-after-accept', 'apps/api/src/routes/platform.ts', /\r?\n\s+AND NOT EXISTS \(SELECT 1 FROM manager_invite i WHERE i\.user_id = u\.id AND i\.used_at IS NOT NULL\)`/, '`'],
    ['onb-invite-lifetime-not-in-db', 'db/migrations/0010_manager_invite.sql', "CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),", ''],
  ].map(([id, file, from, to]) => M(id, file, from, to, API_TESTS('platform-onboarding.test.ts'))),
  // --- login picks the tenant (D12)
  M('login-lookup-any-email', 'db/migrations/0001_tenancy.sql', "AND lower(email) = nullif(lower(current_setting('app.login_email', true)), ''))", ')', API_TESTS('tenancy-host.test.ts')),
  M('email-unique-per-tenant', 'db/migrations/0001_tenancy.sql', 'CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));', 'CREATE UNIQUE INDEX app_user_email_uq ON app_user (tenant_id, lower(email));', API_TESTS('tenancy-host.test.ts')),
  M('device-logo-from-host', 'apps/api/src/routes/branding.ts', 'serveLogo(req, reply, req.principal!.tenantId)', 'serveLogo(req, reply, req.hostTenantId ?? req.principal!.tenantId)', API_TESTS('tenancy-host.test.ts')),
  M('outbox-one-tenant-only','apps/api/src/jobs/outbox.ts', 'for (const d of await scanDue()) {', 'for (const d of (await scanDue()).filter((x) => x.tenant_id.endsWith("a"))) {', API_TESTS('outbox.test.ts')),
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
  // `from` is a string, or a RegExp when the text spans lines (checked-in files may use CRLF).
  const isRe = m.from instanceof RegExp;
  const count = isRe ? (original.match(new RegExp(m.from.source, 'g'))?.length ?? 0) : original.split(m.from).length - 1;
  if (count === 0 || (count > 1 && !m.all)) { results.push([m.id, 'INVALID', `pattern found ${count}x`]); console.log(results.at(-1).join(' | ')); continue; }
  try {
    writeFileSync(m.file, isRe ? original.replace(m.from, m.to) : m.all ? original.split(m.from).join(m.to) : original.replace(m.from, () => m.to));
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
