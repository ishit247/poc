// A cashier's till session. Opening and closing are outbox events like any sale, written in the same
// IndexedDB transaction as the local row, so the tablet and the server cannot disagree about what happened.
import { EVENT_SCHEMA_VERSION, expectedCash, type ShiftSlipView } from '@pos/shared';
import { currentShift, db, type DeviceInfo, type LocalShift } from './db.ts';
import { queue, type Actor } from './sale.ts';
import { api } from './manager/api.ts';

export async function openShift(args: { actor: Actor; openingCashPaise: number; now?: Date }): Promise<LocalShift> {
  if (args.actor.role !== 'cashier') throw new Error('Only a cashier opens a shift.');
  if (!Number.isInteger(args.openingCashPaise) || args.openingCashPaise < 0) throw new RangeError('Opening cash must be zero or more.');
  const at = (args.now ?? new Date()).toISOString();
  return db.transaction('rw', db.shifts, db.outbox, async () => {
    const open = await currentShift();
    if (open) throw new Error(`A shift is already open (${open.userName}).`);
    const shift: LocalShift = { id: crypto.randomUUID(), userId: args.actor.id, userName: args.actor.name, openedAt: at, openingCashPaise: args.openingCashPaise, closedAt: null, countedCashPaise: null };
    await queue({ type: 'shift.opened', schemaVersion: EVENT_SCHEMA_VERSION, shiftId: shift.id, userId: shift.userId, openingCashPaise: shift.openingCashPaise, at });
    await db.shifts.put(shift);
    return shift;
  });
}

/**
 * Closes the shift on the count the cashier typed. The expected figure is not an input and is not shown
 * beforehand; the slip returned afterwards is the first place it appears (as the variance).
 */
export async function closeShift(args: { device: DeviceInfo; actor: Actor; countedCashPaise: number; now?: Date }): Promise<ShiftSlipView> {
  if (!Number.isInteger(args.countedCashPaise) || args.countedCashPaise < 0) throw new RangeError('The count must be zero or more.');
  const at = (args.now ?? new Date()).toISOString();
  return db.transaction('rw', [db.shifts, db.outbox, db.sales, db.orderEvents], async () => {
    const shift = await currentShift();
    if (!shift) throw new Error('There is no open shift to close.');
    if (shift.userId !== args.actor.id) throw new Error(`This shift belongs to ${shift.userName}.`);
    // Orders still unpaid when the drawer closes are abandoned (PLAN 9). Voided before the close so the server sees them in order.
    // Only THIS device's: another device's open orders are views in `visits`, never `sales` rows, and are left alone.
    for (const s of await db.sales.filter((x) => x.status === 'open').toArray()) {
      await queue({ type: 'sale.voided', schemaVersion: EVENT_SCHEMA_VERSION, saleId: s.id, reason: 'abandoned_at_shift_close', at });
      await db.sales.put({ ...s, status: 'void' });
      await db.orderEvents.where('saleId').equals(s.rootId ?? s.id).delete();
    }
    await queue({ type: 'shift.closed', schemaVersion: EVENT_SCHEMA_VERSION, shiftId: shift.id, countedCashPaise: args.countedCashPaise, at });
    await db.shifts.put({ ...shift, closedAt: at, countedCashPaise: args.countedCashPaise });
    return slipFor({ ...shift, closedAt: at, countedCashPaise: args.countedCashPaise }, args.device);
  });
}

/**
 * A manager closes another cashier's drawer from this tablet (they left without closing it). Uses the server's
 * force-close, the same as Day close, so the count, variance and audit are the server's.
 *
 * The caller must have just synced: the server works out "expected" from the sales IT holds, and a sale still in this
 * tablet's outbox would be missing from it (and refused once it arrived after the close). So this refuses while
 * anything is waiting to be sent. Online only, like every manager tool.
 */
export async function managerCloseShift(args: { device: DeviceInfo; token: string; shiftId: string; countedCashPaise: number }): Promise<void> {
  if (!Number.isInteger(args.countedCashPaise) || args.countedCashPaise < 0) throw new RangeError('The count must be zero or more.');
  if ((await db.outbox.filter((r) => !r.rejected).count()) > 0) {
    throw new Error('Some sales on this tablet have not reached the server yet. Connect to the network, press Sync, and try again.');
  }
  const r = await api(`/outlets/${args.device.outletId}/shifts/${args.shiftId}/force-close`, args.token,
    { method: 'POST', body: JSON.stringify({ countedCashPaise: args.countedCashPaise }) });
  if (r.status === 409) return; // already closed (another manager, or Day close): the next pull brings their figures
  if (r.status === 404) throw new Error('The server has no record of this drawer, or you do not manage this outlet.');
  if (r.status === 401) throw new Error('Your manager session has ended. Sign in again.');
  if (r.status !== 200) throw new Error('Could not close the drawer.');
  const { expectedCashPaise, variancePaise } = r.body as { expectedCashPaise: number; variancePaise: number };
  // Apply at once rather than wait for the pull, so the next cashier is not blocked if that pull fails. The pull later
  // finds the shift closed with a manager's figures and leaves it alone (sync.ts).
  await db.transaction('rw', db.shifts, async () => {
    const s = await db.shifts.get(args.shiftId);
    if (s && !s.closedAt) {
      await db.shifts.put({ ...s, closedAt: new Date().toISOString(), countedCashPaise: args.countedCashPaise, closedByManager: { expectedCashPaise, variancePaise } });
    }
  });
}

/** The slip for a closed shift, from what this tablet holds. Totals are the tablet's own until its outbox is empty. */
export async function slipFor(shift: LocalShift, device: DeviceInfo): Promise<ShiftSlipView> {
  const mine = (await db.sales.toArray()).filter((s) => s.shiftId === shift.id);
  const sales = mine.filter((s) => s.status === 'paid');
  const payments = sales.flatMap((s) => s.payments);
  // Refused payments (step 7d) are not sales, but their cash went into this drawer: expected counts it, as the server does.
  const refused = mine.filter((s) => s.status === 'refused');
  const refusedPays = refused.flatMap((s) => s.payments);
  const expected = expectedCash(shift.openingCashPaise, [...payments, ...refusedPays]);
  const sumOf = (ps: typeof payments, m: string) => ps.filter((p) => p.method === m).reduce((a, p) => a + p.amountPaise, 0);
  const sum = (m: string) => sumOf(payments, m);
  return {
    outletName: device.outletName, counterCode: device.counterCode, cashier: shift.userName, openedAt: shift.openedAt, closedAt: shift.closedAt!,
    timeZone: device.timezone, openingCashPaise: shift.openingCashPaise, cashSalesPaise: sum('cash'), upiSalesPaise: sum('upi'), salesCount: sales.length,
    refused: { count: refused.length, cashPaise: sumOf(refusedPays, 'cash'), upiPaise: sumOf(refusedPays, 'upi') },
    countedCashPaise: shift.countedCashPaise!, variancePaise: shift.countedCashPaise! - expected,
    unsyncedCount: await db.outbox.filter((r) => !r.rejected).count(),
  };
}
