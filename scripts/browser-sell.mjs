// Real-browser run of the Sell screen (phase 12 step 6) against the Docker stack on :8080, with installed Edge.
// Usage: node scripts/browser-sell.mjs   (stack up, counter image rebuilt). Writes .validation/browser-sell.log and screenshots.
// Dev data only: seeded tenant A, manager a1@example.test, staff PIN from scripts/seed.ts.
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
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

// The API is reached through nginx on :8080; the tenant is chosen by the Host header.
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: 'localhost', port: 8080, path: '/api' + path, method, headers: { host: 'tenant-a.localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const login = await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' });
const mgr = login.json.token;
// Ids are random per seed: read them from the dev database (tenant A).
const sql = "BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true); SELECT o.id||' '||c.id FROM outlet o JOIN counter c ON c.outlet_id=o.id WHERE o.name='School 1 Canteen' AND c.code='C1'; COMMIT;";
const ids = execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', sql]).toString().split('\n').find((l) => /^[0-9a-f-]{36} [0-9a-f-]{36}$/.test(l)).split(' ');
const outlet = { id: ids[0] }; const counter = { id: ids[1] };
await api('PUT', `/outlets/${outlet.id}/table-mode`, { mode: 'default' }, mgr);
const code = (await api('POST', '/enrolment-codes', { outletId: outlet.id, counterId: counter.id }, mgr)).json.code;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${out}/screens/${n}.png` });
const T = (id) => page.getByTestId(id);
const text = async (id) => (await T(id).innerText()).trim();
const firstItem = () => page.locator('button.item:not([disabled])').first();
const settled = async (f) => { await page.waitForTimeout(400); return f(); }; // IndexedDB live queries repaint a moment after the click
const lineCount = () => settled(() => page.locator('[data-testid="cart-lines"] li .name').count());

try {
  await page.goto(BASE);
  await T('enrol-code').fill(code); await T('enrol-go').click();
  await page.locator('[data-testid^="staff-"]').filter({ hasText: /cashier/i }).first().click();
  for (const d of PIN) await T(`key-${d}`).click();
  await T('pin-go').click();
  await T('opening-cash').fill('500'); await T('open-shift').click();
  await T('tab-sell').click();
  await T('search').waitFor();
  await shot('1-sell-1024x768');
  check('no sideways scroll at 1024x768', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // Quick code search + Add button
  const firstCode = (await page.locator('.item .code').first().innerText()).trim();
  check('items show a 4-digit quick code', /^\d{4}$/.test(firstCode), firstCode);
  check('Add disabled before a code is typed', await T('add-code').isDisabled());
  await T('search').fill(firstCode.slice(0, 2));
  check('prefix shows several matches or a hint', (await text('code-hint')).length > 0, await text('code-hint'));
  await T('search').fill(firstCode);
  check('Add enabled on an exact code', await T('add-code').isEnabled());
  await T('add-code').click();
  check('Add puts one item in the cart', (await lineCount()) === 1);
  check('search cleared after Add', (await T('search').inputValue()) === '');

  // Draft: hold and resume
  const totalBefore = await text('total');
  await T('held-btn').click(); await T('hold').click();
  check('hold empties the cart', (await lineCount()) === 0);
  await T('held-btn').click();
  check('held order appears in the popup', (await settled(() => T('held-order').count())) === 1);
  await T('held-order').click();
  await page.waitForTimeout(400);
  check('resume restores the same total', (await text('total')) === totalBefore, totalBefore);
  await shot('2-resumed-order');

  // Edit the running order, then one-tap pay with quick cash
  await page.locator('[aria-label^="more "]').first().click();
  await page.waitForTimeout(400); const t2 = await text('total');
  check('+ on a running order raises the total', t2 !== totalBefore, `${totalBefore} -> ${t2}`);
  await T('pay-cash').click();
  check('cash dialog opens with quick amounts', (await T('quick-cash').count()) === 1);
  await shot('3-pay-dialog');
  await page.locator('[data-testid^="cash-"]:not([data-testid="cash-exact"]):not([data-testid="cash-in"])').first().click();
  check('quick cash fills the received amount', (await T('cash-in').inputValue()) !== '');
  await T('confirm-pay').click();
  await T('receipt-no').waitFor();
  check('paid receipt shown', true, await text('receipt-no'));
  await shot('4-receipt');
  await T('search').waitFor({ timeout: 9000 });
  check('auto-returns to Sell after ~6 s', true);

  // Pay-now draft with UPI
  await firstItem().click();
  await T('pay-upi').click();
  check('UPI opens the dialog in UPI mode', (await T('quick-cash').count()) === 0);
  await T('confirm-pay').click();
  await T('receipt-no').waitFor();
  check('UPI draft paid in one dialog', true, await text('receipt-no'));
  await T('new-sale').click();

  // Offline: sell with the network cut
  await ctx.setOffline(true);
  await firstItem().click();
  await T('pay-cash').click(); await T('confirm-pay').click();
  await T('receipt-no').waitFor();
  check('a sale completes offline', true, await text('receipt-no'));
  await T('new-sale').click();
  await ctx.setOffline(false);

  // Restaurant mode: tables
  await api('PUT', `/outlets/${outlet.id}/table-mode`, { mode: 'map' }, mgr);
  for (const c of ['T2', 'T3']) await api('POST', `/outlets/${outlet.id}/tables`, { code: c }, mgr);
  await T('sync-now').click();
  await T('table-strip').waitFor({ timeout: 10000 });
  check('map mode shows the table strip', true);
  check('no table chosen: items are refused with a message', await (async () => { await firstItem().click(); return /table/i.test(await text('sell-message')); })());
  await T('table-T2').click();
  await firstItem().click();
  check('first item on a table opens its order', (await lineCount()) === 1);
  check('table shows busy', (await T('table-T2').getAttribute('class')).includes('busy'));
  await T('table-T3').click();
  check('another table starts empty', (await lineCount()) === 0);
  await T('all-tables').click();
  await shot('5-table-map');
  await T('map-T2').click();
  check('map opens the busy table with its lines', (await lineCount()) === 1);
  await shot('6-restaurant-1024x768');

  // Portrait tablet
  await page.setViewportSize({ width: 768, height: 1024 });
  await shot('7-portrait-768x1024');
  check('no sideways scroll at 768x1024', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('Pay buttons reachable at 768x1024', await T('pay-cash').isVisible());
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
  await shot('failure').catch(() => {});
} finally {
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  await api('PUT', `/outlets/${outlet.id}/table-mode`, { mode: 'default' }, mgr);
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-sell.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
