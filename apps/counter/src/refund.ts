// A cashier refunds a whole paid sale of their own open shift (docs/refunds-plan.md). Online only: the server decides,
// after the cashier types their PIN again, and the tablet stores the answer against the sale so the shift slip's expected
// cash drops by the cash paid out, as the server's does. A lost answer is repaired by pull (sync.ts, `applyRefund`).
import { currentShift, db, type LocalSale } from './db.ts';
import type { Actor } from './sale.ts';
import { call } from './online.ts';

type RefundRow = NonNullable<LocalSale['refunds']>[number];

/**
 * Mirror of the route's rule (apps/api/src/routes/refunds.ts): a paid sale of THIS tablet's open shift, refunded by that
 * shift's cashier. Null when the sale may be refunded; otherwise why not, in the cashier's words. The screen hides or
 * disables Refund with this; `refundSale` checks it again.
 */
export async function whyNotRefundable(sale: LocalSale, actor: Actor): Promise<string | null> {
  const shift = await currentShift();
  if (sale.status === 'refunded') return 'Already refunded.';
  if (sale.status !== 'paid') return 'Only a paid bill can be refunded.';
  if (!shift || sale.shiftId !== shift.id) return 'Only a bill from the drawer open now can be refunded.';
  if (shift.userId !== actor.id) return `This drawer belongs to ${shift.userName}.`;
  // The server must hold the sale and its payment, or it cannot refund it (and would answer "not found").
  if ((await db.outbox.filter((r) => !r.rejected && (r.payload as { saleId?: string }).saleId === sale.id).count()) > 0) {
    return 'This bill has not reached the server yet. Connect to the network, press Sync, and try again.';
  }
  return null;
}

/** Records refund rows on a local sale (merging by method) and marks it refunded. Call inside a transaction on `db.sales`. */
export async function applyRefund(saleId: string, rows: readonly RefundRow[]): Promise<void> {
  const sale = await db.sales.get(saleId);
  if (!sale || (sale.status !== 'paid' && sale.status !== 'refunded')) return; // not this tablet's paid sale: nothing to repair
  const byMethod = new Map((sale.refunds ?? []).map((r) => [r.method, r]));
  for (const r of rows) byMethod.set(r.method, { method: r.method, amountPaise: r.amountPaise });
  await db.sales.put({ ...sale, status: 'refunded', refunds: [...byMethod.values()] });
}

export async function refundSale(args: { actor: Actor; token: string; saleId: string; reason: string; pin: string }): Promise<RefundRow[]> {
  const reason = args.reason.trim();
  if (!reason) throw new Error('Give a reason for the refund.');
  const sale = await db.sales.get(args.saleId);
  if (!sale) throw new Error('This bill is not on this tablet.');
  const why = await whyNotRefundable(sale, args.actor);
  if (why) throw new Error(why);

  let r;
  try {
    r = await call<{ refunds?: RefundRow[]; error?: string }>(args.token, `/sales/${sale.id}/refund`, { method: 'POST', body: { reason, pin: args.pin } });
  } catch {
    throw new Error('Needs internet. Nothing was refunded.');
  }
  if (r.status === 403) throw new Error(r.body.error === 'wrong pin' ? 'Wrong PIN. Nothing was refunded.' : 'You cannot refund on this tablet.');
  if (r.status === 423) throw new Error('Too many wrong PINs: this account is locked for a while. Nothing was refunded.');
  if (r.status === 401) throw new Error('Your session has ended. Sign in again.');
  // Already refunded: an earlier try went through and its answer was lost. The next pull records it here.
  if (r.status === 409 && r.body.error === 'already refunded') throw new Error('Already refunded. Press Sync to update this tablet.');
  if (r.status === 404 || r.status === 409) throw new Error('The server cannot refund this bill. Ask a manager.');
  if (r.status !== 200 || !r.body.refunds) throw new Error('Could not refund. Nothing was changed on this tablet; try again.');
  const rows = r.body.refunds;
  await db.transaction('rw', db.sales, () => applyRefund(sale.id, rows));
  return rows;
}
