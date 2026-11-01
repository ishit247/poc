// Brings the whole environment up in Docker: Postgres, migrations, API, counter (nginx).
// Seeds dev data only if the database is empty. Does NOT wipe data; `pnpm run up:fresh` does, then run this.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const run = (args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });

run(['up', '-d', '--build', '--wait']);

const client = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL ?? 'postgres://pos_owner:pos_owner@localhost:55432/pos' });
await client.connect();
const seeded = (await client.query('SELECT count(*)::int AS n FROM platform_admin')).rows[0].n > 0; // not tenant-scoped, so RLS cannot hide it
await client.end();
if (seeded) console.log('database already seeded (use `pnpm run up:fresh` to reset)');
else run(['run', '--rm', 'seed']);

console.log('\nCounter + API  http://localhost:8080  (API under /api)\nPostgres       localhost:55432\nTest accounts: docs/test-accounts.md');
