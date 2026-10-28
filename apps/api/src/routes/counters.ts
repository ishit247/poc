import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { resolveForOutlet } from '../menuData.js';
import { audit } from '../audit.js';

const uuid = z.string().uuid();
const modeBody = z.object({ mode: z.enum(['all', 'listed']) }).strict();
const ruleBody = z.object({
  listed: z.boolean(),
  // null = use the catalogue price. 0 is a real price.
  pricePaise: z.number().int().min(0).max(100_000_000).nullable().default(null),
}).strict();
const counterParams = z.object({ id: uuid });
const ruleParams = z.object({ counterId: uuid, itemId: uuid });

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

/** Scope rule, enforced in the query: the counter must belong to an outlet the manager is assigned to. */
async function ownCounter(c: pg.PoolClient, counterId: string, outletIds: string[]) {
  const r = await c.query('SELECT outlet_id, menu_mode FROM counter WHERE id = $1 AND outlet_id = ANY($2::uuid[])', [counterId, outletIds]);
  return r.rows[0] as { outlet_id: string; menu_mode: 'all' | 'listed' } | undefined;
}

export const counterRoutes: FastifyPluginAsync = async (app) => {
  const cfg = { scope: 'outlet', permission: 'manager' } as const;

  app.put('/counters/:id/menu-mode', { config: cfg }, async (req, reply) => {
    const ps = counterParams.safeParse(req.params);
    const b = modeBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await ownCounter(c, ps.data.id, p.outletIds))) return false;
      await c.query('UPDATE counter SET menu_mode = $2 WHERE id = $1', [ps.data.id, b.data.mode]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'counter.menu_mode', entity: 'counter', entityId: ps.data.id, detail: { mode: b.data.mode } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  app.put('/counters/:counterId/items/:itemId', { config: cfg }, async (req, reply) => {
    const ps = ruleParams.safeParse(req.params);
    const b = ruleBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await ownCounter(c, ps.data.counterId, p.outletIds))) return false;
      const item = await c.query('SELECT 1 FROM item WHERE id = $1 AND deleted_at IS NULL', [ps.data.itemId]);
      if (!item.rowCount) return false;
      await c.query(
        `INSERT INTO counter_item (tenant_id, counter_id, item_id, listed, price_paise) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (counter_id, item_id)
         DO UPDATE SET listed = EXCLUDED.listed, price_paise = EXCLUDED.price_paise, deleted_at = NULL`,
        [p.tenantId, ps.data.counterId, ps.data.itemId, b.data.listed, b.data.pricePaise]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'counter.item_set', entity: 'counter', entityId: ps.data.counterId, detail: { itemId: ps.data.itemId, ...b.data } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // Removing a rule returns the item to the counter's default behaviour.
  app.delete('/counters/:counterId/items/:itemId', { config: cfg }, async (req, reply) => {
    const ps = ruleParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await ownCounter(c, ps.data.counterId, p.outletIds))) return false;
      const r = await c.query('UPDATE counter_item SET deleted_at = now() WHERE counter_id = $1 AND item_id = $2 AND deleted_at IS NULL', [ps.data.counterId, ps.data.itemId]);
      if (!r.rowCount) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'counter.item_clear', entity: 'counter', entityId: ps.data.counterId, detail: { itemId: ps.data.itemId } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // What this counter will actually sell, from the same resolver the tablet uses.
  app.get('/counters/:id/menu', { config: cfg }, async (req, reply) => {
    const ps = counterParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const out = await withTenant(p.tenantId, async (c) => {
      const counter = await ownCounter(c, ps.data.id, p.outletIds);
      if (!counter) return null;
      const menu = await resolveForOutlet(c, counter.outlet_id, 'counter', { id: ps.data.id, mode: counter.menu_mode });
      return { mode: counter.menu_mode, menu };
    });
    return out ?? notFound(reply);
  });
};
