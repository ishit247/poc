// Restore drill: restore a backup into a scratch database next to `pos` and prove it is the same database.
//   node --import tsx scripts/restore-drill.ts [dump]     (default: the newest .backups/*.dump)
//   add --keep to leave the scratch database `pos_restore_drill` for inspection.
// An untested backup is a hope (PLAN section 18). Checks, each PASS/FAIL:
//   1. every table has the same row count as in `pos` (read as the superuser, so RLS hides nothing)
//   2. RLS: the same tables have row security enabled and forced, and the same policies
//   3. the same owners (tables and functions) and the same table grants for pos_app and app_platform
//   4. as pos_app, stamped for tenant A, the restored database shows tenant A's rows and none of B's
//   5. every sealed secret opens under this SECRETS_KEY (a restore without the key loses the webhook and console secrets)
// Compares against the live `pos`, so take the dump just before (scripts/backup.mjs) on a quiet stack.
import { readdirSync, openSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openSecret, totpSecretContext, webhookSecretContext } from '../apps/api/src/security/crypto.ts';

const SCRATCH = 'pos_restore_drill';
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dump = args.find((a) => !a.startsWith('--'))
  ?? (() => { const f = readdirSync('.backups').filter((n) => n.endsWith('.dump')).sort().at(-1); return f && `.backups/${f}`; })();
if (!dump) { console.error('no dump given and none in .backups/ (run node scripts/backup.mjs)'); process.exit(1); }

const psql = (db: string, sql: string, user = 'postgres') => {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '|', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql ${db}: ${r.stderr.trim()}`);
  return r.stdout.trim().split('\n').filter(Boolean);
};

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const same = (name: string, sql: string) => {
  const a = psql('pos', sql), b = psql(SCRATCH, sql);
  const diff = [...a.filter((x) => !b.includes(x)).map((x) => `only live: ${x}`), ...b.filter((x) => !a.includes(x)).map((x) => `only restored: ${x}`)];
  check(name, diff.length === 0 && a.length > 0, diff.length ? diff.slice(0, 5).join('; ') : `${a.length} rows compared`);
};

const started = Date.now();
console.log(`restoring ${dump} (${(statSync(dump).size / 1024).toFixed(0)} KiB) into ${SCRATCH}`);
psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH}`);
psql('postgres', `CREATE DATABASE ${SCRATCH} OWNER pos_owner`);
// Database-level grants are not in a pg_dump of one database: they come from db/init/01-roles.sql on a new server.
psql('postgres', `GRANT CONNECT ON DATABASE ${SCRATCH} TO pos_app, app_platform`);
const fd = openSync(dump, 'r');
const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', SCRATCH, '--exit-on-error'], { stdio: [fd, 'inherit', 'inherit'] });
closeSync(fd);
check('pg_restore completed without error', r.status === 0, `exit ${r.status}`);

try {
  if (r.status === 0) {
    same('1. row count of every table', `
      SELECT c.relname || '|' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
    same('2a. row security enabled and forced, per table', `
      SELECT c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public' ORDER BY 1`);
    same('2b. the same policies', `SELECT tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') FROM pg_policies ORDER BY 1`);
    same('3a. owners of tables and functions', `
      SELECT 'rel|' || c.relname || '|' || pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'p', 'v', 'S')
      UNION ALL SELECT 'fn|' || n.nspname || '.' || p.proname || '|' || pg_get_userbyid(p.proowner) || '|' || p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
    same('3b. table grants for pos_app and app_platform', `
      SELECT grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants
       WHERE grantee IN ('pos_app', 'app_platform') ORDER BY 1`);

    const iso = psql(SCRATCH, `BEGIN; SELECT set_config('app.tenant_id', '${TENANT_A}', true);
      SELECT count(*) FILTER (WHERE tenant_id = '${TENANT_A}') || '|' || count(*) FILTER (WHERE tenant_id <> '${TENANT_A}') FROM sale; COMMIT;`, 'pos_app')
      .find((l) => /^\d+\|\d+$/.test(l)) ?? '';
    const [mine, others] = iso.split('|').map(Number);
    check('4. as pos_app for tenant A: own sales visible, no other tenant\'s', mine! > 0 && others === 0, `${mine} own, ${others} other`);

    const sealed = psql(SCRATCH, `SELECT 'w|' || id || '|' || webhook_secret_sealed FROM outlet_integration
                                  UNION ALL SELECT 'p|' || id || '|' || totp_secret_sealed FROM platform_admin`);
    const bad = sealed.filter((l) => {
      const [kind, id, value] = l.split('|') as [string, string, string];
      try { openSecret(value, kind === 'w' ? webhookSecretContext(id) : totpSecretContext(id)); return false; } catch { return true; }
    });
    check('5. every sealed secret opens under this SECRETS_KEY', sealed.length > 0 && bad.length === 0, `${sealed.length - bad.length}/${sealed.length}`);
  }
} finally {
  if (!keep) psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH}`);
}
console.log(`\n${failed ? `RESTORE DRILL FAILED (${failed})` : 'RESTORE DRILL PASSED'} in ${((Date.now() - started) / 1000).toFixed(1)}s${keep ? `; ${SCRATCH} kept` : ''}`);
process.exit(failed ? 1 : 0);
