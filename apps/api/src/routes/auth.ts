import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantForLogin, withTenant } from '../db.js';
import { audit } from '../audit.js';
import { newEnrolmentSecret, newSecret, sha256 } from '../security/crypto.js';
import { DUMMY_HASH, verifyPassword } from '../security/password.js';
import { clearLockout, lockState, recordFailure } from '../lockout.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const PIN_MAX_FAILED = 5; // PLAN section 10: 5 failures, 5-minute lock
const PIN_LOCK_MINUTES = 5;
const SESSION_HOURS = 12;
const ENROLMENT_MINUTES = 15;

const uuid = z.string().uuid();
const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();
export const deviceLabel = z.string().trim().min(1).max(60);
const codeBody = z.object({ outletId: uuid, counterId: uuid, label: deviceLabel.optional() }).strict();
const pinSignin = z.object({ userId: uuid, pin: z.string().regex(/^\d{6,8}$/) }).strict();
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
    const { email, password } = body.data;
    // The tenant is the one this email belongs to (globally unique). Unknown email: the same answer as a wrong
    // password, after the same hash work, so timing does not reveal which emails exist.
    const tenantId = await tenantForLogin(email);
    if (!tenantId) {
      await verifyPassword(password, DUMMY_HASH);
      return unauthorized(reply);
    }

    const result = await withTenant(tenantId, async (c) => {
      const r = await c.query(
        "SELECT id, password_hash FROM app_user WHERE lower(email) = lower($1) AND role = 'manager' AND active", [email]);
      const u = r.rows[0];
      // lockState row-locks the account's counter, so concurrent guesses are counted exactly.
      const state = u ? await lockState(c, tenantId, u.id, 'password') : null;
      // Always burn one hash verification so timing does not reveal whether the account exists or is locked.
      const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !state || state.locked) return null;

      if (!ok) {
        const lock = await recordFailure(c, u.id, 'password', state, MAX_FAILED_LOGINS, LOCK_MINUTES);
        await audit(c, { tenantId, actorKind: 'anonymous', action: lock ? 'login.locked' : 'login.failed', entity: 'app_user', entityId: u.id });
        return null;
      }

      // Said only to someone who proved the password, so a stranger learns nothing about the account.
      if ((await c.query('SELECT suspended_at FROM tenant WHERE id = $1', [tenantId])).rows[0]?.suspended_at) return 'suspended' as const;

      const sessionId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const secret = newSecret();
      const exp = await c.query(
        `INSERT INTO session (id, tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
        [sessionId, tenantId, u.id, sha256(secret), SESSION_HOURS]);
      await clearLockout(c, u.id, 'password');
      await audit(c, { tenantId, actorKind: 'user', actorId: u.id, action: 'login.ok', entity: 'session', entityId: sessionId });
      return { token: `${tenantId}.${sessionId}.${secret}`, expiresAt: exp.rows[0].expires_at as Date };
    });

    if (result === 'suspended') return reply.code(403).send({ error: 'tenant suspended' });
    return result ? result : unauthorized(reply);
  });

  // --- staff PIN sign-in (online) ------------------------------------------
  // Called by an enrolled tablet. Cashiers and waiters only: a manager never gets a session from a
  // 6-8 digit PIN. The same user cannot be guessed past PIN_MAX_FAILED attempts from ANY device,
  // because the counter is per user, not per tablet. Offline, the tablet checks the same verifier locally.
  app.post('/device/pin-signin', {
    config: {
      scope: 'outlet', permission: 'device',
      // Per tablet (its credential), on top of the global per-IP limit.
      rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => String(req.headers.authorization ?? req.ip) },
    },
  }, async (req, reply) => {
    const body = pinSignin.safeParse(req.body);
    if (!body.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'device') return reply.code(403).send({ error: 'forbidden' });

    const result = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `SELECT u.id, u.name, u.role, u.pin_verifier
           FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id AND uo.deleted_at IS NULL AND uo.outlet_id = $2
          WHERE u.id = $1 AND u.active AND u.role IN ('cashier', 'waiter')`, [body.data.userId, p.outletId]);
      const u = r.rows[0];
      const state = u ? await lockState(c, p.tenantId, u.id, 'pin') : null;
      // Always burn one hash verification, so timing does not reveal who exists at this outlet or is locked.
      const ok = await verifyPassword(body.data.pin, u?.pin_verifier ?? DUMMY_HASH);
      if (!u || !state) return { kind: 'denied' as const };
      if (state.locked) return { kind: 'locked' as const, until: state.lockedUntil };
      if (!ok) {
        const lock = await recordFailure(c, u.id, 'pin', state, PIN_MAX_FAILED, PIN_LOCK_MINUTES);
        await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: lock ? 'pin.locked' : 'pin.failed', entity: 'app_user', entityId: u.id });
        return { kind: 'denied' as const };
      }

      const sessionId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const secret = newSecret();
      const exp = await c.query(
        `INSERT INTO session (id, tenant_id, user_id, token_hash, expires_at, device_id)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6) RETURNING expires_at`,
        [sessionId, p.tenantId, u.id, sha256(secret), SESSION_HOURS, p.deviceId]);
      await clearLockout(c, u.id, 'pin');
      await audit(c, { tenantId: p.tenantId, actorKind: 'device', actorId: p.deviceId, action: 'pin.ok', entity: 'session', entityId: sessionId, detail: { userId: u.id } });
      return { kind: 'ok' as const, token: `${p.tenantId}.${sessionId}.${secret}`, expiresAt: exp.rows[0].expires_at as Date, user: { id: u.id, name: u.name, role: u.role } };
    });

    if (result.kind === 'locked') return reply.code(423).send({ error: 'locked', lockedUntil: result.until });
    if (result.kind === 'denied') return unauthorized(reply);
    return { token: result.token, expiresAt: result.expiresAt, user: result.user };
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

  // The manager screen needs to know which outlets are theirs and what "today" is in each one's timezone.
  app.get('/me', { config: { scope: 'outlet', permission: 'manager' } }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') return {};
    return withTenant(p.tenantId, async (c) => {
      const u = (await c.query('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0];
      const outlets = await c.query(
        `SELECT id, name, timezone, (now() AT TIME ZONE timezone)::date::text AS today
           FROM outlet WHERE id = ANY($1::uuid[]) ORDER BY name`, [p.outletIds]);
      return { name: u?.name as string, role: p.role, outlets: outlets.rows as { id: string; name: string; timezone: string; today: string }[] };
    });
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
        `INSERT INTO enrolment_code (id, tenant_id, outlet_id, counter_id, code_hash, label, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8)) RETURNING expires_at`,
        [id, p.tenantId, outletId, counterId, sha256(secret), body.data.label ?? null, p.userId, ENROLMENT_MINUTES]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'enrolment_code.create', entity: 'enrolment_code', entityId: id, detail: { outletId, counterId } });
      return { code: `${p.tenantId}.${id}.${secret}`, expiresAt: r.rows[0].expires_at as Date };
    });
    return out ?? notFound(reply);
  });

  // Cancel an unused code (e.g. shown on the wrong screen). Scope is in the WHERE: only codes for the manager's outlets.
  app.delete('/enrolment-codes/:id', { config: { scope: 'outlet', permission: 'manager', ...strict(30) } }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const done = await withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE enrolment_code SET expires_at = now()
          WHERE id = $1 AND outlet_id = ANY($2::uuid[]) AND used_at IS NULL AND expires_at > now() RETURNING id`,
        [params.data.id, p.outletIds]);
      if (r.rowCount === 0) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'enrolment_code.cancel', entity: 'enrolment_code', entityId: params.data.id });
      return true;
    });
    return done ? { ok: true } : notFound(reply);
  });

  app.post('/enrol', { config: { scope: 'public', ...strict(10) } }, async (req, reply) => {
    const body = enrolBody.safeParse(req.body);
    if (!body.success) return bad(reply);
    const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Z2-9_]{16})$/i.exec(body.data.code);
    if (!m || !uuid.safeParse(m[1]).success || !uuid.safeParse(m[2]).success) return unauthorized(reply);
    const [, tenantId, codeId, secret] = m as unknown as [string, string, string, string];

    const out = await withTenant(tenantId.toLowerCase(), async (c) => {
      // Single atomic claim: concurrent redemptions of one code cannot both succeed. A suspended tenant's
      // codes are not claimed (they stay valid until they expire, so reactivation does not waste them).
      const claim = await c.query(
        `UPDATE enrolment_code SET used_at = now()
          WHERE id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > now()
            AND NOT EXISTS (SELECT 1 FROM tenant WHERE id = $3 AND suspended_at IS NOT NULL)
          RETURNING outlet_id, counter_id, label`, [codeId.toLowerCase(), sha256(secret), tenantId.toLowerCase()]);
      if (claim.rows.length === 0) {
        // Said only to someone holding a live code, as at login, so a stranger learns nothing about the tenant.
        const live = await c.query(
          `SELECT 1 FROM enrolment_code e JOIN tenant t ON t.id = e.tenant_id
            WHERE e.id = $1 AND e.code_hash = $2 AND e.used_at IS NULL AND e.expires_at > now() AND t.suspended_at IS NOT NULL`,
          [codeId.toLowerCase(), sha256(secret)]);
        if (live.rows.length > 0) return 'suspended' as const;
      }
      const code = claim.rows[0];
      if (!code) return null;
      const deviceId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const credSecret = newSecret();
      await c.query(
        'INSERT INTO device (id, tenant_id, outlet_id, counter_id, credential_hash, label) VALUES ($1,$2,$3,$4,$5,$6)',
        [deviceId, tenantId.toLowerCase(), code.outlet_id, code.counter_id, sha256(credSecret), code.label]);
      await audit(c, { tenantId: tenantId.toLowerCase(), actorKind: 'device', actorId: deviceId, action: 'device.enrol', entity: 'device', entityId: deviceId });
      return { deviceId, credential: `${tenantId.toLowerCase()}.${deviceId}.${credSecret}` };
    });
    if (out === 'suspended') return reply.code(403).send({ error: 'tenant suspended' });
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

  // The tablet caches this at enrolment: the counter code prefixes receipt numbers, the timezone
  // decides the business date. Both are read from the device's own outlet and counter.
  app.get('/device/whoami', { config: { scope: 'outlet', permission: 'device' } }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'device') return {};
    const row = (await withTenant(p.tenantId, (c) => c.query(
      `SELECT c.code AS "counterCode", o.name AS "outletName", o.timezone
         FROM counter c JOIN outlet o ON o.id = c.outlet_id WHERE c.id = $1 AND o.id = $2`, [p.counterId, p.outletId]))).rows[0];
    return { deviceId: p.deviceId, outletId: p.outletId, counterId: p.counterId, ...row };
  });
};
