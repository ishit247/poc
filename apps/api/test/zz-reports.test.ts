// Reports (phase 8). Named to run last: it adds an outlet to tenant A, and the outlet and scope suites count outlets.
// Every figure is checked against hand-worked numbers for one outlet and one past day, so no other suite's data
// can move them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';
import { hostFor } from './hosts.js';
import { KINDS, toCsv } from '../src/reports.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const D = '2026-03-10';
test.after(() => pool.end());

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (app: ReturnType<typeof buildApp>, tenant: string, email: string) =>
  (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;

async function world() {
  const name = `ZZ reports ${randomUUID().slice(0, 8)}`;
  return withTenant(A, async (c) => {
    const o = (await c.query('INSERT INTO outlet (tenant_id, name) VALUES ($1, $2) RETURNING id', [A, name])).rows[0].id as string;
    const ct = (await c.query("INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, 'C1') RETURNING id", [A, o])).rows[0].id as string;
    const dev = (await c.query(
      `INSERT INTO device (tenant_id, outlet_id, counter_id, credential_hash, label, last_seen_at, outbox_pending, app_version)
       VALUES ($1, $2, $3, 'x', 'Till 1', $4, 3, '1.2.3') RETURNING id`, [A, o, ct, `${D}T08:00:00+05:30`])).rows[0].id as string;
    const u = (await c.query(
      `INSERT INTO app_user (tenant_id, name, pin_verifier, role)
       SELECT $1, $2, pin_verifier, 'cashier' FROM app_user WHERE name = 'School 1 Canteen cashier' RETURNING id`, [A, `${name} cashier`])).rows[0].id as string;
    await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [A, u, o]);
    await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) SELECT $1, id, $2 FROM app_user WHERE email = $3', [A, o, 'a1@example.test']);
    const items = (await c.query('SELECT id FROM item WHERE deleted_at IS NULL ORDER BY name LIMIT 2')).rows.map((r) => r.id as string);

    const sh = randomUUID();
    await c.query(
      `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, closed_at, opening_cash_paise, counted_cash_paise, expected_cash_paise, variance_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 5000, 19950, 20000, -50)`, [sh, A, o, dev, u, `${D}T09:00:00+05:30`, `${D}T17:00:00+05:30`]);

    // A drawer still open that day has no count yet: the variance report must not include it.
    await c.query(
      `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise) VALUES ($1, $2, $3, $4, $5, $6, 5000)`,
      [randomUUID(), A, o, dev, u, `${D}T18:00:00+05:30`]);

    let seq = 0;
    const sale = async (at: string, o2: { channel?: string; status?: string; sub: number; tax: number; reason?: string; flags?: string[]; item: number; name: string; qty: number; pay?: [string, number][] }) => {
      const id = randomUUID();
      const counter = (o2.channel ?? 'counter') === 'counter';
      const paid = (o2.status ?? 'paid') === 'paid';
      if (counter && paid) seq += 1;
      await c.query(
        `INSERT INTO sale (id, tenant_id, outlet_id, business_date, shift_id, device_id, created_by, channel, status, receipt_no, receipt_seq, menu_version,
                           subtotal_paise, tax_paise, total_paise, created_at_device, void_reason, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $13, $14, $15, $16, $17)`,
        [id, A, o, D, counter ? sh : null, dev, u, o2.channel ?? 'counter', o2.status ?? 'paid', counter && paid ? `C1-${seq}` : null, counter && paid ? seq : null,
          o2.sub, o2.tax, o2.sub + o2.tax, at, o2.reason ?? null, o2.flags ?? []]);
      await c.query(
        `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`, [A, id, items[o2.item], o2.name, o2.sub / o2.qty, o2.qty, o2.sub, o2.tax]);
      for (const [method, amount] of o2.pay ?? []) {
        await c.query('INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1, $2, $3, $4)', [A, id, method, amount]);
      }
      return id;
    };
    await sale(`${D}T10:15:00+05:30`, { sub: 10000, tax: 500, item: 0, name: 'Alpha', qty: 2, pay: [['cash', 10500]] });
    await sale(`${D}T10:40:00+05:30`, { sub: 3000, tax: 0, item: 1, name: 'Beta', qty: 1, pay: [['upi', 3000]], flags: ['late_arrival'] });
    await sale(`${D}T14:05:00+05:30`, { sub: 5000, tax: 250, item: 0, name: 'Alpha', qty: 1, pay: [['cash', 2000], ['upi', 3250]], flags: ['sold_unavailable'] });
    await sale(`${D}T15:00:00+05:30`, { status: 'void', sub: 1000, tax: 0, item: 1, name: 'Beta', qty: 1, reason: '=HYPERLINK("http://x")' });
    const z1 = await sale(`${D}T12:30:00+05:30`, { channel: 'zomato', sub: 4000, tax: 0, item: 1, name: 'Beta', qty: 1, pay: [['aggregator', 4000]] });
    const z2 = await sale(`${D}T13:30:00+05:30`, { channel: 'zomato', status: 'void', sub: 2000, tax: 0, item: 1, name: 'Beta', qty: 1, reason: 'out of stock' });
    const ord = async (saleId: string, ext: string, status: string, reason: string | null) =>
      (await c.query(
        `INSERT INTO online_order (tenant_id, outlet_id, sale_id, provider, channel, external_order_id, status, reason, received_at)
         VALUES ($1, $2, $3, 'manual', 'zomato', $4, $5, $6, $7) RETURNING id`, [A, o, saleId, ext, status, reason, `${D}T12:00:00+05:30`])).rows[0].id as string;
    const oo1 = await ord(z1, `R-${randomUUID().slice(0, 8)}`, 'handed_over', null);
    await ord(z2, `R-${randomUUID().slice(0, 8)}`, 'rejected', 'out of stock');
    const imp = (await c.query(
      `INSERT INTO settlement_import (tenant_id, outlet_id, channel, filename, period_from, period_to, uploaded_by)
       VALUES ($1, $2, 'zomato', 'march.csv', $3, $3, $4) RETURNING id`, [A, o, D, u])).rows[0].id as string;
    await c.query(`INSERT INTO settlement_line (tenant_id, import_id, external_order_id, gross_paise, payout_paise, online_order_id, result) VALUES ($1, $2, 'Q1', 4500, 4000, $3, 'amount_mismatch')`, [A, imp, oo1]);
    await c.query(`INSERT INTO settlement_line (tenant_id, import_id, external_order_id, gross_paise, payout_paise, online_order_id, result) VALUES ($1, $2, 'Q2', 4000, 3500, $3, 'matched')`, [A, imp, oo1]);
    await c.query(`INSERT INTO settlement_line (tenant_id, import_id, external_order_id, gross_paise, payout_paise, result) VALUES ($1, $2, 'Q3', 900, 800, 'unknown_order')`, [A, imp]);
    await c.query(
      `INSERT INTO sync_event (tenant_id, id, device_id, seq, type, created_at_device, received_at, outcome, reason, payload)
       VALUES ($1, $2, $3, 1, 'sale.created', $4, $4, 'rejected', 'bad_total', '{}')`, [A, randomUUID(), dev, `${D}T11:00:00+05:30`]);
    return { outletId: o, name, cashier: `${name} cashier` };
  });
}

type Rows = Record<string, string | number | null>[];
const get = async (app: ReturnType<typeof buildApp>, token: string, kind: string, q: Record<string, string>) =>
  app.inject({ method: 'GET', url: `/reports/${kind}?${new URLSearchParams({ from: D, to: D, ...q })}`, headers: bearer(token) });

test('reports: figures match hand-worked numbers for one outlet and one day', async () => {
  const app = buildApp();
  const w = await world();
  const mgr = await login(app, A, 'a1@example.test');
  const run = async (kind: string, q: Record<string, string> = {}) => {
    const r = await get(app, mgr, kind, { outletId: w.outletId, ...q });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { rows: Rows; totals: Record<string, number> | null; provisional: boolean };
  };

  const day = await run('sales');
  assert.equal(day.provisional, false, 'a past day is not provisional');
  assert.deepEqual(day.rows.map((r) => [r.label, r.sales, r.gross, r.tax, r.cash, r.upi, r.online]), [[D, 4, 22750, 750, 12500, 6250, 4000]]);
  assert.equal(day.totals!.gross, 22750);

  const ch = await run('sales', { by: 'channel' });
  assert.deepEqual(ch.rows.map((r) => [r.label, r.sales, r.gross]), [['counter', 3, 18750], ['zomato', 1, 4000]]);
  const cashier = await run('sales', { by: 'cashier' });
  assert.deepEqual(cashier.rows.map((r) => [r.label, r.sales, r.gross]), [[w.cashier, 4, 22750]]);
  const counter = await run('sales', { by: 'counter' });
  assert.deepEqual(counter.rows.map((r) => [r.label, r.gross]), [['C1', 22750]]);
  const outlet = await run('sales', { by: 'outlet' });
  assert.deepEqual(outlet.rows.map((r) => [r.label, r.gross]), [[w.name, 22750]]);

  const items = await run('items');
  assert.deepEqual(items.rows.map((r) => [r.label, r.qty, r.net, r.tax]), [['Alpha', 3, 15000, 750], ['Beta', 2, 7000, 0]]);
  const cats = await run('items', { by: 'category' });
  assert.equal(cats.totals!.net, 22000, 'categories add up to the lines');

  const hours = await run('hourly');
  assert.deepEqual(hours.rows.map((r) => [r.hour, r.sales, r.gross]), [[10, 2, 13500], [12, 1, 4000], [14, 1, 5250]]);

  const voids = await run('voids');
  assert.deepEqual(voids.rows.map((r) => [r.channel, r.status, r.total, r.reason]), [
    ['counter', 'void', 1000, '=HYPERLINK("http://x")'], ['zomato', 'void', 2000, 'out of stock']]);

  const v = await run('variance');
  assert.deepEqual(v.rows.map((r) => [r.cashier, r.shifts, r.short, r.expected, r.counted, r.variance]), [[w.cashier, 1, 1, 20000, 19950, -50]]);

  const un = await run('unavailable');
  assert.deepEqual(un.rows.map((r) => [r.ref, r.total, r.items]), [['C1-3', 5250, 'Alpha']]);

  const on = await run('online');
  assert.deepEqual(on.rows.map((r) => [r.channel, r.received, r.delivered, r.rejected, r.expired, r.inProgress, r.gross]), [['zomato', 2, 1, 1, 0, 0, 4000]]);

  const st = await run('settlement');
  assert.deepEqual(st.rows.map((r) => [r.ref, r.result, r.platform, r.ours]), [['Q1', 'amount_mismatch', 4500, 4000], ['Q3', 'unknown_order', 900, null]]);

  const sy = await run('sync');
  assert.deepEqual(sy.rows.map((r) => [r.counter, r.device, r.pending, r.version, r.rejected, r.late]), [['C1', 'Till 1', 3, '1.2.3', 1, 1]]);
});

test('reports: the range is inclusive of both ends and excludes the days around it', async () => {
  const app = buildApp();
  const w = await world();
  const mgr = await login(app, A, 'a1@example.test');
  const rows = async (kind: string, from: string, to: string) =>
    (await get(app, mgr, kind, { outletId: w.outletId, from, to })).json().rows as Rows;
  for (const kind of KINDS) {
    if (kind === 'settlement') continue; // a statement is matched by its period overlapping the range; see below
    for (const from of ['2026-03-11', '2026-03-09']) {
      const r = await rows(kind, from, from);
      // The sync report lists every tablet whatever the dates; its counts are what the dates select.
      if (kind === 'sync') assert.deepEqual(r.map((x) => [x.rejected, x.late]), [[0, 0]], `${kind} ${from}`);
      else assert.deepEqual(r, [], `${kind} on ${from} must be empty`);
    }
    assert.ok((await rows(kind, '2026-03-09', '2026-03-11')).length > 0, `${kind} across the day is not empty`);
  }
  assert.equal((await rows('settlement', '2026-03-09', '2026-03-09')).length, 0, 'a statement for the 10th does not reach the 9th');
  assert.equal((await rows('settlement', '2026-03-11', '2026-03-12')).length, 0);
  assert.equal((await rows('settlement', '2026-03-10', '2026-03-12')).length, 2, 'a range that touches the period includes it');
});

test('reports: today is provisional; a bad range is refused', async () => {
  const app = buildApp();
  const w = await world();
  const mgr = await login(app, A, 'a1@example.test');
  const today = await withTenant(A, async (c) => (await c.query('SELECT (now() AT TIME ZONE timezone)::date::text d FROM outlet WHERE id = $1', [w.outletId])).rows[0].d as string);
  const r = await get(app, mgr, 'sales', { outletId: w.outletId, from: today, to: today });
  assert.equal(r.json().provisional, true);
  for (const q of <Record<string, string>[]>[{ from: '2026-02-30' }, { to: '2026-03-01' }, { from: '2025-01-01', to: '2026-03-10' }, { by: 'nonsense' }, { extra: '1' }]) {
    assert.equal((await get(app, mgr, 'sales', { outletId: w.outletId, ...q })).statusCode, 400, JSON.stringify(q));
  }
  assert.equal((await get(app, mgr, 'items', { outletId: w.outletId, by: 'day' })).statusCode, 400);
  assert.equal((await get(app, mgr, 'nope', {})).statusCode, 400);
});

test('reports: a manager sees only their own outlets; others, cashiers and anonymous callers are turned away', async () => {
  const app = buildApp();
  const w = await world();
  const a1 = await login(app, A, 'a1@example.test');
  const a2 = await login(app, A, 'a2@example.test');
  const b1 = await login(app, B, 'b1@example.test');

  assert.equal((await get(app, a2, 'sales', { outletId: w.outletId })).statusCode, 404, 'same tenant, not their outlet');
  assert.equal((await get(app, b1, 'sales', { outletId: w.outletId })).statusCode, 404, 'another tenant');
  // "all my outlets" never includes an outlet that is not theirs.
  const mine = (await get(app, a2, 'sales', { by: 'outlet' })).json().rows as Rows;
  assert.ok(!mine.some((r) => r.label === w.name));
  const theirs = (await get(app, b1, 'sales', { by: 'outlet' })).json().rows as Rows;
  assert.ok(!theirs.some((r) => r.label === w.name));
  // Every report, not only sales: another manager's consolidated view never contains this outlet's rows.
  for (const kind of KINDS) {
    for (const [who, token] of [['a2', a2], ['b1', b1]] as const) {
      const rows = (await get(app, token, kind, {})).json().rows as Rows;
      assert.ok(!rows.some((r) => Object.values(r).includes(w.name)), `${kind} leaks to ${who}`);
    }
    const own = (await get(app, a1, kind, { outletId: w.outletId })).json().rows as Rows;
    assert.ok(own.length > 0 && own.every((r) => r.outlet === w.name || r.label === w.name), `${kind} for one outlet holds only that outlet`);
  }
  // The manager who is assigned sees it in the consolidated view, and the total equals the outlet on its own.
  const all = (await get(app, a1, 'sales', { by: 'outlet' })).json().rows as Rows;
  assert.equal(all.find((r) => r.label === w.name)!.gross, 22750);

  assert.equal((await app.inject({ method: 'GET', url: `/reports/sales?from=${D}&to=${D}` })).statusCode, 401);
  const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(a1), payload: { outletId: w.outletId, counterId: (await withTenant(A, async (c) => (await c.query('SELECT id FROM counter WHERE outlet_id = $1', [w.outletId])).rows[0].id as string)) } })).json().code;
  const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
  assert.equal((await app.inject({ method: 'GET', url: `/reports/sales?from=${D}&to=${D}`, headers: { authorization: `Device ${cred}` } })).statusCode, 403);
  const cashierId = await withTenant(A, async (c) => (await c.query('SELECT id FROM app_user WHERE name = $1', [w.cashier])).rows[0].id as string);
  const pin = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${cred}` }, payload: { userId: cashierId, pin: '482913' } });
  assert.equal((await app.inject({ method: 'GET', url: `/reports/sales?from=${D}&to=${D}`, headers: bearer(pin.json().token) })).statusCode, 403);
});

test('reports CSV: rupees by integer arithmetic, a total row, and formulas are defused', async () => {
  const app = buildApp();
  const w = await world();
  const mgr = await login(app, A, 'a1@example.test');
  const r = await get(app, mgr, 'sales', { outletId: w.outletId, format: 'csv' });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /^text\/csv/);
  assert.match(String(r.headers['content-disposition']), /attachment; filename="report-sales-2026-03-10_2026-03-10\.csv"/);
  const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Outlet,Day,Sales,Gross,Tax,Cash,UPI,Online');
  assert.equal(lines[1], `${w.name},2026-03-10,4,227.50,7.50,125.00,62.50,40.00`);
  assert.equal(lines[2], 'Total,,4,227.50,7.50,125.00,62.50,40.00');

  const v = await get(app, mgr, 'voids', { outletId: w.outletId, format: 'csv' });
  assert.ok(v.body.includes(`"'=HYPERLINK(""http://x"")"`), v.body);
  assert.ok(!v.body.includes(',=HYPERLINK'), 'a reason is never written bare');

  const small = toCsv({ columns: [{ key: 't', label: 'T', kind: 'text' }, { key: 'a', label: 'A', kind: 'paise', sum: true }], rows: [{ t: 'x', a: -5 }, { t: 'y', a: 100000 }], totals: { a: 99995 } });
  assert.equal(small, '﻿T,A\r\nx,-0.05\r\ny,1000.00\r\nTotal,999.95\r\n', 'amounts under a rupee keep their sign and padding');
});
