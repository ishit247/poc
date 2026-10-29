import type pg from 'pg';

export type LockKind = 'password' | 'pin';

export interface LockState {
  failed: number;
  locked: boolean;
  lockedUntil: Date | null;
}

/**
 * Loads (creating if absent) and row-locks the lockout state for one user and kind.
 * The lock serialises concurrent guesses against one account, so the failure count is exact.
 * Call inside withTenant; the lock is held to commit.
 */
export async function lockState(c: pg.PoolClient, tenantId: string, userId: string, kind: LockKind): Promise<LockState> {
  await c.query(
    'INSERT INTO login_lockout (tenant_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT (user_id, kind) DO NOTHING',
    [tenantId, userId, kind]);
  const r = await c.query(
    `SELECT failed, locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked
       FROM login_lockout WHERE user_id = $1 AND kind = $2 FOR UPDATE`, [userId, kind]);
  const row = r.rows[0];
  return { failed: row.failed, locked: row.locked, lockedUntil: row.locked_until };
}

/** Counts a failure; on reaching `max` the account locks for `minutes` and the counter restarts. Returns true if it just locked. */
export async function recordFailure(c: pg.PoolClient, userId: string, kind: LockKind, state: LockState, max: number, minutes: number): Promise<boolean> {
  const lock = state.failed + 1 >= max;
  await c.query(
    `UPDATE login_lockout SET failed = CASE WHEN $3 THEN 0 ELSE failed + 1 END,
            locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
      WHERE user_id = $1 AND kind = $2`, [userId, kind, lock, minutes]);
  return lock;
}

export async function clearLockout(c: pg.PoolClient, userId: string, kind: LockKind): Promise<void> {
  await c.query('UPDATE login_lockout SET failed = 0, locked_until = NULL WHERE user_id = $1 AND kind = $2', [userId, kind]);
}
