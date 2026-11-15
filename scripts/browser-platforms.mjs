// Phase 9 UI: the counter flags platform lines that match no item, and the manager Platforms tab maps them.
// Installed Edge against the Docker stack on :8080. Usage: node scripts/validate.mjs fresh --yes   then
// node scripts/browser-platforms.mjs. Writes .validation/browser-platforms.log and screenshots in .validation/screens/.
// Dev data only: seeded tenant A. Each run sends one signed webhook order per viewport (they expire on their own)
// and removes the mappings it adds.
import http from 'node:http';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
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

function api(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: 'localhost', port: 8080, path: '/api' + path, method,
      headers: { host: 'tenant-a.localhost', 'content-type': 'application/json', ...headers } },
    (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// The placeholder contract (docs/build-notes.md, phase 9): hex HMAC-SHA256 of "<unix seconds>.<raw body>".
async function platformOrder(ext, orderId) {
  const raw = JSON.stringify({ store_id: 'dev-store-a1', order_id: orderId, customer_label: 'Browser check', lines: [
    { item_id: 'ZS-a-samosa', name: 'Samosa', qty: 1, unit_price_paise: 2500 },
    { item_id: ext, name: 'Paneer Roll', qty: 2, unit_price_paise: 6000 },
  ] });
  const t = String(Math.floor(Date.now() / 1000));
  return api('POST', '/webhooks/zomato', raw, { 'x-timestamp': t, 'x-signature': createHmac('sha256', 'dev-webhook-secret-a1').update(`${t}.${raw}`).digest('hex') });
}

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const auth = { authorization: `Bearer ${mgr}` };
const outlet = (await api('GET', '/me', null, auth)).json.outlets.find((o) => o.name === 'School 1 Canteen');
const outletId = outlet.id, counterId = outlet.counters[0].id;
const openShifts = async () => (await api('GET', `/outlets/${outletId}/day-close?date=${outlet.today}`, null, auth)).json?.blockers?.openShifts ?? [];
const shiftsBefore = new Set((await openShifts()).map((s) => s.id));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

try {
  for (const [w, h] of [[1024, 768], [820, 1180]]) {
    const tag = `@${w}`;
    const ext = `ZX-${randomUUID().slice(0, 8)}`;
    const orderId = `BP-${randomUUID().slice(0, 8)}`;
    const hook = await platformOrder(ext, orderId);
    check(`webhook order with an unmapped line is taken ${tag}`, hook.status === 201, `status ${hook.status}`);

    const ctxs = [];
    // Its own browser context each: a tablet's enrolment lives in the context's storage.
    const enrol = async (label) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      ctxs.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${w}: ${e}`));
      const code = (await api('POST', '/enrolment-codes', { outletId, counterId, label }, auth)).json.code;
      await page.goto(BASE);
      await page.getByTestId('enrol-code').fill(code); await page.getByTestId('enrol-go').click();
      await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
      return page;
    };

    // 1. Counter: the order card says what is not on the bill.
    const page = await enrol(`Platforms ${w}`);
    const T = (id) => page.getByTestId(id);
    await page.locator('[data-testid^="staff-"]').filter({ hasText: /School 1 Canteen cashier(?! 2)/i }).first().click();
    for (const d of PIN) await T(`key-${d}`).click();
    await T('pin-go').click();
    // Online orders are for a cashier with an open drawer; this run's shifts are force-closed at the end.
    await T('opening-cash').fill('500'); await T('open-shift').click();
    await T('tab-orders').click(); await T('tab-online').click();
    if (await until(() => T('online-pin').isVisible().then((v) => v || T('online-add').isVisible()), 8000) && (await T('online-pin').isVisible())) {
      await T('online-pin').fill(PIN); await T('online-connect-go').click();
    }
    const card = page.locator('[data-testid="online-order"]').filter({ hasText: orderId });
    const shown = await until(() => card.getByTestId('online-unmapped').isVisible(), 10000);
    const note = shown ? await card.getByTestId('online-unmapped').innerText() : '';
    check(`counter card names the unmapped line ${tag}`, /2 × Paneer Roll/.test(note), note);
    check(`a card without unmapped lines shows no note ${tag}`,
      (await page.locator('[data-testid="online-order"]').filter({ hasNotText: 'Paneer Roll' }).getByTestId('online-unmapped').count()) === 0);
    check(`counter has no sideways scroll ${tag}`, await noSideScroll(page));
    await page.screenshot({ path: `${out}/screens/platforms-counter-${w}.png` });

    // 2. Manager: Platforms tab lists it, maps it, removes the mapping.
    const m = await enrol(`Platforms mgr ${w}`);
    const M = (id) => m.getByTestId(id);
    await M('more-menu').click(); await M('mgr-open').click();
    await M('mgr-email').fill('a1@example.test'); await M('mgr-password').fill('dev-password-123'); await M('mgr-login').click();
    await M('mgr-tab-platforms').click();
    const row = m.locator('[data-testid="plat-unmapped-row"]').filter({ hasText: ext });
    check(`unmapped item is listed ${tag}`, await until(() => row.isVisible(), 8000));
    check(`connection shows it is on ${tag}`, /^On/.test(await M('plat-status').innerText()));
    check(`seeded Samosa mapping is listed ${tag}`, (await m.locator('[data-testid="plat-map"]').filter({ hasText: 'ZS-a-samosa' }).count()) === 1);
    const teaOff = await row.getByTestId('plat-unmapped-item').locator('option', { hasText: 'Tea' }).first().isDisabled();
    check(`an item with no Zomato price cannot be picked ${tag}`, teaOff);
    check(`Map is disabled until an item is chosen ${tag}`, await row.getByTestId('plat-unmapped-save').isDisabled());
    check(`manager screen has no sideways scroll ${tag}`, await noSideScroll(m));
    await m.screenshot({ path: `${out}/screens/platforms-manager-${w}.png`, fullPage: true });

    await row.getByTestId('plat-unmapped-item').selectOption({ label: 'Samosa' });
    await row.getByTestId('plat-unmapped-save').click();
    const mapped = m.locator('[data-testid="plat-map"]').filter({ hasText: ext });
    check(`mapping moves it to the item list ${tag}`, await until(async () => (await mapped.count()) === 1 && (await row.count()) === 0, 5000));

    await mapped.getByTestId('plat-remove').click();
    await M('plat-remove-confirm').click();
    check(`removing asks, then puts it back on the unmapped list ${tag}`, await until(async () => (await mapped.count()) === 0 && (await row.count()) === 1, 5000));

    // 3. Swiggy: the status says what the server has (the seed has none; the API tests add a turned-off one),
    // and Save says why it is off while the store id is empty.
    const sw = (await api('GET', `/outlets/${outletId}/integrations`, null, auth)).json.integrations.find((i) => i.channel === 'swiggy');
    const want = !sw ? 'Not set up' : !sw.enabled ? 'Turned off' : 'On';
    await M('plat-swiggy').click();
    check(`swiggy status matches the server ${tag}`, await until(async () => (await M('plat-status').innerText()).startsWith(want), 5000), want);
    await M('plat-store').fill('');
    check(`save is disabled with a reason ${tag}`, (await M('plat-save').isDisabled()) && /store id/i.test((await M('plat-save').getAttribute('title')) ?? ''));
    for (const c of ctxs) await c.close();
  }
} finally {
  await browser.close();
  // Leave no drawer open: an open shift would block the next day-close check.
  await until(async () => (await openShifts()).some((s) => !shiftsBefore.has(s.id)), 10000);
  for (const s of (await openShifts()).filter((x) => !shiftsBefore.has(x.id))) {
    await api('POST', `/outlets/${outletId}/shifts/${s.id}/force-close`, { countedCashPaise: 50000 }, auth);
  }
}
check('no page errors', errors.length === 0, errors.join(' | '));
const passed = results.filter((r) => r.ok).length;
log.push(`${passed}/${results.length} passed`);
console.log(`${passed}/${results.length} passed`);
fs.writeFileSync(`${out}/browser-platforms.log`, log.join('\n') + '\n');
process.exitCode = passed === results.length ? 0 : 1;
