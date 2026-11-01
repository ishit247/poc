import { pool, withTenant } from '../db.js';

const BATCH = 100;
export const MAX_ATTEMPTS = 8;

export type OutboxMessage = { id: string; tenantId: string; outletId: string; onlineOrderId: string; provider: string; action: string; payload: unknown };

/** A provider sends one message to a platform; it throws if the platform did not take it. Phase 9 adds zomato and swiggy. */
export type Sender = (m: OutboxMessage) => Promise<void>;

export const senders: Record<string, Sender> = {
  manual: async () => { /* a cashier keyed the order in by hand; there is no platform to tell */ },
};

/** 30 s, 1 min, 2 min ... capped at one hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}

/** The one cross-tenant read: due pending messages, through the `outbox_scan` policy (see 0005_online.sql). */
export async function scanDue(): Promise<{ tenant_id: string; id: string }[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.job', 'outbox', true)");
    const r = await c.query('SELECT tenant_id, id FROM integration_outbox ORDER BY next_attempt_at LIMIT $1', [BATCH]);
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
 * Sends every due message once. Each runs in its own tenant's transaction with the row locked (SKIP LOCKED), so two
 * workers never send the same message and one failing provider never blocks another. A failure schedules the next
 * attempt with backoff; after MAX_ATTEMPTS the message is `failed` and stays visible. Returns messages marked done.
 */
export async function runOutbox(): Promise<number> {
  let sent = 0;
  for (const d of await scanDue()) {
    try {
      const ok = await withTenant(d.tenant_id, async (c) => {
        const m = (await c.query(
          `SELECT id, tenant_id AS "tenantId", outlet_id AS "outletId", online_order_id AS "onlineOrderId", provider, action, payload, attempts
             FROM integration_outbox WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED`, [d.id])).rows[0];
        if (!m) return false;
        try {
          const send = senders[m.provider];
          if (!send) throw new Error(`no sender for provider ${m.provider}`);
          await send(m);
          await c.query(`UPDATE integration_outbox SET status = 'done', done_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [m.id]);
          return true;
        } catch (e) {
          const attempts = m.attempts + 1;
          await c.query(
            `UPDATE integration_outbox SET attempts = $2::int, last_error = $3,
                    status = CASE WHEN $2::int >= $4::int THEN 'failed' ELSE 'pending' END,
                    next_attempt_at = now() + make_interval(secs => $5::int) WHERE id = $1`,
            [m.id, attempts, (e as Error).message.slice(0, 500), MAX_ATTEMPTS, backoffSeconds(attempts)]);
          return false;
        }
      });
      if (ok) sent++;
    } catch (e) {
      console.error('OUTBOX FAILED', d.id, (e as Error).message); // one bad row must not stop the rest
    }
  }
  return sent;
}

export function startOutboxJob(everyMs = 5_000): () => void {
  const t = setInterval(() => { runOutbox().catch((e) => console.error('OUTBOX JOB FAILED', e)); }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
