// A cashier's till session. Opening and closing are outbox events like any sale, written in the same
// IndexedDB transaction as the local row, so the tablet and the server cannot disagree about what happened.
import { EVENT_SCHEMA_VERSION, expectedCash, type ShiftSlipView } from '@pos/shared';
import { currentShift, db, type DeviceInfo, type LocalShift } from './db.ts';
import { queue, type Actor } from './sale.ts';

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
  return db.transaction('rw', db.shifts, db.outbox, db.sales, async () => {
    const shift = await currentShift();
    if (!shift) throw new Error('There is no open shift to close.');
    if (shift.userId !== args.actor.id) throw new Error(`This shift belongs to ${shift.userName}.`);
    await queue({ type: 'shift.closed', schemaVersion: EVENT_SCHEMA_VERSION, shiftId: shift.id, countedCashPaise: args.countedCashPaise, at });
    await db.shifts.put({ ...shift, closedAt: at, countedCashPaise: args.countedCashPaise });
    return slipFor({ ...shift, closedAt: at, countedCashPaise: args.countedCashPaise }, args.device);
  });
}

/** The slip for a closed shift, from what this tablet holds. Totals are the tablet's own until its outbox is empty. */
export async function slipFor(shift: LocalShift, device: DeviceInfo): Promise<ShiftSlipView> {
  const sales = (await db.sales.toArray()).filter((s) => s.shiftId === shift.id && s.status === 'paid');
  const payments = sales.flatMap((s) => s.payments);
  const expected = expectedCash(shift.openingCashPaise, payments);
  const sum = (m: string) => payments.filter((p) => p.method === m).reduce((a, p) => a + p.amountPaise, 0);
  return {
    outletName: device.outletName, counterCode: device.counterCode, cashier: shift.userName, openedAt: shift.openedAt, closedAt: shift.closedAt!,
    timeZone: device.timezone, openingCashPaise: shift.openingCashPaise, cashSalesPaise: sum('cash'), upiSalesPaise: sum('upi'), salesCount: sales.length,
    countedCashPaise: shift.countedCashPaise!, variancePaise: shift.countedCashPaise! - expected,
    unsyncedCount: await db.outbox.filter((r) => !r.rejected).count(),
  };
}
