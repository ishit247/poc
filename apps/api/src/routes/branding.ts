import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { LOGO_MAX_BYTES, LOGO_TYPES, sniffLogo } from '@pos/shared';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

export const brandingRoutes: FastifyPluginAsync = async (app) => {
  // Raw image bodies for the upload. The route's own bodyLimit (below) is what caps their size.
  app.addContentTypeParser([...LOGO_TYPES], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Public, by address: the sign-in screens show the tenant's name and logo before anyone is signed in.
  // Scope: the tenant is the one named by the Host header; nothing else is reachable from here.
  app.get('/branding', { config: { scope: 'public', ...limit(120) } }, async (req, reply) => {
    if (!req.hostTenantId) return reply.code(404).send({ error: 'not found' });
    return withTenant(req.hostTenantId, async (c) => {
      const name = (await c.query('SELECT name FROM tenant')).rows[0]?.name as string | undefined;
      const logo = (await c.query('SELECT sha256, content_type AS "contentType" FROM tenant_logo WHERE deleted_at IS NULL')).rows[0];
      return { name: name ?? '', logo: logo ?? null };
    });
  });

  const serveLogo = async (req: FastifyRequest, reply: FastifyReply, tenantId: string) => {
    const row = (await withTenant(tenantId, (c) =>
      c.query('SELECT bytes, content_type AS "contentType", sha256 FROM tenant_logo WHERE deleted_at IS NULL'))).rows[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    const etag = `"${row.sha256}"`;
    reply.header('etag', etag).header('cache-control', 'public, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    // Served as an inert image: no sniffing, and a policy that forbids everything if it were ever opened as a page.
    return reply
      .header('content-type', row.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(row.bytes);
  };

  // By address, for the optional branded sign-in page.
  app.get('/branding/logo', { config: { scope: 'public', ...limit(120) } }, async (req, reply) => {
    if (!req.hostTenantId) return reply.code(404).send({ error: 'not found' });
    return serveLogo(req, reply, req.hostTenantId);
  });

  // By credential, for an enrolled tablet (works on the bare domain). Scope: the device's own tenant, nothing else.
  app.get('/device/logo', { config: { scope: 'tenant', permission: 'device', ...limit(120) } }, async (req, reply) =>
    serveLogo(req, reply, req.principal!.tenantId));

  // Manager: set or remove their own tenant's logo (RLS pins the tenant).
  const cfg = { scope: 'tenant', permission: 'manager' } as const;

  app.put('/settings/logo', { config: cfg, bodyLimit: LOGO_MAX_BYTES }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    const body = req.body;
    const declared = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > LOGO_MAX_BYTES) return reply.code(400).send({ error: 'invalid request' });
    // The bytes decide, not the header: a script renamed .png, or a type that differs from what was declared, is refused.
    const real = sniffLogo(body);
    if (!real || real !== declared) return reply.code(400).send({ error: 'invalid request' });
    const sha = createHash('sha256').update(body).digest('hex');
    await withTenant(p.tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenant_logo (tenant_id, content_type, bytes, sha256) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET content_type = $2, bytes = $3, sha256 = $4, deleted_at = NULL`,
        [p.tenantId, real, body, sha]);
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'logo.set', entity: 'tenant_logo', entityId: p.tenantId, detail: { contentType: real, bytes: body.length, sha256: sha } });
    });
    return { ok: true, sha256: sha };
  });

  app.delete('/settings/logo', { config: cfg }, async (req, reply) => {
    const p = req.principal!;
    if (p.kind !== 'user') return reply.code(403).send({ error: 'forbidden' });
    await withTenant(p.tenantId, async (c) => {
      // A tombstone, so tablets learn of the removal by pull.
      await c.query('UPDATE tenant_logo SET content_type = NULL, bytes = NULL, sha256 = NULL, deleted_at = now() WHERE deleted_at IS NULL');
      await audit(c, { tenantId: p.tenantId, actorKind: 'user', actorId: p.userId, action: 'logo.remove', entity: 'tenant_logo', entityId: p.tenantId });
    });
    return { ok: true };
  });
};
