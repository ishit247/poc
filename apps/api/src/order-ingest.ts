// Running orders on the server (phase 12, PLAN D15 and D18; docs/phase12-plan.md "Step 4 notes").
//
// One table visit is a ROOT sale (opened by `order.opened`) plus any sales split off it for lines that arrived after a
// payment; all share `sale.order_root_id`. The server never edits lines event by event: after every order event it
// folds ALL the visit's applied order events with the shared `foldOrder` and rewrites the visit's one open sale to
// match (`openLines`). So the server's rows are the fold by construction, whatever order the events arrived in.
//
// A line with a row on a paid (or void) sale is settled: changing or removing it afterwards is refused `already_paid`
// (or `sale_void`). Every change to one visit happens under a lock on its root row, whichever device sends it.
import type pg from 'pg';
import {
  checkPayment, exclusiveLine, foldOrder, openLines, orderTotals, OrderEvent, paise,
  type ClosedLine, type FoldedLine, type GstRounding, type OrderEnvelope, type OrderFold, type OrderOpened, type PaymentTaken, type TradingSettings,
} from '@pos/shared';
import { audit } from './audit.js';
import type { DevicePrincipal, Envelope } from './ingest.js';
import { Defer, Reject } from './sync-outcome.js';

const SKEW_MS = 5 * 60_000;
const MODES: GstRounding[] = ['half_up', 'up', 'down'];
const STEPS = [0, 10, 50, 100] as const;

type LineEvent = Exclude<OrderEvent, OrderOpened>;
type PaymentV2 = Extract<PaymentTaken, { schemaVersion: 2 }>;

/** D18: anyone who signs in on a tablet here (cashier or waiter) may change an open order, on any of its devices. */
async function worksHere(c: pg.PoolClient, outletId: string, userId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
      WHERE u.id = $1 AND uo.outlet_id = $2 AND u.role IN ('cashier', 'waiter')`, [userId, outletId]);
  return !!r.rowCount;
}

async function checkTable(c: pg.PoolClient, outletId: string, tableId: string): Promise<void> {
  const r = await c.query('SELECT 1 FROM dining_table WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL', [tableId, outletId]);
  if (!r.rowCount) throw new Reject('unknown_table');
}

export async function applyOrderOpened(
  c: pg.PoolClient, p: DevicePrincipal, e: Envelope, ev: OrderOpened,
  businessDay: (date: string) => Promise<{ id: string; closed: boolean }>,
): Promise<void> {
  if (!(await worksHere(c, p.outletId, ev.createdBy))) throw new Reject('unknown_user');
  if ((await c.query('SELECT 1 FROM sale WHERE id = $1', [ev.saleId])).rowCount) {
    // A re-queued copy (new seq, same payload) opens the same order: nothing to do. Anything else claiming the id is refused.
    const same = await c.query(
      `SELECT 1 FROM sync_event WHERE entity_id = $1 AND type = 'order.opened' AND outcome = 'applied' AND payload = $2::jsonb`,
      [ev.saleId, JSON.stringify(e.payload)]);
    if (same.rowCount) return;
    throw new Reject('sale_exists');
  }
  await checkTable(c, p.outletId, ev.tableId);

  const flags: string[] = [];
  if (new Date(ev.createdAtDevice).getTime() > Date.now() + SKEW_MS) flags.push('clock_ahead');
  const day = await businessDay(ev.businessDate);
  if (day.closed) flags.push('late_arrival');
  // Two open orders on one table (two devices, both offline) are allowed and flagged, never refused (phase 12 invariant).
  const busy = await c.query(`SELECT 1 FROM sale WHERE table_id = $1 AND status = 'open' AND outlet_id = $2`, [ev.tableId, p.outletId]);
  if (busy.rowCount) flags.push('table_shared');

  await c.query(
    `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, device_id, created_by, table_id, order_root_id, channel, status,
                       device_seq, menu_version, subtotal_paise, tax_paise, round_off_paise, total_paise, created_at_device, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,'counter','open',$9,$10,0,0,0,0,$11,$12)`,
    [ev.saleId, p.tenantId, p.outletId, day.id, ev.businessDate, p.deviceId, ev.createdBy, ev.tableId, e.seq, ev.menuVersion, ev.createdAtDevice, flags]);
}

interface Visit { rootId: string; rootStatus: string }

/**
 * The visit an event names (by its root or by a split), with the root locked. Not here yet: wait, unless its opening was
 * turned away. Any device of the sale's outlet may send order events (D18); another outlet's may not.
 */
async function visitOf(c: pg.PoolClient, p: DevicePrincipal, saleId: string): Promise<Visit> {
  const t = (await c.query('SELECT outlet_id, order_root_id FROM sale WHERE id = $1', [saleId])).rows[0];
  if (!t) {
    const refused = await c.query(`SELECT 1 FROM sync_event WHERE entity_id = $1 AND type = 'order.opened' AND outcome = 'rejected'`, [saleId]);
    if (refused.rowCount) throw new Reject('sale_rejected');
    throw new Defer();
  }
  if (!t.order_root_id) throw new Reject('not_an_order');
  if (t.outlet_id !== p.outletId) throw new Reject('wrong_outlet');
  const root = (await c.query('SELECT status FROM sale WHERE id = $1 FOR UPDATE', [t.order_root_id])).rows[0];
  return { rootId: t.order_root_id, rootStatus: root.status };
}

/** Every applied order event of the visit, renamed to the root so they fold as one order. */
async function visitEvents(c: pg.PoolClient, rootId: string): Promise<OrderEnvelope[]> {
  const r = await c.query(
    `SELECT device_id, seq::text AS seq, payload FROM sync_event
      WHERE entity_id IN (SELECT id FROM sale WHERE order_root_id = $1) AND outcome = 'applied' AND type LIKE 'order.%'`, [rootId]);
  return r.rows.map((x) => ({ deviceId: x.device_id, seq: Number(x.seq), payload: { ...OrderEvent.parse(x.payload), saleId: rootId } }));
}

async function closedLines(c: pg.PoolClient, rootId: string): Promise<(ClosedLine & { status: string })[]> {
  const r = await c.query(
    `SELECT l.line_id AS "lineId", l.qty, l.removed_at IS NOT NULL AS removed, s.status
       FROM sale_line l JOIN sale s ON s.id = l.sale_id WHERE s.order_root_id = $1 AND s.status <> 'open'`, [rootId]);
  return r.rows;
}

/** A line whose add was turned away will never arrive: an event that needs it is refused rather than left waiting forever. */
async function lineRefused(c: pg.PoolClient, rootId: string, lineId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM sync_event WHERE entity_id IN (SELECT id FROM sale WHERE order_root_id = $1)
        AND type = 'order.line_added' AND outcome = 'rejected' AND payload->>'lineId' = $2`, [rootId, lineId]);
  return !!r.rowCount;
}

const appendFlags = `flags || ARRAY(SELECT unnest($2::text[]) EXCEPT SELECT unnest(flags))`;

/**
 * Rewrites the visit's one open sale to hold exactly `openLines(fold, closed)`, with money from the same totals() the
 * tablet uses. No open sale and something to hold: a split is created on the order's table, flagged `late_lines`.
 */
async function writeOpen(c: pg.PoolClient, p: DevicePrincipal, rootId: string, fold: OrderFold, s: TradingSettings, flags: string[]): Promise<void> {
  const lines = openLines(fold, await closedLines(c, rootId));
  let openId = (await c.query(`SELECT id FROM sale WHERE order_root_id = $1 AND status = 'open'`, [rootId])).rows[0]?.id as string | undefined;
  if (!openId) {
    if (!lines.length) return;
    openId = crypto.randomUUID();
    await c.query(
      `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, device_id, created_by, table_id, order_root_id, channel, status,
                         menu_version, subtotal_paise, tax_paise, round_off_paise, total_paise, created_at_device, flags)
       SELECT $1, tenant_id, outlet_id, business_day_id, business_date, device_id, created_by, $3, id, 'counter', 'open',
              menu_version, 0, 0, 0, 0, created_at_device, ARRAY['late_lines'] FROM sale WHERE id = $2`,
      [openId, rootId, fold.tableId]);
    await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'order.split', entity: 'sale', entityId: openId,
      detail: { root: rootId, lines: lines.map((l) => ({ lineId: l.lineId, qty: l.qty })) } });
  }

  await c.query('DELETE FROM sale_line WHERE sale_id = $1 AND NOT (line_id = ANY($2::uuid[]))', [openId, lines.map((l) => l.lineId)]);
  for (const l of lines) {
    const a = exclusiveLine(l.unitPaise, l.qty, l.gstRateBp, s.gstRounding);
    await c.query(
      `INSERT INTO sale_line (tenant_id, sale_id, line_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise,
                              added_by, added_at, removed_by, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (sale_id, line_id) DO UPDATE SET qty = EXCLUDED.qty, line_total_paise = EXCLUDED.line_total_paise, tax_paise = EXCLUDED.tax_paise,
              removed_by = EXCLUDED.removed_by, removed_at = EXCLUDED.removed_at
        WHERE (sale_line.qty, sale_line.tax_paise, sale_line.removed_by, sale_line.removed_at)
              IS DISTINCT FROM (EXCLUDED.qty, EXCLUDED.tax_paise, EXCLUDED.removed_by, EXCLUDED.removed_at)`,
      [p.tenantId, openId, l.lineId, l.itemId, l.name, l.unitPaise, l.gstRateBp, l.qty, a.net, a.tax, l.addedBy, l.addedAt, l.removedBy, l.removedAt]);
  }
  const t = orderTotals({ ...fold, lines }, s);
  await c.query(
    `UPDATE sale SET subtotal_paise = $3, tax_paise = $4, round_off_paise = $5, total_paise = $6, table_id = $7, flags = ${appendFlags} WHERE id = $1`,
    [openId, flags, t.subtotal, t.tax, t.roundOff, t.total, fold.tableId]);
}

/** `order.line_added`, `order.line_changed`, `order.line_removed`, `order.moved`. */
export async function applyOrderChange(c: pg.PoolClient, p: DevicePrincipal, e: Envelope, ev: LineEvent, s: TradingSettings): Promise<void> {
  const v = await visitOf(c, p, ev.saleId);
  if (v.rootStatus === 'void') throw new Reject('sale_void');
  if (!(await worksHere(c, p.outletId, ev.by))) throw new Reject('unknown_user');

  const flags: string[] = [];
  if (Date.parse(ev.at) > Date.now() + SKEW_MS) flags.push('clock_ahead');
  if (ev.type === 'order.line_added') {
    const item = (await c.query(
      `SELECT i.deleted_at IS NOT NULL OR COALESCE(NOT oi.available, false) AS unavailable
         FROM item i LEFT JOIN outlet_item oi ON oi.item_id = i.id AND oi.outlet_id = $2 WHERE i.id = $1`, [ev.itemId, p.outletId])).rows[0];
    if (!item) throw new Reject('unknown_item');
    if (item.unavailable) flags.push('sold_unavailable'); // accepted: the food may already be on the table
    if (ev.qty > s.maxLineQty) flags.push('over_qty_cap');
  }
  if (ev.type === 'order.moved') {
    await checkTable(c, p.outletId, ev.tableId);
    if (!(await c.query(`SELECT 1 FROM sale WHERE order_root_id = $1 AND status = 'open'`, [v.rootId])).rowCount) throw new Reject('not_open');
  }

  const fold = foldOrder(v.rootId, [...(await visitEvents(c, v.rootId)), { deviceId: p.deviceId, seq: e.seq, payload: { ...ev, saleId: v.rootId } }]);
  if (ev.type === 'order.line_added') {
    // Two different lines under one id: keep the first, refuse the second (the fold would otherwise pick by clock).
    if (fold.anomalies.some((a) => a.kind === 'line_conflict' && a.lineId === ev.lineId)) throw new Reject('line_conflict');
  } else if (ev.type !== 'order.moved') {
    if (!fold.lines.some((l) => l.lineId === ev.lineId)) {
      if (await lineRefused(c, v.rootId, ev.lineId)) throw new Reject('line_rejected');
      throw new Defer('line_not_yet_received');
    }
    const settled = (await closedLines(c, v.rootId)).filter((r) => r.lineId === ev.lineId);
    if (settled.some((r) => r.status === 'paid' || r.status === 'refunded')) throw new Reject('already_paid');
    if (settled.length) throw new Reject('sale_void');
  }
  await writeOpen(c, p, v.rootId, fold, s, flags);
}

/** Locks the root of an order sale before the sale itself, so a payment and a line event never wait on each other in turn. */
export async function lockVisit(c: pg.PoolClient, rootId: string): Promise<void> {
  await c.query('SELECT 1 FROM sale WHERE id = $1 FOR UPDATE', [rootId]);
}

const variants = (s: TradingSettings): TradingSettings[] =>
  [s, ...MODES.flatMap((m) => STEPS.map((b) => ({ ...s, gstRounding: m, billRoundTo: b })))];

const toFolded = (r: Record<string, any>): FoldedLine => ({
  lineId: r.line_id, itemId: r.item_id, name: r.name_snapshot, unitPaise: paise(Number(r.unit_price_paise)), gstRateBp: r.gst_rate_bp,
  qty: r.qty, addedBy: r.added_by, addedAt: r.added_at?.toISOString?.() ?? r.added_at,
  removedBy: r.removed_by, removedAt: r.removed_at ? (r.removed_at.toISOString?.() ?? r.removed_at) : null,
});

/**
 * A v2 payment against the open sale it names: the payment wins (docs/phase12-plan.md). The sale's lines become exactly the
 * paid lines at the paid quantities (a line another device removed or lowered first is paid as listed, and audited); lines
 * the payment did not cover leave this sale, and `settleVisit` puts them on a split. Returns the flags for the sale.
 */
export async function payOrder(c: pg.PoolClient, p: DevicePrincipal, saleId: string, rootId: string, ev: PaymentV2, s: TradingSettings): Promise<string[]> {
  const rows = (await c.query(
    `SELECT line_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, added_by, added_at, removed_by, removed_at
       FROM sale_line WHERE sale_id = $1`, [saleId])).rows;
  const view: OrderFold = { saleId, opened: null, tableId: null, lines: rows.map(toFolded), anomalies: [] };

  const tries = variants(s);
  let check = checkPayment(view, ev.lines, ev.totalPaise, tries[0]);
  if (check.kind === 'defer') {
    // Not on this sale. Settled on another sale of the visit, or turned away: never payable here. Otherwise not arrived yet.
    const fold = foldOrder(rootId, await visitEvents(c, rootId));
    for (const id of check.missing) {
      if (fold.lines.some((l) => l.lineId === id)) throw new Reject('line_not_on_sale');
      if (await lineRefused(c, rootId, id)) throw new Reject('line_rejected');
    }
    throw new Defer('line_not_yet_received');
  }
  // The tablet may have totalled under settings the manager has since changed: accept any consistent rounding, and flag it.
  let used = 0;
  for (let i = 1; check.kind === 'mismatch' && i < tries.length; i++) {
    const next = checkPayment(view, ev.lines, ev.totalPaise, tries[i]);
    if (next.kind === 'ok') { check = next; used = i; }
  }
  if (check.kind !== 'ok') throw new Reject('payment_total_mismatch');

  for (const [i, l] of check.paid.entries()) {
    const a = check.totals.lines[i]!;
    await c.query(
      `UPDATE sale_line SET qty = $3, line_total_paise = $4, tax_paise = $5, removed_by = NULL, removed_at = NULL WHERE sale_id = $1 AND line_id = $2`,
      [saleId, l.lineId, l.qty, a.net, a.tax]);
  }
  // Live lines the payment did not name leave this sale (removed ones stay, as the history of what was taken off).
  await c.query('DELETE FROM sale_line WHERE sale_id = $1 AND removed_at IS NULL AND NOT (line_id = ANY($2::uuid[]))', [saleId, check.paid.map((l) => l.lineId)]);
  await c.query('UPDATE sale SET subtotal_paise = $2, tax_paise = $3, round_off_paise = $4, total_paise = $5 WHERE id = $1',
    [saleId, check.totals.subtotal, check.totals.tax, check.totals.roundOff, check.totals.total]);

  for (const o of check.overridden) {
    await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'order.payment_overrode', entity: 'sale', entityId: saleId,
      detail: { lineId: o.lineId, kind: o.kind, foldQty: o.foldQty, paidQty: ev.lines.find((l) => l.lineId === o.lineId)!.qty } });
  }
  const flags: string[] = [];
  if (used !== 0) flags.push('settings_differ');
  if (check.overridden.length) flags.push('payment_overrode');
  return flags;
}

/** After a payment: whatever the visit holds that no closed sale took goes on its open sale (a new `late_lines` split). */
export async function settleVisit(c: pg.PoolClient, p: DevicePrincipal, rootId: string, s: TradingSettings): Promise<void> {
  await writeOpen(c, p, rootId, foldOrder(rootId, await visitEvents(c, rootId)), s, []);
}
