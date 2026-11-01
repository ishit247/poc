// Preflight for scripts/validate.mjs: fail early, with the reason, instead of ten minutes in.
import { spawnSync } from 'node:child_process';

const checks = [];
const major = Number(process.versions.node.split('.')[0]);
checks.push([`node ${process.versions.node} (need >= 22)`, major >= 22]);
checks.push(['docker daemon reachable', spawnSync('docker', ['info'], { shell: true }).status === 0]);
const pg = spawnSync('docker compose ps --status running --services', { shell: true, encoding: 'utf8' });
checks.push(['postgres container running (docker compose up -d --wait postgres)', /postgres/.test(pg.stdout ?? '')]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok' : 'not ok'} - ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
