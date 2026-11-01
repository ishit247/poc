// Destroys the dev volume, then brings the whole Docker environment up: migrations from 0001, reseed.
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('docker', ['compose', '--profile', 'seed', 'down', '-v']);
run('node', ['scripts/up.mjs']);
