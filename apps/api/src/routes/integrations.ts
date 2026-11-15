import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { sealWebhookSecret, WEBHOOK_SECRET_MIN } from '../security/crypto.js';

// Manager setup for the aggregator adapters (phase 9, 0006): how a platform names this outlet, the webhook secret,
// and which of our items each platform item id is. Read by the webhook path (routes/webhooks.ts).

const uuid = z.string().uuid();
const channel = z.enum(['zomato', 'swiggy']);
// Ids as the platform sends them: printable, no spaces. The lengths match the 0006 checks.
const externalId = z.string().trim().regex(/^[\x21-\x7e]{1,64}$/);

const outletParams = z.object({ id: uuid });
const channelParams = z.object({ id: uuid, channel });
const mapParams = z.object({ id: uuid, mapId: uuid });
const mapQuery = z.object({ channel }).strict();
const mapBody = z.object({ channel, externalItemId: externalId, itemId: uuid }).strict();
const integrationBody = z.object({
  externalStoreId: externalId,
  // Required when the integration is first saved; left out afterwards, the stored secret is kept.
  webhookSecret: z.string().min(WEBHOOK_SECRET_MIN).max(200).regex(/^[\x21-\x7e]+$/).optional(),
  serviceUserId: uuid,
  deviceId: uuid,
  enabled: z.boolean(),
}).strict();

const bad = (reply: FastifyReply, error = 'invalid request') => reply.code(400).send({ error });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // Scope: a manager sets up only outlets assigned to them (checked before any query); RLS pins the tenant.
  // A map id or integration is always looked up together with that outlet, so an id from another outlet is 404.
  const cfg = { scope: 'outlet', permission: 'manager' } as const;

  // Never returns the secret, sealed or not.
  app.get('/outlets/:id/integrations', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      const integrations = await c.query(
        `SELECT channel, external_store_id AS "externalStoreId", service_user_id AS "serviceUserId", device_id AS "deviceId",
                enabled, last_event_at AS "lastEventAt"
           FROM outlet_integration WHERE outlet_id = $1 ORDER BY channel`, [ps.data.id]);
      const devices = await c.query(
        `SELECT d.id, COALESCE(d.label, 'Counter ' || c.code) AS name FROM device d JOIN counter c ON c.id = d.counter_id
          WHERE d.outlet_id = $1 AND d.revoked_at IS NULL ORDER BY 2`, [ps.data.id]);
      const users = await c.query(
        `SELECT u.id, u.name, u.role FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
          WHERE uo.outlet_id = $1 AND uo.deleted_at IS NULL AND u.active ORDER BY u.name`, [ps.data.id]);
      // The evidence when an order "never arrived": the latest calls, without the payload.
      const events = await c.query(
        `SELECT channel, result, detail, received_at AS "receivedAt" FROM inbound_event
          WHERE outlet_id = $1 ORDER BY received_at DESC LIMIT 20`, [ps.data.id]);
      return { integrations: integrations.rows, devices: devices.rows, users: users.rows, events: events.rows };
    });
  });

  app.put('/outlets/:id/integrations/:channel', { config: cfg }, async (req, reply) => {
    const ps = channelParams.safeParse(req.params);
    const b = integrationBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    const { id: outletId, channel: ch } = ps.data;
    const { externalStoreId, webhookSecret, serviceUserId, deviceId, enabled } = b.data;
    let r: 'ok' | 'no_device' | 'no_user' | 'no_secret';
    try {
      r = await withTenant(p.tenantId, async (c) => {
      // Both must belong to this outlet: the order lands on that tablet and is booked to that person.
      const ok = (await c.query(
        `SELECT EXISTS (SELECT 1 FROM device WHERE id = $2 AND outlet_id = $1 AND revoked_at IS NULL) AS dev,
                EXISTS (SELECT 1 FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id
                         WHERE u.id = $3 AND uo.outlet_id = $1 AND uo.deleted_at IS NULL AND u.active) AS usr`,
        [outletId, deviceId, serviceUserId])).rows[0];
      if (!ok.dev) return 'no_device';
      if (!ok.usr) return 'no_user';

      const existing = (await c.query('SELECT id FROM outlet_integration WHERE outlet_id = $1 AND channel = $2 FOR UPDATE', [outletId, ch])).rows[0];
      if (existing) {
        await c.query(
          `UPDATE outlet_integration SET external_store_id = $2, service_user_id = $3, device_id = $4, enabled = $5,
                  webhook_secret_sealed = COALESCE($6, webhook_secret_sealed) WHERE id = $1`,
          [existing.id, externalStoreId, serviceUserId, deviceId, enabled, webhookSecret ? sealWebhookSecret(existing.id, webhookSecret) : null]);
      } else {
        if (!webhookSecret) return 'no_secret';
        // The id is made here because the sealed secret is bound to it.
        const id = randomUUID();
        await c.query(
          `INSERT INTO outlet_integration (id, tenant_id, outlet_id, channel, external_store_id, webhook_secret_sealed, service_user_id, device_id, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, p.tenantId, outletId, ch, externalStoreId, sealWebhookSecret(id, webhookSecret), serviceUserId, deviceId, enabled]);
      }
      await audit(c, {
        tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: existing ? 'integration.update' : 'integration.create',
        entity: 'outlet', entityId: outletId,
        detail: { channel: ch, externalStoreId, serviceUserId, deviceId, enabled, secretChanged: !!webhookSecret },
      });
      return 'ok';
      });
    } catch (e) {
      // The store id is unique per platform across all tenants (it is how a webhook finds its tenant), so another
      // tenant's row can be what refuses it; RLS hides that row, the unique index does not.
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'store id already in use' });
      throw e;
    }
    switch (r) {
      case 'ok': return { ok: true };
      case 'no_device': return bad(reply, 'tablet not at this outlet');
      case 'no_user': return bad(reply, 'person not at this outlet');
      case 'no_secret': return bad(reply, 'webhook secret required');
    }
  });

  // Mapped ids, plus platform items that arrived on an order and are still unmapped (the kitchen saw them flagged).
  app.get('/outlets/:id/item-maps', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const q = mapQuery.safeParse(req.query);
    if (!ps.success || !q.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      // `priced` mirrors createOrder (routes/online.ts): an item needs a live item_price on the channel, or the
      // webhook rejects the order with "a mapped item has no price on this channel".
      const maps = await c.query(
               `SELECT m.id, m.external_item_id AS "externalItemId", m.item_id AS "itemId", i.name AS "itemName",
                        (i.deleted_at IS NULL AND EXISTS (SELECT 1 FROM item_price ip
                           WHERE ip.item_id = m.item_id AND ip.channel = m.channel AND ip.deleted_at IS NULL)) AS priced
                   FROM item_channel_map m JOIN item i ON i.id = m.item_id
                  WHERE m.outlet_id = $1 AND m.channel = $2 ORDER BY i.name, m.external_item_id`, [ps.data.id, q.data.channel]);
      const unmapped = await c.query(
               `SELECT l->>'externalItemId' AS "externalItemId", (array_agg(l->>'name' ORDER BY o.received_at DESC))[1] AS name,
                        count(*)::int AS orders, max(o.received_at) AS "lastSeen"
                   FROM online_order o CROSS JOIN LATERAL jsonb_array_elements(o.unmapped_lines) l
                  WHERE o.outlet_id = $1 AND o.channel = $2 AND o.received_at > now() - interval '30 days'
                    AND jsonb_array_length(o.unmapped_lines) > 0
                    AND NOT EXISTS (SELECT 1 FROM item_channel_map m
                                     WHERE m.outlet_id = o.outlet_id AND m.channel = o.channel AND m.external_item_id = l->>'externalItemId')
                  GROUP BY 1 ORDER BY max(o.received_at) DESC LIMIT 100`, [ps.data.id, q.data.channel]);
      return { maps: maps.rows, unmapped: unmapped.rows };
    });
  });

  // Maps one platform id to an item; mapping the same id again moves it to the new item.
  app.put('/outlets/:id/item-maps', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = mapBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      const item = (await c.query('SELECT 1 FROM item WHERE id = $1 AND deleted_at IS NULL', [b.data.itemId])).rows[0];
      if (!item) return notFound(reply);
      const row = (await c.query(
        `INSERT INTO item_channel_map (tenant_id, outlet_id, channel, external_item_id, item_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (outlet_id, channel, external_item_id) DO UPDATE SET item_id = EXCLUDED.item_id RETURNING id`,
        [p.tenantId, ps.data.id, b.data.channel, b.data.externalItemId, b.data.itemId])).rows[0];
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'item_map.set', entity: 'item_channel_map', entityId: row.id, detail: b.data });
      return { id: row.id };
    });
  });

  app.delete('/outlets/:id/item-maps/:mapId', { config: cfg }, async (req, reply) => {
    const ps = mapParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    return withTenant(p.tenantId, async (c) => {
      const gone = (await c.query(
        'DELETE FROM item_channel_map WHERE id = $1 AND outlet_id = $2 RETURNING channel, external_item_id AS "externalItemId", item_id AS "itemId"',
        [ps.data.mapId, ps.data.id])).rows[0];
      if (!gone) return notFound(reply);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'item_map.remove', entity: 'item_channel_map', entityId: ps.data.mapId, detail: gone });
      return { ok: true };
    });
  });
};
