// Reports (PLAN 14). Each report is one query over a business-date range for a set of outlets, returning typed
// columns so the same rows serve the screen and the CSV. Money stays integer paise until the CSV, where it is
// written as rupees by integer arithmetic (never a float).
import type pg from 'pg';

export type ColKind = 'text' | 'int' | 'paise';
export interface Col { key: string; label: string; kind: ColKind; sum?: boolean }
export type Cell = string | number | null;
export interface ReportResult { columns: Col[]; rows: Record<string, Cell>[]; totals: Record<string, number> | null }

export const KINDS = ['sales', 'items', 'hourly', 'voids', 'variance', 'unavailable', 'online', 'settlement', 'sync'] as const;
export type Kind = (typeof KINDS)[number];

export const SALES_BY = ['day', 'outlet', 'counter', 'cashier', 'channel'] as const;
export const ITEMS_BY = ['item', 'category'] as const;

interface Args { outletIds: string[]; from: string; to: string; by?: string }

const text = (key: string, label: string): Col => ({ key, label, kind: 'text' });
const int = (key: string, label: string, sum = true): Col => ({ key, label, kind: 'int', sum });
const money = (key: string, label: string, sum = true): Col => ({ key, label, kind: 'paise', sum });
const OUTLET = text('outlet', 'Outlet');

// Paid sales in range: the base every sales report reads. A refunded or void sale is reported by `voids`.
const PAID = `
  SELECT s.id, s.device_id, s.created_by, s.channel, s.business_date, s.total_paise, s.tax_paise, s.created_at_device,
         o.name AS outlet, o.timezone
    FROM sale s JOIN outlet o ON o.id = s.outlet_id
   WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.status = 'paid'`;

const SALES_BY_SQL: Record<(typeof SALES_BY)[number], { join: string; label: string; group: string; order: string; head: Col[] }> = {
  day:     { join: '', label: 'b.business_date::text', group: 'b.business_date', order: 'label', head: [OUTLET, text('label', 'Day')] },
  outlet:  { join: '', label: 'b.outlet', group: '', order: 'gross DESC', head: [text('label', 'Outlet')] },
  counter: { join: 'JOIN device d ON d.id = b.device_id JOIN counter ct ON ct.id = d.counter_id', label: 'ct.code', group: 'ct.code', order: 'gross DESC', head: [OUTLET, text('label', 'Counter')] },
  cashier: { join: 'JOIN app_user u ON u.id = b.created_by', label: 'u.name', group: 'u.id, u.name', order: 'gross DESC', head: [OUTLET, text('label', 'Taken by')] },
  channel: { join: '', label: 'b.channel', group: 'b.channel', order: 'gross DESC', head: [OUTLET, text('label', 'Channel')] },
};

async function sales(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const by = SALES_BY_SQL[(a.by as (typeof SALES_BY)[number]) ?? 'day'];
  const r = await c.query(
    `WITH b AS (${PAID}),
          p AS (SELECT sale_id,
                       COALESCE(sum(amount_paise) FILTER (WHERE method = 'cash'), 0) AS cash,
                       COALESCE(sum(amount_paise) FILTER (WHERE method = 'upi'), 0) AS upi,
                       COALESCE(sum(amount_paise) FILTER (WHERE method = 'aggregator'), 0) AS online
                  FROM payment WHERE sale_id IN (SELECT id FROM b) GROUP BY sale_id)
     SELECT b.outlet, ${by.label} AS label, count(*)::int AS sales, sum(b.total_paise)::bigint AS gross, sum(b.tax_paise)::bigint AS tax,
            sum(p.cash)::bigint AS cash, sum(p.upi)::bigint AS upi, sum(p.online)::bigint AS online
       FROM b LEFT JOIN p ON p.sale_id = b.id ${by.join}
      GROUP BY b.outlet${by.group ? ', ' + by.group : ''} ORDER BY ${by.order}, b.outlet`, [a.outletIds, a.from, a.to]);
  const columns = [...by.head, int('sales', 'Sales'), money('gross', 'Gross'), money('tax', 'Tax'), money('cash', 'Cash'), money('upi', 'UPI'), money('online', 'Online')];
  return shape(columns, r.rows);
}

async function items(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const byItem = (a.by ?? 'item') === 'item';
  const r = await c.query(
    `WITH b AS (${PAID})
     SELECT b.outlet, ${byItem ? 'l.name_snapshot AS label, cat.name AS category' : 'cat.name AS label'},
            sum(l.qty)::bigint AS qty, sum(l.line_total_paise)::bigint AS net, sum(l.tax_paise)::bigint AS tax
       FROM b JOIN sale_line l ON l.sale_id = b.id JOIN item i ON i.id = l.item_id JOIN category cat ON cat.id = i.category_id
      GROUP BY b.outlet, ${byItem ? 'l.item_id, l.name_snapshot, cat.name' : 'cat.id, cat.name'} ORDER BY net DESC, label`, [a.outletIds, a.from, a.to]);
  const columns = [OUTLET, text('label', byItem ? 'Item' : 'Category'), ...(byItem ? [text('category', 'Category')] : []),
    int('qty', 'Quantity'), money('net', 'Before tax'), money('tax', 'Tax')];
  return shape(columns, r.rows);
}

async function hourly(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const r = await c.query(
    `WITH b AS (${PAID})
     SELECT b.outlet, extract(hour FROM b.created_at_device AT TIME ZONE b.timezone)::int AS hour, count(*)::int AS sales, sum(b.total_paise)::bigint AS gross
       FROM b GROUP BY b.outlet, 2 ORDER BY b.outlet, 2`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, int('hour', 'Hour (0-23)', false), int('sales', 'Sales'), money('gross', 'Gross')], r.rows);
}

async function voids(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const r = await c.query(
    `SELECT o.name AS outlet, s.business_date::text AS date, s.channel, s.status,
            COALESCE(s.receipt_no, oo.external_order_id, '') AS ref, s.total_paise::bigint AS total,
            COALESCE(s.void_reason, oo.reason, '') AS reason, u.name AS "by"
       FROM sale s JOIN outlet o ON o.id = s.outlet_id JOIN app_user u ON u.id = s.created_by
       LEFT JOIN online_order oo ON oo.sale_id = s.id
      WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.status IN ('void', 'refunded')
      ORDER BY s.business_date, o.name, ref`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('date', 'Day'), text('channel', 'Channel'), text('status', 'Status'), text('ref', 'Receipt / order'),
    money('total', 'Amount'), text('reason', 'Reason'), text('by', 'Taken by')], r.rows);
}

async function variance(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  // A shift belongs to the day it was opened on, in the outlet's own timezone (as in day close).
  const r = await c.query(
    `SELECT o.name AS outlet, u.name AS cashier, count(*)::int AS shifts, count(*) FILTER (WHERE sh.closed_by IS NOT NULL)::int AS forced,
            sum(sh.expected_cash_paise)::bigint AS expected, sum(sh.counted_cash_paise)::bigint AS counted, sum(sh.variance_paise)::bigint AS variance,
            count(*) FILTER (WHERE sh.variance_paise < 0)::int AS short
       FROM shift sh JOIN outlet o ON o.id = sh.outlet_id JOIN app_user u ON u.id = sh.user_id
      WHERE sh.outlet_id = ANY($1::uuid[]) AND sh.closed_at IS NOT NULL
        AND (sh.opened_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
      GROUP BY o.name, u.id, u.name ORDER BY variance, o.name, u.name`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('cashier', 'Cashier'), int('shifts', 'Shifts'), int('short', 'Shifts short'), int('forced', 'Closed by a manager'),
    money('expected', 'Expected'), money('counted', 'Counted'), money('variance', 'Variance')], r.rows);
}

async function unavailable(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const r = await c.query(
    `SELECT o.name AS outlet, s.business_date::text AS date, COALESCE(s.receipt_no, oo.external_order_id, '') AS ref, s.channel, s.status,
            s.total_paise::bigint AS total, u.name AS "by",
            (SELECT string_agg(DISTINCT l.name_snapshot, ', ') FROM sale_line l WHERE l.sale_id = s.id) AS items
       FROM sale s JOIN outlet o ON o.id = s.outlet_id JOIN app_user u ON u.id = s.created_by
       LEFT JOIN online_order oo ON oo.sale_id = s.id
      WHERE s.outlet_id = ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date
        AND 'sold_unavailable' = ANY(s.flags) AND s.status IN ('paid', 'refunded')
      ORDER BY s.business_date, o.name, ref`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('date', 'Day'), text('ref', 'Receipt / order'), text('channel', 'Channel'), text('status', 'Status'),
    money('total', 'Amount'), text('by', 'Taken by'), text('items', 'Items')], r.rows);
}

async function online(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const r = await c.query(
    `SELECT o.name AS outlet, oo.channel, count(*)::int AS received,
            count(*) FILTER (WHERE oo.status = 'handed_over')::int AS delivered,
            count(*) FILTER (WHERE oo.status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE oo.status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE oo.status = 'expired')::int AS expired,
            count(*) FILTER (WHERE oo.status IN ('received', 'accepted', 'preparing', 'ready'))::int AS "inProgress",
            count(*) FILTER (WHERE oo.price_overridden)::int AS overridden,
            COALESCE(sum(s.total_paise) FILTER (WHERE oo.status = 'handed_over'), 0)::bigint AS gross
       FROM online_order oo JOIN outlet o ON o.id = oo.outlet_id JOIN sale s ON s.id = oo.sale_id
      WHERE oo.outlet_id = ANY($1::uuid[]) AND (oo.received_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
      GROUP BY o.name, oo.channel ORDER BY o.name, oo.channel`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('channel', 'Platform'), int('received', 'Received'), int('delivered', 'Delivered'), int('rejected', 'Rejected'),
    int('cancelled', 'Cancelled'), int('expired', 'Expired'), int('inProgress', 'Still open'), int('overridden', 'Price changed'), money('gross', 'Delivered gross')], r.rows);
}

async function settlement(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  // Lines that did not match, from every statement whose period touches the range. Orders a statement omits are
  // on the statement's own screen (they depend on which statement is read); this lists what the platform said.
  const r = await c.query(
    `SELECT o.name AS outlet, i.channel, i.filename AS file, i.period_from::text || ' to ' || i.period_to::text AS period,
            l.external_order_id AS ref, l.result, l.gross_paise::bigint AS platform, s.total_paise::bigint AS ours
       FROM settlement_line l JOIN settlement_import i ON i.id = l.import_id JOIN outlet o ON o.id = i.outlet_id
       LEFT JOIN online_order oo ON oo.id = l.online_order_id LEFT JOIN sale s ON s.id = oo.sale_id
      WHERE i.outlet_id = ANY($1::uuid[]) AND l.result <> 'matched' AND i.period_to >= $2::date AND i.period_from <= $3::date
      ORDER BY o.name, i.uploaded_at DESC, l.external_order_id`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('channel', 'Platform'), text('file', 'Statement'), text('period', 'Period'), text('ref', 'Platform order'),
    text('result', 'Result'), money('platform', 'Platform says', false), money('ours', 'We have', false)], r.rows);
}

async function syncHealth(c: pg.PoolClient, a: Args): Promise<ReportResult> {
  const r = await c.query(
    `SELECT o.name AS outlet, ct.code AS counter, COALESCE(d.label, '') AS device,
            COALESCE(to_char(d.last_seen_at AT TIME ZONE o.timezone, 'YYYY-MM-DD HH24:MI'), 'never') AS "lastSeen",
            d.outbox_pending AS pending, COALESCE(d.app_version, '') AS version, CASE WHEN d.revoked_at IS NULL THEN '' ELSE 'revoked' END AS state,
            (SELECT count(*) FROM sync_event e WHERE e.device_id = d.id AND e.outcome = 'rejected'
                AND (e.received_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date)::int AS rejected,
            (SELECT count(*) FROM sale s WHERE s.device_id = d.id AND 'late_arrival' = ANY(s.flags)
                AND s.business_date BETWEEN $2::date AND $3::date)::int AS late
       FROM device d JOIN outlet o ON o.id = d.outlet_id JOIN counter ct ON ct.id = d.counter_id
      WHERE d.outlet_id = ANY($1::uuid[]) ORDER BY o.name, ct.code, d.enrolled_at`, [a.outletIds, a.from, a.to]);
  return shape([OUTLET, text('counter', 'Counter'), text('device', 'Tablet'), text('state', 'State'), text('lastSeen', 'Last heard from'),
    int('pending', 'Waiting to send', false), text('version', 'App version'), int('rejected', 'Events turned away'), int('late', 'Late arrivals')], r.rows);
}

/** bigint columns arrive as strings; amounts stay well inside Number's exact range. */
function shape(cols: Col[], rows: Record<string, unknown>[]): ReportResult {
  const out = rows.map((r) => Object.fromEntries(cols.map((col): [string, Cell] => {
    const v = r[col.key];
    if (v == null) return [col.key, null];
    return [col.key, col.kind === 'text' ? String(v) : Number(v)];
  })));
  const sums = cols.filter((col) => col.sum);
  const totals = out.length && sums.length ? Object.fromEntries(sums.map((col) => [col.key, out.reduce((n, r) => n + Number(r[col.key] ?? 0), 0)])) : null;
  return { columns: cols, rows: out, totals };
}

const RUN: Record<Kind, (c: pg.PoolClient, a: Args) => Promise<ReportResult>> = {
  sales, items, hourly, voids, variance, unavailable, online, settlement, sync: syncHealth,
};

export const runReport = (c: pg.PoolClient, kind: Kind, a: Args) => RUN[kind](c, a);

/** Today's figures are provisional (PLAN 14): true when the range reaches the current date at any chosen outlet. */
export async function isProvisional(c: pg.PoolClient, outletIds: string[], to: string): Promise<boolean> {
  const r = await c.query(
    `SELECT COALESCE(bool_or($2::date >= (now() AT TIME ZONE timezone)::date), false) AS p FROM outlet WHERE id = ANY($1::uuid[])`, [outletIds, to]);
  return r.rows[0].p as boolean;
}

// ---- CSV ----

const rupees = (n: number) => {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** A cell a spreadsheet would read as a formula is prefixed so it is shown, not run (void reasons are typed by people). */
const textCell = (s: string) => {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(r: ReportResult): string {
  const head = r.columns.map((col) => textCell(col.label)).join(',');
  const cell = (col: Col, v: Cell) => (v == null ? '' : col.kind === 'text' ? textCell(String(v)) : col.kind === 'paise' ? rupees(Number(v)) : String(v));
  const lines = r.rows.map((row) => r.columns.map((col) => cell(col, row[col.key] ?? null)).join(','));
  if (r.totals) {
    const t = r.columns.map((col, i) => (i === 0 ? 'Total' : r.totals![col.key] === undefined ? '' : cell(col, r.totals![col.key]!)));
    lines.push(t.join(','));
  }
  return '﻿' + [head, ...lines].join('\r\n') + '\r\n';
}
