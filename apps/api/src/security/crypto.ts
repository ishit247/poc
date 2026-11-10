import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// --- secrets the server must read back (webhook HMAC keys, authenticator seeds) --------------------------------
// AES-256-GCM under SECRETS_KEY (base64, 32 bytes). Stored as `v1:` + base64url(iv | tag | ciphertext). The context
// (table, column and row id) is authenticated data: a sealed value copied onto another row, or another tenant's row,
// does not open. Lose the key and every sealed secret is lost with it: back it up apart from the database.
// Without SECRETS_KEY a public dev key is used, except under NODE_ENV=production (the API image), where it is required.
const DEV_SECRETS_KEY = Buffer.from('dev-only-key-do-not-use-in-prod!'); // 32 bytes, public on purpose

function secretsKey(): Buffer {
  const v = process.env.SECRETS_KEY;
  if (!v) {
    if (process.env.NODE_ENV === 'production') throw new Error('SECRETS_KEY is not set (base64 of 32 random bytes)');
    return DEV_SECRETS_KEY;
  }
  const k = Buffer.from(v, 'base64');
  if (k.length !== 32) throw new Error('SECRETS_KEY must be base64 of exactly 32 bytes');
  return k;
}

/** Fails at start-up rather than at the first webhook or console sign-in. */
export const checkSecretsKey = () => void secretsKey();

export function sealSecret(plain: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretsKey(), iv).setAAD(Buffer.from(context));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

/** Throws if the value was sealed under another key or context, or altered. */
export function openSecret(sealed: string, context: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown sealed-secret format');
  const b = Buffer.from(sealed.slice(3), 'base64url');
  const d = createDecipheriv('aes-256-gcm', secretsKey(), b.subarray(0, 12)).setAAD(Buffer.from(context));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/** The one place each sealed column's context is spelt, so writer and reader cannot drift apart. */
export const webhookSecretContext = (integrationId: string) => `outlet_integration.webhook_secret:${integrationId}`;
export const WEBHOOK_SECRET_MIN = 16;
/** A platform's webhook secret, sealed for its integration row. Too short a secret is refused here, not stored. */
export function sealWebhookSecret(integrationId: string, secret: string): string {
  if (secret.length < WEBHOOK_SECRET_MIN) throw new Error(`webhook secret must be at least ${WEBHOOK_SECRET_MIN} characters`);
  return sealSecret(secret, webhookSecretContext(integrationId));
}
export const totpSecretContext = (adminId: string) => `platform_admin.totp_secret:${adminId}`;

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
