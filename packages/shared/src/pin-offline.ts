// Offline PIN check on the tablet. Same verifier format as the server
// (scrypt$N$r$p$<salt b64>$<hash b64>), computed with @noble/hashes so it runs in a browser.
// The local lockout mirrors the server's: 5 failures, 5-minute lock. The clock is injected.
import { scryptAsync } from '@noble/hashes/scrypt.js';

export const OFFLINE_PIN_MAX_FAILED = 5;
export const OFFLINE_PIN_LOCK_MS = 5 * 60 * 1000;

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPinVerifier(pin: string, verifier: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = verifier.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = b64(hash);
  const actual = await scryptAsync(new TextEncoder().encode(pin.normalize('NFKC')), b64(salt), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    dkLen: expected.length,
    maxmem: 128 * 1024 * 1024,
  });
  return sameBytes(actual, expected);
}

export interface PinAttemptState {
  failures: number;
  lockedUntil: number | null; // epoch ms
}

export const FRESH_PIN_STATE: PinAttemptState = { failures: 0, lockedUntil: null };

export type PinAttempt =
  | { kind: 'ok'; state: PinAttemptState }
  | { kind: 'wrong'; state: PinAttemptState }
  | { kind: 'locked'; state: PinAttemptState; lockedUntil: number };

/**
 * One attempt for one user. While locked the verifier is not even consulted, so a
 * correct PIN does not unlock early. The caller persists `state` before returning.
 */
export async function attemptPin(
  state: PinAttemptState,
  now: number,
  check: () => Promise<boolean>,
): Promise<PinAttempt> {
  if (state.lockedUntil !== null && now < state.lockedUntil) return { kind: 'locked', state, lockedUntil: state.lockedUntil };
  const failures = state.lockedUntil !== null ? 0 : state.failures; // an expired lock starts a fresh count
  if (await check()) return { kind: 'ok', state: FRESH_PIN_STATE };
  const next = failures + 1;
  if (next >= OFFLINE_PIN_MAX_FAILED) {
    const lockedUntil = now + OFFLINE_PIN_LOCK_MS;
    return { kind: 'locked', state: { failures: next, lockedUntil }, lockedUntil };
  }
  return { kind: 'wrong', state: { failures: next, lockedUntil: null } };
}
