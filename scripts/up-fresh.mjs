// Destroys the dev volume, recreates Postgres, runs every migration from 0001, reseeds.
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('docker', ['compose', 'down', '-v']);
run('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
run('node', ['scripts/migrate.mjs']);
run('node', ['--import', 'tsx', 'scripts/seed.ts']);
