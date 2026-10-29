import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import type { Principal } from '../scope.js';

const idParams = z.object({ id: z.string().uuid() });
const voidBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

/**
 * THE scope rule for orders ("whose"), as one SQL predicate every order route must use.
 * A permission says a waiter may use these routes; this says which orders they may touch.
 *   waiter  : only orders they took themselves, and only while open
 *   cashier : open orders at their outlets (to take payment) plus everything in shifts they own
 *   manager : every order at their outlets
 * A record outside the rule is indistinguishable from one that does not exist (404, never 403).
 * Parameters $1..$3 are reserved: role, user id, outlet ids.
 */
export const ORDER_SCOPE = `
  sale.outlet_id = ANY($3::uuid[]) AND (
       $1 = 'manager'
    OR ($1 = 'cashier' AND (sale.status = 'open'
                            OR sale.shift_id IN (SELECT id FROM shift WHERE user_id = $2)))
    OR ($1 = 'waiter' AND sale.created_by = $2 AND sale.status = 'open'))`;

const scopeParams = (p: Extract<Principal, { kind: 'user' }>) => [p.role, p.userId, p.outletIds];

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const cfg = { scope: 'own-orders', permission: 'staff' } as const;

  app.get('/orders', { config: cfg }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') return [];
    return withTenant(p.tenantId, async (c) => (await c.query(
      `SELECT sale.id, sale.status, sale.channel, sale.receipt_no AS "receiptNo", sale.total_paise AS "totalPaise",
              sale.created_by AS "createdBy", sale.created_at_device AS "createdAt"
         FROM sale WHERE ${ORDER_SCOPE} ORDER BY sale.created_at_device DESC LIMIT 200`, scopeParams(p))).rows);
  });

  app.get('/orders/:id', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    if (!ps.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const out = await withTenant(p.tenantId, async (c) => {
      const s = await c.query(
        `SELECT sale.id, sale.status, sale.channel, sale.receipt_no AS "receiptNo", sale.subtotal_paise AS "subtotalPaise",
                sale.tax_paise AS "taxPaise", sale.round_off_paise AS "roundOffPaise", sale.total_paise AS "totalPaise", sale.created_by AS "createdBy",
                sale.created_at_device AS "createdAt"
           FROM sale WHERE sale.id = $4 AND ${ORDER_SCOPE}`, [...scopeParams(p), ps.data.id]);
      if (!s.rows[0]) return null;
      const lines = await c.query(
        `SELECT item_id AS "itemId", name_snapshot AS name, unit_price_paise AS "unitPricePaise", gst_rate_bp AS "gstRateBp",
                qty, line_total_paise AS "lineTotalPaise", tax_paise AS "taxPaise" FROM sale_line WHERE sale_id = $1`, [ps.data.id]);
      return { ...s.rows[0], lines: lines.rows };
    });
    return out ?? notFound(reply);
  });

  // Online void of an OPEN order only. Voiding a paid sale is a manager action on synced data (later phase).
  app.post('/orders/:id/void', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = voidBody.safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE sale SET status = 'void', void_reason = $5 WHERE sale.id = $4 AND sale.status = 'open' AND ${ORDER_SCOPE} RETURNING sale.id`,
        [...scopeParams(p), ps.data.id, b.data.reason]);
      if (!r.rowCount) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'order.void', entity: 'sale', entityId: ps.data.id, detail: { reason: b.data.reason } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });
};
