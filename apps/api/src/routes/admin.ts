import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pinProblem } from '@pos/shared';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { clearLockout } from '../lockout.js';
import { hashPassword } from '../security/password.js';
import { deviceLabel } from './auth.js';

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const counterCode = z.string().regex(/^[A-Za-z0-9-]{1,20}$/);
// Only the roles a manager may create. Managers are created by the platform, not by other managers.
const staffRole = z.enum(['cashier', 'waiter']);
const pin = z.string().max(32).superRefine((v, ctx) => {
  const problem = pinProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const outletParams = z.object({ id: uuid });
const idParams = z.object({ id: uuid });
const counterBody = z.object({ code: counterCode }).strict();
const userBody = z.object({ name, role: staffRole, pin, outletIds: z.array(uuid).min(1).max(20) }).strict();
const userPatch = z.object({ name: name.optional(), active: z.boolean().optional(), outletIds: z.array(uuid).min(1).max(20).optional() })
  .strict().refine((b) => Object.keys(b).length > 0);
const pinBody = z.object({ pin }).strict();
const labelBody = z.object({ label: deviceLabel }).strict();

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });
const conflict = (reply: FastifyReply) => reply.code(409).send({ error: 'already exists' });
const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const cfg = { scope: 'outlet', permission: 'manager' } as const;
  const inScope = (outletIds: string[], ids: string[]) => ids.every((id) => outletIds.includes(id));

  // --- counters -------------------------------------------------------------
  app.post('/outlets/:id/counters', { config: cfg }, async (req, reply) => {
    const ps = outletParams.safeParse(req.params);
    const b = counterBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user' || !p.outletIds.includes(ps.data.id)) return notFound(reply);
    try {
      const row = await withTenant(p.tenantId, async (c) => {
        const r = await c.query('INSERT INTO counter (tenant_id, outlet_id, code) VALUES ($1,$2,$3) RETURNING id, code', [p.tenantId, ps.data.id, b.data.code]);
        await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'counter.create', entity: 'counter', entityId: r.rows[0].id, detail: { outletId: ps.data.id, code: b.data.code } });
        return r.rows[0];
      });
      return reply.code(201).send(row);
    } catch (e) {
      if (isUnique(e)) return conflict(reply);
      throw e;
    }
  });

  app.patch('/counters/:id', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = counterBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    try {
      const row = await withTenant(p.tenantId, async (c) => {
        const r = await c.query('UPDATE counter SET code = $2 WHERE id = $1 AND outlet_id = ANY($3::uuid[]) RETURNING id, code', [ps.data.id, b.data.code, p.outletIds]);
        if (r.rowCount) await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'counter.rename', entity: 'counter', entityId: ps.data.id, detail: b.data });
        return r.rows[0];
      });
      return row ?? notFound(reply);
    } catch (e) {
      if (isUnique(e)) return conflict(reply);
      throw e;
    }
  });

  // --- cashier / waiter accounts -------------------------------------------
  // A user is manageable only if EVERY outlet they work at is one of the manager's: otherwise a
  // manager at one school could change someone who also works at another school's canteen.
  app.get('/users', { config: cfg }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') return [];
    return withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `SELECT u.id, u.name, u.role, u.active,
                array_agg(uo.outlet_id ORDER BY uo.outlet_id) FILTER (WHERE uo.outlet_id = ANY($1::uuid[])) AS "outletIds"
           FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id AND uo.deleted_at IS NULL
          GROUP BY u.id HAVING bool_or(uo.outlet_id = ANY($1::uuid[]))
          ORDER BY u.name`, [p.outletIds]);
      return r.rows;
    });
  });

  app.post('/users', { config: { ...cfg, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = userBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    if (!inScope(p.outletIds, b.data.outletIds)) return notFound(reply);
    const verifier = await hashPassword(b.data.pin);
    const row = await withTenant(p.tenantId, async (c) => {
      const u = await c.query(
        'INSERT INTO app_user (tenant_id, name, pin_verifier, role) VALUES ($1,$2,$3,$4) RETURNING id, name, role, active',
        [p.tenantId, b.data.name, verifier, b.data.role]);
      for (const outletId of new Set(b.data.outletIds)) {
        await c.query('INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1,$2,$3)', [p.tenantId, u.rows[0].id, outletId]);
      }
      // The PIN is never written to the audit trail.
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'user.create', entity: 'app_user', entityId: u.rows[0].id, detail: { role: b.data.role, outletIds: b.data.outletIds } });
      return { ...u.rows[0], outletIds: [...new Set(b.data.outletIds)] };
    });
    return reply.code(201).send(row);
  });

  /** Loads a cashier/waiter and reports whether this manager may change them. */
  async function manageable(c: import('pg').PoolClient, id: string, outletIds: string[]) {
    const r = await c.query(
      `SELECT u.role, array_agg(uo.outlet_id) AS outlets FROM app_user u JOIN user_outlet uo ON uo.user_id = u.id AND uo.deleted_at IS NULL WHERE u.id = $1 GROUP BY u.role`, [id]);
    const u = r.rows[0] as { role: string; outlets: string[] } | undefined;
    return u && u.role !== 'manager' && inScope(outletIds, u.outlets) ? u : null;
  }

  app.patch('/users/:id', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = userPatch.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    if (b.data.outletIds && !inScope(p.outletIds, b.data.outletIds)) return notFound(reply);
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await manageable(c, ps.data.id, p.outletIds))) return false;
      if (b.data.name !== undefined) await c.query('UPDATE app_user SET name = $2 WHERE id = $1', [ps.data.id, b.data.name]);
      if (b.data.active !== undefined) await c.query('UPDATE app_user SET active = $2 WHERE id = $1', [ps.data.id, b.data.active]);
      if (b.data.outletIds) {
        // Tombstone what is no longer wanted, revive or add what is. Rows that do not change are not
        // touched (the WHERE on DO UPDATE), so they keep their version and devices do not re-pull them.
        const wanted = [...new Set(b.data.outletIds)];
        await c.query('UPDATE user_outlet SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL AND outlet_id <> ALL($2::uuid[])', [ps.data.id, wanted]);
        for (const outletId of wanted) {
          await c.query(
            `INSERT INTO user_outlet (tenant_id, user_id, outlet_id) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, outlet_id) DO UPDATE SET deleted_at = NULL WHERE user_outlet.deleted_at IS NOT NULL`,
            [p.tenantId, ps.data.id, outletId]);
        }
      }
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'user.update', entity: 'app_user', entityId: ps.data.id, detail: b.data });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  app.post('/users/:id/pin', { config: { ...cfg, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = pinBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const verifier = await hashPassword(b.data.pin);
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await manageable(c, ps.data.id, p.outletIds))) return false;
      await c.query('UPDATE app_user SET pin_verifier = $2 WHERE id = $1', [ps.data.id, verifier]);
      await clearLockout(c, ps.data.id, 'pin'); // a reset PIN starts clean
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'user.pin_reset', entity: 'app_user', entityId: ps.data.id });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // A manager clears a PIN lockout (e.g. a waiter who forgot theirs and locked themselves out).
  app.post('/users/:id/unlock', { config: { ...cfg, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    if (!ps.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      if (!(await manageable(c, ps.data.id, p.outletIds))) return false;
      await clearLockout(c, ps.data.id, 'pin');
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'user.unlock', entity: 'app_user', entityId: ps.data.id });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });

  // --- devices --------------------------------------------------------------
  app.get('/devices', { config: cfg }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') return [];
    return withTenant(p.tenantId, async (c) => {
      const r = await c.query(
        `SELECT d.id, d.label, d.outlet_id AS "outletId", d.counter_id AS "counterId", c.code AS "counterCode",
                d.enrolled_at AS "enrolledAt", d.last_seen_at AS "lastSeenAt", d.revoked_at AS "revokedAt", d.app_version AS "appVersion"
           FROM device d JOIN counter c ON c.id = d.counter_id
          WHERE d.outlet_id = ANY($1::uuid[]) ORDER BY d.enrolled_at DESC`, [p.outletIds]);
      return r.rows;
    });
  });

  app.patch('/devices/:id', { config: cfg }, async (req, reply) => {
    const ps = idParams.safeParse(req.params);
    const b = labelBody.safeParse(req.body);
    if (!ps.success || !b.success) return bad(reply);
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const ok = await withTenant(p.tenantId, async (c) => {
      const r = await c.query('UPDATE device SET label = $2 WHERE id = $1 AND outlet_id = ANY($3::uuid[])', [ps.data.id, b.data.label, p.outletIds]);
      if (!r.rowCount) return false;
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'device.label', entity: 'device', entityId: ps.data.id, detail: b.data });
      return true;
    });
    return ok ? { ok: true } : notFound(reply);
  });
};
