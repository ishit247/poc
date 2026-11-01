import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { parseSettlement } from '../settlement.js';

// Settlement import (PLAN 11): a manager uploads a platform's payout statement, we compare it with our orders and
// report. It never edits a sale. Scope: a manager reaches only outlets assigned to them, checked before any query.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const outletParams = z.object({ id: z.string().uuid() });
const importParams = z.object({ id: z.string().uuid(), importId: z.string().uuid() });
const uploadBody = z.object({
  channel: z.enum(['zomato', 'swiggy']),
  filename: z.string().trim().min(1).max(200),
  periodFrom: date,
  periodTo: date,
  csv: z.string().min(1).max(1_500_000),
}).strict();
const MAX_PERIOD_DAYS = 93;

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

async function report(c: pg.PoolClient, outletId: string, importId: string) {
  const imp = (await c.query(
    `SELECT i.id, i.channel, i.filename, i.period_from::text AS "periodFrom", i.period_to::text AS "periodTo",
            i.uploaded_at AS "uploadedAt", u.name AS "uploadedBy"
       FROM settlement_import i JOIN app_user u ON u.id = i.uploaded_by WHERE i.id = $1 AND i.outlet_id = $2`, [importId, outletId])).rows[0];
  if (!imp) return null;
  const lines = (await c.query(
    `SELECT l.external_order_id AS "externalOrderId", l.gross_paise::bigint AS "grossPaise", l.payout_paise::bigint AS "payoutPaise",
            l.result, s.total_paise::bigint AS "ourPaise", o.status AS "orderStatus"
       FROM settlement_line l
       LEFT JOIN online_order o ON o.id = l.online_order_id LEFT JOIN sale s ON s.id = o.sale_id
      WHERE l.import_id = $1 ORDER BY l.result = 'matched', l.external_order_id`, [importId])).rows;
  // Missing: orders we handed over inside the period that the statement does not mention.
  const missing = (await c.query(
    `SELECT o.external_order_id AS "externalOrderId", s.total_paise::bigint AS "ourPaise", s.business_date::text AS "businessDate"
       FROM online_order o JOIN sale s ON s.id = o.sale_id
      WHERE o.outlet_id = $1 AND o.channel = $2 AND o.status = 'handed_over' AND s.business_date BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM settlement_line l WHERE l.import_id = $5 AND l.external_order_id = o.external_order_id)
      ORDER BY s.business_date, o.external_order_id`, [outletId, imp.channel, imp.periodFrom, imp.periodTo, importId])).rows;
  // bigint columns arrive as strings; amounts stay well inside Number's exact range.
  const L = lines.map((x) => ({ ...x, grossPaise: Number(x.grossPaise), payoutPaise: Number(x.payoutPaise), ourPaise: x.ourPaise == null ? null : Number(x.ourPaise) }));
  const M = missing.map((x) => ({ ...x, ourPaise: Number(x.ourPaise) }));
  const sum = (k: string, rows: Record<string, unknown>[]) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return {
    ...imp, lines: L, missing: M,
    summary: {
      lines: L.length,
      matched: L.filter((x) => x.result === 'matched').length,
      amountMismatch: L.filter((x) => x.result === 'amount_mismatch').length,
      unknownOrder: L.filter((x) => x.result === 'unknown_order').length,
      // Paid by the platform but we did not deliver it (rejected, expired, cancelled, or still open).
      notDelivered: L.filter((x) => x.orderStatus && x.orderStatus !== 'handed_over').length,
      missing: M.length,
      grossPaise: sum('grossPaise', L), payoutPaise: sum('payoutPaise', L), commissionPaise: sum('grossPaise', L) - sum('payoutPaise', L),
      missingPaise: sum('ourPaise', M),
    },
  };
}

export const settlementRoutes: FastifyPluginAsync = async (app) => {
  const cfg = { scope: 'outlet', permission: 'manager' } as const;

  app.post('/outlets/:id/settlement-imports', { config: cfg, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = uploadBody.safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    const { channel, filename, periodFrom, periodTo, csv } = b.data;
    if (Number.isNaN(Date.parse(periodFrom)) || Number.isNaN(Date.parse(periodTo)) || periodTo < periodFrom || days(periodFrom, periodTo) > MAX_PERIOD_DAYS) {
      return reply.code(400).send({ error: 'invalid period' });
    }
    const parsed = parseSettlement(csv);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid file', errors: parsed.errors.slice(0, 20), moreErrors: Math.max(0, parsed.errors.length - 20) });

    return withTenant(p.tenantId, async (c) => {
      const imp = (await c.query(
        `INSERT INTO settlement_import (tenant_id, outlet_id, channel, filename, period_from, period_to, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [p.tenantId, ps.data.id, channel, filename, periodFrom, periodTo, p.userId])).rows[0];
      const ids = parsed.lines.map((l) => l.externalOrderId);
      // Only this outlet's orders on this platform can match; anything else is "unknown" to this outlet.
      const ours = new Map<string, { id: string; total: number }>((await c.query(
        `SELECT o.external_order_id, o.id, s.total_paise::bigint AS total FROM online_order o JOIN sale s ON s.id = o.sale_id
          WHERE o.outlet_id = $1 AND o.channel = $2 AND o.external_order_id = ANY($3::text[])`, [ps.data.id, channel, ids])).rows
        .map((r) => [r.external_order_id as string, { id: r.id as string, total: Number(r.total) }]));
      const rows = parsed.lines.map((l) => {
        const o = ours.get(l.externalOrderId);
        return [imp.id, l.externalOrderId, l.grossPaise, l.payoutPaise, o?.id ?? null, !o ? 'unknown_order' : o.total === l.grossPaise ? 'matched' : 'amount_mismatch'];
      });
      await c.query(
        `INSERT INTO settlement_line (tenant_id, import_id, external_order_id, gross_paise, payout_paise, online_order_id, result)
         SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::bigint[], $5::bigint[], $6::uuid[], $7::text[])`,
        [p.tenantId, ...[0, 1, 2, 3, 4, 5].map((i) => rows.map((r) => r[i]))]);
      const out = await report(c, ps.data.id, imp.id);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'settlement.import', entity: 'settlement_import', entityId: imp.id,
        detail: { outletId: ps.data.id, channel, filename, ...out!.summary } });
      return reply.code(201).send(out);
    });
  });

  app.get('/outlets/:id/settlement-imports', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    if (!ps.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => (await c.query(
      `SELECT i.id, i.channel, i.filename, i.period_from::text AS "periodFrom", i.period_to::text AS "periodTo", i.uploaded_at AS "uploadedAt",
              (SELECT count(*)::int FROM settlement_line l WHERE l.import_id = i.id) AS lines,
              (SELECT count(*)::int FROM settlement_line l WHERE l.import_id = i.id AND l.result <> 'matched') AS problems
         FROM settlement_import i WHERE i.outlet_id = $1 ORDER BY i.uploaded_at DESC LIMIT 50`, [ps.data.id])).rows);
  });

  app.get('/outlets/:id/settlement-imports/:importId', { config: cfg }, async (req, reply) => {
    const ps = importParams.safeParse(req.params);
    if (!ps.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => (await report(c, ps.data.id, ps.data.importId)) ?? notFound(reply));
  });
};
