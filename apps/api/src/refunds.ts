import type pg from 'pg';

/**
 * The refunds paid out of a shift's drawer (docs/refunds-plan.md), as `expectedCash` takes them: shift close (ingest.ts)
 * and force-close (routes/dayclose.ts). The refund route takes `shift_id` from the cashier's own open shift and locks
 * that shift first, as both close paths do, so a close sees every refund committed before it and none can follow it.
 */
export async function refundsOf(c: pg.PoolClient, shiftId: string): Promise<{ method: string; amountPaise: number }[]> {
  return (await c.query('SELECT method, amount_paise::int AS "amountPaise" FROM refund WHERE shift_id = $1', [shiftId])).rows;
}
