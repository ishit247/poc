// Real-browser run of the saved discount (docs/discounts-plan.md step 5) against the Docker stack on :8080, with installed
// Edge, at 1024x768 and 820x1180: a cashier puts a discount on the draft cart from the Sell screen's Discount icon, prints
// the bill, opens Pay (prefilled), saves the order (held list shows the discounted total), resumes it, removes and re-sets
// the discount on the open order, pays it; a discount that stops fitting is shown as not applied; a waiter sees Discount
// disabled with the reason. Usage: node scripts/browser-discount-saved.mjs   (stack up on a `fresh` seed, counter image rebuilt).
// Writes .validation/browser-discount-saved.log and screenshots. Dev data only: tenant A, staff PIN from scripts/seed.ts.
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
await api('PUT', '/settings', { ...before, discountMaxBp: 1500 }, mgr);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

/** A tablet: enrolled, signed in as `role` (cashier or waiter), on the Sell screen. */
async function tablet(role, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { window.print = () => {}; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${width}: ${e}`));
  const code = (await api('POST', '/enrolment-codes', { outletId, counterId }, mgr)).json.code;
  await page.goto(BASE);
  await page.getByTestId('enrol-code').fill(code); await page.getByTestId('enrol-go').click();
  const who = page.locator('[data-testid^="staff-"]').filter({ hasText: new RegExp(`School 1 Canteen ${role}(?! 2)`, 'i') }).first();
  await who.waitFor({ timeout: 10000 }).catch(async () => { throw new Error(`no ${role} on the sign-in screen: ${(await page.locator('[data-testid^="staff-"]').allInnerTexts()).join(', ')} (${page.url()})`); });
  await who.click();
  for (const d of PIN) await page.getByTestId(`key-${d}`).click();
  await page.getByTestId('pin-go').click();
  const opening = page.getByTestId('opening-cash');
  await Promise.race([opening.waitFor({ timeout: 5000 }).catch(() => {}), page.getByTestId('tab-sell').waitFor({ timeout: 5000 }).catch(() => {})]);
  if (await opening.isVisible().catch(() => false)) { await opening.fill('500'); await page.getByTestId('open-shift').click(); }
  await page.getByTestId('tab-sell').click();
  return { ctx, page, T: (id) => page.getByTestId(id) };
}

async function cashier(width, height) {
  const tag = `${width}x${height}`;
  const { ctx, page, T } = await tablet('cashier', width, height);
  const text = async (id) => (await T(id).innerText()).trim();
  const shot = (n) => page.screenshot({ path: `${out}/screens/discount-saved-${tag}-${n}.png` });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await T('item-Tea').waitFor({ timeout: 15000 });

  // The action row: plain text buttons, then three icon buttons, all in one row, all 44px or taller.
  for (let i = 0; i < 3; i++) await T('item-Tea').click();
  const ids = ['clear', 'save-order', 'discount-btn', 'print-bill'];
  const boxes = await Promise.all(ids.map((id) => T(id).boundingBox()));
  check(`${tag}: Clear, Save, Discount and Print sit in one row`, boxes.every((b) => b && Math.abs(b.y + b.height / 2 - (boxes[0].y + boxes[0].height / 2)) < 4), JSON.stringify(boxes.map((b) => b && Math.round(b.y))));
  check(`${tag}: the icon buttons are 44px or taller and have a name`, (await Promise.all(['save-order', 'discount-btn', 'print-bill'].map(async (id) =>
    // CSS px: the app's S/M/L zoom (default 0.9) scales what is drawn, as it does for every other control
    parseFloat(await T(id).evaluate((el) => getComputedStyle(el).minHeight)) >= 44 && !!(await T(id).getAttribute('aria-label')) && !!(await T(id).getAttribute('title'))))).every(Boolean),
    JSON.stringify(await Promise.all(['save-order', 'discount-btn', 'print-bill'].map(async (id) => { const b = await T(id).boundingBox(); return [Math.round(b.width), Math.round(b.height), await T(id).getAttribute('title')]; }))));
  check(`${tag}: the cart panel does not scroll sideways`, await noSideScroll());

  // Draft discount: 3 Tea = 30.00 + 5% GST; 10% off before GST: 3.00 off, GST 1.35, due 28.35.
  await T('discount-btn').click();
  check(`${tag}: Remove discount is there but disabled before one is set`, await T('discount-remove').isDisabled());
  check(`${tag}: Apply is disabled until the discount is complete, and says why`, (await T('discount-apply').isDisabled()) && /Type the discount/.test((await T('discount-apply').getAttribute('title')) ?? ''));
  await T('discount-value').fill('20');
  check(`${tag}: over the cap is refused with the cap`, await until(async () => /At most 15%/.test(await text('discount-why')), 2000));
  await T('discount-value').fill('10');
  await T('discount-reason-pick').filter({ hasText: 'Staff meal' }).click();
  check(`${tag}: the dialog shows the discount, the GST and the total`, /−₹3\.00 before GST, GST ₹1\.35, total ₹28\.35/.test(await text('discount-summary')), await text('discount-summary'));
  await shot('1-dialog');
  await T('discount-apply').click();
  await T('discount-label').waitFor();
  check(`${tag}: the cart shows Discount (reason) and the discounted total`, (await text('discount-label')) === 'Discount (Staff meal)' && (await text('discount-amount')) === '−₹3.00' && (await text('total')) === '₹28.35',
    `${await text('discount-label')} ${await text('discount-amount')} ${await text('total')}`);
  check(`${tag}: the Pay buttons follow the discounted total`, /28\.35/.test(await text('pay-cash')) && /28\.35/.test(await text('pay-upi')));
  check(`${tag}: the Discount icon shows it is on`, ((await T('discount-btn').getAttribute('class')) ?? '').includes('active'));
  await shot('2-cart');

  // Print bill carries it.
  await T('print-bill').click();
  await T('draft-bill-text').waitFor();
  const draft = await until(async () => { const t = await text('draft-bill-text'); return t.includes('Discount') ? t : ''; }, 4000);
  check(`${tag}: the draft bill shows the discount and the total`, /Sub Total\s+30\.00\nDiscount 10% \(Staff meal\)\s+-3\.00/.test(draft ?? '') && /TOTAL\s+28\.35/.test(draft ?? ''), (draft ?? '').split('\n').filter((l) => /Sub|Disc|GST|TOTAL/.test(l)).join(' / '));
  await T('draft-close').click();

  // Pay opens with it filled in; cancelling leaves the cart's discount alone.
  await T('pay-cash').click();
  await until(async () => (await text('pay-due')) === '28.35', 3000);
  check(`${tag}: Pay opens with the saved discount filled in`, (await text('pay-due')) === '28.35' && (await T('discount-value').inputValue()) === '10' && (await T('discount-reason').inputValue()) === 'Staff meal',
    `${await text('pay-due')} ${await T('discount-value').inputValue()} ${await T('discount-reason').inputValue()}`);
  await shot('3-pay-prefilled');
  await page.locator('.dialog.pay').getByRole('button', { name: 'Cancel' }).click();
  check(`${tag}: cancelling Pay keeps the discount`, (await text('total')) === '₹28.35');

  // Save the order: the draft clears, the held list shows the discounted total, resuming brings the discount back.
  await T('save-order').click();
  await until(async () => (await T('cart-lines').locator('li .name').count()) === 0, 4000);
  check(`${tag}: Save order clears the draft and its discount`, (await T('discount-label').count()) === 0 && (await text('total')) === '₹0.00', await text('total'));
  await T('held-btn').click();
  const mine = T('held-order').filter({ hasText: '3 × Tea · ₹28.35' }).first(); // earlier runs may have left held orders
  const held = await until(async () => (await mine.count()) === 1, 6000);
  check(`${tag}: the held order shows the discounted total`, !!held, (await T('held-order').allInnerTexts()).join(' | '));
  await shot('4-held');
  await mine.click();
  await T('discount-label').waitFor({ timeout: 6000 });
  check(`${tag}: resuming brings the discount back on the order`, (await text('total')) === '₹28.35' && (await text('discount-label')) === 'Discount (Staff meal)');
  check(`${tag}: Save order is disabled on a saved order, and says why`, (await T('save-order').isDisabled()) && /already saved/.test((await T('save-order').getAttribute('title')) ?? ''));

  const ys = await Promise.all(['void-order', 'clear', 'save-order', 'discount-btn', 'print-bill'].map(async (id) => { const b = await T(id).boundingBox(); return Math.round(b.y + b.height / 2); }));
  check(`${tag}: on an open order, Clear, Void and the three icons still share one row`, ys.every((y) => Math.abs(y - ys[0]) <= 2), ys.join(','));

  // Remove it, set it again as a flat amount on the open order.
  await T('discount-btn').click();
  check(`${tag}: the order's dialog opens with the saved discount`, (await T('discount-value').inputValue()) === '10');
  await T('discount-remove').click();
  await until(async () => (await T('discount-label').count()) === 0, 4000);
  check(`${tag}: Remove discount puts the total back`, (await text('total')) === '₹31.50', await text('total'));
  await T('discount-btn').click();
  await page.getByRole('button', { name: '₹ off' }).click();
  await T('discount-value').fill('3'); await T('discount-reason-pick').filter({ hasText: 'Staff meal' }).click();
  await T('discount-apply').click();
  await T('discount-label').waitFor({ timeout: 6000 });
  check(`${tag}: a flat ₹3 on the open order lowers the total (before GST)`, (await text('total')) === '₹28.35' && (await text('discount-amount')) === '−₹3.00', `${await text('total')} ${await text('discount-amount')}`);

  // Pay it: Pay opens with the ₹ discount, the receipt shows it.
  await T('pay-cash').click();
  await until(async () => (await text('pay-due')) === '28.35', 3000); // the settings load from IndexedDB a moment after the dialog opens
  check(`${tag}: Pay opens with the order's discount`, (await text('pay-due')) === '28.35' && (await T('discount-value').inputValue()) === '3.00', `${await text('pay-due')} ${await T('discount-value').inputValue()}`);
  await T('confirm-pay').click(); await T('receipt-no').waitFor();
  const receipt = (await until(async () => { const t = await text('receipt-text'); return /TOTAL/.test(t) ? t : ''; }, 4000)) ?? ''; // the text is filled in a moment after the number shows
  check(`${tag}: the receipt shows the discount and the discounted total`, /Discount \(Staff meal\)\s+-3\.00/.test(receipt) && /TOTAL\s+28\.35/.test(receipt), receipt.split('\n').filter((l) => /Sub|Disc|TOTAL/.test(l)).join(' / '));
  await T('new-sale').click();

  // A discount that stops fitting is shown as not applied, with why, and the total is the plain bill.
  await T('tab-sell').click();
  for (let i = 0; i < 3; i++) await T('item-Tea').click();
  await T('discount-btn').click();
  await page.getByRole('button', { name: '₹ off' }).click();
  await T('discount-value').fill('4'); await T('discount-reason-pick').filter({ hasText: 'Staff meal' }).click();
  await T('discount-apply').click();
  await T('discount-label').waitFor();
  await page.getByLabel('less Tea').click(); await page.getByLabel('less Tea').click();
  await T('discount-not-applied').waitFor({ timeout: 4000 });
  check(`${tag}: a discount that no longer fits is shown as not applied`, /At most 15%/.test(await text('discount-not-applied')) && (await text('total')) === '₹10.50' && (await T('discount-label').count()) === 0,
    `${await text('discount-not-applied')} ${await text('total')}`);
  await shot('5-not-applied');
  await T('clear').click();
  check(`${tag}: Clear removes the draft's discount too`, (await T('discount-not-applied').count()) === 0);
  await ctx.close();
}

async function waiter(width, height) {
  const tag = `${width}x${height}`;
  const { ctx, page, T } = await tablet('waiter', width, height);
  await T('item-Tea').waitFor({ timeout: 15000 });
  await T('item-Tea').click();
  const why = (await T('discount-btn').getAttribute('title')) ?? '';
  check(`${tag}: a waiter's Discount is disabled and says why`, (await T('discount-btn').isDisabled()) && /Only a cashier/.test(why), why);
  check(`${tag}: a waiter has the Save, Print icons and no Pay`, (await T('save-order').isVisible()) && (await T('print-bill').isVisible()) && (await T('pay-cash').count()) === 0);
  await page.screenshot({ path: `${out}/screens/discount-saved-${tag}-6-waiter.png` });
  await ctx.close();
}

try {
  for (const [w, h] of [[1024, 768], [820, 1180]]) {
    await cashier(w, h);
    await waiter(w, h);
  }
} catch (e) {
  check('run completed', false, String(e).split('\n').slice(0, 10).join(' | '));
} finally {
  await api('PUT', '/settings', before, mgr);
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-discount-saved.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
