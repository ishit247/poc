// Day close (PLAN 14): a manager, online, per outlet. The preview and the close share one computation,
// so what the manager saw is what gets frozen.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { expectedCash } from '@pos/shared';
import { audit } from '../audit.js';

const params = z.object({ id: z.string().uuid() });
const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
// A tablet that is off or lost can hold the close up for ever; the manager may knowingly step over it.
const closeBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acknowledgedDeviceIds: z.array(z.string().uuid()).max(50).default([]),
}).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

interface Blockers {
  openShifts: { id: string; cashier: string; deviceId: string; openedAt: string }[];
  openSales: number;
  devices: { id: string; label: string | null; counter: string; lastSeenAt: string | null; outboxPending: number | null; blocking: boolean }[];
}

async function blockers(c: pg.PoolClient, outletId: string, date: string): Promise<Blockers> {
  const shifts = await c.query(
    `SELECT s.id, u.name AS cashier, s.device_id AS "deviceId", s.opened_at AS "openedAt"
       FROM shift s JOIN app_user u ON u.id = s.user_id
      WHERE s.outlet_id = $1 AND s.closed_at IS NULL ORDER BY s.opened_at`, [outletId]);
  const open = await c.query(`SELECT count(*)::int AS n FROM sale WHERE outlet_id = $1 AND status = 'open' AND business_date <= $2`, [outletId, date]);
  const devices = await c.query(
    `SELECT d.id, d.label, c.code AS counter, d.last_seen_at AS "lastSeenAt", d.outbox_pending AS "outboxPending",
            COALESCE(d.outbox_pending, 0) > 0 AS blocking
       FROM device d JOIN counter c ON c.id = d.counter_id
      WHERE d.outlet_id = $1 AND d.revoked_at IS NULL ORDER BY c.code, d.enrolled_at`, [outletId]);
  return { openShifts: shifts.rows, openSales: open.rows[0].n, devices: devices.rows };
}

async function totals(c: pg.PoolClient, outletId: string, dayId: string, date: string) {
  const sales = await c.query(
    `SELECT count(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(sum(total_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS gross,
            COALESCE(sum(tax_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS tax,
            count(*) FILTER (WHERE status = 'void')::int AS voids,
            COALESCE(sum(total_paise) FILTER (WHERE status = 'void'), 0)::bigint AS "voidTotal",
            count(*) FILTER (WHERE status = 'refunded')::int AS refunds,
            COALESCE(sum(total_paise) FILTER (WHERE status = 'refunded'), 0)::bigint AS "refundTotal"
       FROM sale WHERE business_day_id = $1`, [dayId]);
  const pay = await c.query(
    `SELECT p.method, COALESCE(sum(p.amount_paise), 0)::bigint AS amount
       FROM payment p JOIN sale s ON s.id = p.sale_id
      WHERE s.business_day_id = $1 AND s.status IN ('paid', 'refunded') GROUP BY p.method`, [dayId]);
  const by = Object.fromEntries(pay.rows.map((r) => [r.method, Number(r.amount)]));
  // A shift belongs to the day it was opened on, in the outlet's own timezone.
  const shifts = await c.query(
    `SELECT s.id, u.name AS cashier, ct.code AS counter, s.opening_cash_paise AS "float", s.counted_cash_paise AS counted,
            s.expected_cash_paise AS expected, s.variance_paise AS variance
       FROM shift s JOIN app_user u ON u.id = s.user_id JOIN device d ON d.id = s.device_id JOIN counter ct ON ct.id = d.counter_id
       JOIN outlet o ON o.id = s.outlet_id
      WHERE s.outlet_id = $1 AND (s.opened_at AT TIME ZONE o.timezone)::date = $2 AND s.closed_at IS NOT NULL
      ORDER BY ct.code, s.opened_at`, [outletId, date]);
  const s = sales.rows[0];
  return {
    paidSales: s.paid, grossPaise: Number(s.gross), taxPaise: Number(s.tax),
    cashPaise: by.cash ?? 0, upiPaise: by.upi ?? 0, onlineGrossPaise: by.aggregator ?? 0,
    voids: s.voids, voidTotalPaise: Number(s.voidTotal), refunds: s.refunds, refundTotalPaise: Number(s.refundTotal),
    shifts: shifts.rows.map((r) => ({ ...r, float: Number(r.float), counted: Number(r.counted), expected: Number(r.expected), variance: Number(r.variance) })),
    varianceTotalPaise: shifts.rows.reduce((a, r) => a + Number(r.variance), 0),
  };
}

/**
 * Receipt numbers run 1..k per device per day (PLAN 7.7), so a hole means a sale the server never accepted:
 * a rejected event, or one still on a tablet. Shown to the manager; it does not block the close.
 */
async function receiptGaps(c: pg.PoolClient, outletId: string, date: string) {
  const r = await c.query(
    `SELECT g.device_id AS "deviceId", ct.code AS counter, array_agg(n ORDER BY n) AS missing
       FROM (SELECT device_id, max(receipt_seq) AS top, array_agg(receipt_seq) AS have
               FROM sale WHERE outlet_id = $1 AND business_date = $2 AND receipt_seq IS NOT NULL GROUP BY device_id) g
       JOIN device d ON d.id = g.device_id JOIN counter ct ON ct.id = d.counter_id
       CROSS JOIN LATERAL generate_series(1, g.top) n
      WHERE NOT n = ANY(g.have) GROUP BY g.device_id, ct.code ORDER BY ct.code`, [outletId, date]);
  return r.rows as { deviceId: string; counter: string; missing: number[] }[];
}

/**
 * Sales of earlier days whose records reached the server after that day's close and before this one: each is surfaced once.
 * A counter sale arrives as a sync event; an online sale is made by an API call, so its arrival is its handover.
 */
async function lateAdjustments(c: pg.PoolClient, outletId: string, date: string) {
  const prev = await c.query(
    `SELECT max(closed_at) AS at FROM business_day WHERE outlet_id = $1 AND date < $2 AND closed_at IS NOT NULL`, [outletId, date]);
  const since = prev.rows[0].at as Date | null;
  if (!since) return [];
  const r = await c.query(
    `SELECT s.id, s.business_date::text AS "businessDate", s.receipt_no AS "receiptNo", s.status, s.total_paise::bigint AS "totalPaise"
       FROM sale s
      WHERE s.outlet_id = $1 AND s.business_date < $2 AND 'late_arrival' = ANY(s.flags)
        AND (EXISTS (SELECT 1 FROM sync_event e WHERE e.entity_id = s.id AND e.type IN ('sale.created', 'payment.taken') AND e.received_at > $3)
             OR EXISTS (SELECT 1 FROM online_order o WHERE o.sale_id = s.id AND o.status = 'handed_over' AND o.status_at > $3))
      ORDER BY s.business_date, s.receipt_seq`, [outletId, date, since]);
  return r.rows.map((x) => ({ ...x, totalPaise: Number(x.totalPaise) }));
}

async function today(c: pg.PoolClient, outletId: string): Promise<string> {
  return (await c.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM outlet WHERE id = $1`, [outletId])).rows[0].d;
}

export const dayCloseRoutes: FastifyPluginAsync = async (app) => {
  // Scope: a manager closes only outlets assigned to them. Checked before any query.
  const cfg = { scope: 'outlet', permission: 'manager' } as const;

  app.get('/outlets/:id/day-close', { config: cfg }, async (req, reply) => {
    const ps = params.safeParse(req.params);
    const q = query.safeParse(req.query);
    if (!ps.success || !q.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      const day = (await c.query(
        'SELECT id, closed_at AS "closedAt", totals FROM business_day WHERE outlet_id = $1 AND date = $2', [ps.data.id, q.data.date])).rows[0];
      if (day?.closedAt) return { date: q.data.date, closed: true, closedAt: day.closedAt, totals: day.totals, lateAdjustments: [] };
      const b = await blockers(c, ps.data.id, q.data.date);
      return {
        date: q.data.date, closed: false, provisional: q.data.date >= (await today(c, ps.data.id)),
        blockers: b,
        // Preview only: nothing is written until the manager closes.
        totals: day ? await totals(c, ps.data.id, day.id, q.data.date) : null,
        lateAdjustments: await lateAdjustments(c, ps.data.id, q.data.date),
        receiptGaps: await receiptGaps(c, ps.data.id, q.data.date),
      };
    });
  });

  // A drawer nobody can close (lost tablet, cashier gone home) would hold the day open for ever.
  // The manager counts the cash and closes it for them; the variance is worked out as for any shift.
  app.post('/outlets/:id/shifts/:shiftId/force-close', { config: cfg }, async (req, reply) => {
    const ps = z.object({ id: z.string().uuid(), shiftId: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ countedCashPaise: z.number().int().min(0).max(100_000_000) }).strict().safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      // Lock the row so a tablet's own close, arriving at the same moment, cannot also win.
      const s = (await c.query('SELECT opening_cash_paise::int AS opening, closed_at FROM shift WHERE id = $1 AND outlet_id = $2 FOR UPDATE', [ps.data.shiftId, ps.data.id])).rows[0];
      if (!s) return notFound(reply);
      if (s.closed_at) return reply.code(409).send({ error: 'already closed' });
      const pays = await c.query(
        `SELECT pay.method, pay.amount_paise::int AS "amountPaise" FROM payment pay JOIN sale sl ON sl.id = pay.sale_id WHERE sl.shift_id = $1`, [ps.data.shiftId]);
      const expected = expectedCash(s.opening, pays.rows);
      const counted = b.data.countedCashPaise;
      await c.query(
        `UPDATE shift SET closed_at = now(), closed_by = $2, counted_cash_paise = $3::bigint, expected_cash_paise = $4::bigint, variance_paise = $3::bigint - $4::bigint WHERE id = $1`,
        [ps.data.shiftId, p.userId, counted, expected]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'shift.force_close', entity: 'shift', entityId: ps.data.shiftId,
        detail: { outletId: ps.data.id, countedCashPaise: counted, expectedCashPaise: expected, variancePaise: counted - expected } });
      return { ok: true, expectedCashPaise: expected, variancePaise: counted - expected };
    });
  });

  app.post('/outlets/:id/day-close', { config: cfg }, async (req, reply) => {
    const ps = params.safeParse(req.params);
    const b = closeBody.safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    const { date, acknowledgedDeviceIds } = b.data;

    return withTenant(p.tenantId, async (c) => {
      if (date > (await today(c, ps.data.id))) return reply.code(400).send({ error: 'that day has not started' });
      // The row lock orders this against ingest: a sale being written for this day either lands first
      // (and is counted) or waits and finds the day closed (and is flagged late_arrival).
      const day = (await c.query(
        `INSERT INTO business_day (tenant_id, outlet_id, date) VALUES ($1, $2, $3)
         ON CONFLICT (outlet_id, date) DO UPDATE SET date = EXCLUDED.date RETURNING id, closed_at`, [p.tenantId, ps.data.id, date])).rows[0];
      if (day.closed_at) return reply.code(409).send({ error: 'already closed' });

      const bl = await blockers(c, ps.data.id, date);
      const unacked = bl.devices.filter((d) => d.blocking && !acknowledgedDeviceIds.includes(d.id));
      if (bl.openShifts.length || bl.openSales || unacked.length) {
        return reply.code(409).send({ error: 'cannot close', blockers: { ...bl, devices: bl.devices.map((d) => ({ ...d, blocking: unacked.some((u) => u.id === d.id) })) } });
      }

      const frozen = { ...(await totals(c, ps.data.id, day.id, date)), lateAdjustments: await lateAdjustments(c, ps.data.id, date), receiptGaps: await receiptGaps(c, ps.data.id, date) };
      await c.query('UPDATE business_day SET closed_at = now(), closed_by = $2, totals = $3 WHERE id = $1 AND closed_at IS NULL',
        [day.id, p.userId, JSON.stringify(frozen)]);
      const skipped = bl.devices.filter((d) => d.blocking && acknowledgedDeviceIds.includes(d.id)).map((d) => ({ id: d.id, outboxPending: d.outboxPending }));
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'day.close', entity: 'business_day', entityId: day.id,
        detail: { outletId: ps.data.id, date, grossPaise: frozen.grossPaise, acknowledgedDevices: skipped } });
      return { ok: true, date, totals: frozen };
    });
  });
};
