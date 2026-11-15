// Manager Settings tab: selling rules, logo, outlet receipt details and GST. Installed Edge against the Docker stack
// on :8080. Usage: node scripts/validate.mjs fresh --yes   then   node scripts/browser-settings.mjs
// Writes .validation/browser-settings.log and screenshots in .validation/screens/. Dev data only: seeded tenant A.
// It restores what it changes, so the seed is as it was afterwards (the logo is removed only if there was none).
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GSTIN = '27AAPFU0939F1ZV';
const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const before = (await api('GET', '/settings', null, mgr)).json;
const meBefore = (await api('GET', '/me', null, mgr)).json.outlets.find((o) => o.name === 'School 1 Canteen');
const hadLogo = (await fetch('http://localhost:8080/api/settings/logo', { headers: { authorization: `Bearer ${mgr}` } })).status === 200;
const outletId = meBefore.id, counterId = meBefore.counters[0].id;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  for (const [w, h] of [[1024, 768], [820, 1180]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${w}: ${e}`));
    const T = (id) => page.getByTestId(id);
    const code = (await api('POST', '/enrolment-codes', { outletId, counterId, label: `Settings ${w}` }, mgr)).json.code;
    await page.goto(BASE);
    await T('enrol-code').fill(code); await T('enrol-go').click();
    await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
    await T('more-menu').click(); await T('mgr-open').click();
    await T('mgr-email').fill('a1@example.test'); await T('mgr-password').fill('dev-password-123'); await T('mgr-login').click();
    await T('mgr-tab-settings').click();
    await T('mgr-settings').waitFor();
    const tag = `@${w}`;

    // selling rules
    await T('set-qty').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="set-qty"]')?.value === '99', null, { timeout: 5000 }).catch(() => {});
    check(`loads current rules ${tag}`, (await T('set-qty').inputValue()) === String(before.maxLineQty) && (await T('set-days').inputValue()) === String(before.offlineDays));
    check(`save is disabled until something changes ${tag}`, await T('set-save').isDisabled());
    await T('set-qty').fill('0');
    check(`quantity 0 cannot be saved, and says why ${tag}`, (await T('set-save').isDisabled()) && /Quantity limit/.test((await T('set-save').getAttribute('title')) ?? ''));
    await T('set-qty').fill('50'); await T('set-rounding').selectOption('up'); await T('set-roundoff').selectOption('50'); await T('set-days').fill('10');
    await T('set-save').click();
    await page.getByText('Saved.').first().waitFor({ timeout: 5000 });
    const now = (await api('GET', '/settings', null, mgr)).json;
    check(`rules saved on the server ${tag}`, now.maxLineQty === 50 && now.gstRounding === 'up' && now.billRoundTo === 50 && now.offlineDays === 10, JSON.stringify(now));
    check(`save disabled again after saving ${tag}`, await T('set-save').isDisabled());
    await api('PUT', '/settings', before, mgr);

    // receipt details
    const card = page.locator(`[data-testid="set-outlet"][data-outlet-id="${outletId}"]`).first();
    await card.scrollIntoViewIfNeeded();
    await card.getByTestId('set-fssai').fill('123');
    check(`short FSSAI cannot be saved ${tag}`, await card.getByTestId('set-info-save').isDisabled());
    await card.getByTestId('set-address').fill(`1 Test Road, Pune ${w}`);
    await card.getByTestId('set-fssai').fill('12345678901234');
    await card.getByTestId('set-info-save').click();
    await card.getByText('Saved.').waitFor({ timeout: 5000 });
    const me1 = (await api('GET', '/me', null, mgr)).json.outlets.find((o) => o.id === outletId);
    check(`address and FSSAI saved ${tag}`, me1.address === `1 Test Road, Pune ${w}` && me1.fssaiNo === '12345678901234');

    // GST
    await card.getByTestId('set-gst-on').check();
    await card.getByTestId('set-gstin').fill('BADGSTIN');
    check(`GST on with a bad GSTIN cannot be saved ${tag}`, await card.getByTestId('set-gst-save').isDisabled());
    await card.getByTestId('set-gstin').fill(GSTIN.toLowerCase());
    await card.getByTestId('set-gst-save').click();
    await card.getByText('Saved.').last().waitFor({ timeout: 5000 });
    const me2 = (await api('GET', '/me', null, mgr)).json.outlets.find((o) => o.id === outletId);
    check(`GST saved with the GSTIN upper-cased ${tag}`, me2.gstEnabled === true && me2.gstin === GSTIN);

    // logo
    await T('set-logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await T('set-logo-img').waitFor({ timeout: 5000 });
    check(`logo uploaded and shown ${tag}`, true);
    await T('set-logo-file').setInputFiles({ name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    check(`a GIF is refused with a message ${tag}`, await page.getByText('Use a PNG, JPEG or WebP picture.').isVisible());
    await page.screenshot({ path: `${out}/screens/settings-${w}.png`, fullPage: true });
    if (!hadLogo) { await T('set-logo-remove').click(); await page.getByText('No logo yet.').waitFor({ timeout: 5000 }); check(`logo removed ${tag}`, true); }

    // layout: nothing scrolls sideways
    check(`no horizontal scroll ${tag}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await ctx.close();

    // put the outlet back for the next size
    await api('PUT', `/outlets/${outletId}/gst`, { enabled: !!meBefore.gstEnabled, gstin: meBefore.gstin ?? null }, mgr);
    await api('PUT', `/outlets/${outletId}/receipt-info`, { address: meBefore.address ?? null, fssaiNo: meBefore.fssaiNo ?? null }, mgr);
  }
  check('no page errors', errors.length === 0, errors.join('; '));
} finally {
  await browser.close();
  fs.writeFileSync(`${out}/browser-settings.log`, log.join('\n') + '\n');
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
