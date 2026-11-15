// Real-browser run of bill discounts (docs/discounts-plan.md step 2) against the Docker stack on :8080, with installed
// Edge, at 1024x768 and 820x1180: the manager sets the cap and a reason in Settings → Selling rules, then a cashier gives
// a percentage discount on a counter sale and a flat one on a running order, syncs, and closes the drawer.
// Usage: node scripts/browser-discount.mjs   (stack up on a `fresh` seed, counter image rebuilt).
// Writes .validation/browser-discount.log and screenshots. Dev data only: tenant A (half-up GST, no round-off), staff PIN from scripts/seed.ts.
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/counter/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8080';
const PIN = '482913';
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const out = '.validation';
fs.mkdirSync(`${out}/screens`, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: 'localhost', port: 8080, path: '/api' + path, method, headers: { host: 'tenant-a.localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
function sql(q) {
  const s = `BEGIN; SELECT set_config('app.tenant_id','${TENANT_A}',true); SELECT 'R|'||concat_ws('|', ${q}; COMMIT;`;
  return execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', s]).toString()
    .split('\n').filter((l) => l.startsWith('R|')).map((l) => l.slice(2).split('|'));
}
async function until(f, ms = 10000, every = 150) {
  const end = Date.now() + ms; let v;
  for (;;) { try { v = await f(); } catch { v = undefined; } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, every)); }
}

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const [[outletId, counterId]] = sql("o.id, c.id) FROM outlet o JOIN counter c ON c.outlet_id=o.id WHERE o.name='School 1 Canteen' AND c.code='C1'");
await api('PUT', `/outlets/${outletId}/table-mode`, { mode: 'default' }, mgr);
const before = (await api('GET', '/settings', null, mgr)).json;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

async function tablet(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${width}: ${e}`));
  const code = (await api('POST', '/enrolment-codes', { outletId, counterId }, mgr)).json.code;
  await page.goto(BASE);
  await page.getByTestId('enrol-code').fill(code); await page.getByTestId('enrol-go').click();
  await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
  return { ctx, page, T: (id) => page.getByTestId(id) };
}

/** The manager sets the largest discount and adds a reason, from the tablet's manager tools. */
async function settings({ width, height }) {
  const tag = `${width}x${height}`;
  await api('PUT', '/settings', { ...before, discountMaxBp: 0 }, mgr);
  const { ctx, page, T } = await tablet(width, height);
  await T('more-menu').click(); await T('mgr-open').click();
  await T('mgr-email').fill('a1@example.test'); await T('mgr-password').fill('dev-password-123'); await T('mgr-login').click();
  await T('mgr-tab-settings').click();
  await T('set-discount-cap').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="set-qty"]')?.value !== '', null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: the cap loads as 0 (discounts off)`, await until(async () => (await T('set-discount-cap').inputValue()) === '0', 5000), await T('set-discount-cap').inputValue());
  check(`${tag}: the default discount reasons load`, (await T('set-discount-reasons').inputValue()).includes('Staff meal'));
  await T('set-discount-cap').fill('150');
  check(`${tag}: a cap over 100% cannot be saved, and says why`, (await T('set-save').isDisabled()) && /Largest discount/.test((await T('set-save').getAttribute('title')) ?? ''));
  await T('set-discount-cap').fill('15');
  await T('set-discount-reasons').fill(`${await T('set-discount-reasons').inputValue()}\nBirthday`);
  await T('set-save').click();
  await page.getByText('Saved.').first().waitFor({ timeout: 5000 });
  const now = (await api('GET', '/settings', null, mgr)).json;
  check(`${tag}: cap and reasons saved on the server`, now.discountMaxBp === 1500 && now.discountReasons.at(-1) === 'Birthday', JSON.stringify([now.discountMaxBp, now.discountReasons]));
  check(`${tag}: no sideways scroll on Settings`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${out}/screens/discount-${tag}-0-settings.png`, fullPage: true });
  await ctx.close();
}

/** A cashier: 10% off a counter sale (cash), ₹2 off a running order (UPI), sync, close the drawer. */
async function cashier({ width, height }) {
  const tag = `${width}x${height}`;
  const { ctx, page, T } = await tablet(width, height);
  await ctx.addInitScript(() => { window.print = () => {}; });
  const text = async (id) => (await T(id).innerText()).trim();
  const shot = (n) => page.screenshot({ path: `${out}/screens/discount-${tag}-${n}.png` });
  // The dialog is on screen AND Confirm is visible inside it (the dialog may scroll; its action row must not).
  const fits = async () => {
    const box = await page.locator('.dialog.pay').boundingBox();
    const ok = await T('confirm-pay').boundingBox();
    return !!box && !!ok && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height
      && ok.y >= box.y && ok.y + ok.height <= box.y + box.height;
  };
  await page.locator('[data-testid^="staff-"]').filter({ hasText: /School 1 Canteen cashier(?! 2)/i }).first().click();
  for (const d of PIN) await T(`key-${d}`).click();
  await T('pin-go').click();
  await T('opening-cash').fill('500'); await T('open-shift').click();
  await T('tab-sell').click();
  const deviceId = sql(`id) FROM device WHERE counter_id='${counterId}' ORDER BY enrolled_at DESC LIMIT 1`)[0][0];

  // Counter sale: 3 Tea = 30.00 + 5% GST. 10% off before GST: 3.00 off, GST 1.35 on 27.00, due 28.35.
  for (let i = 0; i < 3; i++) await T('item-Tea').click();
  await T('pay-cash').click();
  check(`${tag}: the dialog opens at the full total`, (await text('pay-due')) === '31.50', await text('pay-due'));
  const plain = await until(() => T('discount-open').isEnabled(), 3000);
  check(`${tag}: Discount is a plain button, offered`, plain && !((await T('discount-open').getAttribute('class')) ?? '').includes('primary'),
    `enabled=${plain} title=${await T('discount-open').getAttribute('title')}`);
  await T('discount-open').click();
  check(`${tag}: an empty discount cannot be confirmed, and says why`, (await T('confirm-pay').isDisabled()) && /Type the discount/.test((await T('confirm-pay').getAttribute('title')) ?? ''));
  await T('discount-value').fill('20');
  check(`${tag}: over the cap is refused, and says the cap`, await until(async () => /At most 15%/.test(await text('discount-why')), 2000), await text('discount-why').catch(() => ''));
  await T('discount-value').fill('10');
  check(`${tag}: a reason is required`, (await T('confirm-pay').isDisabled()) && /reason/.test((await T('confirm-pay').getAttribute('title')) ?? ''));
  check(`${tag}: the manager's new reason is offered`, (await T('discount-reason-pick').filter({ hasText: 'Birthday' }).count()) === 1);
  await T('discount-reason-pick').filter({ hasText: 'Staff meal' }).click();
  check(`${tag}: the due follows the discount (before GST)`, (await text('pay-due')) === '28.35', await text('pay-due'));
  check(`${tag}: the summary shows the discount and the GST on the rest`, /−₹3\.00 before GST, GST ₹1\.35/.test(await text('discount-summary')), await text('discount-summary'));
  check(`${tag}: quick cash follows the due`, (await T('cash-in').getAttribute('placeholder')) === '28.35');
  check(`${tag}: the pay dialog fits the screen with the discount open`, await fits());
  await shot('1-pay-percent');
  await T('mode-split').click();
  check(`${tag}: Split, the tallest layout, keeps Confirm in view`, await fits());
  await shot('1b-pay-split');
  await T('mode-cash').click();
  // No discount clears in one tap, and the total goes back.
  await T('discount-clear').click();
  check(`${tag}: No discount restores the total`, (await text('pay-due')) === '31.50' && (await T('discount-panel').count()) === 0);
  await T('discount-open').click();
  check(`${tag}: reopening starts empty`, (await T('discount-value').inputValue()) === '' && (await T('discount-reason').inputValue()) === '');
  await T('discount-value').fill('10'); await T('discount-reason-pick').filter({ hasText: 'Staff meal' }).click();
  await T('cash-in').fill('50');
  check(`${tag}: change is from the discounted total`, /21\.65/.test(await text('change')), await text('change'));
  await T('confirm-pay').click(); await T('receipt-no').waitFor();
  const r1 = await text('receipt-no');
  const receipt1 = await text('receipt-text');
  check(`${tag}: the receipt shows the discount between Sub Total and GST`, /Sub Total\s+30\.00\nDiscount 10% \(Staff meal\)\s+-3\.00\nCGST/.test(receipt1), receipt1.split('\n').filter((l) => /Sub|Disc|GST|TOTAL/.test(l)).join(' / '));
  check(`${tag}: the receipt total is the discounted one`, /TOTAL\s+28\.35/.test(receipt1));
  await shot('2-receipt');
  await T('new-sale').click();

  // Running order: 2 Tea held (an order on the default table), resumed, paid by UPI with ₹2.00 off and a typed reason.
  // 20.00 - 2.00 = 18.00, GST 0.90, due 18.90.
  for (let i = 0; i < 2; i++) await T('item-Tea').click();
  await T('held-btn').click(); await T('hold').click();
  await T('held-btn').click();
  await T('held-order').last().click();
  await until(async () => (await T('pay-upi').innerText()).includes('21.00'), 5000);
  await T('pay-upi').click();
  await T('discount-open').click();
  await T('discount-amount').click();
  await T('discount-value').fill('2');
  await T('discount-reason').fill('Waited long');
  check(`${tag}: a flat discount on the order`, (await text('pay-due')) === '18.90', await text('pay-due'));
  check(`${tag}: the UPI dialog fits the screen`, await fits());
  await shot('3-pay-order-amount');
  await T('confirm-pay').click(); await T('receipt-no').waitFor();
  const r2 = await text('receipt-no');
  const receipt2 = await text('receipt-text');
  check(`${tag}: order receipt shows the flat discount`, /Discount \(Waited long\)\s+-2\.00/.test(receipt2) && /TOTAL\s+18\.90/.test(receipt2), receipt2.split('\n').filter((l) => /Disc|TOTAL/.test(l)).join(' / '));
  await T('new-sale').click();

  // The server accepted both, unflagged, with the discount as given.
  await T('sync-now').click();
  const row = (no) => sql(`s.discount_paise, coalesce(s.discount_bp::text,'-'), s.discount_reason, s.total_paise, array_length(s.flags,1) IS NULL, (SELECT sum(l.discount_paise) FROM sale_line l WHERE l.sale_id=s.id)) FROM sale s WHERE s.receipt_no='${no}' AND COALESCE(s.paid_device_id, s.device_id)='${deviceId}'`)[0]?.join('|');
  check(`${tag}: server has the counter sale's discount`, await until(() => row(r1) === '300|1000|Staff meal|2835|t|300', 15000), row(r1));
  check(`${tag}: server has the order's discount`, await until(() => row(r2) === '200|-|Waited long|1890|t|200', 15000), row(r2));

  // Close the drawer: 500.00 float + 28.35 cash. The slip counts both discounts.
  await T('more-menu').click(); await T('tab-shift').click();
  await T('counted-cash').fill('528.35'); await T('close-shift').click();
  await T('shift-slip-text').waitFor({ timeout: 15000 });
  const slip = await text('shift-slip-text');
  check(`${tag}: shift slip lists the discounts, and the cash matches`, /Discounts \(2\)\s+5\.00/.test(slip) && /Cash matches/.test(slip), slip.split('\n').filter((l) => /Disc|Cash|UPI|SHORT|OVER/.test(l)).join(' / '));
  await shot('4-shift-slip');
  await T('slip-done').click();
  check(`${tag}: the server agrees with the slip`, await until(() => sql(`expected_cash_paise, variance_paise) FROM shift WHERE device_id='${deviceId}'`)[0]?.join('|') === '52835|0', 15000));
  await ctx.close();
}

/** Discounts off: the button is there (no layout shift) but disabled, and says why. */
async function off({ width, height }) {
  const tag = `${width}x${height}`;
  await api('PUT', '/settings', { ...before, discountMaxBp: 0 }, mgr);
  const { ctx, page, T } = await tablet(width, height);
  await page.locator('[data-testid^="staff-"]').filter({ hasText: /School 1 Canteen cashier(?! 2)/i }).first().click();
  for (const d of PIN) await T(`key-${d}`).click();
  await T('pin-go').click();
  await T('opening-cash').fill('0'); await T('open-shift').click();
  await T('tab-sell').click();
  await T('item-Tea').click(); await T('pay-cash').click();
  const why = await until(async () => /Discounts are off/.test((await T('discount-open').getAttribute('title')) ?? ''), 3000);
  check(`${tag}: discounts off: Discount disabled, and says why`, why && await T('discount-open').isDisabled(), await T('discount-open').getAttribute('title'));
  await T('confirm-pay').click(); await T('receipt-no').waitFor(); await T('new-sale').click();
  await T('more-menu').click(); await T('tab-shift').click();
  await T('counted-cash').fill('10.50'); await T('close-shift').click();
  await T('shift-slip-text').waitFor({ timeout: 15000 });
  check(`${tag}: no Discounts line when none was given`, !/Discounts/.test(await T('shift-slip-text').innerText()));
  await T('slip-done').click();
  await ctx.close();
}

try {
  for (const size of [{ width: 1024, height: 768 }, { width: 820, height: 1180 }]) {
    await settings(size);
    await cashier(size);
    await off(size);
  }
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
} finally {
  await api('PUT', '/settings', before, mgr);
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-discount.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
