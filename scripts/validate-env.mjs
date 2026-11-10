// Preflight for scripts/validate.mjs: fail early, with the reason, instead of ten minutes in.
import { spawnSync } from 'node:child_process';

const checks = [];
const major = Number(process.versions.node.split('.')[0]);
checks.push([`node ${process.versions.node} (need >= 22)`, major >= 22]);
const docker = spawnSync('docker', ['info'], { shell: true }).status === 0;
checks.push(['docker daemon reachable (start Docker Desktop)', docker]);

// Postgres and garage are started here if they are not running (a cold machine), so stages after this one find them.
// Starting them changes no data; `fresh` is the stage that wipes.
const running = () => spawnSync('docker compose ps --status running --services', { shell: true, encoding: 'utf8' }).stdout ?? '';
if (docker && !(/postgres/.test(running()) && /garage/.test(running()))) {
  console.log('# starting postgres and garage');
  const up = spawnSync('docker compose up -d --wait postgres garage', { shell: true, stdio: 'inherit' });
  if (up.status === 0) spawnSync(process.execPath, ['scripts/garage-init.mjs'], { stdio: 'inherit' });
}
const svc = docker ? running() : '';
checks.push(['postgres container running', /postgres/.test(svc)]);
checks.push(['garage container running (bucket and key from scripts/garage-init.mjs)', /garage/.test(svc)]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok' : 'not ok'} - ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
