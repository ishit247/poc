// Ingest: one device event at a time, each in its own transaction, idempotent on the event id.
//
// Outcomes the tablet understands:
//   applied    - done; the tablet may drop it from its outbox
//   duplicate  - seen before (a retry after a lost response); same as applied
//   rejected   - will never be accepted as sent; the tablet parks it for a human (a reason is given)
//   deferred   - cannot be judged yet (its sale, or an order line it names, has not arrived); keep it and retry
//
// Facts are never rewritten and a real sale is not thrown away over policy: a sale whose arithmetic is
// internally consistent is accepted even if the manager changed a setting while the tablet was offline;
// the difference is recorded in `sale.flags`. Only a sale that cannot be true (lines that do not add up,
// an unknown person or item) is rejected.
import type pg from 'pg';
import {
  OutboxEvent, exclusiveLine, expectedCash, paise, roundOffFor,
  type GstRounding, type OrderVoided, type PaymentTaken, type PrintReprinted, type SaleCreated, type SaleVoided, type ShiftClosed, type ShiftOpened, type TradingSettings,
} from '@pos/shared';
import { audit } from './audit.js';
import { withTenant } from './db.js';
import { applyOrderChange, applyOrderOpened, lockVisit, payOrder, settleVisit } from './order-ingest.js';
import { Defer, Reject, RejectUnrecorded } from './sync-outcome.js';

export interface Envelope { eventId: string; seq: number; createdAt: string; payload: unknown }
export type Status = 'applied' | 'duplicate' | 'rejected' | 'deferred';
export interface Result { eventId: string; status: Status; reason?: string }
export interface DevicePrincipal { tenantId: string; deviceId: string; outletId: string; counterId: string; revokedAt: Date | null }

const SKEW_MS = 5 * 60_000;
const MODES: GstRounding[] = ['half_up', 'up', 'down'];

// Event versions this server ingests, per type (PLAN 7.8, N-1). An event's version is the version of its own shape.
const KNOWN: Record<string, readonly number[]> = {
  'sale.created': [1], 'payment.taken': [1, 2], 'print.reprinted': [1], 'shift.opened': [1], 'shift.closed': [1], 'sale.voided': [1],
  'order.opened': [2], 'order.line_added': [2], 'order.line_changed': [2], 'order.line_removed': [2], 'order.moved': [2],
  'order.voided': [2],
};

export async function ingest(p: DevicePrincipal, e: Envelope, settings: TradingSettings): Promise<Result> {
  try {
    return await withTenant(p.tenantId, (c) => decide(c, p, e, settings));
  } catch (err) {
    if (err instanceof Defer) return { eventId: e.eventId, status: 'deferred', reason: err.reason };
    if (err instanceof RejectUnrecorded) return { eventId: e.eventId, status: 'rejected', reason: err.reason };
    throw err;
  }
}

async function decide(c: pg.PoolClient, p: DevicePrincipal, e: Envelope, settings: TradingSettings): Promise<Result> {
  // One event of a device at a time: two pushes of the same batch cannot both pass the ledger check.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [p.deviceId]);

  const seen = (await c.query('SELECT device_id, outcome, reason FROM sync_event WHERE id = $1', [e.eventId])).rows[0];
  if (seen) {
    if (seen.device_id !== p.deviceId) return { eventId: e.eventId, status: 'rejected', reason: 'event_id_conflict' };
    return seen.outcome === 'applied' ? { eventId: e.eventId, status: 'duplicate' } : { eventId: e.eventId, status: 'rejected', reason: seen.reason };
  }
  if ((await c.query('SELECT 1 FROM sync_event WHERE device_id = $1 AND seq = $2', [p.deviceId, e.seq])).rowCount) {
    throw new RejectUnrecorded('seq_reused');
  }

  const head = e.payload as { type?: unknown; schemaVersion?: unknown } | null;
  const type = typeof head?.type === 'string' ? head.type : '';
  if (!Object.hasOwn(KNOWN, type)) throw new RejectUnrecorded('unknown_event_type');
  const version = head?.schemaVersion;
  if (typeof version !== 'number' || !KNOWN[type]!.includes(version)) throw new RejectUnrecorded('unsupported_schema_version');

  let reason: string | null = null;
  const parsed = OutboxEvent.safeParse(e.payload);
  await c.query('SAVEPOINT ev');
  try {
    if (!parsed.success) throw new Reject('invalid_payload');
    // A revoked tablet may deliver what it did BEFORE revocation, by its own clock; nothing after.
    if (p.revokedAt && new Date(e.createdAt) > p.revokedAt) throw new Reject('after_revocation');
    const ev = parsed.data;
    if (ev.type === 'sale.created') await applySale(c, p, e, ev, settings);
    else if (ev.type === 'payment.taken') await applyPayment(c, p, ev, settings);
    else if (ev.type === 'shift.opened') await applyShiftOpened(c, p, ev);
    else if (ev.type === 'shift.closed') await applyShiftClosed(c, p, ev);
    else if (ev.type === 'sale.voided') await applyVoid(c, p, ev);
    else if (ev.type === 'order.voided') await applyOrderVoid(c, p, ev);
    else if (ev.type === 'print.reprinted') await applyReprint(c, p, ev);
    else if (ev.type === 'order.opened') await applyOrderOpened(c, p, e, ev, (d) => businessDay(c, p, d));
    else await applyOrderChange(c, p, e, ev, settings);
    await c.query('RELEASE SAVEPOINT ev');
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT ev');
    if (err instanceof Defer) throw err;
    if (err instanceof Reject) reason = err.reason;
    // A constraint the database enforces (class 22 data, 23 integrity) is a rejection, not a server fault.
    else if (typeof (err as { code?: unknown }).code === 'string' && /^2[23]/.test((err as { code: string }).code)) {
      reason = `database:${(err as { constraint?: string }).constraint ?? (err as { code: string }).code}`;
    } else throw err;
  }

  const entityId = !parsed.success ? null : 'saleId' in parsed.data ? parsed.data.saleId : parsed.data.shiftId;
  await c.query(
    `INSERT INTO sync_event (tenant_id, id, device_id, seq, type, entity_id, schema_version, created_at_device, outcome, reason, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [p.tenantId, e.eventId, p.deviceId, e.seq, type, entityId, version, e.createdAt, reason ? 'rejected' : 'applied', reason, JSON.stringify(e.payload)]);

  if (reason) {
    await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'sync.rejected', entity: 'sync_event', entityId: e.eventId, detail: { type, reason } });
    return { eventId: e.eventId, status: 'rejected', reason };
  }
  if (p.revokedAt) {
    await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'sync.from_revoked_device', entity: 'sync_event', entityId: e.eventId, detail: { type } });
  }
  return { eventId: e.eventId, status: 'applied' };
}

async function businessDay(c: pg.PoolClient, p: DevicePrincipal, date: string): Promise<{ id: string; closed: boolean }> {
  const r = await c.query(
    `INSERT INTO business_day (tenant_id, outlet_id, date) VALUES ($1, $2, $3)
     ON CONFLICT (outlet_id, date) DO UPDATE SET date = EXCLUDED.date RETURNING id, closed_at IS NOT NULL AS closed`,
    [p.tenantId, p.outletId, date]);
  return r.rows[0];
}

/** Lines must add up on their own terms. Which settings were in force is NOT judged here (see flags). */
function checkArithmetic(ev: SaleCreated): void {
  let net = 0;
  let tax = 0;
  for (const l of ev.lines) {
    if (l.netPaise !== l.unitPaise * l.qty) throw new Reject('line_net_mismatch');
    const taxes = MODES.map((m) => exclusiveLine(paise(l.unitPaise), l.qty, l.gstRateBp, m).tax as number);
    if (!taxes.includes(l.taxPaise)) throw new Reject('line_tax_mismatch');
    net += l.netPaise;
    tax += l.taxPaise;
  }
  if (net !== ev.subtotalPaise) throw new Reject('subtotal_mismatch');
  if (tax !== ev.taxPaise) throw new Reject('tax_mismatch');
  if (Math.abs(ev.roundOffPaise) > 50) throw new Reject('round_off_too_large'); // the largest step is 100, nearest
}

function policyFlags(ev: SaleCreated, s: TradingSettings): string[] {
  const flags: string[] = [];
  if (ev.lines.some((l) => l.qty > s.maxLineQty)) flags.push('over_qty_cap');
  const lines = ev.lines.map((l) => exclusiveLine(paise(l.unitPaise), l.qty, l.gstRateBp, s.gstRounding));
  const tax = lines.reduce((a, l) => a + l.tax, 0);
  const net = lines.reduce((a, l) => a + l.net, 0);
  if (tax !== ev.taxPaise || roundOffFor(paise(net + tax), s.billRoundTo) !== ev.roundOffPaise) flags.push('settings_differ');
  return flags;
}

async function applySale(c: pg.PoolClient, p: DevicePrincipal, e: Envelope, ev: SaleCreated, s: TradingSettings): Promise<void> {
  if (ev.channel !== 'counter') throw new Reject('channel_not_allowed'); // online orders arrive another way (phase 7)
  checkArithmetic(ev);

  // The person must have worked at this outlet (a later removal does not undo a sale they rang up).
  const who = await c.query(
    `SELECT 1 FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
      WHERE u.id = $1 AND uo.outlet_id = $2 AND u.role IN ('cashier', 'waiter')`, [ev.createdBy, p.outletId]);
  if (!who.rowCount) throw new Reject('unknown_user');

  const ids = [...new Set(ev.lines.map((l) => l.itemId))];
  const items = await c.query(
    `SELECT i.id, i.deleted_at IS NOT NULL OR COALESCE(NOT oi.available, false) AS unavailable
       FROM item i LEFT JOIN outlet_item oi ON oi.item_id = i.id AND oi.outlet_id = $2
      WHERE i.id = ANY($1::uuid[])`, [ids, p.outletId]);
  if (items.rowCount !== ids.length) throw new Reject('unknown_item');

  const flags = policyFlags(ev, s);
  if (items.rows.some((r) => r.unavailable)) flags.push('sold_unavailable'); // accepted: the food was handed over
  if (new Date(ev.createdAtDevice).getTime() > Date.now() + SKEW_MS) flags.push('clock_ahead');
  const day = await businessDay(c, p, ev.businessDate);
  if (day.closed) flags.push('late_arrival');

  await c.query(
    `INSERT INTO sale (id, tenant_id, outlet_id, business_day_id, business_date, device_id, created_by, channel, status,
                       device_seq, menu_version, subtotal_paise, tax_paise, round_off_paise, total_paise, created_at_device, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14,$15,$16)`,
    [ev.saleId, p.tenantId, p.outletId, day.id, ev.businessDate, p.deviceId, ev.createdBy, ev.channel, e.seq, ev.menuVersion,
     ev.subtotalPaise, ev.taxPaise, ev.roundOffPaise, ev.totalPaise, ev.createdAtDevice, flags]);
  for (const l of ev.lines) {
    await c.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.tenantId, ev.saleId, l.itemId, l.name, l.unitPaise, l.gstRateBp, l.qty, l.netPaise, l.taxPaise]);
  }
}

/**
 * The sale an event is about, locked. Not here yet: wait for it, unless it was turned away (then waiting is forever).
 * `as` is who the event needs this device to be:
 * - `pay`: a table order may be paid on any device of its outlet (step 7b; the receipt is from the payer's own series
 *   and the money goes into the payer's shift). A whole sale is paid where it was rung up.
 * - `opener`: the shift-close void (`sale.voided`) stays with the device that holds the order.
 * - `void`: `order.voided` of a table order may come from any device of its outlet (who may void it is judged by
 *   `applyOrderVoid`); a whole sale, as with paying, only from where it was rung up.
 * - `receipt`: a reprint is of the payer's receipt, so on the device that paid.
 */
async function saleOf(c: pg.PoolClient, p: DevicePrincipal, saleId: string, as: 'pay' | 'opener' | 'void' | 'receipt') {
  // A running order's root is locked first, as every order event does (order-ingest.ts), so the two never deadlock.
  const root = (await c.query('SELECT order_root_id FROM sale WHERE id = $1', [saleId])).rows[0]?.order_root_id as string | null | undefined;
  if (root) await lockVisit(c, root);
  const sale = (await c.query(
    'SELECT device_id, outlet_id, paid_device_id, status, total_paise, receipt_no, order_root_id, created_by FROM sale WHERE id = $1 FOR UPDATE', [saleId])).rows[0];
  if (!sale) {
    // An order may have been opened on another device of the outlet (D18), so its refusal is looked up from any device.
    const refused = await c.query(
      `SELECT 1 FROM sync_event WHERE entity_id = $2
          AND ((type = 'sale.created' AND device_id = $1) OR type = 'order.opened') AND outcome = 'rejected'`, [p.deviceId, saleId]);
    if (refused.rowCount) throw new Reject('sale_rejected');
    throw new Defer();
  }
  if ((as === 'pay' || as === 'void') && sale.order_root_id) {
    if (sale.outlet_id !== p.outletId) throw new Reject('wrong_outlet');
  } else if ((as === 'receipt' ? sale.paid_device_id ?? sale.device_id : sale.device_id) !== p.deviceId) {
    throw new Reject('wrong_device');
  }
  return sale as { device_id: string; status: string; total_paise: string; receipt_no: string | null; order_root_id: string | null; created_by: string };
}

/**
 * A cashier or waiter cancels an open table order from any device of its outlet (step 7c). Same rule as the online
 * void (`ORDER_SCOPE`): a cashier any open order here, a waiter only one they opened. A manager voids online; no
 * tablet signs a manager in. The status check is what makes the payment win, in either order of arrival: a void after
 * the payment finds it paid (`not_open`); a payment after the void finds it void (`sale_void`, in `applyPayment`).
 */
async function applyOrderVoid(c: pg.PoolClient, p: DevicePrincipal, ev: OrderVoided): Promise<void> {
  const sale = await saleOf(c, p, ev.saleId, 'void');
  const who = (await c.query(
    `SELECT u.role FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
      WHERE u.id = $1 AND uo.outlet_id = $2 AND u.role IN ('cashier', 'waiter')`, [ev.voidedBy, p.outletId])).rows[0] as { role: string } | undefined;
  if (!who) throw new Reject('unknown_user');
  if (who.role === 'waiter' && sale.created_by !== ev.voidedBy) throw new Reject('not_own_order');
  if (sale.status !== 'open') throw new Reject(sale.status === 'void' ? 'already_void' : 'not_open'); // the payment wins
  await c.query(`UPDATE sale SET status = 'void', void_reason = $2 WHERE id = $1`, [ev.saleId, ev.reason]);
  await audit(c, {
    tenantId: p.tenantId, actorKind: 'user', actorId: ev.voidedBy, action: 'order.voided', entity: 'sale', entityId: ev.saleId,
    detail: { reason: ev.reason, at: ev.at, deviceId: p.deviceId, openedOnDeviceId: sale.device_id, rootId: sale.order_root_id },
  });
}

/** Only a paid sale has a receipt to print again. The audit entry is the trail a manager reads. */
/** Only an unpaid order can be voided by the tablet: if the payment got here first, the sale stands. */
async function applyVoid(c: pg.PoolClient, p: DevicePrincipal, ev: SaleVoided): Promise<void> {
  const sale = await saleOf(c, p, ev.saleId, 'opener');
  if (sale.status !== 'open') throw new Reject(sale.status === 'void' ? 'already_void' : 'not_open');
  await c.query(`UPDATE sale SET status = 'void', void_reason = $2 WHERE id = $1`, [ev.saleId, ev.reason]);
  await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'sale.voided', entity: 'sale', entityId: ev.saleId, detail: { reason: ev.reason, at: ev.at } });
}

async function applyReprint(c: pg.PoolClient, p: DevicePrincipal, ev: PrintReprinted): Promise<void> {
  const sale = await saleOf(c, p, ev.saleId, 'receipt');
  if (sale.status !== 'paid' && sale.status !== 'refunded') throw new Reject('not_paid');
  const who = await c.query(
    `SELECT 1 FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
      WHERE u.id = $1 AND uo.outlet_id = $2 AND u.role IN ('cashier', 'waiter')`, [ev.reprintedBy, p.outletId]);
  if (!who.rowCount) throw new Reject('unknown_user');
  await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: ev.reprintedBy, action: 'sale.reprinted', entity: 'sale', entityId: ev.saleId, detail: { receiptNo: sale.receipt_no, at: ev.at, deviceId: p.deviceId } });
}

/** This device's shift, locked. Not here yet: wait for it, unless its opening was turned away. */
async function shiftOf(c: pg.PoolClient, p: DevicePrincipal, shiftId: string) {
  const shift = (await c.query(
    'SELECT device_id, user_id, closed_at, closed_by, opening_cash_paise::int AS opening FROM shift WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
  if (!shift) {
    const refused = await c.query(
      `SELECT 1 FROM sync_event WHERE device_id = $1 AND entity_id = $2 AND type = 'shift.opened' AND outcome = 'rejected'`, [p.deviceId, shiftId]);
    if (refused.rowCount) throw new Reject('shift_rejected');
    throw new Defer();
  }
  if (shift.device_id !== p.deviceId) throw new Reject('wrong_device');
  return shift as { user_id: string; closed_at: Date | null; closed_by: string | null; opening: number };
}

async function applyShiftOpened(c: pg.PoolClient, p: DevicePrincipal, ev: ShiftOpened): Promise<void> {
  // Only a cashier holds a drawer, and only one drawer is open per tablet at a time.
  const who = await c.query(
    `SELECT 1 FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id WHERE u.id = $1 AND uo.outlet_id = $2 AND u.role = 'cashier'`, [ev.userId, p.outletId]);
  if (!who.rowCount) throw new Reject('unknown_user');
  if ((await c.query('SELECT 1 FROM shift WHERE device_id = $1 AND closed_at IS NULL', [p.deviceId])).rowCount) throw new Reject('shift_already_open');
  await c.query(
    `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ev.shiftId, p.tenantId, p.outletId, p.deviceId, ev.userId, ev.at, ev.openingCashPaise]);
}

/** Expected cash and variance are worked out here, from the payments this server holds, in the same way the tablet's slip does. */
async function applyShiftClosed(c: pg.PoolClient, p: DevicePrincipal, ev: ShiftClosed): Promise<void> {
  const shift = await shiftOf(c, p, ev.shiftId);
  // A manager got there first. The manager's count stands; the cashier's own figure stays in the ledger row of this
  // (rejected) event. The tablet reads this reason as "already dealt with" and learns the outcome from pull.
  if (shift.closed_at) throw new Reject(shift.closed_by ? 'shift_force_closed' : 'shift_already_closed');
  const pays = await c.query(
    `SELECT pay.method, pay.amount_paise::int AS "amountPaise" FROM payment pay JOIN sale s ON s.id = pay.sale_id WHERE s.shift_id = $1`, [ev.shiftId]);
  const expected = expectedCash(shift.opening, pays.rows);
  await c.query(
    `UPDATE shift SET closed_at = $2, counted_cash_paise = $3::bigint, expected_cash_paise = $4::bigint, variance_paise = $3::bigint - $4::bigint WHERE id = $1`,
    [ev.shiftId, ev.at, ev.countedCashPaise, expected]);
}

async function applyPayment(c: pg.PoolClient, p: DevicePrincipal, ev: PaymentTaken, s: TradingSettings): Promise<void> {
  const sale = await saleOf(c, p, ev.saleId, 'pay');
  // A running order is paid line by line (v2); a whole sale by its total (v1). No tablet writes the other pairing.
  if (sale.order_root_id && ev.schemaVersion !== 2) throw new Reject('order_needs_v2_payment');
  if (!sale.order_root_id && ev.schemaVersion === 2) throw new Reject('not_an_order');
  if (sale.status === 'void') throw new Reject('sale_void');
  if (sale.status !== 'open') throw new Reject('already_paid');

  let orderFlags: string[] = [];
  if (ev.schemaVersion === 2) orderFlags = await payOrder(c, p, ev.saleId, sale.order_root_id!, ev, s);
  else if (ev.payments.reduce((a, x) => a + x.amountPaise, 0) !== Number(sale.total_paise)) throw new Reject('payments_not_total');
  const code = (await c.query('SELECT code FROM counter WHERE id = $1', [p.counterId])).rows[0]?.code as string | undefined;
  if (ev.receiptNo !== `${code}-${ev.businessDate.replaceAll('-', '')}-${ev.receiptSeq}`) throw new Reject('bad_receipt_no');

  // Money taken after the drawer was counted still belongs to that shift, but its variance is already
  // fixed: accept it (the cash was taken) and flag the sale so a manager sees it.
  const shift = ev.shiftId ? await shiftOf(c, p, ev.shiftId) : null;
  const afterClose = !!shift?.closed_at;

  const day = await businessDay(c, p, ev.businessDate);
  await c.query(
    `UPDATE sale SET status = 'paid', receipt_no = $2, receipt_seq = $3, business_date = $4, business_day_id = $5, shift_id = $7,
                     paid_device_id = $10,
                     flags = CASE WHEN $6 AND NOT 'late_arrival' = ANY(flags) THEN array_append(flags, 'late_arrival') ELSE flags END
                             || CASE WHEN $8 THEN ARRAY['after_shift_close'] ELSE '{}'::text[] END
                             || $9::text[]
      WHERE id = $1`,
    [ev.saleId, ev.receiptNo, ev.receiptSeq, ev.businessDate, day.id, day.closed, ev.shiftId ?? null, afterClose, orderFlags, p.deviceId]);
  for (const x of ev.payments) {
    await c.query(
      `INSERT INTO payment (tenant_id, sale_id, method, amount_paise, tendered_paise, change_paise, upi_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.tenantId, ev.saleId, x.method, x.amountPaise, x.tenderedPaise, x.changePaise, x.upiRef]);
  }
  // What the payment did not cover is split off onto a new open order on the same table (D18), never lost.
  if (sale.order_root_id) await settleVisit(c, p, sale.order_root_id, s);
}
