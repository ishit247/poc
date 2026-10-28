import pg from 'pg';

const url = process.env.APP_DATABASE_URL ?? 'postgres://pos_app:pos_app@localhost:55432/pos';
export const pool = new pg.Pool({ connectionString: url });

/**
 * The only way to get a tenant-scoped handle. The stamp is set with
 * set_config(..., is_local => true) so it dies with the transaction and cannot
 * leak through the pool.
 */
export async function withTenant<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
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
