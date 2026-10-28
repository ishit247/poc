import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';

const PAGE = 500;
const query = z.object({ cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();

// ONE statement, so every table is read from the same snapshot. Four separate
// queries could straddle a commit: a later table would show version 12 while an
// earlier one missed 11, and the cursor would skip 11 for good. Combined with
// commit-ordered versions (app.next_version), a snapshot is a prefix of history.
const PULL_SQL = `
  SELECT 'category' AS type, id, version, deleted_at IS NOT NULL AS deleted,
         jsonb_build_object('name', name, 'sortOrder', sort_order) AS data
    FROM category WHERE version > $1
  UNION ALL
  SELECT 'item', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('categoryId', category_id, 'name', name, 'hsnCode', hsn_code, 'sortOrder', sort_order)
    FROM item WHERE version > $1
  UNION ALL
  SELECT 'item_price', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('itemId', item_id, 'channel', channel, 'pricePaise', price_paise, 'gstRateBp', gst_rate_bp)
    FROM item_price WHERE version > $1
  UNION ALL
  SELECT 'outlet_item', item_id, version, deleted_at IS NOT NULL,
         jsonb_build_object('available', available, 'listed', listed)
    FROM outlet_item WHERE version > $1 AND outlet_id = $2
  UNION ALL
  SELECT 'outlet', id, version, false,
         jsonb_build_object('menuMode', menu_mode, 'gstEnabled', gst_enabled, 'gstin', gstin)
    FROM outlet WHERE version > $1 AND id = $2
  UNION ALL
  SELECT 'outlet_price', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('itemId', item_id, 'channel', channel, 'pricePaise', price_paise)
    FROM outlet_price WHERE version > $1 AND outlet_id = $2
  UNION ALL
  SELECT 'counter', id, version, false,
         jsonb_build_object('menuMode', menu_mode)
    FROM counter WHERE version > $1 AND id = $3
  UNION ALL
  SELECT 'counter_item', item_id, version, deleted_at IS NOT NULL,
         jsonb_build_object('listed', listed, 'pricePaise', price_paise)
    FROM counter_item WHERE version > $1 AND counter_id = $3
  ORDER BY version
  LIMIT ${PAGE + 1}`;

export const syncRoutes: FastifyPluginAsync = async (app) => {
  // Scope: an enrolled device gets its tenant's catalogue, its own outlet's availability,
  // its own outlet's settings, menu rules and price overrides, and ONLY its own counter's menu rules.
  app.get('/sync/pull', { config: { scope: 'outlet', permission: 'device' } }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });

    const rows = await withTenant(p.tenantId, async (c) => (await c.query(PULL_SQL, [q.data.cursor, p.outletId, p.counterId])).rows);
    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;
    const last = page[page.length - 1];
    return {
      // Unchanged when nothing is newer; otherwise the highest version delivered.
      cursor: last ? Number(last.version) : q.data.cursor,
      hasMore,
      changes: page.map((r) => ({ type: r.type, id: r.id, version: Number(r.version), deleted: r.deleted, data: r.data })),
    };
  });
};
