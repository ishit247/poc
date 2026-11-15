import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { ordersTopic, publish } from '../hub.js';
import { DUMMY_HASH, verifyPassword } from '../security/password.js';
import { lockState, recordFailure } from '../lockout.js';
import { PIN_LOCK_MINUTES, PIN_MAX_FAILED } from './auth.js';

const idParams = z.object({ id: z.string().uuid() });
const refundBody = z.object({ reason: z.string().trim().min(1).max(200), pin: z.string().regex(/^\d{6,8}$/) }).strict();

/**
 * Refund of a whole paid counter sale (PLAN 17 Q15, docs/refunds-plan.md). THE rule for who may refund, in one place:
 * the cashier whose OPEN shift on THIS tablet took the payment, after typing their own PIN again. So the cash goes back
 * out of the drawer it went into, and the day cannot be closed under it (day close refuses while a shift is open).
 * Online. Sales of other shifts, closed shifts and online orders are outside the rule; they read as not found.
 * Mirror: the tablet's Refund control (refunds-plan step 3) offers it only for sales of its own open shift.
 */
export const refundRoutes: FastifyPluginAsync = async (app) => {
  app.post('/sales/:id/refund', {
    config: {
      scope: 'shift-owner', permission: 'till',
      // Per session, on top of the global per-IP limit; the PIN lockout below is the real guard on guessing.
      rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => String(req.headers.authorization ?? req.ip) },
    },
  }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = refundBody.safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user' || !p.deviceId) return reply.code(403).send({ error: 'refund on the tablet whose drawer pays it out' });
    const deviceId = p.deviceId;

    const out = await withTenant(p.tenantId, async (c) => {
      // Re-PIN first, with the sign-in lockout (same counter, so a refund prompt is no way round it). The verifier
      // query names no sale, so a wrong PIN learns nothing about the sale either.
      const u = (await c.query('SELECT pin_verifier FROM app_user WHERE id = $1 AND active', [p.userId])).rows[0];
      const state = u ? await lockState(c, p.tenantId, p.userId, 'pin') : null;
      const ok = await verifyPassword(b.data.pin, u?.pin_verifier ?? DUMMY_HASH);
      if (!u || !state) return { kind: 'wrong-pin' as const };
      if (state.locked) return { kind: 'locked' as const, until: state.lockedUntil };
      if (!ok) {
        const lock = await recordFailure(c, p.userId, 'pin', state, PIN_MAX_FAILED, PIN_LOCK_MINUTES);
        await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: lock ? 'pin.locked' : 'refund.pin_failed', entity: 'sale', entityId: ps.data.id });
        return { kind: 'wrong-pin' as const };
      }
      // A correct PIN does not clear the counter: that is sign-in's job, and a refund is not a sign-in.

      // The sale's shift must be the caller's own, open, on this tablet. The shift is locked before the sale, the order
      // ingest uses (shift, then sale), so a shift close arriving at the same moment runs wholly before or after this.
      const shift = (await c.query(
        `SELECT sh.id FROM shift sh JOIN sale s ON s.shift_id = sh.id
          WHERE s.id = $1 AND s.channel = 'counter' AND sh.device_id = $2 AND sh.user_id = $3 AND sh.closed_at IS NULL
            AND sh.outlet_id = ANY($4::uuid[])
          FOR UPDATE OF sh`, [ps.data.id, deviceId, p.userId, p.outletIds])).rows[0];
      const sale = shift && (await c.query(
        'SELECT id, status, outlet_id, receipt_no FROM sale WHERE id = $1 AND shift_id = $2 FOR UPDATE', [ps.data.id, shift.id])).rows[0];
      if (!sale) return { kind: 'not-found' as const };
      if (sale.status === 'refunded') return { kind: 'conflict' as const, error: 'already refunded' };
      if (sale.status !== 'paid') return { kind: 'conflict' as const, error: 'only a paid sale can be refunded' };

      // Each method gets back what it took. The deferred check in 0004 (assert_sale_payments) holds this at commit.
      const back = (await c.query(
        `INSERT INTO refund (tenant_id, sale_id, method, amount_paise, reason, shift_id, device_id, refunded_by)
         SELECT $1, $2, method, sum(amount_paise), $3, $4, $5, $6 FROM payment WHERE sale_id = $2 GROUP BY method
         RETURNING method, amount_paise::int AS "amountPaise"`,
        [p.tenantId, sale.id, b.data.reason, shift.id, deviceId, p.userId])).rows as { method: 'cash' | 'upi'; amountPaise: number }[];
      await c.query("UPDATE sale SET status = 'refunded' WHERE id = $1", [sale.id]);
      await audit(c, {
        tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'sale.refund', entity: 'sale', entityId: sale.id,
        detail: { reason: b.data.reason, receiptNo: sale.receipt_no, shiftId: shift.id, deviceId, refunds: back },
      });
      return { kind: 'ok' as const, outletId: sale.outlet_id as string, refunds: back };
    });

    if (out.kind === 'wrong-pin') return reply.code(403).send({ error: 'wrong pin' });
    if (out.kind === 'locked') return reply.code(423).send({ error: 'locked', lockedUntil: out.until });
    if (out.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (out.kind === 'conflict') return reply.code(409).send({ error: out.error });
    publish(ordersTopic(out.outletId)); // after the commit, as for a void
    return { ok: true, refunds: out.refunds };
  });
};
