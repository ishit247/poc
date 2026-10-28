import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { resolveForOutlet } from '../menuData.js';

const uuid = z.string().uuid();
const channel = z.enum(['counter', 'zomato', 'swiggy']);
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const outletParams = z.object({ id: uuid });
const ruleParams = z.object({ outletId: uuid, itemId: uuid });
const priceParams = z.object({ outletId: uuid, itemId: uuid, channel });
const modeBody = z.object({ mode: z.enum(['all', 'listed']) }).strict();
const listedBody = z.object({ listed: z.boolean() }).strict();
const priceBody = z.object({ pricePaise: z.number().int().min(0).max(100_000_000) }).strict();
const gstBody = z.object({
  enabled: z.boolean(),
  gstin: z.string().regex(GSTIN).nullable().default(null),
}).strict().refine((b) => !b.enabled || b.gstin !== null, { message: 'GSTIN required to enable GST' });
const menuQuery = z.object({ channel: channel.default('counter') }).strict();

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

export const outletRoutes: FastifyPluginAsync = async (app) => {
  // Scope: a manager configures only outlets assigned to them. Checked before any query.
  const cfg = { scope: 'outlet', permission: 'manager' } as const;
  const mine = (outletIds: string[], id: string) => outletIds.includes(id);

  app.put('/outlets/:id/menu-mode', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = modeBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    await withTenant(p.tenantId, async (c) => {
      await c.query('UPDATE outlet SET menu_mode = $2 WHERE id = $1', [ps.data.id, b.data.mode]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.menu_mode', entity: 'outlet', entityId: ps.data.id, detail: b.data });
    });
    return { ok: true };
  });

  // GST provision (Q3): enabling needs a well-formed GSTIN; the format check is also a DB constraint.
  app.put('/outlets/:id/gst', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = gstBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    await withTenant(p.tenantId, async (c) => {
      await c.query('UPDATE outlet SET gst_enabled = $2, gstin = $3 WHERE id = $1', [ps.data.id, b.data.enabled, b.data.gstin]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.gst', entity: 'outlet', entityId: ps.data.id, detail: b.data });
    });
    return { ok: true };
  });

  app.put('/outlets/:outletId/menu/items/:itemId', { config: cfg }, async (req, reply) => {
    const ps = ruleParams.safeParse(req.params);
    const b = listedBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.outletId)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      const item = await c.query('SELECT 1 FROM item WHERE id = $1 AND deleted_at IS NULL', [ps.data.itemId]);
      if (!item.rowCount) return false;
      await c.query(
        `INSERT INTO outlet_item (tenant_id, outlet_id, item_id, listed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (outlet_id, item_id) DO UPDATE SET listed = EXCLUDED.listed, deleted_at = NULL`,
        [p.tenantId, ps.data.outletId, ps.data.itemId, b.data.listed]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.item_listed', entity: 'outlet', entityId: ps.data.outletId, detail: { itemId: ps.data.itemId, ...b.data } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  app.put('/outlets/:outletId/prices/:itemId/:channel', { config: cfg }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    const b = priceBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.outletId)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      const item = await c.query('SELECT 1 FROM item WHERE id = $1 AND deleted_at IS NULL', [ps.data.itemId]);
      if (!item.rowCount) return false;
      await c.query(
        `INSERT INTO outlet_price (tenant_id, outlet_id, item_id, channel, price_paise) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (outlet_id, item_id, channel) WHERE deleted_at IS NULL
         DO UPDATE SET price_paise = EXCLUDED.price_paise`,
        [p.tenantId, ps.data.outletId, ps.data.itemId, ps.data.channel, b.data.pricePaise]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.price_set', entity: 'outlet', entityId: ps.data.outletId, detail: { itemId: ps.data.itemId, channel: ps.data.channel, ...b.data } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  app.delete('/outlets/:outletId/prices/:itemId/:channel', { config: cfg }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.outletId)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        'UPDATE outlet_price SET deleted_at = now() WHERE outlet_id = $1 AND item_id = $2 AND channel = $3 AND deleted_at IS NULL',
        [ps.data.outletId, ps.data.itemId, ps.data.channel]);
      if (!r.rowCount) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.price_clear', entity: 'outlet', entityId: ps.data.outletId, detail: { itemId: ps.data.itemId, channel: ps.data.channel } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // What this outlet sells on a channel, from the same resolver the tablet uses.
  app.get('/outlets/:id/menu', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const q = menuQuery.safeParse(req.query);
    if (!ps.success || !q.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    const menu = await withTenant(p.tenantId, (c) => resolveForOutlet(c, ps.data.id, q.data.channel));
    return menu ? { channel: q.data.channel, menu } : notFound(reply);
  });
};
