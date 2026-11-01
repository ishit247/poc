// Platform console API (PLAN 5, 15, 18). Everything here is scope 'platform': outside any tenant, answered only
// to a signed-in platform_admin, and on the app_platform database role, which cannot read sales or users.
// The one tenant-side write (the first manager) goes through withTenant, the same stamped path the tenant API uses.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withPlatform, withTenant } from '../db.js';
import { audit } from '../audit.js';
import { healthWarnings } from '../platformHealth.js';
import { platformAudit } from '../platformAudit.js';
import { insertInvite, newInvite } from '../invite.js';
import { newSecret, sha256 } from '../security/crypto.js';
import { DUMMY_HASH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../security/password.js';
import { matchTotp } from '../security/totp.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const SESSION_MINUTES = 120; // short and absolute: no sliding extension

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const loginBody = z.object({
  email: z.string().email().max(254), password: z.string().min(1).max(256), code: z.string().max(10),
}).strict();
// Same shape as the database CHECK on tenant.subdomain (reserved names are refused there).
const subdomain = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
const tenantBody = z.object({ name: z.string().trim().min(1).max(100), subdomain: subdomain.optional() }).strict();
const renameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
// Without a password the manager is invited: the operator never learns the password (see 0010_manager_invite.sql).
const managerBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(256).optional(),
  outletIds: z.array(uuid).max(50).optional(),
}).strict();
const outletBody = z.object({
  name: z.string().trim().min(1).max(100),
  counters: z.array(z.string().regex(/^[A-Za-z0-9-]{1,20}$/)).min(1).max(20).default(['C1']),
}).strict();
const managerParams = z.object({ id: uuid, uid: uuid });

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });
const strict = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

const TENANT_SELECT = `
  SELECT t.id, t.name, t.subdomain, t.created_at AS "createdAt", t.suspended_at AS "suspendedAt",
         (SELECT count(*)::int FROM outlet o WHERE o.tenant_id = t.id) AS outlets,
         (SELECT count(*)::int FROM device d WHERE d.tenant_id = t.id AND d.revoked_at IS NULL) AS devices
    FROM tenant t`;

export const platformRoutes: FastifyPluginAsync = async (app) => {
  const any = { scope: 'platform', permission: 'platform-any' } as const;
  const owner = { scope: 'platform', permission: 'platform-owner' } as const;

  // --- sign in: password AND a fresh authenticator code, one generic failure ------------------------------
  app.post('/platform/login', { config: { scope: 'public', ...strict(10) } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const { email, password, code } = body.data;

    const result = await withPlatform(async (c) => {
      const a = (await c.query(
        `SELECT id, password_hash, totp_secret, totp_last_step, failed_logins, (locked_until IS NOT NULL AND locked_until > now()) AS locked
           FROM platform_admin WHERE lower(email) = lower($1) AND active FOR UPDATE`, [email])).rows[0];
      // Always burn one hash verification so timing does not reveal whether the account exists or is locked.
      const passwordOk = await verifyPassword(password, a?.password_hash ?? DUMMY_HASH);
      if (!a || a.locked) return null;

      const step = matchTotp(a.totp_secret, code);
      // A step at or below the last accepted one is a replay of a code already used.
      const codeOk = step !== null && step > Number(a.totp_last_step);
      if (!passwordOk || !codeOk) {
        const lock = a.failed_logins + 1 >= MAX_FAILED_LOGINS;
        await c.query(
          `UPDATE platform_admin SET failed_logins = CASE WHEN $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
          [a.id, lock, LOCK_MINUTES]);
        await platformAudit(c, { adminId: a.id, action: lock ? 'login.locked' : 'login.failed', entity: 'platform_admin', entityId: a.id });
        return null;
      }

      await c.query('UPDATE platform_admin SET failed_logins = 0, locked_until = NULL, totp_last_step = $2 WHERE id = $1', [a.id, step]);
      const sessionId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const secret = newSecret();
      const exp = await c.query(
        `INSERT INTO platform_session (id, admin_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at`, [sessionId, a.id, sha256(secret), SESSION_MINUTES]);
      await platformAudit(c, { adminId: a.id, action: 'login.ok', entity: 'platform_session', entityId: sessionId });
      return { token: `${sessionId}.${secret}`, expiresAt: exp.rows[0].expires_at as Date };
    });
    return result ?? reply.code(401).send({ error: 'invalid credentials' });
  });

  app.post('/platform/logout', { config: any }, async (req) => {
    const a = req.admin!;
    await withPlatform(async (c) => {
      await c.query('UPDATE platform_session SET revoked_at = now() WHERE id = $1', [a.sessionId]);
      await platformAudit(c, { adminId: a.adminId, action: 'logout', entity: 'platform_session', entityId: a.sessionId });
    });
    return { ok: true };
  });

  app.get('/platform/me', { config: any }, async (req) => {
    const a = req.admin!;
    return withPlatform(async (c) =>
      (await c.query('SELECT id, name, email, role FROM platform_admin WHERE id = $1', [a.adminId])).rows[0]);
  });

  // --- tenants ----------------------------------------------------------------------------------------------
  app.get('/platform/tenants', { config: any }, async () =>
    withPlatform(async (c) => (await c.query(`${TENANT_SELECT} ORDER BY t.created_at, t.name`)).rows));

  app.get('/platform/tenants/:id', { config: any }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return bad(reply);
    const row = await withPlatform(async (c) => (await c.query(`${TENANT_SELECT} WHERE t.id = $1`, [params.data.id])).rows[0]);
    return row ?? notFound(reply);
  });

  app.post('/platform/tenants', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const body = tenantBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const a = req.admin!;
    try {
      return reply.code(201).send(await withPlatform(async (c) => {
        const t = (await c.query('INSERT INTO tenant (name, subdomain) VALUES ($1, $2) RETURNING id', [body.data.name, body.data.subdomain ?? null])).rows[0];
        await platformAudit(c, { adminId: a.adminId, action: 'tenant.create', tenantId: t.id, entity: 'tenant', entityId: t.id, detail: body.data });
        return (await c.query(`${TENANT_SELECT} WHERE t.id = $1`, [t.id])).rows[0];
      }));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') return reply.code(409).send({ error: 'subdomain taken' });
      if (code === '23514') return bad(reply); // reserved or malformed subdomain
      throw e;
    }
  });

  app.patch('/platform/tenants/:id', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const body = renameBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply);
    const a = req.admin!;
    const row = await withPlatform(async (c) => {
      const old = (await c.query('SELECT name FROM tenant WHERE id = $1 FOR UPDATE', [params.data.id])).rows[0];
      if (!old) return null;
      await c.query('UPDATE tenant SET name = $2 WHERE id = $1', [params.data.id, body.data.name]);
      await platformAudit(c, { adminId: a.adminId, action: 'tenant.rename', tenantId: params.data.id, entity: 'tenant', entityId: params.data.id, detail: { from: old.name, to: body.data.name } });
      return (await c.query(`${TENANT_SELECT} WHERE t.id = $1`, [params.data.id])).rows[0];
    });
    return row ?? notFound(reply);
  });

  for (const [verb, suspend] of [['suspend', true], ['reactivate', false]] as const) {
    app.post(`/platform/tenants/:id/${verb}`, { config: { ...owner, ...strict(30) } }, async (req, reply) => {
      const params = idParams.safeParse(req.params);
      const body = reasonBody.safeParse(req.body);
      if (!params.success || !body.success) return bad(reply);
      const a = req.admin!;
      const row = await withPlatform(async (c) => {
        const r = await c.query(
          `UPDATE tenant SET suspended_at = ${suspend ? 'now()' : 'NULL'}
            WHERE id = $1 AND (suspended_at IS NULL) = $2 RETURNING id`, [params.data.id, suspend]);
        if (!r.rowCount) return null;
        await platformAudit(c, { adminId: a.adminId, action: `tenant.${verb}`, tenantId: params.data.id, entity: 'tenant', entityId: params.data.id, detail: { reason: body.data.reason } });
        return (await c.query(`${TENANT_SELECT} WHERE t.id = $1`, [params.data.id])).rows[0];
      });
      // Unknown tenant, or already in the requested state: the same 404, so the call is idempotent to read.
      return row ?? notFound(reply);
    });
  }

  // The first manager of a tenant. Managers are never created by other managers (admin.ts), so this is the way in.
  // The tenant-side write uses the stamped tenant path; it is recorded in the tenant's own audit trail so its
  // managers can see that the platform did it, then on the platform trail.
  app.post('/platform/tenants/:id/managers', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const body = managerBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply);
    const a = req.admin!;
    const tenantId = params.data.id;
    const known = await withPlatform(async (c) => (await c.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId])).rowCount === 1);
    if (!known) return notFound(reply);

    // Invited (no password given): the stored hash is of a secret nobody holds, so the account cannot sign in
    // until the manager redeems the invite and sets their own.
    const passwordHash = await hashPassword(body.data.password ?? newSecret());
    // A manager signs in by password only; the PIN column is required, so it holds a verifier nobody knows.
    const pinVerifier = await hashPassword(newSecret());
    const invite = body.data.password === undefined ? newInvite(tenantId) : null;
    const outletIds = [...new Set(body.data.outletIds ?? [])];
    let userId: string;
    try {
      const made = await withTenant(tenantId, async (c) => {
        if (outletIds.length > 0) {
          // Outlets of this tenant only (the stamped connection hides the rest).
          const n = (await c.query('SELECT count(*)::int AS n FROM outlet WHERE id = ANY($1::uuid[])', [outletIds])).rows[0].n as number;
          if (n !== outletIds.length) return null;
        }
        const u = (await c.query(
          `INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash)
           VALUES ($1, $2, $3, 'manager', $4, $5) RETURNING id`, [tenantId, body.data.name, pinVerifier, body.data.email, passwordHash])).rows[0];
        for (const outletId of outletIds) {
          await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1, $2, $3)', [tenantId, u.id, outletId]);
        }
        if (invite) await insertInvite(c, tenantId, u.id, invite, a.adminId);
        await audit(c, { tenantId, actorKind: 'system', action: 'platform.manager.create', entity: 'app_user', entityId: u.id, detail: { platformAdminId: a.adminId, invited: invite !== null } });
        return u.id as string;
      });
      if (made === null) return notFound(reply);
      userId = made;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email already used' });
      throw e;
    }
    await withPlatform(async (c) => platformAudit(c, {
      adminId: a.adminId, action: 'manager.create', tenantId, entity: 'app_user', entityId: userId, detail: { email: body.data.email, invited: invite !== null, outletIds } }));
    return reply.code(201).send({ id: userId, ...(invite ? { invite: invite.token, inviteExpiresAt: invite.expiresAt } : {}) });
  });

  // A fresh link for a manager who has not accepted (lost or expired). Older unused links stop working.
  app.post('/platform/tenants/:id/managers/:uid/invite', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const params = managerParams.safeParse(req.params);
    if (!params.success) return bad(reply);
    const a = req.admin!;
    const { id: tenantId, uid } = params.data;
    const known = await withPlatform(async (c) => (await c.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId])).rowCount === 1);
    if (!known) return notFound(reply);
    const invite = newInvite(tenantId);
    const ok = await withTenant(tenantId, async (c) => {
      // Only a manager who never signed in: an invite that was redeemed is spent, and a live account is not reset.
      const pending = await c.query(
        `SELECT 1 FROM app_user u WHERE u.id = $1 AND u.role = 'manager'
            AND EXISTS (SELECT 1 FROM manager_invite i WHERE i.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM manager_invite i WHERE i.user_id = u.id AND i.used_at IS NOT NULL)`, [uid]);
      if (pending.rowCount === 0) return false;
      await c.query('UPDATE manager_invite SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [uid]);
      await insertInvite(c, tenantId, uid, invite, a.adminId);
      await audit(c, { tenantId, actorKind: 'system', action: 'platform.manager.reinvite', entity: 'app_user', entityId: uid, detail: { platformAdminId: a.adminId } });
      return true;
    });
    if (!ok) return notFound(reply);
    await withPlatform(async (c) => platformAudit(c, { adminId: a.adminId, action: 'manager.reinvite', tenantId, entity: 'app_user', entityId: uid }));
    return { invite: invite.token, inviteExpiresAt: invite.expiresAt };
  });

  // --- outlets and counters ---------------------------------------------------------------------------------------
  // Written on the stamped tenant path like the first manager, so the console role gains no write right on tenant data.
  app.get('/platform/tenants/:id/outlets', { config: any }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return bad(reply);
    const tenantId = params.data.id;
    const known = await withPlatform(async (c) => (await c.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId])).rowCount === 1);
    if (!known) return notFound(reply);
    return withTenant(tenantId, async (c) => ({
      outlets: (await c.query(
        `SELECT o.id, o.name, o.timezone,
                COALESCE((SELECT json_agg(json_build_object('id', k.id, 'code', k.code) ORDER BY k.code) FROM counter k WHERE k.outlet_id = o.id), '[]') AS counters
           FROM outlet o ORDER BY o.name`)).rows,
      managers: (await c.query(
        `SELECT u.id, u.name, u.email, u.active,
                EXISTS (SELECT 1 FROM manager_invite i WHERE i.user_id = u.id) AS invited,
                EXISTS (SELECT 1 FROM manager_invite i WHERE i.user_id = u.id AND i.used_at IS NOT NULL) AS "acceptedInvite",
                EXISTS (SELECT 1 FROM manager_invite i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > now()) AS "invitePending",
                COALESCE((SELECT json_agg(uo.outlet_id) FROM user_outlet uo WHERE uo.user_id = u.id AND uo.deleted_at IS NULL), '[]') AS "outletIds"
           FROM app_user u WHERE u.role = 'manager' ORDER BY u.name`)).rows,
    }));
  });

  app.post('/platform/tenants/:id/outlets', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const body = outletBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply);
    const a = req.admin!;
    const tenantId = params.data.id;
    const known = await withPlatform(async (c) => (await c.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId])).rowCount === 1);
    if (!known) return notFound(reply);
    const codes = [...new Set(body.data.counters.map((x) => x.toUpperCase()))];
    const out = await withTenant(tenantId, async (c) => {
      const o = (await c.query('INSERT INTO outlet (tenant_id, name) VALUES ($1, $2) RETURNING id, name, timezone', [tenantId, body.data.name])).rows[0];
      const counters: { id: string; code: string }[] = [];
      for (const code of codes) {
        counters.push((await c.query('INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1, $2, $3) RETURNING id, code', [tenantId, o.id, code])).rows[0]);
      }
      await audit(c, { tenantId, actorKind: 'system', action: 'platform.outlet.create', entity: 'outlet', entityId: o.id, detail: { platformAdminId: a.adminId, counters: codes } });
      return { ...o, counters };
    });
    await withPlatform(async (c) => platformAudit(c, { adminId: a.adminId, action: 'outlet.create', tenantId, entity: 'outlet', entityId: out.id, detail: { name: body.data.name, counters: codes } }));
    return reply.code(201).send(out);
  });

  // --- support impersonation (0009): read-only, 30 minutes, reason required, owner only ----------------------------
  // The grant is written by a SECURITY DEFINER function that also writes the tenant's own audit row; the platform audit
  // row goes in the same transaction. The credential is shown once and works as `Support <tenantId>.<id>.<secret>`.
  app.post('/platform/tenants/:id/impersonate', { config: { ...owner, ...strict(10) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const body = reasonBody.safeParse(req.body);
    if (!params.success || !body.success) return bad(reply);
    const a = req.admin!;
    const tenantId = params.data.id;
    const out = await withPlatform(async (c) => {
      const t = (await c.query('SELECT suspended_at FROM tenant WHERE id = $1', [tenantId])).rows[0];
      if (!t) return null;
      const adminName = (await c.query('SELECT name FROM platform_admin WHERE id = $1', [a.adminId])).rows[0].name as string;
      const secret = newSecret();
      const g = (await c.query('SELECT id, expires_at FROM platform.start_impersonation($1, $2, $3, $4, $5)',
        [tenantId, a.adminId, adminName, body.data.reason, sha256(secret)])).rows[0];
      await platformAudit(c, { adminId: a.adminId, action: 'impersonation.start', tenantId, entity: 'impersonation', entityId: g.id, detail: { reason: body.data.reason, readOnly: true, expiresAt: g.expires_at } });
      return { id: g.id as string, expiresAt: g.expires_at as Date, credential: `Support ${tenantId}.${g.id}.${secret}`, readOnly: true as const };
    });
    return out ? reply.code(201).send(out) : notFound(reply);
  });

  app.post('/platform/tenants/:id/impersonations/:iid/end', { config: { ...owner, ...strict(30) } }, async (req, reply) => {
    const params = z.object({ id: uuid, iid: uuid }).safeParse(req.params);
    if (!params.success) return bad(reply);
    const a = req.admin!;
    const ended = await withPlatform(async (c) => {
      const ok = (await c.query('SELECT platform.end_impersonation($1, $2) AS ok', [params.data.id, params.data.iid])).rows[0].ok as boolean;
      if (ok) await platformAudit(c, { adminId: a.adminId, action: 'impersonation.end', tenantId: params.data.id, entity: 'impersonation', entityId: params.data.iid });
      return ok;
    });
    return ended ? { ok: true } : notFound(reply);
  });

  // --- health and usage: counts from SECURITY DEFINER functions (0008), never rows ---------------------------
  const healthQuery = z.object({
    staleHours: z.coerce.number().int().min(0).max(720).default(24),
    quietHours: z.coerce.number().int().min(0).max(720).default(24),
  });

  app.get('/platform/health', { config: any }, async (req, reply) => {
    const q = healthQuery.safeParse(req.query);
    if (!q.success) return bad(reply);
    return withPlatform(async (c) => {
      const tenants = (await c.query('SELECT id, name, subdomain, suspended_at AS "suspendedAt" FROM tenant ORDER BY created_at, name')).rows;
      if (!tenants.length) return [];
      const h = (await c.query(
        `SELECT tenant_id AS "tenantId", outlets, devices, devices_stale AS "devicesStale", devices_unsynced AS "devicesUnsynced",
                device_outbox_events AS "deviceOutboxEvents", last_device_seen AS "lastDeviceSeen",
                sync_applied_24h AS "syncApplied24h", sync_rejected_24h AS "syncRejected24h", last_sync_at AS "lastSyncAt",
                online_outbox_pending AS "onlineOutboxPending", online_outbox_failed AS "onlineOutboxFailed",
                online_outbox_oldest_pending AS "onlineOutboxOldestPending", integrations_enabled AS "integrationsEnabled",
                integrations_quiet AS "integrationsQuiet", webhook_rejected_24h AS "webhookRejected24h", app_versions AS "appVersions"
           FROM platform.tenant_health($1::uuid[], $2, $3)`,
        [tenants.map((t) => t.id), q.data.staleHours, q.data.quietHours])).rows;
      const byId = new Map(h.map((r) => [r.tenantId as string, r]));
      return tenants.map((t) => {
        const row = byId.get(t.id)!;
        return { ...t, ...row, warnings: healthWarnings(row, q.data.staleHours, q.data.quietHours) };
      });
    });
  });

  app.get('/platform/usage', { config: any }, async (req, reply) => {
    const q = z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    if (!q.success) return bad(reply);
    // Default: the last six whole months.
    const since = q.data.since ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
    try {
      return await withPlatform(async (c) => {
        const ids = (await c.query('SELECT id FROM tenant')).rows.map((r) => r.id as string);
        if (!ids.length) return [];
        return (await c.query(
          `SELECT u.tenant_id AS "tenantId", t.name, to_char(u.month, 'YYYY-MM') AS month, u.sales,
                  u.online_orders AS "onlineOrders", u.active_devices AS "activeDevices", u.active_outlets AS "activeOutlets"
             FROM platform.tenant_usage($1::uuid[], $2::date) u JOIN tenant t ON t.id = u.tenant_id
            ORDER BY t.name, u.month`, [ids, since])).rows;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '22008' || (e as { code?: string }).code === '22007') return bad(reply); // impossible date
      throw e;
    }
  });

  // --- the console's own trail ------------------------------------------------------------------------------
  app.get('/platform/audit', { config: any }, async (req, reply) => {
    const q = z.object({ tenantId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).safeParse(req.query);
    if (!q.success) return bad(reply);
    return withPlatform(async (c) => (await c.query(
      `SELECT id, at, admin_id AS "adminId", action, tenant_id AS "tenantId", entity, entity_id AS "entityId", detail
         FROM platform_audit WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY id DESC LIMIT $2`,
      [q.data.tenantId ?? null, q.data.limit])).rows);
  });
};
