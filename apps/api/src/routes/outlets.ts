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
// Receipt header and footer. Printable text only: no control characters (they would reach the printer).
const receiptInfoBody = z.object({
  address: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/).nullable(),
  fssaiNo: z.string().regex(/^[0-9]{14}$/).nullable(),
}).strict();
const menuQuery = z.object({ channel: channel.default('counter') }).strict();
// Tables (PLAN D14). The code is what the counter shows, so it matches the database check.
const tableCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$/);
const tableParams = z.object({ id: uuid, tableId: uuid });
const tableBody = z.object({ code: tableCode, sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional() }).strict();
const tablePatch = tableBody.partial().strict().refine((b) => Object.keys(b).length > 0);
const tableModeBody = z.object({ mode: z.enum(['default', 'map']) }).strict();
const TABLE_COLS = 'id, code, sort_order AS "sortOrder", is_default AS "isDefault"';

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

  // --- tables (PLAN D14). Manager, own outlets only; a table is always looked up WITH its outlet, so another
  // outlet's table id is simply not found. ----------------------------------------------------------------------
  app.put('/outlets/:id/table-mode', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = tableModeBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    await withTenant(p.tenantId, async (c) => {
      await c.query('UPDATE outlet SET table_mode = $2 WHERE id = $1', [ps.data.id, b.data.mode]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.table_mode', entity: 'outlet', entityId: ps.data.id, detail: b.data });
    });
    return { ok: true };
  });

  app.get('/outlets/:id/tables', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      const mode = (await c.query('SELECT table_mode AS "tableMode" FROM outlet WHERE id = $1', [ps.data.id])).rows[0]?.tableMode;
      const tables = await c.query(
        `SELECT ${TABLE_COLS}, EXISTS (SELECT 1 FROM sale s WHERE s.table_id = dining_table.id AND s.status = 'open') AS "hasOpenOrder"
           FROM dining_table WHERE outlet_id = $1 AND deleted_at IS NULL ORDER BY sort_order, lower(code)`, [ps.data.id]);
      return { tableMode: mode, tables: tables.rows };
    });
  });

  app.post('/outlets/:id/tables', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = tableBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    try {
      const row = await withTenant(p.tenantId, async (c) => {
        // Appended after the last one unless the manager chose a position.
        const r = await c.query(
          `INSERT INTO dining_table (tenant_id, outlet_id, code, sort_order)
           VALUES ($1, $2, $3, COALESCE($4::int, (SELECT COALESCE(max(sort_order), 0) + 10 FROM dining_table WHERE outlet_id = $2)))
           RETURNING ${TABLE_COLS}`,
          [p.tenantId, ps.data.id, b.data.code, b.data.sortOrder ?? null]);
        await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'table.create', entity: 'dining_table', entityId: r.rows[0].id, detail: { outletId: ps.data.id, code: b.data.code } });
        return r.rows[0];
      });
      return reply.code(201).send(row);
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).code === '23505') return reply.code(409).send({ error: 'table code in use' });
      throw e;
    }
  });

  app.patch('/outlets/:id/tables/:tableId', { config: cfg }, async (req, reply) => {
    const ps = tableParams.safeParse(req.params);
    const b = tablePatch.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    try {
      const row = await withTenant(p.tenantId, async (c) => {
        const r = await c.query(
          `UPDATE dining_table SET code = COALESCE($3, code), sort_order = COALESCE($4::int, sort_order)
            WHERE id = $2 AND outlet_id = $1 AND deleted_at IS NULL RETURNING ${TABLE_COLS}`,
          [ps.data.id, ps.data.tableId, b.data.code ?? null, b.data.sortOrder ?? null]);
        if (r.rowCount) await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'table.update', entity: 'dining_table', entityId: ps.data.tableId, detail: b.data });
        return r.rows[0];
      });
      return row ?? notFound(reply);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'table code in use' });
      throw e;
    }
  });

  app.delete('/outlets/:id/tables/:tableId', { config: cfg }, async (req, reply) => {
    const ps = tableParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    const out = await withTenant(p.tenantId, async (c) => {
      const t = (await c.query('SELECT is_default FROM dining_table WHERE id = $2 AND outlet_id = $1 AND deleted_at IS NULL FOR UPDATE', [ps.data.id, ps.data.tableId])).rows[0];
      if (!t) return 'missing' as const;
      if (t.is_default) return 'default' as const;
      // A table with an unpaid order on it cannot disappear from under the cashier.
      if ((await c.query("SELECT 1 FROM sale WHERE table_id = $1 AND status = 'open' LIMIT 1", [ps.data.tableId])).rowCount) return 'busy' as const;
      await c.query('UPDATE dining_table SET deleted_at = now() WHERE id = $1', [ps.data.tableId]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'table.delete', entity: 'dining_table', entityId: ps.data.tableId, detail: { outletId: ps.data.id } });
      return 'ok' as const;
    });
    if (out === 'default') return reply.code(409).send({ error: 'the default table cannot be removed' });
    if (out === 'busy') return reply.code(409).send({ error: 'table has an open order' });
    return out === 'ok' ? { ok: true } : notFound(reply);
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

  app.put('/outlets/:id/receipt-info', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = receiptInfoBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !mine(p.outletIds, ps.data.id)) return notFound(reply);
    await withTenant(p.tenantId, async (c) => {
      await c.query('UPDATE outlet SET address = $2, fssai_no = $3 WHERE id = $1', [ps.data.id, b.data.address, b.data.fssaiNo]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'outlet.receipt_info', entity: 'outlet', entityId: ps.data.id, detail: b.data });
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
