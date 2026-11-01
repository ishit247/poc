import type { FastifyPluginAsync } from 'fastify';
import { DEFAULT_SETTINGS, TradingSettings } from '@pos/shared';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';

const SELECT = `SELECT max_line_qty AS "maxLineQty", gst_rounding AS "gstRounding",
                       bill_round_to AS "billRoundTo", offline_days AS "offlineDays"
                  FROM tenant_setting`;

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Scope: a manager reads and replaces their own tenant's trading settings (RLS pins the tenant).
  const cfg = { scope: 'tenant', permission: 'manager' } as const;

  app.get('/settings', { config: cfg }, async (req) => {
    const p = req.principal!;
    const rows = await withTenant(p.tenantId, async (c) => (await c.query(SELECT)).rows);
    return rows[0] ?? DEFAULT_SETTINGS;
  });

  // Scope: the tenant's own record of every time the platform operator looked at its data (0009). Never the token.
  app.get('/support-access', { config: cfg }, async (req) => {
    const p = req.principal!;
    return withTenant(p.tenantId, async (c) => (await c.query(
      `SELECT id, admin_name AS "operator", reason, created_at AS "startedAt", expires_at AS "expiresAt", ended_at AS "endedAt"
         FROM impersonation ORDER BY created_at DESC LIMIT 100`)).rows);
  });

  app.put('/settings', { config: cfg }, async (req, reply) => {
    const b = TradingSettings.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    await withTenant(p.tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenant_setting (tenant_id, max_line_qty, gst_rounding, bill_round_to, offline_days)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET max_line_qty = $2, gst_rounding = $3, bill_round_to = $4, offline_days = $5`,
        [p.tenantId, b.data.maxLineQty, b.data.gstRounding, b.data.billRoundTo, b.data.offlineDays]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'settings.update', entity: 'tenant_setting', entityId: p.tenantId, detail: b.data });
    });
    return { ok: true };
  });
};
