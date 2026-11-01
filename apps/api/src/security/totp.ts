// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits), the profile every authenticator app implements.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function newTotpSecret(): string {
  return base32(randomBytes(20));
}

function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);

export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const n = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * The step a code matches within one step either side of now (clock drift), or null. The caller must refuse a
 * step at or below the last one accepted for the account, so a captured code cannot be replayed.
 */
export function matchTotp(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let hit: number | null = null;
  // No early exit: every candidate is compared, so timing does not reveal which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const a = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(a, Buffer.from(code)) && hit === null) hit = step;
  }
  return hit;
}
