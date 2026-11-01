import type { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { pool, withTenant } from '../db.js';
import { providers, type Channel, type NormalisedOrder } from '../providers/index.js';
import { createOrder } from './online.js';
import { publish } from '../hub.js';

// Inbound platform orders (PLAN 11). Public routes: a platform has no session, so the caller is proven by an HMAC
// signature made with the secret of the outlet it names. The tenant comes from that outlet's integration row,
// never from the request. The paths are fixed (no :id), so there is no record id for a caller to aim at.
//
// Order of checks matters: look up the outlet -> verify the signature -> only then write anything. An unsigned
// request leaves no row, so strangers cannot fill inbound_event.

type Integration = { id: string; tenantId: string; outletId: string; secret: string; serviceUserId: string; deviceId: string };

/** The cross-tenant read: which outlet is this store id? Through the `webhook_lookup` window (see 0006). */
export async function findIntegration(channel: Channel, storeId: string): Promise<Integration | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.job', 'webhook', true)");
    const r = await c.query(
      `SELECT id, tenant_id AS "tenantId", outlet_id AS "outletId", webhook_secret AS secret, service_user_id AS "serviceUserId", device_id AS "deviceId"
         FROM outlet_integration WHERE channel = $1 AND external_store_id = $2`, [channel, storeId]);
    await c.query('COMMIT');
    return r.rows[0] ?? null;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

type Outcome = { status: number; result: 'created' | 'duplicate' | 'rejected'; detail?: string; id?: string };

async function ingest(c: pg.PoolClient, ch: Channel, integ: Integration, o: NormalisedOrder, raw: string): Promise<Outcome> {
  const maps = (await c.query(
    `SELECT external_item_id AS ext, item_id AS "itemId" FROM item_channel_map WHERE outlet_id = $1 AND channel = $2 AND external_item_id = ANY($3::text[])`,
    [integ.outletId, ch, o.lines.map((l) => l.externalItemId)])).rows;
  const byExt = new Map<string, string>(maps.map((m) => [m.ext, m.itemId]));
  const lines = o.lines.filter((l) => byExt.has(l.externalItemId)).map((l) => ({ itemId: byExt.get(l.externalItemId)!, qty: l.qty, unitPaise: l.unitPaise }));
  const unmapped = o.lines.filter((l) => !byExt.has(l.externalItemId));
  if (lines.length === 0) return { status: 422, result: 'rejected', detail: 'no line maps to a menu item' };

  const r = await createOrder(c, { tenantId: integ.tenantId, userId: integ.serviceUserId, deviceId: integ.deviceId }, [integ.outletId],
    { channel: ch, externalOrderId: o.externalOrderId, customerLabel: o.customerLabel, deliveryNote: o.deliveryNote, acceptWithinSeconds: 180, lines },
    { provider: ch, rawPayload: raw, unmapped });
  switch (r.kind) {
    case 'created': return { status: 201, result: 'created', id: r.id };
    case 'existing': return { status: 200, result: 'duplicate', id: r.id };
    case 'unknown_item': return { status: 422, result: 'rejected', detail: 'a mapped item has no price on this channel' };
    case 'zero_total': return { status: 422, result: 'rejected', detail: 'order total is zero' };
    default: return { status: 422, result: 'rejected', detail: 'outlet or counter not found' };
  }
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // The signature covers the exact bytes, so keep them: parse the JSON ourselves from the same string.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  for (const ch of ['zomato', 'swiggy'] as const) {
    app.post(`/webhooks/${ch}`, { config: { scope: 'public' } }, async (req, reply) => {
      const provider = providers[ch];
      const raw = typeof req.body === 'string' ? req.body : '';
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return reply.code(400).send({ error: 'bad request' }); }
      const storeId = provider.storeIdOf(json);
      if (!storeId) return reply.code(400).send({ error: 'bad request' });

      // An unknown store and a bad signature look the same from outside.
      const integ = await findIntegration(ch, storeId);
      const ts = String(req.headers['x-timestamp'] ?? '');
      const sig = String(req.headers['x-signature'] ?? '');
      if (!integ || !provider.verifySignature(integ.secret, ts, raw, sig)) return reply.code(401).send({ error: 'unauthorized' });

      let parsed: NormalisedOrder | null = null;
      try { parsed = provider.parseInbound(json); } catch { /* recorded below as rejected */ }

      const out = await withTenant(integ.tenantId, async (c) => {
        const o: Outcome = parsed ? await ingest(c, ch, integ, parsed, raw) : { status: 422, result: 'rejected', detail: 'payload does not match the expected shape' };
        await c.query(`INSERT INTO inbound_event (tenant_id, outlet_id, channel, result, detail, raw_payload) VALUES ($1,$2,$3,$4,$5,$6)`,
          [integ.tenantId, integ.outletId, ch, o.result, o.detail ?? null, raw]);
        await c.query('UPDATE outlet_integration SET last_event_at = now() WHERE id = $1', [integ.id]);
        return o;
      });
      if (out.result === 'created') publish(integ.outletId);
      return reply.code(out.status).send({ result: out.result, ...(out.detail ? { detail: out.detail } : {}), ...(out.id ? { id: out.id } : {}) });
    });
  }
};
