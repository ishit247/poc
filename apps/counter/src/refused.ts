// A payment the server refused on the tablet that took it (phase 12 step 7d). The customer paid and has a receipt;
// another device's closing of the same order stands (the table was paid there first, or voided there first). This
// tablet then: marks the row `refused` (not paid, not void), keeps its receipt and payments, counts its cash in the
// drawer's expected figure and as its own slip line, and shows a banner until a manager acknowledges it.
import { db, type LocalSale, type OutboxRow } from './db.ts';

/** Server refusals meaning "the customer paid, but another device's closing stands" (apps/api/src/refused.ts). */
export const REFUSED_REASONS: readonly string[] = ['already_paid', 'sale_void'];

/** Is this parked outbox row a refused payment (shown by its own banner rather than the generic "not accepted" one)? */
export const isRefusedPayment = (r: OutboxRow) =>
  !!r.rejected && r.payload.type === 'payment.taken' && REFUSED_REASONS.includes(r.rejected);

/**
 * Called inside push's result transaction (it must include `db.sales`). Only a row this device holds as paid changes:
 * the payment is this device's, so its row is. Returns whether a row was marked.
 */
export async function markRefused(row: OutboxRow, reason: string, now = new Date()): Promise<boolean> {
  if (row.payload.type !== 'payment.taken' || !REFUSED_REASONS.includes(reason)) return false;
  const sale = await db.sales.get(row.payload.saleId);
  if (!sale || sale.status !== 'paid') return false;
  await db.sales.put({ ...sale, status: 'refused', refused: { reason, eventId: row.eventId, at: now.toISOString() } });
  return true;
}

/** Refused rows still waiting for a manager, oldest first. */
export async function unacknowledgedRefused(): Promise<LocalSale[]> {
  const rows = await db.sales.where('status').equals('refused').toArray();
  return rows.filter((s) => !s.refused?.ackAt).sort((a, b) => (a.refused?.at ?? '').localeCompare(b.refused?.at ?? ''));
}

export function refusedWhy(reason: string | undefined): string {
  return reason === 'sale_void' ? 'the order was voided on another device first' : 'the table was already paid on another counter';
}

/**
 * A manager, signed in on this tablet, acknowledges a refused payment: the server records it (audit), then this tablet
 * marks the row acknowledged and drops its parked outbox row (the server already holds that event, refused). Online only.
 */
export async function acknowledgeRefused(args: { token: string; outletId: string; saleId: string; note?: string }): Promise<void> {
  const sale = await db.sales.get(args.saleId);
  if (!sale || sale.status !== 'refused' || !sale.refused) throw new Error('That payment is not a refused one.');
  const r = await fetch(`/api/outlets/${args.outletId}/refused-payments/${sale.refused.eventId}/ack`, {
    method: 'POST', headers: { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args.note ? { note: args.note } : {}),
  });
  if (!r.ok) throw new Error(r.status === 404 ? 'The server has no record of this refusal yet. Sync, then try again.' : `Could not record it (${r.status}).`);
  await db.transaction('rw', db.sales, db.outbox, async () => {
    const now = await db.sales.get(args.saleId);
    if (!now?.refused) return;
    await db.sales.put({ ...now, refused: { ...now.refused, ackAt: new Date().toISOString() } });
    await db.outbox.where('eventId').equals(now.refused.eventId).delete();
  });
}
