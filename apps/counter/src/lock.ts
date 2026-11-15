// The offline lock (PLAN 7.2): a tablet that has not reached the server for `offlineDays` stops selling until it
// syncs, which bounds what a lost or stolen tablet can do. Contact is the later of the last pull and the last push,
// both written only after the server answered (sync.ts). The tablet's clock is all there is offline, so a clock
// set back past the last contact is treated as locked too: otherwise winding it back would skip the lock.
import { getMeta } from './db.ts';

export const DAY_MS = 86_400_000;
/** The banner warns in the last day before the lock. */
export const WARN_MS = DAY_MS;
/** How far the clock may sit behind the last contact (a time-zone or NTP correction) before it counts as set back. */
export const CLOCK_SLACK_MS = DAY_MS;

export type Lock =
  | { state: 'ok' }
  | { state: 'warn'; leftMs: number }
  | { state: 'locked'; reason: 'never' | 'too_long' | 'clock' };

export function offlineLock(lastContact: string | undefined, nowMs: number, offlineDays: number): Lock {
  const at = lastContact ? Date.parse(lastContact) : NaN;
  if (Number.isNaN(at)) return { state: 'locked', reason: 'never' };
  if (nowMs < at - CLOCK_SLACK_MS) return { state: 'locked', reason: 'clock' };
  const leftMs = at + offlineDays * DAY_MS - nowMs;
  if (leftMs <= 0) return { state: 'locked', reason: 'too_long' };
  return leftMs <= WARN_MS ? { state: 'warn', leftMs } : { state: 'ok' };
}

/** The later of the two successful contacts, as stored. */
export async function lastContact(): Promise<string | undefined> {
  const [pull, push] = await Promise.all([getMeta('lastPull'), getMeta('lastPush')]);
  const times = [pull, push].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
