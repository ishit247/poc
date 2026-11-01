// Platform console API (PLAN 5, 15, 18). Everything here is scope 'platform': outside any tenant, answered only
// to a signed-in platform_admin, and on the app_platform database role, which cannot read sales or users.
// The one tenant-side write (the first manager) goes through withTenant, the same stamped path the tenant API uses.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withPlatform, withTenant } from '../db.js';
import { audit } from '../audit.js';
import { platformAudit } from '../platformAudit.js';
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
const tenantBody = z.object({ name: z.string().trim().min(1).max(100), subdomain }).strict();
const renameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
const managerBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(256),
}).strict();

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
        const t = (await c.query('INSERT INTO tenant (name, subdomain) VALUES ($1, $2) RETURNING id', [body.data.name, body.data.subdomain])).rows[0];
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

    const passwordHash = await hashPassword(body.data.password);
    // A manager signs in by password only; the PIN column is required, so it holds a verifier nobody knows.
    const pinVerifier = await hashPassword(newSecret());
    let userId: string;
    try {
      userId = await withTenant(tenantId, async (c) => {
        const u = (await c.query(
          `INSERT INTO app_user (tenant_id, name, pin_verifier, role, email, password_hash)
           VALUES ($1, $2, $3, 'manager', $4, $5) RETURNING id`, [tenantId, body.data.name, pinVerifier, body.data.email, passwordHash])).rows[0];
        await audit(c, { tenantId, actorKind: 'system', action: 'platform.manager.create', entity: 'app_user', entityId: u.id, detail: { platformAdminId: a.adminId } });
        return u.id as string;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email already used' });
      throw e;
    }
    await withPlatform(async (c) => platformAudit(c, {
      adminId: a.adminId, action: 'manager.create', tenantId, entity: 'app_user', entityId: userId, detail: { email: body.data.email } }));
    return reply.code(201).send({ id: userId });
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
