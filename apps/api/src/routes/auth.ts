import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { newEnrolmentSecret, newSecret, sha256 } from '../security/crypto.js';
import { DUMMY_HASH, verifyPassword } from '../security/password.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;
const ENROLMENT_MINUTES = 15;

const uuid = z.string().uuid();
const loginBody = z.object({ tenantId: uuid, email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();
const codeBody = z.object({ outletId: uuid, counterId: uuid }).strict();
const enrolBody = z.object({ code: z.string().max(200) }).strict();
const idParams = z.object({ id: uuid });

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: 'invalid credentials' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

const strict = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

export const authRoutes: FastifyPluginAsync = async (app) => {
  // --- manager login -------------------------------------------------------
  app.post('/login', { config: { scope: 'public', ...strict(10) } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const { tenantId, email, password } = body.data;

    const result = await withTenant(tenantId, async (c) => {
      // FOR UPDATE serialises concurrent guesses per account, so the lockout count is exact.
      const r = await c.query(
        `SELECT id, password_hash, failed_logins, (locked_until IS NOT NULL AND locked_until > now()) AS locked
           FROM app_user
          WHERE lower(email) = lower($1) AND role = 'manager' AND active
          FOR UPDATE`, [email]);
      const u = r.rows[0];
      // Always burn one hash verification so timing does not reveal whether the account exists or is locked.
      const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
      if (!u || u.locked) return null;

      if (!ok) {
        const lock = u.failed_logins + 1 >= MAX_FAILED_LOGINS;
        await c.query(
          `UPDATE app_user SET failed_logins = CASE WHEN $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`, [u.id, lock, LOCK_MINUTES]);
        await audit(c, { tenantId, actorKind: 'anonymous', action: lock ? 'login.locked' : 'login.failed', entity: 'app_user', entityId: u.id });
        return null;
      }

      const sessionId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const secret = newSecret();
      const exp = await c.query(
        `INSERT INTO session (id, tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
        [sessionId, tenantId, u.id, sha256(secret), SESSION_HOURS]);
      await c.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      await audit(c, { tenantId, actorKind: 'user', actorId: u.id, action: 'login.ok', entity: 'session', entityId: sessionId });
      return { token: `${tenantId}.${sessionId}.${secret}`, expiresAt: exp.rows[0].expires_at as Date };
    });

    return result ? result : unauthorized(reply);
  });

  app.post('/logout', { config: { scope: 'tenant', permission: 'staff' } }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') return { ok: true };
    await withTenant(p.tenantId, async (c) => {
      await c.query('UPDATE session SET revoked_at = now() WHERE id = $1 AND user_id = $2', [p.sessionId, p.userId]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'logout', entity: 'session', entityId: p.sessionId });
    });
    return { ok: true };
  });

  // --- device enrolment ----------------------------------------------------
  app.post('/enrolment-codes', { config: { scope: 'outlet', permission: 'manager', ...strict(20) } }, async (req, reply) => {
    const body = codeBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const { outletId, counterId } = body.data;
    // Scope: the manager may only enrol devices at outlets assigned to them.
    if (!p.outletIds.includes(outletId)) return notFound(reply);

    const out = await withTenant(p.tenantId, async (c) => {
      const counter = await c.query('SELECT 1 FROM counter WHERE id = $1 AND outlet_id = $2', [counterId, outletId]);
      if (counter.rowCount === 0) return null;
      const id = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const secret = newEnrolmentSecret();
      const r = await c.query(
        `INSERT INTO enrolment_code (id, tenant_id, outlet_id, counter_id, code_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING expires_at`,
        [id, p.tenantId, outletId, counterId, sha256(secret), p.userId, ENROLMENT_MINUTES]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'enrolment_code.create', entity: 'enrolment_code', entityId: id, detail: { outletId, counterId } });
      return { code: `${p.tenantId}.${id}.${secret}`, expiresAt: r.rows[0].expires_at as Date };
    });
    return out ?? notFound(reply);
  });

  app.post('/enrol', { config: { scope: 'public', ...strict(10) } }, async (req, reply) => {
    const body = enrolBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Z2-9_]{16})$/i.exec(body.data.code);
    if (!m || !uuid.safeParse(m[1]).success || !uuid.safeParse(m[2]).success) return unauthorized(reply);
    const [, tenantId, codeId, secret] = m as unknown as [string, string, string, string];

    const out = await withTenant(tenantId.toLowerCase(), async (c) => {
      // Single atomic claim: concurrent redemptions of one code cannot both succeed.
      const claim = await c.query(
        `UPDATE enrolment_code SET used_at = now()
          WHERE id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING outlet_id, counter_id`, [codeId.toLowerCase(), sha256(secret)]);
      const code = claim.rows[0];
      if (!code) return null;
      const deviceId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const credSecret = newSecret();
      await c.query(
        'INSERT INTO device (id, tenant_id, outlet_id, counter_id, credential_hash) VALUES ($1,$2,$3,$4,$5)',
        [deviceId, tenantId.toLowerCase(), code.outlet_id, code.counter_id, sha256(credSecret)]);
      await audit(c, { tenantId: tenantId.toLowerCase(), actorKind: 'device', actorId: deviceId, action: 'device.enrol', entity: 'device', entityId: deviceId });
      return { deviceId, credential: `${tenantId.toLowerCase()}.${deviceId}.${credSecret}` };
    });
    return out ?? unauthorized(reply);
  });

  app.post('/devices/:id/revoke', { config: { scope: 'outlet', permission: 'manager', ...strict(30) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const done = await withTenant(p.tenantId, async (c) => {
      // Scope is part of the WHERE: a device at someone else's outlet simply does not match.
      const r = await c.query(
        'UPDATE device SET revoked_at = now() WHERE id = $1 AND outlet_id = ANY($2::uuid[]) AND revoked_at IS NULL RETURNING id',
        [params.data.id, p.outletIds]);
      if (r.rowCount === 0) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'device.revoke', entity: 'device', entityId: params.data.id });
      return true;
    });
    return done ? { ok: true } : notFound(reply);
  });

  app.get('/device/whoami', { config: { scope: 'outlet', permission: 'device' } }, async (req) => {
    const p = req.principal!;
    return p.kind === 'device' ? { deviceId: p.deviceId, outletId: p.outletId, counterId: p.counterId } : {};
  });
};
