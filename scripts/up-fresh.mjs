// Destroys the dev volume, then brings the whole Docker environment up: migrations from 0001, reseed.
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('docker', ['compose', '--profile', 'seed', 'down', '-v']);
run('node', ['scripts/up.mjs', ...process.argv.slice(2)]); // `--test`: seed the test fixture (scripts/seed-test.ts) instead of the demo data
