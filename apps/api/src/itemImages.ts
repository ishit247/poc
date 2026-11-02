import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ITEM_IMAGE_MAX_BYTES, ITEM_IMAGE_MAX_PER_TENANT, SHA256_HEX, sniffLogo } from '@pos/shared';
import { withTenant } from './db.js';
import { deleteObject, getObject, putObject, tenantKey } from './objects.js';

/** The picture's hash and real type if the body is an acceptable item picture; the bytes decide, never the header. */
export function checkImage(body: unknown, declaredType: string | undefined) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > ITEM_IMAGE_MAX_BYTES) return null;
  const type = sniffLogo(body);
  if (!type || type !== (declaredType ?? '').split(';')[0]!.trim()) return null;
  return { type, sha256: createHash('sha256').update(body).digest('hex') };
}

/**
 * One transaction-scoped lock per tenant for everything that adds, drops or removes pictures. Storing and releasing are
 * then strictly ordered, so "the last item stopped using it" and "an item just started using it" cannot interleave into
 * a dangling reference. Picture changes are rare manager actions, so a tenant-wide lock costs nothing.
 *
 * ORDER MATTERS: every versioned write holds the tenant's version lock until commit, so a route that touches pictures
 * must call this FIRST, before its first UPDATE/INSERT on a versioned table. Taking it after is a deadlock waiting to happen.
 */
export const lockItemImages = (c: pg.PoolClient, tenantId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`item_image:${tenantId}`]);
const lock = lockItemImages;

/**
 * Stores a picture for the tenant (once per distinct hash): the object first, then the index row. False when the tenant is
 * at its picture limit. Call inside withTenant. A failure after the object is written leaves an object with no row, which
 * the next upload of the same picture simply reuses.
 */
export async function storeItemImage(c: pg.PoolClient, tenantId: string, sha256: string, type: string, bytes: Buffer): Promise<boolean> {
  await lock(c, tenantId);
  if ((await c.query('SELECT 1 FROM item_image WHERE sha256 = $1', [sha256])).rowCount) return true;
  const n = (await c.query('SELECT count(*)::int AS n FROM item_image')).rows[0].n as number;
  if (n >= ITEM_IMAGE_MAX_PER_TENANT) return false;
  await putObject(tenantKey(tenantId, sha256), bytes, type);
  await c.query('INSERT INTO item_image (tenant_id, sha256, content_type, byte_size) VALUES ($1, $2, $3, $4)', [tenantId, sha256, type, bytes.length]);
  return true;
}

/**
 * Drops the index row of a picture no live item points at any more and says so (the hash), so the caller can remove the
 * object once the transaction has committed (purgeItemImage). Call inside the transaction that dropped the reference.
 */
export async function releaseItemImage(c: pg.PoolClient, tenantId: string, sha256: string | null | undefined): Promise<string | null> {
  if (!sha256) return null;
  await lock(c, tenantId);
  const r = await c.query(
    'DELETE FROM item_image WHERE sha256 = $1 AND NOT EXISTS (SELECT 1 FROM item WHERE image_sha256 = $1 AND deleted_at IS NULL)', [sha256]);
  return r.rowCount ? sha256 : null;
}

/**
 * Removes the object of a released picture, after commit. Re-checks under the same lock that nobody has stored the picture
 * again in the meantime. Best effort: a failure leaves an orphan object (wasted space, never a broken item).
 */
export async function purgeItemImage(tenantId: string, sha256: string | null): Promise<void> {
  if (!sha256) return;
  try {
    await withTenant(tenantId, async (c) => {
      await lock(c, tenantId);
      if (!(await c.query('SELECT 1 FROM item_image WHERE sha256 = $1', [sha256])).rowCount) await deleteObject(tenantKey(tenantId, sha256));
    });
  } catch (e) {
    console.error('item picture object not removed', tenantId, sha256, e);
  }
}

/**
 * Serves one of the tenant's pictures. The address is the content hash, so the bytes behind it never change and the
 * browser may keep them for good. The index row (pinned to the tenant by RLS) is checked first, so a hash that is not this
 * tenant's is a 404 whatever the store holds. Served as an inert image (no sniffing, and a policy that forbids everything
 * if it were ever opened as a page).
 */
export async function serveItemImage(req: FastifyRequest, reply: FastifyReply, tenantId: string, sha256: string) {
  if (!SHA256_HEX.test(sha256)) return reply.code(400).send({ error: 'invalid request' });
  const row = (await withTenant(tenantId, (c) => c.query('SELECT content_type AS "contentType" FROM item_image WHERE sha256 = $1', [sha256]))).rows[0];
  if (!row) return reply.code(404).send({ error: 'not found' });
  const etag = `"${sha256}"`;
  const cache = 'private, max-age=31536000, immutable';
  if (req.headers['if-none-match'] === etag) return reply.header('etag', etag).header('cache-control', cache).code(304).send();
  const bytes = await getObject(tenantKey(tenantId, sha256));
  if (!bytes) return reply.code(404).send({ error: 'not found' });
  return reply
    .header('etag', etag)
    .header('cache-control', cache)
    .header('content-type', row.contentType)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .send(bytes);
}
