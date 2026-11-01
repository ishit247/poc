import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { DEFAULT_SETTINGS, exclusiveLine, paise } from '@pos/shared';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { publish, subscribe } from '../hub.js';

// Online orders (PLAN 11). Online-only calls from a signed-in cashier or manager on an enrolled tablet; they do not
// go through sync_event. Each order is a `sale` on the platform's channel plus an `online_order` carrying the
// lifecycle. The sale stays open until handover, then becomes paid with one aggregator payment; a rejected,
// cancelled or expired order voids it. Online sales belong to no cashier shift (they are not drawer cash).

const idParams = z.object({ id: z.string().uuid() });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

const createBody = z.object({
  channel: z.enum(['zomato', 'swiggy']),
  externalOrderId: z.string().trim().min(1).max(64),
  customerLabel: z.string().trim().max(120).optional(),
  deliveryNote: z.string().trim().max(300).optional(),
  acceptWithinSeconds: z.number().int().min(30).max(900).default(180),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    qty: z.number().int().min(1).max(99),
    // Only when the platform's price differs from the menu's price for that channel.
    unitPaise: z.number().int().min(0).max(100_000_000).optional(),
  }).strict()).min(1).max(50),
}).strict();

const transitionBody = z.object({
  to: z.enum(['accepted', 'preparing', 'ready', 'handed_over', 'rejected', 'cancelled']),
  reason: z.string().trim().min(1).max(200).optional(),
  prepMinutes: z.number().int().min(1).max(240).optional(),
}).strict();

/** THE lifecycle table. The schema trigger (app.online_order_guard) is the floor under it. `expired` is the job's, not a caller's. */
export const NEXT: Record<string, readonly string[]> = {
  received: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['handed_over', 'cancelled'],
};
/** The platform message each move sends. `preparing` and `expired` map to what the platform understands. */
const OUTBOX_ACTION: Record<string, string> = {
  accepted: 'accept', rejected: 'reject', expired: 'reject', ready: 'ready', handed_over: 'handed_over', cancelled: 'cancel',
};
export const ACTIVE =['received', 'accepted', 'preparing', 'ready'];

const COLS = `o.id, o.sale_id AS "saleId", o.outlet_id AS "outletId", o.channel, o.provider, o.external_order_id AS "externalOrderId",
  o.unmapped_lines AS "unmappedLines", o.status, o.accept_by AS "acceptBy", o.prep_minutes AS "prepMinutes", o.customer_label AS "customerLabel",
  o.delivery_note AS "deliveryNote", o.reason, o.price_overridden AS "priceOverridden", o.received_at AS "receivedAt",
  o.status_at AS "statusAt", s.total_paise::bigint AS "totalPaise"`;

/** The scope rule ("whose") for every online-order route: orders at the caller's own outlets. $1 = outlet ids. */
const SCOPE = 'o.outlet_id = ANY($1::uuid[])';

async function localDate(c: pg.PoolClient, outletId: string): Promise<string> {
  return (await c.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM outlet WHERE id = $1`, [outletId])).rows[0].d;
}

async function businessDay(c: pg.PoolClient, tenantId: string, outletId: string, date: string) {
  const r = await c.query(
    `INSERT INTO business_day (tenant_id, outlet_id, date) VALUES ($1, $2, $3)
     ON CONFLICT (outlet_id, date) DO UPDATE SET date = EXCLUDED.date RETURNING id, closed_at IS NOT NULL AS closed`,
    [tenantId, outletId, date]);
  return r.rows[0] as { id: string; closed: boolean };
}

async function fetchOrder(c: pg.PoolClient, outletIds: string[], id: string) {
  const o = (await c.query(`SELECT ${COLS} FROM online_order o JOIN sale s ON s.id = o.sale_id WHERE o.id = $2 AND ${SCOPE}`, [outletIds, id])).rows[0];
  if (!o) return null;
  const lines = (await c.query(
    `SELECT item_id AS "itemId", name_snapshot AS name, unit_price_paise AS "unitPricePaise", qty, line_total_paise AS "lineTotalPaise", tax_paise AS "taxPaise"
       FROM sale_line WHERE sale_id = $1`, [o.saleId])).rows;
  return { ...o, lines };
}

type Actor = { tenantId: string; userId: string; deviceId: string };
/** Set by the webhook path (phase 9): where the order came from, what the platform sent, and lines we could not map. */
export type OrderSource = { provider: 'zomato' | 'swiggy'; rawPayload: string; unmapped: unknown[] };

export async function createOrder(c: pg.PoolClient, a: Actor, outletIds: string[], b: z.infer<typeof createBody>, source?: OrderSource) {
  const dev = (await c.query('SELECT outlet_id FROM device WHERE id = $1', [a.deviceId])).rows[0];
  if (!dev || !outletIds.includes(dev.outlet_id)) return { kind: 'not_found' as const };
  const outletId: string = dev.outlet_id;

  const existing = (await c.query('SELECT id FROM online_order WHERE channel = $1 AND external_order_id = $2', [b.channel, b.externalOrderId])).rows[0];
  if (existing) return { kind: 'existing' as const, id: existing.id as string };

  const ids = [...new Set(b.lines.map((l) => l.itemId))];
  const items = (await c.query(
    `SELECT i.id, i.name, ip.gst_rate_bp AS "gstRateBp", COALESCE(op.price_paise, ip.price_paise)::int AS price
       FROM item i
       JOIN item_price ip ON ip.item_id = i.id AND ip.channel = $2 AND ip.deleted_at IS NULL
       LEFT JOIN outlet_price op ON op.item_id = i.id AND op.outlet_id = $3 AND op.channel = $2 AND op.deleted_at IS NULL
      WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL`, [ids, b.channel, outletId])).rows;
  if (items.length !== ids.length) return { kind: 'unknown_item' as const };
  const byId = new Map(items.map((i) => [i.id as string, i]));

  const s = (await c.query('SELECT gst_rounding FROM tenant_setting')).rows[0];
  const rounding = s?.gst_rounding ?? DEFAULT_SETTINGS.gstRounding;

  let overridden = false;
  let net = 0;
  let tax = 0;
  const priced = b.lines.map((l) => {
    const it = byId.get(l.itemId)!;
    const unit = l.unitPaise ?? it.price;
    if (unit !== it.price) overridden = true;
    const amt = exclusiveLine(paise(unit), l.qty, it.gstRateBp, rounding);
    net += amt.net as number;
    tax += amt.tax as number;
    return { l, it, unit, net: amt.net as number, tax: amt.tax as number };
  });
  if (net + tax <= 0) return { kind: 'zero_total' as const };

  const date = await localDate(c, outletId);
  const version = (await c.query('SELECT COALESCE(max(version), 0)::bigint AS v FROM item_price')).rows[0].v;
  const sale = (await c.query(
    `INSERT INTO sale (id, tenant_id, outlet_id, business_date, device_id, created_by, channel, status, menu_version,
                       subtotal_paise, tax_paise, round_off_paise, total_paise, created_at_device)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'open',$7,$8,$9,0,$10, now()) RETURNING id`,
    [a.tenantId, outletId, date, a.deviceId, a.userId, b.channel, version, net, tax, net + tax])).rows[0];
  for (const p of priced) {
    await c.query(
      `INSERT INTO sale_line (tenant_id, sale_id, item_id, name_snapshot, unit_price_paise, gst_rate_bp, qty, line_total_paise, tax_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.tenantId, sale.id, p.it.id, p.it.name, p.unit, p.it.gstRateBp, p.l.qty, p.net, p.tax]);
  }
  const o = (await c.query(
    `INSERT INTO online_order (tenant_id, outlet_id, sale_id, provider, channel, external_order_id, accept_by, customer_label, delivery_note, price_overridden, raw_payload, unmapped_lines)
     VALUES ($1,$2,$3,$10,$4,$5, now() + make_interval(secs => $6), $7,$8,$9, $11::text::jsonb, $12)
     RETURNING id`,
    [a.tenantId, outletId, sale.id, b.channel, b.externalOrderId, b.acceptWithinSeconds, b.customerLabel ?? null, b.deliveryNote ?? null, overridden,
      source?.provider ?? 'manual', source?.rawPayload ?? null, JSON.stringify(source?.unmapped ?? [])])).rows[0];
  await c.query(
    `INSERT INTO online_order_event (tenant_id, online_order_id, from_status, to_status, actor_id, device_id, detail) VALUES ($1,$2,NULL,'received',$3,$4,$5)`,
    [a.tenantId, o.id, a.userId, a.deviceId, { priceOverridden: overridden }]);
  await audit(c, { tenantId: a.tenantId, actorKind: 'user', actorId: a.userId, action: 'online_order.create', entity: 'online_order', entityId: o.id,
    detail: { channel: b.channel, externalOrderId: b.externalOrderId, priceOverridden: overridden } });
  return { kind: 'created' as const, id: o.id as string };
}

/** Every status change goes through here: the table, the sale's consequence, the event row, the audit row. */
export async function moveOrder(c: pg.PoolClient, a: { tenantId: string; userId: string | null; deviceId: string | null }, outletIds: string[], id: string,
    to: string, extra: { reason?: string; prepMinutes?: number }) {
  const o = (await c.query(
    `SELECT o.id, o.sale_id, o.outlet_id, o.status FROM online_order o WHERE o.id = $2 AND ${SCOPE} FOR UPDATE`, [outletIds, id])).rows[0];
  if (!o) return { kind: 'not_found' as const };
  const from = o.status as string;
  if (!(NEXT[from] ?? []).includes(to) && !(to === 'expired' && from === 'received')) return { kind: 'bad_move' as const, from };
  if ((to === 'rejected' || to === 'cancelled' || to === 'expired') && !extra.reason) return { kind: 'reason_required' as const };

  if (to === 'handed_over') {
    const date = await localDate(c, o.outlet_id);
    const day = await businessDay(c, a.tenantId, o.outlet_id, date);
    const sale = (await c.query('SELECT total_paise FROM sale WHERE id = $1', [o.sale_id])).rows[0];
    await c.query(
      `UPDATE sale SET status = 'paid', business_date = $2, business_day_id = $3,
              flags = CASE WHEN $4 THEN array_append(flags, 'late_arrival') ELSE flags END WHERE id = $1`,
      [o.sale_id, date, day.id, day.closed]);
    await c.query(`INSERT INTO payment (tenant_id, sale_id, method, amount_paise) VALUES ($1,$2,'aggregator',$3)`, [a.tenantId, o.sale_id, sale.total_paise]);
  } else if (to === 'rejected' || to === 'cancelled' || to === 'expired') {
    await c.query(`UPDATE sale SET status = 'void', void_reason = $2 WHERE id = $1`, [o.sale_id, `online order ${to}: ${extra.reason}`]);
  }
  await c.query(
    `UPDATE online_order SET status = $2, status_at = now(), reason = COALESCE($3, reason), prep_minutes = COALESCE($4, prep_minutes) WHERE id = $1`,
    [id, to, extra.reason ?? null, extra.prepMinutes ?? null]);
  await c.query(
    `INSERT INTO online_order_event (tenant_id, online_order_id, from_status, to_status, actor_id, device_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.tenantId, id, from, to, a.userId, a.deviceId, { reason: extra.reason ?? null }]);
  await audit(c, { tenantId: a.tenantId, actorKind: a.userId ? 'user' : 'system', actorId: a.userId, action: `online_order.${to}`, entity: 'online_order', entityId: id, detail: { from, reason: extra.reason ?? null } });
  const action = OUTBOX_ACTION[to];
  if (action) {
    // Same transaction as the move: the message exists exactly when the move does. The dedupe key makes it one per action.
    await c.query(
      `INSERT INTO integration_outbox (tenant_id, outlet_id, online_order_id, provider, action, payload, dedupe_key)
       SELECT tenant_id, outlet_id, id, provider, $2, $3, id::text || ':' || $2 FROM online_order WHERE id = $1
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [id, action, { reason: extra.reason ?? null, prepMinutes: extra.prepMinutes ?? null }]);
  }
  return { kind: 'ok' as const };
}

export const onlineRoutes: FastifyPluginAsync = async (app) => {
  const cfg = { scope: 'outlet', permission: 'till' } as const;

  app.get('/online-orders', { config: cfg }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    return withTenant(p.tenantId, async (c) => (await c.query(
      `SELECT ${COLS} FROM online_order o JOIN sale s ON s.id = o.sale_id
        WHERE ${SCOPE} AND o.status = ANY($2::text[]) ORDER BY o.received_at LIMIT 200`, [p.outletIds, ACTIVE])).rows);
  });

  // Server-sent events: "something changed at your outlets". The client refetches the list. Scope: the outlets of the
  // signed-in caller, taken from the session, never from the request. The browser's EventSource cannot send an
  // Authorization header, so the tablet reads this with fetch.
  app.get('/online-orders/stream', { config: cfg }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\nevent: ready\ndata: {}\n\n');
    const unsubscribe = subscribe(p.outletIds, () => res.write('event: changed\ndata: {}\n\n'));
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(beat); unsubscribe(); });
    return reply;
  });

  app.get('/online-orders/:id', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    if (!ps.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const out = await withTenant(p.tenantId, (c) => fetchOrder(c, p.outletIds, ps.data.id));
    return out ?? notFound(reply);
  });

  app.post('/online-orders', { config: cfg }, async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    if (!p.deviceId) return reply.code(409).send({ error: 'device_required' }); // an online order is keyed at an enrolled tablet
    const a = { tenantId: p.tenantId, userId: p.userId, deviceId: p.deviceId };
    const run = () => withTenant(p.tenantId, async (c) => {
      const r = await createOrder(c, a, p.outletIds, b.data);
      return r.kind === 'created' || r.kind === 'existing' ? { ...r, order: await fetchOrder(c, p.outletIds, r.id) } : r;
    });
    let r;
    try {
      r = await run();
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e; // a concurrent request created the same platform order: return that one
      r = await run();
    }
    switch (r.kind) {
      case 'created': publish(r.order.outletId); return reply.code(201).send(r.order);
      case 'existing': return r.order ? r.order : notFound(reply); // same platform order id: the order we already have
      case 'unknown_item': return reply.code(422).send({ error: 'unknown_item' });
      case 'zero_total': return reply.code(422).send({ error: 'zero_total' });
      default: return notFound(reply);
    }
  });

  app.post('/online-orders/:id/transition', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = transitionBody.safeParse(req.body);
    if (!ps.success || !b.success) return reply.code(400).send({ error: 'invalid request' });
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const r = await withTenant(p.tenantId, async (c) => {
      const m = await moveOrder(c, { tenantId: p.tenantId, userId: p.userId, deviceId: p.deviceId }, p.outletIds, ps.data.id, b.data.to, b.data);
      return m.kind === 'ok' ? { ...m, order: await fetchOrder(c, p.outletIds, ps.data.id) } : m;
    });
    switch (r.kind) {
      case 'ok': publish(r.order.outletId); return r.order;
      case 'bad_move': return reply.code(409).send({ error: 'bad_move', from: r.from });
      case 'reason_required': return reply.code(422).send({ error: 'reason_required' });
      default: return notFound(reply);
    }
  });
};
