// Sealed secrets (security/crypto.ts): the webhook HMAC keys and console authenticator seeds the server must read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkSecretsKey, openSecret, sealSecret, sealWebhookSecret, webhookSecretContext } from '../src/security/crypto.js';

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test('secrets: a sealed value opens with the same context, and is not the plain text', () => {
  const s = sealSecret('dev-webhook-secret-a1', 'ctx:1');
  assert.match(s, /^v1:[A-Za-z0-9_-]{40,}$/); // the shape the database checks (0006, 0007)
  assert.ok(!s.includes('dev-webhook'));
  assert.equal(openSecret(s, 'ctx:1'), 'dev-webhook-secret-a1');
  assert.notEqual(sealSecret('same', 'ctx:1'), sealSecret('same', 'ctx:1'), 'a fresh IV each time');
});

test('secrets: a value copied onto another row (another context) does not open', () => {
  const s = sealWebhookSecret('row-a', 'dev-webhook-secret-a1');
  assert.throws(() => openSecret(s, webhookSecretContext('row-b')));
  assert.equal(openSecret(s, webhookSecretContext('row-a')), 'dev-webhook-secret-a1');
});

test('secrets: an altered value, an unknown format or another key is refused', () => {
  const s = sealSecret('x'.repeat(20), 'c');
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  assert.throws(() => openSecret(flipped, 'c'));
  assert.throws(() => openSecret(s.replace('v1:', 'v2:'), 'c'), /format/);
  withEnv({ SECRETS_KEY: randomBytes(32).toString('base64') }, () => assert.throws(() => openSecret(s, 'c')));
});

test('secrets: a webhook secret shorter than 16 characters is not sealed', () => {
  assert.throws(() => sealWebhookSecret('row', 'short'), /at least 16/);
});

test('secrets: production needs SECRETS_KEY (32 bytes); dev falls back to the public dev key', () => {
  withEnv({ NODE_ENV: 'production', SECRETS_KEY: undefined }, () => assert.throws(checkSecretsKey, /SECRETS_KEY is not set/));
  withEnv({ NODE_ENV: 'production', SECRETS_KEY: randomBytes(16).toString('base64') }, () => assert.throws(checkSecretsKey, /exactly 32 bytes/));
  withEnv({ NODE_ENV: 'production', SECRETS_KEY: randomBytes(32).toString('base64') }, () => assert.doesNotThrow(checkSecretsKey));
  withEnv({ NODE_ENV: undefined, SECRETS_KEY: undefined }, () => assert.doesNotThrow(checkSecretsKey));
});
