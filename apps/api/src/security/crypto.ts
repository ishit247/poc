import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random secret. Only its hash is ever stored. */
export const newSecret = () => randomBytes(32).toString('base64url');

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * One-time enrolment secret: 16 chars from a 32-symbol alphabet (80 bits),
 * no look-alike characters, so a human can read it out.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789_';
export function newEnrolmentSecret(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}
