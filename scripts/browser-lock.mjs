// Offline lock (PLAN 7.2, apps/counter/src/lock.ts): a tablet whose last server contact is older than the tenant's
// offlineDays stops selling, and unlocks by itself at its next successful sync. Installed Edge against the Docker
// stack on :8080. Usage: node scripts/validate.mjs fresh --yes   then   node scripts/browser-lock.mjs
// Writes .validation/browser-lock.log and screenshots in .validation/screens/. Dev data only: seeded tenant A.
// The contact times are aged by writing the tablet's own IndexedDB while it is offline; nothing on the server changes.
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/counter/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8080';
const out = '.validation';
fs.mkdirSync(`${out}/screens`, { recursive: true });
const log = [];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); const l = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`; log.push(l); console.log(l); };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: 'localhost', port: 8080, path: '/api' + path, method,
      headers: { host: 'tenant-a.localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const outlet = (await api('GET', '/me', null, mgr)).json.outlets.find((o) => o.name === 'School 1 Canteen');
const days = (await api('GET', '/settings', null, mgr)).json.offlineDays;
const DAY = 86_400_000;

// Sets the tablet's lastPull and lastPush (the contact times lock.ts reads) to `ageMs` before now.
const age = (page, ageMs) => page.evaluate((a) => new Promise((resolve, reject) => {
  const open = indexedDB.open('counter');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('meta', 'readwrite');
    const t = new Date(Date.now() - a).toISOString();
    tx.objectStore('meta').put({ key: 'lastPull', value: t });
    tx.objectStore('meta').put({ key: 'lastPush', value: t });
    tx.oncomplete = () => { open.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}), ageMs);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  for (const [w, h] of [[1024, 768], [820, 1180]]) {
    const tag = `@${w}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${w}: ${e}`));
    const T = (id) => page.getByTestId(id);
    const code = (await api('POST', '/enrolment-codes', { outletId: outlet.id, counterId: outlet.counters[0].id, label: `Lock ${w}` }, mgr)).json.code;
    await page.goto(BASE);
    await T('enrol-code').fill(code); await T('enrol-go').click();
    await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
    check(`a freshly synced tablet is open ${tag}`, (await T('offline-lock').count()) === 0 && (await T('lock-warn').count()) === 0);

    // Offline, contact a few hours short of the limit: still selling, with a warning.
    await ctx.setOffline(true);
    await age(page, days * DAY - 3 * 3_600_000);
    await page.reload();
    await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
    const warned = await until(() => T('lock-warn').isVisible(), 5000);
    check(`warns in the last day ${tag}`, warned, warned ? await T('lock-warn').innerText() : (await page.locator('body').innerText()).slice(0, 300).replace(/\s+/g, ' '));
    check(`still selling while warned ${tag}`, (await T('offline-lock').count()) === 0);

    // Past the limit: the PIN pad is replaced by the lock.
    await age(page, days * DAY + 3_600_000);
    await page.reload();
    check(`locks once the days are up ${tag}`, await until(() => T('offline-lock').isVisible(), 8000));
    check(`lock says why ${tag}`, (await T('offline-lock').getAttribute('data-reason')) === 'too_long');
    check(`no PIN pad while locked ${tag}`, (await page.locator('[data-testid^="staff-"]').count()) === 0);
    check(`no sideways scroll ${tag}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${out}/screens/lock-${w}.png` });

    // A clock set back past the last contact also locks.
    await age(page, -3 * DAY);
    await page.reload();
    check(`a clock set back locks ${tag}`, await until(async () => (await T('offline-lock').getAttribute('data-reason')) === 'clock', 8000));

    // Back online: the next sync writes a new contact time and the lock lifts by itself.
    await age(page, days * DAY + 3_600_000);
    await ctx.setOffline(false);
    // The browser's `online` event already syncs, which usually unlocks before a tap; Try now is for when it did not.
    await T('lock-sync').click({ timeout: 2000 }).catch(() => {});
    check(`unlocks after a sync ${tag}`, await until(async () => (await T('offline-lock').count()) === 0 && (await page.locator('[data-testid^="staff-"]').count()) > 0, 15000));
    await ctx.close();
  }
} finally {
  await browser.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
const passed = results.filter((r) => r.ok).length;
log.push(`${passed}/${results.length} passed`);
console.log(`${passed}/${results.length} passed`);
fs.writeFileSync(`${out}/browser-lock.log`, log.join('\n') + '\n');
process.exitCode = passed === results.length ? 0 : 1;
