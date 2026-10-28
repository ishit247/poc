import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import type { Principal } from '../scope.js';

const uuid = z.string().uuid();
const channel = z.enum(['counter', 'zomato', 'swiggy']);
const name = z.string().trim().min(1).max(100);
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);

const categoryBody = z.object({ name, sortOrder: sortOrder.optional() }).strict();
const categoryPatch = categoryBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const hsn = z.string().regex(/^[0-9]{4,8}$/).nullable();
const itemBody = z.object({ categoryId: uuid, name, hsnCode: hsn.optional(), sortOrder: sortOrder.optional() }).strict();
const itemPatch = itemBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const priceBody = z.object({
  pricePaise: z.number().int().min(0).max(100_000_000),
  gstRateBp: z.number().int().min(0).max(4000),
}).strict();
const availableBody = z.object({ available: z.boolean() }).strict();
const idParams = z.object({ id: uuid });
const priceParams = z.object({ id: uuid, channel });
const stockParams = z.object({ outletId: uuid, itemId: uuid });

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

/** Builds "col = $n" pairs from a validated patch, using a fixed column map (never client keys). */
function setClause(patch: Record<string, unknown>, cols: Record<string, string>, start: number) {
  const keys = Object.keys(patch).filter((k) => k in cols);
  return { sql: keys.map((k, i) => `${cols[k]} = $${start + i}`).join(', '), values: keys.map((k) => patch[k]) };
}

async function liveExists(c: pg.PoolClient, table: 'category' | 'item', id: string) {
  const r = await c.query(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export const menuRoutes: FastifyPluginAsync = async (app) => {
  const mgr = { scope: 'tenant', permission: 'manager' } as const;
  const actor = (p: Principal) => ({
    tenantId: p.tenantId,
    actorKind: p.kind,
    actorId: p.kind === 'user' ? p.userId : p.deviceId,
  });

  app.get('/menu', { config: mgr }, async (req) => {
    const p = req.principal!;
    return withTenant(p.tenantId, async (c) => {
      const [cats, items, prices] = await Promise.all([
        c.query('SELECT id, name, sort_order AS "sortOrder" FROM category WHERE deleted_at IS NULL ORDER BY sort_order, name'),
        c.query('SELECT id, category_id AS "categoryId", name, hsn_code AS "hsnCode", sort_order AS "sortOrder" FROM item WHERE deleted_at IS NULL ORDER BY sort_order, name'),
        c.query('SELECT item_id AS "itemId", channel, price_paise::int AS "pricePaise", gst_rate_bp AS "gstRateBp" FROM item_price WHERE deleted_at IS NULL'),
      ]);
      return { categories: cats.rows, items: items.rows, prices: prices.rows };
    });
  });

  // --- categories ---------------------------------------------------------
  app.post('/categories', { config: mgr }, async (req, reply) => {
    const b = categoryBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    const row = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        'INSERT INTO category (tenant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id, name, sort_order AS "sortOrder"',
        [p.tenantId, b.data.name, b.data.sortOrder ?? 0]);
      await audit(c, { ...actor(p), action: 'category.create', entity: 'category', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.code(201).send(row);
  });

  app.patch('/categories/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = categoryPatch.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    const set = setClause(b.data, { name: 'name', sortOrder: 'sort_order' }, 2);
    const row = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE category SET ${set.sql} WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, sort_order AS "sortOrder"`,
        [ids.data.id, ...set.values]);
      if (r.rowCount) await audit(c, { ...actor(p), action: 'category.update', entity: 'category', entityId: ids.data.id });
      return r.rows[0];
    });
    return row ?? notFound(reply);
  });

  app.delete('/categories/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const out = await withTenant(p.tenantId, async (c) => {
      const used = await c.query('SELECT 1 FROM item WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1', [ids.data.id]);
      if (used.rowCount) return 'in-use' as const;
      const r = await c.query('UPDATE category SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [ids.data.id]);
      if (!r.rowCount) return 'missing' as const;
      await audit(c, { ...actor(p), action: 'category.delete', entity: 'category', entityId: ids.data.id });
      return 'ok' as const;
    });
    if (out === 'in-use') return reply.code(409).send({ error: 'category has items' });
    return out === 'ok' ? { ok: true } : notFound(reply);
  });

  // --- items --------------------------------------------------------------
  app.post('/items', { config: mgr }, async (req, reply) => {
    const b = itemBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    const row = await withTenant(p.tenantId, async (c) => {
      if (!(await liveExists(c, 'category', b.data.categoryId))) return null;
      const r = await c.query(
        'INSERT INTO item (tenant_id, category_id, name, hsn_code, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id, category_id AS "categoryId", name, hsn_code AS "hsnCode", sort_order AS "sortOrder"',
        [p.tenantId, b.data.categoryId, b.data.name, b.data.hsnCode ?? null, b.data.sortOrder ?? 0]);
      await audit(c, { ...actor(p), action: 'item.create', entity: 'item', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return row ? reply.code(201).send(row) : bad(reply);
  });

  app.patch('/items/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    const b = itemPatch.safeParse(req.body);
    if (!ids.success || !b.success) return bad(reply);
    const p = req.principal!;
    const set = setClause(b.data, { categoryId: 'category_id', name: 'name', hsnCode: 'hsn_code', sortOrder: 'sort_order' }, 2);
    const out = await withTenant(p.tenantId, async (c) => {
      if (b.data.categoryId && !(await liveExists(c, 'category', b.data.categoryId))) return 'bad-category' as const;
      const r = await c.query(
        `UPDATE item SET ${set.sql} WHERE id = $1 AND deleted_at IS NULL RETURNING id, category_id AS "categoryId", name, hsn_code AS "hsnCode", sort_order AS "sortOrder"`,
        [ids.data.id, ...set.values]);
      if (!r.rowCount) return 'missing' as const;
      await audit(c, { ...actor(p), action: 'item.update', entity: 'item', entityId: ids.data.id });
      return r.rows[0];
    });
    if (out === 'bad-category') return bad(reply);
    return out === 'missing' ? notFound(reply) : out;
  });

  app.delete('/items/:id', { config: mgr }, async (req, reply) => {
    const ids = idParams.safeParse(req.params);
    if (!ids.success) return bad(reply);
    const p = req.principal!;
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query('UPDATE item SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [ids.data.id]);
      if (!r.rowCount) return false;
      // Tombstone the prices too, so devices drop them in the same pull.
      await c.query('UPDATE item_price SET deleted_at = now() WHERE item_id = $1 AND deleted_at IS NULL', [ids.data.id]);
      await audit(c, { ...actor(p), action: 'item.delete', entity: 'item', entityId: ids.data.id });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // --- channel prices -----------------------------------------------------
  app.put('/items/:id/prices/:channel', { config: mgr }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    const b = priceBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    const row = await withTenant(p.tenantId, async (c) => {
      if (!(await liveExists(c, 'item', ps.data.id))) return null;
      const r = await c.query(
        `INSERT INTO item_price (tenant_id, item_id, channel, price_paise, gst_rate_bp) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (item_id, channel) WHERE deleted_at IS NULL
         DO UPDATE SET price_paise = EXCLUDED.price_paise, gst_rate_bp = EXCLUDED.gst_rate_bp
         RETURNING item_id AS "itemId", channel, price_paise::int AS "pricePaise", gst_rate_bp AS "gstRateBp"`,
        [p.tenantId, ps.data.id, ps.data.channel, b.data.pricePaise, b.data.gstRateBp]);
      await audit(c, { ...actor(p), action: 'price.set', entity: 'item', entityId: ps.data.id, detail: { channel: ps.data.channel, ...b.data } });
      return r.rows[0];
    });
    return row ?? notFound(reply);
  });

  app.delete('/items/:id/prices/:channel', { config: mgr }, async (req, reply) => {
    const ps = priceParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query('UPDATE item_price SET deleted_at = now() WHERE item_id = $1 AND channel = $2 AND deleted_at IS NULL', [ps.data.id, ps.data.channel]);
      if (!r.rowCount) return false;
      await audit(c, { ...actor(p), action: 'price.delete', entity: 'item', entityId: ps.data.id, detail: { channel: ps.data.channel } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // --- stock toggle: cashier or manager, only at their own outlets ----------
  app.put('/outlets/:outletId/items/:itemId', { config: { scope: 'outlet', permission: 'till' } }, async (req, reply) => {
    const ps = stockParams.safeParse(req.params);
    const b = availableBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.outletId)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await liveExists(c, 'item', ps.data.itemId))) return false;
      await c.query(
        `INSERT INTO outlet_item (tenant_id, outlet_id, item_id, available) VALUES ($1,$2,$3,$4)
         ON CONFLICT (outlet_id, item_id) DO UPDATE SET available = EXCLUDED.available, deleted_at = NULL`,
        [p.tenantId, ps.data.outletId, ps.data.itemId, b.data.available]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'stock.set', entity: 'item', entityId: ps.data.itemId, detail: { outletId: ps.data.outletId, available: b.data.available } });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });
};
