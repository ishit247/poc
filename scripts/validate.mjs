// Validation runner with live feedback. Every stage is also runnable alone.
//   node scripts/validate.mjs --list
//   node scripts/validate.mjs quick            profile: env, typecheck, unit tests (no database reset)
//   node scripts/validate.mjs standard         + fresh start from migration 0001 + db tests
//   node scripts/validate.mjs full             + counter build + mutation checks (slow: 10+ minutes)
//   node scripts/validate.mjs typecheck db     any stage names
//   flags: --yes (skip the confirmation before a destructive stage), --keep-going (do not stop at first failure)
// Output: a live line per stage (spinner, elapsed, passed/failed counts), a summary table, full logs in
// .validation/<stage>.log and a report at .validation/report.html (open it from disk).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const STAGES = {
  env: {
    what: 'Node version, Docker daemon, no mutation run in progress',
    run: 'node scripts/validate-env.mjs',
  },
  typecheck: { what: 'tsc --noEmit in every package', run: 'pnpm typecheck' },
  'unit-api': {
    what: 'API tests on real Postgres (scope, auth, orders, sync, tenancy)',
    run: 'pnpm --filter ./apps/api test',
    needsDb: true,
  },
  'unit-counter': { what: 'Tablet tests (sale, push, receipt)', run: 'pnpm --filter ./apps/counter test' },
  fresh: {
    what: 'DESTROYS the dev volume, reruns migrations 0001.., reseeds two tenants',
    run: 'pnpm run up:fresh',
    destructive: true,
    needsDb: true,
  },
  db: {
    what: 'Schema tests: RLS isolation, trading invariants, online orders',
    run: 'node --test db/test/rls.test.mjs db/test/trading.test.mjs db/test/online.test.mjs db/test/platform.test.mjs',
    needsDb: true,
  },
  build: { what: 'Tablet production build (tsc + vite)', run: 'pnpm --filter ./apps/counter build' },
  mutation: {
    what: 'Weaken one guard at a time, require a test to fail. Rewrites source files while running',
    run: 'node scripts/mutation-checks.mjs',
    destructive: true,
    needsDb: true,
    slow: true,
  },
};
const PROFILES = {
  quick: ['env', 'typecheck', 'unit-counter'],
  standard: ['env', 'typecheck', 'fresh', 'db', 'unit-api', 'unit-counter'],
  full: ['env', 'typecheck', 'fresh', 'db', 'unit-api', 'unit-counter', 'build', 'mutation'],
};

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const fmt = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const names = args.filter((a) => !a.startsWith('--'));

if (flags.has('--list') || names.length === 0) {
  console.log(bold('Stages'));
  for (const [k, s] of Object.entries(STAGES)) console.log(`  ${k.padEnd(13)}${s.slow ? yellow('[slow] ') : ''}${s.destructive ? red('[destructive] ') : ''}${s.what}`);
  console.log(bold('\nProfiles'));
  for (const [k, v] of Object.entries(PROFILES)) console.log(`  ${k.padEnd(13)}${v.join(' → ')}`);
  process.exit(names.length === 0 && !flags.has('--list') ? 1 : 0);
}

const plan = names.flatMap((n) => PROFILES[n] ?? [n]);
for (const n of plan) if (!STAGES[n]) { console.error(red(`unknown stage or profile: ${n}`)); process.exit(1); }

mkdirSync('.validation', { recursive: true });

function runStage(name) {
  const st = STAGES[name];
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(`.validation/${name}.log`);
    const counts = { ok: 0, fail: 0 };
    let last = '', tail = [], buf = '';
    const child = spawn(st.run, { shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
    const take = (d) => {
      log.write(d);
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const raw of lines) {
        const l = raw.replace(ANSI, '');
        if (!l.trim()) continue;
        if (/^\s*ok \d+/.test(l)) counts.ok++;
        else if (/^\s*not ok \d+/.test(l)) counts.fail++;
        last = l.trim().slice(0, 70);
        tail.push(l); if (tail.length > 40) tail.shift();
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    let i = 0;
    const status = () => `${counts.ok} ok${counts.fail ? red(` ${counts.fail} FAILED`) : ''}`;
    const tick = setInterval(() => {
      if (tty) process.stdout.write(`\r\x1b[2K  ${yellow(frames[i++ % frames.length])} ${name.padEnd(13)} ${fmt(Date.now() - started).padEnd(7)} ${status()}  ${dim(last)}`.slice(0, 200));
      else if (++i % 15 === 0) console.log(`  … ${name} ${fmt(Date.now() - started)} ${counts.ok} ok ${counts.fail} failed`);
    }, 200);
    child.on('close', (code) => {
      clearInterval(tick); log.end();
      const ms = Date.now() - started;
      const pass = code === 0;
      if (tty) process.stdout.write('\r\x1b[2K');
      console.log(`  ${pass ? green('✔') : red('✘')} ${name.padEnd(13)} ${fmt(ms).padEnd(7)} ${counts.ok} ok${counts.fail ? red(` ${counts.fail} failed`) : ''}${pass ? '' : red(`  exit ${code}`)}`);
      if (!pass) for (const l of tail.slice(-12)) console.log(dim(`      ${l.slice(0, 160)}`));
      resolve({ name, pass, ms, ...counts, code, tail: pass ? [] : tail.slice(-25) });
    });
  });
}

const guard = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'mutation-checks' } | Measure-Object).Count"], { encoding: 'utf8' });
const mutationRunning = Number(guard.stdout?.trim()) > 0;
if (mutationRunning) {
  console.error(red('A mutation run is in progress: it owns the database and rewrites source files, so any result now would be about a mutant.'));
  console.error('Wait for it to finish (or stop it and restore the tree with git), then rerun.');
  process.exit(2);
}

const destructive = plan.filter((n) => STAGES[n].destructive);
if (destructive.length && !flags.has('--yes')) {
  if (!tty) { console.error(red(`Destructive stage(s) ${destructive.join(', ')} need --yes when not run in a terminal.`)); process.exit(2); }
  console.log(yellow(`These stages change state: ${destructive.join(', ')}`));
  for (const n of destructive) console.log(`  ${n}: ${STAGES[n].what}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Continue? [y/N] ')).trim().toLowerCase(); rl.close();
  if (a !== 'y') process.exit(1);
}

console.log(bold(`\nValidating: ${plan.join(' → ')}\n`));
const results = [];
for (const n of plan) {
  const r = await runStage(n);
  results.push(r);
  if (!r.pass && !flags.has('--keep-going')) {
    for (const rest of plan.slice(results.length)) results.push({ name: rest, skipped: true });
    break;
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const row = (r) => r.skipped
  ? `<tr class="skip"><td>${r.name}</td><td>skipped</td><td></td><td></td><td></td></tr>`
  : `<tr class="${r.pass ? 'pass' : 'fail'}"><td>${r.name}</td><td>${r.pass ? 'PASS' : 'FAIL'}</td><td>${fmt(r.ms)}</td><td>${r.ok}</td><td>${r.fail}</td></tr>${r.pass ? '' : `<tr><td colspan="5"><pre>${esc(r.tail.join('\n'))}</pre></td></tr>`}`;
writeFileSync('.validation/report.html', `<meta charset="utf-8"><title>Validation report</title>
<style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 10px}
.pass td:nth-child(2){color:#0a7a2f;font-weight:600}.fail td:nth-child(2){color:#b00020;font-weight:600}.skip{color:#888}pre{margin:0;font-size:12px}</style>
<h1>Validation report</h1><p>${new Date().toISOString()} · ${plan.join(' → ')}</p>
<table><tr><td>stage</td><td>result</td><td>time</td><td>ok</td><td>failed</td></tr>${results.map(row).join('')}</table>`);

const bad = results.filter((r) => r.skipped || !r.pass);
console.log(`\n${bad.length ? red(bold('NOT VALIDATED')) : green(bold('ALL STAGES PASSED'))}  ${dim('logs: .validation/<stage>.log   report: .validation/report.html')}`);
for (const r of results.filter((x) => x.skipped)) console.log(yellow(`  skipped: ${r.name}`));
process.exit(bad.length ? 1 : 0);
