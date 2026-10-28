import type pg from 'pg';

export interface AuditEntry {
  tenantId: string;
  actorKind: 'user' | 'device' | 'system' | 'anonymous';
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Appends to audit inside the caller's transaction, behind a SAVEPOINT: if the
 * audit insert fails it rolls back to the savepoint only, so the business write
 * survives. A failed audit is reported loudly but does not abort the caller.
 */
export async function audit(c: pg.PoolClient, e: AuditEntry): Promise<void> {
  await c.query('SAVEPOINT audit_sp');
  try {
    await c.query(
      'INSERT INTO audit (tenant_id, actor_kind, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.tenantId, e.actorKind, e.actorId ?? null, e.action, e.entity, e.entityId ?? null, e.detail ?? {}]);
    await c.query('RELEASE SAVEPOINT audit_sp');
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT audit_sp');
    console.error('AUDIT WRITE FAILED', e.action, (err as Error).message);
  }
}
