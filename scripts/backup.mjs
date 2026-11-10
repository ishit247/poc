// Database backup: one pg_dump (custom format) of `pos` into .backups/pos-<UTC time>.dump.
//   node scripts/backup.mjs [--out <dir>]
// Runs pg_dump inside the postgres container as the superuser. It must NOT run as pos_owner or pos_app: every table
// has FORCEd row-level security, and pg_dump (row_security off) then refuses or, as an RLS-filtered role, would
// dump nothing. On a real server use a dedicated role with BYPASSRLS and read rights only (docs/runbook.md).
// Item pictures live in the object store, not in this dump (docs/runbook.md, "What a backup does not hold").
// Prove a dump restores with: node --import tsx scripts/restore-drill.ts
import { mkdirSync, openSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const i = process.argv.indexOf('--out');
const dir = i > 0 ? process.argv[i + 1] : '.backups';
mkdirSync(dir, { recursive: true });
const file = `${dir}/pos-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;

const started = Date.now();
const fd = openSync(file, 'w');
const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'pos', '-Fc'],
  // Owners are kept (no --no-owner): restored as postgres, tables would belong to the superuser, and a SECURITY
  // DEFINER function owned by it would bypass RLS. The roles must exist before a restore (db/init/01-roles.sql).
  { stdio: ['ignore', fd, 'inherit'] });
closeSync(fd);
if (r.status !== 0) { console.error(`backup FAILED (pg_dump exit ${r.status}); ${file} is incomplete`); process.exit(1); }
console.log(`backup ${file}  ${(statSync(file).size / 1024).toFixed(0)} KiB  ${((Date.now() - started) / 1000).toFixed(1)}s`);
