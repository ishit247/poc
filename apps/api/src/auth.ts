// Authentication hook. Credentials embed the tenant id so lookup stays inside
// RLS (no bypass role):
//   Bearer <tenantId>.<sessionId>.<secret>   manager/cashier session
//   Device <tenantId>.<deviceId>.<secret>    enrolled device
// Any malformed, unknown, expired, revoked or mismatching credential yields the
// same 401, so nothing is learned from the failure.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tenantForHost, withTenant } from './db.js';
import { safeEqualHex, sha256 } from './security/crypto.js';
import type { Permission, Principal } from './scope.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CRED = new RegExp(`^(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

const APP_VERSION = /^[A-Za-z0-9._+-]{1,40}$/;

function parse(header: string | undefined): { scheme: 'Bearer' | 'Device'; tenantId: string; id: string; secret: string } | null {
  if (!header) return null;
  const sp = header.indexOf(' ');
  const scheme = header.slice(0, sp);
  if (scheme !== 'Bearer' && scheme !== 'Device') return null;
  const m = CRED.exec(header.slice(sp + 1));
  return m ? { scheme, tenantId: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), secret: m[3]! } : null;
}

async function authenticate(req: FastifyRequest): Promise<Principal | null> {
  const p = parse(req.headers.authorization);
  if (!p) return null;
  const hash = sha256(p.secret);

  if (p.scheme === 'Bearer') {
    return withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        // A PIN session (device_id set) dies with its device: revoking the tablet ends it.
        `SELECT s.token_hash, s.device_id, u.id AS user_id, u.role,
                COALESCE(array_agg(uo.outlet_id) FILTER (WHERE uo.outlet_id IS NOT NULL), '{}') AS outlet_ids
           FROM session s
           JOIN app_user u ON u.id = s.user_id AND u.active
           LEFT JOIN device d ON d.id = s.device_id
           LEFT JOIN user_outlet uo ON uo.user_id = u.id AND uo.deleted_at IS NULL
          WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND (s.device_id IS NULL OR d.revoked_at IS NULL)
          GROUP BY s.token_hash, s.device_id, u.id, u.role`, [p.id]);
      const row = r.rows[0];
      if (!row || !safeEqualHex(row.token_hash, hash)) return null;
      return { kind: 'user', tenantId: p.tenantId, userId: row.user_id, role: row.role, outletIds: row.outlet_ids, sessionId: p.id, deviceId: row.device_id } as Principal;
    });
  }

  return withTenant(p.tenantId, async (c) => {
    const r = await c.query(
      'SELECT credential_hash, outlet_id, counter_id FROM device WHERE id = $1 AND revoked_at IS NULL', [p.id]);
    const row = r.rows[0];
    if (!row || !safeEqualHex(row.credential_hash, hash)) return null;
    // The tablet reports its build on every request; a malformed value is ignored, not trusted.
    const reported = req.headers['x-app-version'];
    const appVersion = typeof reported === 'string' && APP_VERSION.test(reported) ? reported : null;
    await c.query('UPDATE device SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE id = $1', [p.id, appVersion]);
    return { kind: 'device', tenantId: p.tenantId, deviceId: p.id, outletId: row.outlet_id, counterId: row.counter_id } as Principal;
  });
}

export function allowed(permission: Permission, p: Principal): boolean {
  switch (permission) {
    case 'manager': return p.kind === 'user' && p.role === 'manager';
    case 'till': return p.kind === 'user' && (p.role === 'manager' || p.role === 'cashier');
    case 'staff': return p.kind === 'user';
    case 'device': return p.kind === 'device';
  }
}

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const cfg = req.routeOptions.config;
    req.hostTenantId = await tenantForHost(req.headers.host);
    if (cfg.scope === 'public') return;
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    // A credential from one tenant presented on another tenant's address is refused (RLS would stop the
    // data anyway; this keeps the address and the account in agreement). A bare/unknown host is not judged.
    if (req.hostTenantId && req.hostTenantId !== principal.tenantId) return reply.code(401).send({ error: 'unauthorized' });
    // Deny by default: a route with no permission (cannot happen past onRoute) is refused.
    if (!cfg.permission || !allowed(cfg.permission, principal)) return reply.code(403).send({ error: 'forbidden' });
    req.principal = principal;
  });
}
