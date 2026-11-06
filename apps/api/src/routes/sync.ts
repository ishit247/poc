import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type TradingSettings } from '@pos/shared';
import { withTenant } from '../db.js';
import { ingest } from '../ingest.js';
import { ordersTopic, publish, subscribe } from '../hub.js';

const PAGE = 500;
const query = z.object({ cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();

// ONE statement, so every table is read from the same snapshot. Four separate
// queries could straddle a commit: a later table would show version 12 while an
// earlier one missed 11, and the cursor would skip 11 for good. Combined with
// commit-ordered versions (app.next_version), a snapshot is a prefix of history.
const PULL_SQL = `
  SELECT 'category' AS type, id, version, deleted_at IS NOT NULL AS deleted,
         jsonb_build_object('name', name, 'code', code, 'sortOrder', sort_order) AS data
    FROM category WHERE version > $1
  UNION ALL
  SELECT 'item', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('categoryId', category_id, 'name', name, 'code', code, 'hsnCode', hsn_code, 'description', description,
                            'diet', diet, 'imageSha256', image_sha256, 'sortOrder', sort_order)
    FROM item WHERE version > $1
  UNION ALL
  SELECT 'tag', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('name', name, 'sortOrder', sort_order)
    FROM tag WHERE version > $1
  UNION ALL
  SELECT 'item_tag', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('itemId', item_id, 'tagId', tag_id)
    FROM item_tag WHERE version > $1
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
         jsonb_build_object('menuMode', menu_mode, 'gstEnabled', gst_enabled, 'gstin', gstin, 'address', address, 'fssaiNo', fssai_no,
                            'tableMode', table_mode)
    FROM outlet WHERE version > $1 AND id = $2
  UNION ALL
  -- This outlet's table slots (PLAN D14); a removed table is a tombstone.
  SELECT 'dining_table', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('code', code, 'sortOrder', sort_order, 'isDefault', is_default)
    FROM dining_table WHERE version > $1 AND outlet_id = $2
  UNION ALL
  SELECT 'outlet_price', id, version, deleted_at IS NOT NULL,
         jsonb_build_object('itemId', item_id, 'channel', channel, 'pricePaise', price_paise)
    FROM outlet_price WHERE version > $1 AND outlet_id = $2
  UNION ALL
  SELECT 'tenant_setting', tenant_id, version, false,
         jsonb_build_object('maxLineQty', max_line_qty, 'gstRounding', gst_rounding,
                            'billRoundTo', bill_round_to, 'offlineDays', offline_days)
    FROM tenant_setting WHERE version > $1
  UNION ALL
  -- The logo's bytes are not in pull: only its hash and type, so a tablet fetches /branding/logo when the hash changes.
  SELECT 'tenant_logo', tenant_id, version, deleted_at IS NOT NULL,
         CASE WHEN deleted_at IS NOT NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('sha256', sha256, 'contentType', content_type) END
    FROM tenant_logo WHERE version > $1
  UNION ALL
  SELECT 'counter', id, version, false,
         jsonb_build_object('menuMode', menu_mode)
    FROM counter WHERE version > $1 AND id = $3
  UNION ALL
  SELECT 'counter_item', item_id, version, deleted_at IS NOT NULL,
         jsonb_build_object('listed', listed, 'pricePaise', price_paise)
    FROM counter_item WHERE version > $1 AND counter_id = $3
  UNION ALL
  -- Staff of THIS outlet only, cashiers and waiters only (a manager's verifier never leaves the server).
  -- A user row changes when the person OR their membership does, hence GREATEST. Removal and
  -- deactivation are tombstones with no verifier, so a lost PIN cannot linger on a tablet.
  SELECT 'user', u.id, GREATEST(u.version, uo.version), (uo.deleted_at IS NOT NULL OR NOT u.active),
         CASE WHEN uo.deleted_at IS NOT NULL OR NOT u.active THEN '{}'::jsonb
              ELSE jsonb_build_object('name', u.name, 'role', u.role, 'pinVerifier', u.pin_verifier) END
    FROM user_outlet uo JOIN app_user u ON u.id = uo.user_id
   WHERE uo.outlet_id = $2 AND u.role IN ('cashier', 'waiter') AND GREATEST(u.version, uo.version) > $1
  UNION ALL
  -- THIS tablet's own shifts, and only those a manager closed for it: the tablet already knows about any it closed itself.
  SELECT 'shift', id, version, false,
         jsonb_build_object('closedAt', closed_at, 'countedCashPaise', counted_cash_paise::int,
                            'expectedCashPaise', expected_cash_paise::int, 'variancePaise', variance_paise::int)
    FROM shift WHERE version > $1 AND device_id = $4 AND closed_by IS NOT NULL
  ORDER BY version
  LIMIT ${PAGE + 1}`;

// The open-orders pull (phase 12 step 7, "12b"): the visits of THIS outlet that changed since the cursor, each sent
// WHOLE (every applied order event of the visit, and the lines its closed sales took), so the tablet refolds it with
// the same foldOrder/openLines as the server, together with its own unsent events. ONE statement, so the page is one
// snapshot; versions are commit-ordered (order_visit, 0004), so a snapshot is a prefix of history.
// A closed visit is sent with `open` null, so the tablet drops what it held. A tablet that holds no visits yet (its
// first pass, every page of it until `hasMore` is false) says `fresh=1`, and closed visits are skipped: otherwise a
// new tablet would page through the outlet's whole history. Not inferred from cursor 0: page 2 of a first pass has a
// cursor above 0. Visits are small (tens of events), and a page holds at most ORDER_PAGE of them.
const ORDER_PAGE = 100;
const ordersQuery = query.extend({ fresh: z.enum(['0', '1']).optional() }).strict();
const ORDERS_SQL = `
  WITH page AS (
    SELECT v.root_id, v.version,
           (SELECT s.id FROM sale s WHERE s.order_root_id = v.root_id AND s.status = 'open') AS open_id
      FROM order_visit v
     WHERE v.outlet_id = $1 AND v.version > $2
       AND (NOT $3 OR EXISTS (SELECT 1 FROM sale s WHERE s.order_root_id = v.root_id AND s.status = 'open'))
     ORDER BY v.version
     LIMIT ${ORDER_PAGE + 1}
  )
  SELECT p.root_id, p.version,
         (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'deviceId', s.device_id) ORDER BY s.received_at, s.id)
            FROM sale s WHERE s.order_root_id = p.root_id) AS sales,
         CASE WHEN p.open_id IS NULL THEN NULL ELSE jsonb_build_object(
           'saleId', p.open_id,
           'deviceId', (SELECT device_id FROM sale WHERE id = p.open_id),
           'closed', COALESCE((SELECT jsonb_agg(jsonb_build_object('lineId', l.line_id, 'qty', l.qty, 'removed', l.removed_at IS NOT NULL))
                                 FROM sale_line l JOIN sale s ON s.id = l.sale_id
                                WHERE s.order_root_id = p.root_id AND s.status <> 'open'), '[]'::jsonb),
           'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('deviceId', e.device_id, 'seq', e.seq, 'payload', e.payload) ORDER BY e.device_id, e.seq)
                                 FROM sync_event e
                                WHERE e.entity_id IN (SELECT id FROM sale WHERE order_root_id = p.root_id)
                                  AND e.outcome = 'applied' AND e.type LIKE 'order.%'), '[]'::jsonb)) END AS open
    FROM page p
   ORDER BY p.version`;

const MAX_BATCH = 100;
const pushBody = z.object({
  events: z.array(z.object({
    eventId: z.string().uuid(),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string().datetime({ offset: true }),
    payload: z.unknown(),
  }).strict()).min(1).max(MAX_BATCH),
}).strict();

async function tenantSettings(tenantId: string): Promise<TradingSettings> {
  const row = await withTenant(tenantId, async (c) =>
    (await c.query('SELECT max_line_qty, gst_rounding, bill_round_to, offline_days FROM tenant_setting')).rows[0]);
  return row
    ? { maxLineQty: row.max_line_qty, gstRounding: row.gst_rounding, billRoundTo: row.bill_round_to, offlineDays: row.offline_days }
    : DEFAULT_SETTINGS;
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  // Push. Scope: an enrolled device writes events for ITS OWN outlet and counter only; the tenant, outlet,
  // device and counter all come from the credential, never from the body. A revoked device is let in on
  // this route alone, and ingest judges each event against the moment of revocation.
  app.post('/sync/push', { config: { scope: 'outlet', permission: 'device', allowRevokedDevice: true } }, async (req, reply) => {
    const body = pushBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });
    const settings = await tenantSettings(p.tenantId);
    // In the device's own order: a payment is judged after the sale it pays for.
    const results = [];
    for (const e of [...body.data.events].sort((a, b) => a.seq - b.seq)) results.push(await ingest(p, e, settings));
    // After the commits: wake the outlet's other tablets. Over-telling is harmless (a pull with nothing new is cheap).
    if (results.some((r) => r.status === 'applied')) publish(ordersTopic(p.outletId));
    return { results };
  });

  // Scope: an enrolled device gets the open table visits of ITS OWN outlet only (D18: any device of the outlet may
  // change them); the outlet comes from the credential, never from the request.
  app.get('/sync/orders', { config: { scope: 'outlet', permission: 'device' } }, async (req, reply) => {
    const q = ordersQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });

    const rows = await withTenant(p.tenantId, async (c) => (await c.query(ORDERS_SQL, [p.outletId, q.data.cursor, q.data.fresh === '1'])).rows);
    const hasMore = rows.length > ORDER_PAGE;
    const page = hasMore ? rows.slice(0, ORDER_PAGE) : rows;
    const last = page[page.length - 1];
    return {
      cursor: last ? Number(last.version) : q.data.cursor,
      hasMore,
      visits: page.map((r) => ({ rootId: r.root_id, version: Number(r.version), sales: r.sales ?? [], open: r.open })),
    };
  });

  // Server-sent "an order at your outlet changed"; the tablet then calls /sync/orders. Payload-free, so the stream
  // can never carry what the reader may not see. Scope: the device's own outlet, from the credential.
  app.get('/sync/orders/stream', { config: { scope: 'outlet', permission: 'device' } }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\nevent: ready\ndata: {}\n\n');
    const unsubscribe = subscribe([ordersTopic(p.outletId)], () => res.write('event: changed\ndata: {}\n\n'));
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(beat); unsubscribe(); });
    return reply;
  });

  // Scope: an enrolled device gets its tenant's catalogue, its own outlet's availability,
  // its own outlet's settings, menu rules and price overrides, and ONLY its own counter's menu rules.
  app.get('/sync/pull', { config: { scope: 'outlet', permission: 'device' } }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });

    const rows = await withTenant(p.tenantId, async (c) => (await c.query(PULL_SQL, [q.data.cursor, p.outletId, p.counterId, p.deviceId])).rows);
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
