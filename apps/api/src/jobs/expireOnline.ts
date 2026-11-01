import { pool, withTenant } from '../db.js';
import { moveOrder } from '../routes/online.js';
import { publish } from '../hub.js';

const BATCH = 200;

/** The one cross-tenant read: ids of overdue `received` orders, through the `expiry_scan` policy (see 0005_online.sql). */
export async function scanDue(): Promise<{ tenant_id: string; outlet_id: string; id: string }[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.job', 'expire_online', true)");
    const r = await c.query('SELECT tenant_id, outlet_id, id FROM online_order ORDER BY accept_by LIMIT $1', [BATCH]);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Orders nobody accepted in time become `expired` and their sale is voided. Each order moves in its own
 * tenant's transaction through the same function a cashier's tap uses, so the lifecycle table and the audit
 * trail are the same. An order that was accepted a moment ago is simply no longer `received`: moveOrder
 * locks the row and refuses, and the job moves on.
 * Returns how many orders it expired.
 */
export async function expireDueOrders(): Promise<number> {
  const due = await scanDue();
  let n = 0;
  for (const d of due) {
    try {
      const r = await withTenant(d.tenant_id, (c) =>
        moveOrder(c, { tenantId: d.tenant_id, userId: null, deviceId: null }, [d.outlet_id], d.id, 'expired', { reason: 'not accepted in time' }));
      if (r.kind === 'ok') { n++; publish(d.outlet_id); }
    } catch (e) {
      console.error('EXPIRE FAILED', d.id, (e as Error).message); // one bad order must not stop the rest
    }
  }
  return n;
}

export function startExpiryJob(everyMs = 15_000): () => void {
  const t = setInterval(() => { expireDueOrders().catch((e) => console.error('EXPIRY JOB FAILED', e)); }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
