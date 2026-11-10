// Revoking a tablet from the manager's Tablets tab (phase 11 step 6), two tablets at School 1 C1, installed Edge,
// against the Docker stack on :8080. Usage: node scripts/validate.mjs fresh --yes   then   node scripts/browser-tablets.mjs
// Writes .validation/browser-tablets.log and screenshots in .validation/screens/. Dev data only: seeded tenant A.
//
// What it checks: the list shows both tablets and marks the one in your hand; revoking the other one asks for a reason
// and records it; a sale that tablet made offline BEFORE the revocation still reaches the server when it reconnects,
// and then the tablet returns to the set-up screen; the tablet in your hand cannot revoke itself while it holds
// records not yet sent, and can once they are sent, after which it is back at the set-up screen.
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/counter/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8080';
const PIN = '482913';
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
const sql = (q) => execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-F', '|', '-c',
  `BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true); ${q}; COMMIT;`]).toString()
  .split('\n').filter((l) => l && !['BEGIN', 'COMMIT'].includes(l) && !l.startsWith('00000000-'));

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const [[outletId, counterId]] = sql("SELECT o.id, c.id FROM outlet o JOIN counter c ON c.outlet_id = o.id WHERE o.name = 'School 1 Canteen' AND c.code = 'C1'").map((l) => l.split('|'));
const tag = Date.now().toString(36).slice(-4).toUpperCase();

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

async function tablet(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  const label = `Tab ${name}-${tag}`;
  const code = (await api('POST', '/enrolment-codes', { outletId, counterId, label }, mgr)).json.code;
  await page.goto(BASE);
  await page.getByTestId('enrol-code').fill(code); await page.getByTestId('enrol-go').click();
  await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
  const T = (id) => page.getByTestId(id);
  const [[id]] = sql(`SELECT id FROM device WHERE label = '${label}'`).map((l) => l.split('|'));
  return {
    ctx, page, T, label, id,
    shot: (n) => page.screenshot({ path: `${out}/screens/tablets-${n}.png` }),
    until: async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await page.waitForTimeout(100); } return false; },
    async cashierSale() {
      await page.locator('[data-testid^="staff-"]').filter({ hasText: /School 1 Canteen cashier(?! 2)/i }).first().click();
      for (const d of PIN) await T(`key-${d}`).click();
      await T('pin-go').click();
      const opening = T('opening-cash');
      if (await opening.waitFor({ timeout: 5000 }).then(() => true, () => false)) { await opening.fill('500'); await T('open-shift').click(); }
      await T('tab-sell').click();
      await page.locator('button.item:not([disabled])').first().click();
      await T('pay-cash').click(); await T('confirm-pay').click();
      const receipt = (await T('receipt-no').innerText()).trim();
      await T('new-sale').click();
      await T('more-menu').click(); await T('sign-out').click();
      return receipt;
    },
    async manager() {
      await T('more-menu').click(); await T('mgr-open').click();
      await T('mgr-email').fill('a1@example.test'); await T('mgr-password').fill('dev-password-123'); await T('mgr-login').click();
      await T('mgr-tab-tablets').click();
      await T('mgr-tablets').waitFor();
    },
  };
}
const row = (t, deviceId) => t.page.locator(`[data-testid="mgr-tablet"][data-device-id="${deviceId}"]`);

try {
  const a = await tablet('A', { width: 1024, height: 768 }); // the manager's tablet
  const b = await tablet('B', { width: 768, height: 1024 });

  // B rings a cash sale while offline: it exists only on B when A revokes it.
  await b.ctx.setOffline(true);
  const bReceipt = await b.cashierSale();
  check('B: a sale made offline', /\d/.test(bReceipt), bReceipt);

  await a.manager();
  await a.until(async () => (await row(a, b.id).count()) === 1);
  check('Tablets tab lists both tablets by label', (await row(a, a.id).innerText()).includes(a.label) && (await row(a, b.id).innerText()).includes(b.label));
  check('the tablet in your hand is marked', (await row(a, a.id).innerText()).includes('This tablet') && !(await row(a, b.id).innerText()).includes('This tablet'));
  check('no sideways scroll at 1024x768', await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.shot('1-list');

  // Rename B so it can be told apart: Save stays disabled until the name changes; the list and server follow.
  const newName = `Waiter tablet ${tag}`;
  await row(a, b.id).getByTestId('mgr-rename').click();
  check('rename opens with the current name, Save disabled until it changes',
    (await a.T('mgr-rename-label').inputValue()) === b.label && await a.T('mgr-rename-go').isDisabled());
  await a.T('mgr-rename-label').fill(`  ${newName}  `);
  await a.shot('1b-rename');
  await a.T('mgr-rename-go').click();
  check('the list shows the new name', await a.until(async () => (await row(a, b.id).innerText()).includes(newName)));
  const [[label, audited]] = sql(`SELECT d.label, (SELECT count(*) FROM audit WHERE action = 'device.label' AND entity_id = d.id) FROM device d WHERE d.id = '${b.id}'`).map((l) => l.split('|'));
  check('server: label saved trimmed, rename audited', label === newName && audited === '1', `${label} ${audited}`);
  check('both buttons on one row, Revoke last', await a.page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="mgr-tablet"][data-device-id="${id}"]`);
    const [x, y] = [r.querySelector('[data-testid="mgr-rename"]').getBoundingClientRect(), r.querySelector('[data-testid="mgr-revoke"]').getBoundingClientRect()];
    return Math.abs(x.top - y.top) < 2 && x.right <= y.left;
  }, b.id));
  await a.page.setViewportSize({ width: 768, height: 1024 });
  check('portrait 768x1024: no sideways scroll with two buttons per row', await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.shot('1c-portrait');
  await a.page.setViewportSize({ width: 1024, height: 768 });

  // Revoke B: the reason is required; a quick reason fills it.
  await row(a, b.id).getByTestId('mgr-revoke').click();
  check('revoke is disabled until a reason is given', await a.T('mgr-revoke-go').isDisabled());
  await a.page.getByRole('button', { name: 'Stolen', exact: true }).click();
  check('a quick reason fills the field', (await a.T('mgr-revoke-reason').inputValue()) === 'Stolen');
  await a.shot('2-confirm');
  await a.T('mgr-revoke-go').click();
  check('B leaves the working list', await a.until(async () => (await row(a, b.id).count()) === 0));
  await a.T('mgr-show-revoked').click();
  check('B is listed under Revoked', (await a.page.locator(`[data-testid="mgr-tablet-revoked"][data-device-id="${b.id}"]`).count()) === 1);
  const [[revokedAt, reason]] = sql(`SELECT d.revoked_at IS NOT NULL, a.detail->>'reason' FROM device d JOIN audit a ON a.entity_id = d.id AND a.action = 'device.revoke' WHERE d.id = '${b.id}'`).map((l) => l.split('|'));
  check('server: B revoked, audit row carries the reason', revokedAt === 't' && reason === 'Stolen', `${revokedAt} ${reason}`);

  // B reconnects: its pre-revocation sale is delivered (push accepts a revoked tablet's earlier events), then it resets.
  await b.ctx.setOffline(false);
  check('B returns to the set-up screen with a notice', await b.until(async () => (await b.T('enrol-notice').count()) === 1, 20000));
  const [[delivered]] = sql(`SELECT count(*) FROM sale WHERE device_id = '${b.id}' AND status = 'paid'`).map((l) => l.split('|'));
  check('server: B\'s offline sale from before the revocation arrived', delivered === '1', delivered);
  await b.shot('3-b-reset');

  // A cannot revoke itself while it holds unsent records. Block A's push so a sale stays unsent.
  await a.T('more-menu').click(); await a.T('mgr-exit').click();
  await a.page.route('**/api/sync/push', (r) => r.abort());
  await a.cashierSale();
  await a.manager();
  await row(a, a.id).getByTestId('mgr-revoke').click();
  await a.T('mgr-revoke-reason').fill('Replaced');
  check('self-revoke with unsent records: refused, and says why',
    await a.until(async () => (await a.T('mgr-revoke-self').innerText()).includes('not sent yet')) && await a.T('mgr-revoke-go').isDisabled());
  await a.shot('4-self-unsent');
  await a.page.keyboard.press('Escape');

  // Once sent, it may.
  await a.page.unroute('**/api/sync/push');
  await a.T('sync-now').click();
  check('A: its sale is sent', await a.until(async () => /^0\b/.test((await a.T('pending').innerText()).trim()), 15000));
  await row(a, a.id).getByTestId('mgr-revoke').click();
  await a.T('mgr-revoke-reason').fill('Replaced');
  check('self-revoke allowed once everything is sent', await a.until(async () => (await a.T('mgr-revoke-self').innerText()).includes('return to the set-up screen')) && await a.T('mgr-revoke-go').isEnabled());
  await a.T('mgr-revoke-go').click();
  check('A returns to the set-up screen at once', await a.until(async () => (await a.T('enrol-notice').count()) === 1, 5000));
  const [[aRevoked]] = sql(`SELECT revoked_at IS NOT NULL FROM device WHERE id = '${a.id}'`).map((l) => l.split('|'));
  check('server: A revoked', aRevoked === 't');
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter((r) => r.ok).length;
const summary = `${passed}/${results.length} passed${passed < results.length ? '; failed: ' + results.filter((r) => !r.ok).map((r) => r.name).join(', ') : ''}`;
console.log(summary);
fs.writeFileSync(`${out}/browser-tablets.log`, [...log, summary].join('\n') + '\n');
process.exit(passed === results.length ? 0 : 1);
