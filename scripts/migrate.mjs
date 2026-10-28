// Applies db/migrations/*.sql in name order as pos_owner. Tracks files by NAME
// only (no checksum) on purpose: while no real tenant exists, a migration is
// fixed in place and re-applied to a fresh volume (see CLAUDE.md).
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const url = process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos';

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log('applied', file);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('FAILED', file, e.message);
    process.exitCode = 1;
    break;
  }
}
await client.end();
