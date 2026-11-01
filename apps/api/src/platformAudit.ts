import type pg from 'pg';

export interface PlatformAuditEntry {
  adminId?: string | null;
  action: string;
  tenantId?: string | null;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Appends to platform_audit inside the console's transaction, behind a SAVEPOINT, like the tenant audit: a failed
 * audit insert rolls back to the savepoint only, so the console action it describes survives, and is reported loudly.
 */
export async function platformAudit(c: pg.PoolClient, e: PlatformAuditEntry): Promise<void> {
  await c.query('SAVEPOINT paudit_sp');
  try {
    await c.query(
      'INSERT INTO platform_audit (admin_id, action, tenant_id, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.adminId ?? null, e.action, e.tenantId ?? null, e.entity, e.entityId ?? null, e.detail ?? {}]);
    await c.query('RELEASE SAVEPOINT paudit_sp');
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT paudit_sp');
    console.error('PLATFORM AUDIT WRITE FAILED', e.action, (err as Error).message);
  }
}
