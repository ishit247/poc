import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/** Per-request flag, opened by an onRequest hook (auth.ts) and set once the caller proves to be a support session. */
export const requestMode = new AsyncLocalStorage<{ readOnly: boolean }>();

const url = process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos';
export const pool = new pg.Pool({ connectionString: url });

// The platform console's own pool, as the app_platform role (see db/migrations/0007_platform.sql).
// It never carries a tenant stamp: what it may read is decided by grants and policies, not by a stamp.
const platformUrl = process.env.PLATFORM_DATABASE_URL ?? 'postgres://app_platform:app_platform@localhost:55432/pos';
export const platformPool = new pg.Pool({ connectionString: platformUrl });

/** A transaction on the console role. Use only from /platform routes. */
export async function withPlatform<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await platformPool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * The only way to get a tenant-scoped handle. The stamp is set with
 * set_config(..., is_local => true) so it dies with the transaction and cannot
 * leak through the pool.
 */
export async function withTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // A support (impersonation) request cannot write: Postgres itself refuses, whatever a route does.
    if (requestMode.getStore()?.readOnly) await c.query('SET TRANSACTION READ ONLY');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

// --- tenant from the request's host ----------------------------------------
// <subdomain>.<BASE_DOMAIN>. The lookup is the one place a request is seen before its tenant is known:
// it stamps app.host_subdomain, which lets the tenant row policy show that single row and nothing else.
const BASE_DOMAIN = (process.env.BASE_DOMAIN ?? 'localhost').toLowerCase();
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The subdomain label in a Host header, or null (bare domain, other domain, nested labels, junk). */
export function subdomainOf(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d{1,5}$/, '');
  if (!name.endsWith('.' + BASE_DOMAIN)) return null;
  const label = name.slice(0, -(BASE_DOMAIN.length + 1));
  return LABEL.test(label) ? label : null;
}

const hostCache = new Map<string, { id: string | null; until: number }>();

/** The tenant id for a Host header, or null if the host names no tenant. Cached briefly; subdomains rarely change. */
export async function tenantForHost(host: string | undefined): Promise<string | null> {
  const label = subdomainOf(host);
  if (!label) return null;
  const hit = hostCache.get(label);
  if (hit && hit.until > Date.now()) return hit.id;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.host_subdomain', $1, true)", [label]);
    const id = ((await c.query('SELECT id FROM tenant WHERE subdomain = $1', [label])).rows[0]?.id as string | undefined) ?? null;
    await c.query('COMMIT');
    if (hostCache.size > 1000) hostCache.clear();
    hostCache.set(label, { id, until: Date.now() + (id ? 30_000 : 5_000) });
    return id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
