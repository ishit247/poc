// Authentication hook. Credentials embed the tenant id so lookup stays inside
// RLS (no bypass role):
//   Bearer <tenantId>.<sessionId>.<secret>   manager/cashier session
//   Device <tenantId>.<deviceId>.<secret>    enrolled device
// Any malformed, unknown, expired, revoked or mismatching credential yields the
// same 401, so nothing is learned from the failure.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { requestMode, tenantForHost, withPlatform, withTenant } from './db.js';
import { safeEqualHex, sha256 } from './security/crypto.js';
import type { Permission, PlatformAdmin, Principal } from './scope.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CRED = new RegExp(`^(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

const APP_VERSION = /^[A-Za-z0-9._+-]{1,40}$/;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function parse(header: string | undefined): { scheme: 'Bearer' | 'Device' | 'Support'; tenantId: string; id: string; secret: string } | null {
  if (!header) return null;
  const sp = header.indexOf(' ');
  const scheme = header.slice(0, sp);
  if (scheme !== 'Bearer' && scheme !== 'Device' && scheme !== 'Support') return null;
  const m = CRED.exec(header.slice(sp + 1));
  return m ? { scheme, tenantId: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), secret: m[3]! } : null;
}

/** A suspended tenant is refused here (not as "unknown credential"), so a tablet can tell the operator's decision from a typo. */
async function isSuspended(c: PoolClient, tenantId: string): Promise<boolean> {
  const r = await c.query('SELECT suspended_at FROM tenant WHERE id = $1', [tenantId]);
  return r.rows[0]?.suspended_at != null;
}

// --- platform console credential: "Platform <sessionId>.<secret>" ----------------------------------------
const PLATFORM_CRED = new RegExp(`^Platform (${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

async function authenticatePlatform(req: FastifyRequest): Promise<PlatformAdmin | null> {
  const m = PLATFORM_CRED.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const sessionId = m[1]!.toLowerCase();
  return withPlatform(async (c) => {
    const r = await c.query(
      `SELECT s.token_hash, a.id AS admin_id, a.role
         FROM platform_session s JOIN platform_admin a ON a.id = s.admin_id AND a.active
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sessionId]);
    const row = r.rows[0];
    if (!row || !safeEqualHex(row.token_hash, sha256(m[2]!))) return null;
    return { adminId: row.admin_id, role: row.role, sessionId } as PlatformAdmin;
  });
}

/** Console routes are served only on PLATFORM_HOST when it is set, so they can sit behind a VPN or allowlist. */
function wrongPlatformHost(req: FastifyRequest): boolean {
  const want = process.env.PLATFORM_HOST?.toLowerCase();
  if (!want) return false;
  const have = (req.headers.host ?? '').toLowerCase().replace(/:\d{1,5}$/, '');
  return have !== want;
}

async function authenticate(req: FastifyRequest): Promise<Principal | 'suspended' | null> {
  const p = parse(req.headers.authorization);
  if (!p) return null;
  const hash = sha256(p.secret);

  // An operator's impersonation grant (platform console, 0009). Expiry (30 min) and early end are checked on every request.
  if (p.scheme === 'Support') {
    return withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        'SELECT token_hash FROM impersonation WHERE id = $1 AND ended_at IS NULL AND expires_at > now()', [p.id]);
      const row = r.rows[0];
      if (!row || !safeEqualHex(row.token_hash, hash)) return null;
      if (await isSuspended(c, p.tenantId)) return 'suspended' as const;
      const outlets = (await c.query('SELECT id FROM outlet')).rows.map((o) => o.id as string);
      return { kind: 'user', tenantId: p.tenantId, userId: NIL_UUID, role: 'manager', outletIds: outlets, sessionId: p.id, deviceId: null, support: { impersonationId: p.id } } as Principal;
    });
  }

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
      if (await isSuspended(c, p.tenantId)) return 'suspended' as const;
      return { kind: 'user', tenantId: p.tenantId, userId: row.user_id, role: row.role, outletIds: row.outlet_ids, sessionId: p.id, deviceId: row.device_id } as Principal;
    });
  }

  return withTenant(p.tenantId, async (c) => {
    // A route may opt in to revoked devices; it is then told when revocation happened and must judge
    // each event against it. Every other route sees a revoked device as unknown.
    const allowRevoked = req.routeOptions.config.allowRevokedDevice === true;
    const r = await c.query(
      `SELECT credential_hash, outlet_id, counter_id, revoked_at FROM device WHERE id = $1 AND ($2 OR revoked_at IS NULL)`, [p.id, allowRevoked]);
    const row = r.rows[0];
    if (!row || !safeEqualHex(row.credential_hash, hash)) return null;
    if (await isSuspended(c, p.tenantId)) return 'suspended' as const;
    // The tablet reports its build on every request; a malformed value is ignored, not trusted.
    const reported = req.headers['x-app-version'];
    const appVersion = typeof reported === 'string' && APP_VERSION.test(reported) ? reported : null;
    const pending = Number(req.headers['x-outbox-pending']);
    const outboxPending = Number.isInteger(pending) && pending >= 0 && pending < 1_000_000 ? pending : null;
    await c.query(
      'UPDATE device SET last_seen_at = now(), app_version = COALESCE($2, app_version), outbox_pending = COALESCE($3, outbox_pending) WHERE id = $1',
      [p.id, appVersion, outboxPending]);
    return { kind: 'device', tenantId: p.tenantId, deviceId: p.id, outletId: row.outlet_id, counterId: row.counter_id, revokedAt: row.revoked_at ?? null } as Principal;
  });
}

export function allowed(permission: Permission, p: Principal): boolean {
  switch (permission) {
    case 'manager': return p.kind === 'user' && p.role === 'manager';
    case 'till': return p.kind === 'user' && (p.role === 'manager' || p.role === 'cashier');
    case 'staff': return p.kind === 'user';
    case 'device': return p.kind === 'device';
    case 'platform-owner':
    case 'platform-any': return false; // console permissions are judged by allowedAdmin, never against a tenant principal
  }
}

export function allowedAdmin(permission: Permission, a: PlatformAdmin): boolean {
  switch (permission) {
    case 'platform-owner': return a.role === 'owner';
    case 'platform-any': return true;
    default: return false;
  }
}

export function registerAuth(app: FastifyInstance) {
  // Opens the per-request store that withTenant reads. Callback style, so the whole request runs inside it.
  app.addHook('onRequest', (_req, _reply, done) => { requestMode.run({ readOnly: false }, done); });

  app.addHook('onRequest', async (req, reply) => {
    const cfg = req.routeOptions.config;
    // Everything under /platform (login included) answers only on the console's own address when one is configured.
    if (req.url.startsWith('/platform/') && wrongPlatformHost(req)) return reply.code(404).send({ error: 'request failed' });
    req.hostTenantId = await tenantForHost(req.headers.host);
    if (cfg.scope === 'public') return;
    if (cfg.scope === 'platform') {
      const admin = await authenticatePlatform(req);
      if (!admin) return reply.code(401).send({ error: 'unauthorized' });
      if (!cfg.permission || !allowedAdmin(cfg.permission, admin)) return reply.code(403).send({ error: 'forbidden' });
      req.admin = admin;
      return;
    }
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (principal === 'suspended') return reply.code(403).send({ error: 'tenant suspended' });
    // Deny by default: a route with no permission (cannot happen past onRoute) is refused.
    if (!cfg.permission || !allowed(cfg.permission, principal)) return reply.code(403).send({ error: 'forbidden' });
    // Support access is read-only: refused here by method, and again by Postgres (every transaction of this request
    // is READ ONLY). A route that wrote on GET would fail the second, not slip through.
    if (principal.kind === 'user' && principal.support) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(403).send({ error: 'read-only support session' });
      const mode = requestMode.getStore();
      if (!mode) return reply.code(500).send({ error: 'request failed' }); // cannot happen; never fall back to read-write
      mode.readOnly = true;
    }
    req.principal = principal;
  });
}
