// Manager invite tokens (0010_manager_invite.sql): `<tenantId>.<inviteId>.<secret>`, secret stored hashed, single use.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { newSecret, sha256 } from './security/crypto.js';

export const INVITE_DAYS = 3;
const TOKEN = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;

export type Invite = { id: string; token: string; secretHash: string; expiresAt: Date };

export function newInvite(tenantId: string): Invite {
  const id = randomUUID();
  const secret = newSecret();
  return { id, token: `${tenantId}.${id}.${secret}`, secretHash: sha256(secret), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) };
}

export function parseInvite(token: string): { tenantId: string; id: string; secretHash: string } | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  return { tenantId: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), secretHash: sha256(m[3]!) };
}

export async function insertInvite(c: PoolClient, tenantId: string, userId: string, inv: Invite, adminId: string): Promise<void> {
  await c.query(
    `INSERT INTO manager_invite (id, tenant_id, user_id, token_hash, admin_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [inv.id, tenantId, userId, inv.secretHash, adminId, inv.expiresAt]);
}
