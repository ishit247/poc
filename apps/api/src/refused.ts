// Refused payments (phase 12 step 7d). Two cashiers can take one table's money while one of them is offline (7b), or a
// cashier can take money offline for an order another device voided (7c). The server keeps its rules (the first payment
// stands; a void that landed first stands) and refuses the loser with `already_paid` or `sale_void`. The customer did
// pay, though: the cash is in the losing drawer and its receipt number was printed. Nothing new is recorded for it; the
// refused `payment.taken` row in `sync_event` IS the record, and these readers make shift close and day close honest
// about it: its cash counts as expected in that drawer, and its receipt number is listed as refused, not as missing.
import type pg from 'pg';

/** The refusals that mean "the customer paid, but another device's closing stands". Any other refusal is a fault. */
export const REFUSED_REASONS = ['already_paid', 'sale_void'] as const;

/**
 * The payments refused on one shift: the shift's device sent them, naming the shift. Cash and UPI alike; the caller
 * adds them to the shift's payments, so `expectedCash` counts the cash part exactly as it does for an accepted one.
 */
export async function refusedPaymentsOf(c: pg.PoolClient, shiftId: string, deviceId: string): Promise<{ method: string; amountPaise: number }[]> {
  const r = await c.query(
    `SELECT x.method, x."amountPaise"
       FROM sync_event e CROSS JOIN LATERAL jsonb_to_recordset(e.payload->'payments') AS x(method text, "amountPaise" int)
      WHERE e.device_id = $2 AND e.type = 'payment.taken' AND e.outcome = 'rejected' AND e.reason = ANY($3::text[])
        AND e.payload->>'shiftId' = $1`, [shiftId, deviceId, REFUSED_REASONS]);
  return r.rows;
}

export const cashOf = (pays: readonly { method: string; amountPaise: number }[]) =>
  pays.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amountPaise, 0);

export interface RefusedReceipt {
  eventId: string; deviceId: string; counter: string; saleId: string; receiptNo: string; receiptSeq: number; reason: string;
  cashPaise: number; upiPaise: number; receivedAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null;
  /** Arrived after its drawer was closed: its cash is outside that shift's figures (they were fixed at the close). */
  afterDrawerClosed: boolean;
}

/** Refused receipts of one outlet's business day (the date the receipt was issued on), with any manager acknowledgement. */
export async function refusedReceipts(c: pg.PoolClient, outletId: string, date: string): Promise<RefusedReceipt[]> {
  const r = await c.query(
    `SELECT e.id AS "eventId", e.device_id AS "deviceId", ct.code AS counter, e.entity_id AS "saleId",
            e.payload->>'receiptNo' AS "receiptNo", (e.payload->>'receiptSeq')::int AS "receiptSeq", e.reason,
            (SELECT COALESCE(sum((x->>'amountPaise')::bigint) FILTER (WHERE x->>'method' = 'cash'), 0) FROM jsonb_array_elements(e.payload->'payments') x)::bigint AS cash,
            (SELECT COALESCE(sum((x->>'amountPaise')::bigint) FILTER (WHERE x->>'method' = 'upi'), 0) FROM jsonb_array_elements(e.payload->'payments') x)::bigint AS upi,
            e.received_at AS "receivedAt", a.at AS "acknowledgedAt", u.name AS "acknowledgedBy",
            -- The drawer it names was already closed: its cash is NOT in that shift's expected figure or refused_cash_paise,
            -- which were fixed at the close. Only a manager's force-close can come first (a tablet sends its payments before
            -- its own close), and only then is closed_at server time (a tablet's close carries the tablet's clock), so
            -- both sides of the comparison are the server's.
            (sh.closed_at IS NOT NULL) AS "afterDrawerClosed"
       FROM sync_event e JOIN device d ON d.id = e.device_id JOIN counter ct ON ct.id = d.counter_id
       LEFT JOIN shift sh ON sh.id::text = e.payload->>'shiftId' AND sh.device_id = e.device_id
       LEFT JOIN LATERAL (SELECT au.at, au.actor_id FROM audit au
                           WHERE au.action = 'payment.refused_ack' AND au.entity = 'sync_event' AND au.entity_id = e.id
                           ORDER BY au.at LIMIT 1) a ON true
       LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE d.outlet_id = $1 AND e.type = 'payment.taken' AND e.outcome = 'rejected' AND e.reason = ANY($3::text[])
        AND e.payload->>'businessDate' = $2
      ORDER BY ct.code, (e.payload->>'receiptSeq')::int`, [outletId, date, REFUSED_REASONS]);
  return r.rows.map(({ cash, upi, ...x }) => ({ ...x, cashPaise: Number(cash), upiPaise: Number(upi) }));
}
