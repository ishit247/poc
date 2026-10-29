// Offline PIN sign-in against the verifiers pulled from the server. Failures are counted
// per user on this tablet; the count is written BEFORE the slow check, so killing the tab
// mid-attempt cannot be used to guess for free.
import { attemptPin, FRESH_PIN_STATE, verifyPinVerifier, type PinAttempt } from '@pos/shared';
import { db } from './db.ts';

export async function signInWithPin(userId: string, pinVerifier: string, pin: string, now = Date.now()): Promise<PinAttempt> {
  const state = (await db.pinState.get(userId))?.state ?? FRESH_PIN_STATE;
  const result = await attemptPin(state, now, async () => {
    const fresh = state.lockedUntil !== null ? 0 : state.failures;
    await db.pinState.put({ userId, state: { failures: fresh + 1, lockedUntil: null } });
    return verifyPinVerifier(pin, pinVerifier);
  });
  await db.pinState.put({ userId, state: result.state });
  return result;
}

export async function lockedUntil(userId: string, now = Date.now()): Promise<number | null> {
  const s = (await db.pinState.get(userId))?.state;
  return s?.lockedUntil && s.lockedUntil > now ? s.lockedUntil : null;
}
