import { db, type LocalShift } from '../src/db.ts';
import type { Actor } from '../src/sale.ts';

/** An open drawer on the tablet, with no outbox event: for tests about something other than the shift itself. */
export async function seedShift(actor: Actor, openingCashPaise = 0): Promise<LocalShift> {
  const shift: LocalShift = { id: crypto.randomUUID(), userId: actor.id, userName: actor.name, openedAt: new Date().toISOString(), openingCashPaise, closedAt: null, countedCashPaise: null };
  await db.shifts.clear();
  await db.shifts.put(shift);
  return shift;
}
