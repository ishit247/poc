// Real-browser run of the cashier's Refund (docs/refunds-plan.md step 3) against the Docker stack on :8080, with installed
// Edge, at 1024x768 and 820x1180. Usage: node scripts/browser-refund.mjs   (stack up on a `fresh` seed, counter image rebuilt).
// Writes .validation/browser-refund.log and screenshots. Dev data only: seeded tenant A, manager a1@example.test, staff PIN from scripts/seed.ts.
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

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

/** One tablet at one size: two sales, refund one (cash or UPI), close the drawer, and check the server agrees. */
async function run({ width, height, method }) {
  const tag = `${width}x${height}`;
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  const T = (id) => page.getByTestId(id);
  const text = async (id) => (await T(id).innerText()).trim();
  const shot = (n) => page.screenshot({ path: `${out}/screens/refund-${tag}-${n}.png` });
  const pending = async () => Number((await text('pending')).match(/^(\d+)/)?.[1] ?? NaN);
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const sale = async (pay) => {
    await T('item-Tea').click(); await T(`pay-${pay}`).click(); await T('confirm-pay').click(); await T('receipt-no').waitFor();
    const no = await text('receipt-no'); await T('new-sale').click(); return no;
  };
  const row = (no) => T('recent-receipt').filter({ hasText: no });

  const code = (await api('POST', '/enrolment-codes', { outletId, counterId }, mgr)).json.code;
  await page.goto(BASE);
  await T('enrol-code').fill(code); await T('enrol-go').click();
  await page.locator('[data-testid^="staff-"]').filter({ hasText: /School 1 Canteen cashier(?! 2)/i }).first().click();
  for (const d of PIN) await T(`key-${d}`).click();
  await T('pin-go').click();
  await T('opening-cash').fill('500'); await T('open-shift').click();
  await T('tab-sell').click();
  const deviceId = sql(`id) FROM device WHERE counter_id='${counterId}' ORDER BY enrolled_at DESC LIMIT 1`)[0][0];

  // Offline: the bill is taken but has not reached the server, so Refund is there but disabled, and says why.
  await ctx.setOffline(true);
  const target = await sale(method);
  await T('tab-orders').click();
  const btn = row(target).getByTestId('refund');
  check(`${tag}: Refund is offered but disabled before the bill syncs`, await until(() => btn.isDisabled(), 3000));
  check(`${tag}: the disabled Refund says why`, /not reached the server/.test((await btn.getAttribute('title')) ?? ''), await btn.getAttribute('title'));
  await ctx.setOffline(false);
  await T('tab-sell').click();
  const kept = await sale(method === 'cash' ? 'upi' : 'cash');
  await T('sync-now').click();
  check(`${tag}: both bills sent`, await until(async () => (await pending()) === 0, 15000));
  await T('tab-orders').click();
  check(`${tag}: Refund enabled once sent`, await until(() => row(target).getByTestId('refund').isEnabled(), 5000));
  check(`${tag}: no sideways scroll on Orders`, await noSideScroll());

  // The dialog names the payout by method; a wrong PIN refunds nothing.
  await row(target).getByTestId('refund').click();
  const payout = await text('refund-payout');
  check(`${tag}: dialog names the payout`, method === 'cash' ? /₹10\.50 cash from this drawer/.test(payout) : /₹10\.50 UPI to pay back/.test(payout), payout);
  check(`${tag}: Refund needs a reason and the PIN`, await T('refund-go').isDisabled());
  const box = await page.locator('.dialog[aria-label="Refund this bill"]').boundingBox();
  check(`${tag}: dialog fits the screen`, box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, JSON.stringify(box));
  await shot('1-dialog');
  check(`${tag}: Reason starts empty (no browser autofill)`, (await T('refund-reason').inputValue()) === '', await T('refund-reason').inputValue());
  check(`${tag}: no password-type field in the dialog`, (await page.locator('.dialog input[type="password"]').count()) === 0);
  check(`${tag}: the manager's reasons are offered`, (await T('refund-reason-options').locator('option').count()) === 5 && (await T('refund-reason-pick').count()) === 5);
  await T('refund-reason-pick').filter({ hasText: 'Wrong item served' }).click();
  check(`${tag}: tapping a reason fills the field`, (await T('refund-reason').inputValue()) === 'Wrong item served');
  await T('refund-pin').fill('000000'); await T('refund-go').click();
  check(`${tag}: a wrong PIN says so and refunds nothing`, await until(async () => /Wrong PIN/.test(await text('refund-error')), 8000), await text('refund-error').catch(() => ''));
  check(`${tag}: still paid on the server after the wrong PIN`, sql(`status) FROM sale WHERE receipt_no='${target}' AND device_id='${deviceId}'`)[0][0] === 'paid');

  await T('refund-pin').fill(PIN); await T('refund-go').click();
  await T('refund-slip-text').waitFor({ timeout: 10000 });
  const slip = await text('refund-slip-text');
  check(`${tag}: refund slip names the bill, the amount and the reason`, slip.includes('REFUND') && slip.includes(target) && /10\.50/.test(slip) && slip.includes('Wrong item served'));
  await T('print').click();
  check(`${tag}: Print calls print`, await until(() => page.evaluate(() => window.__prints === 1), 3000));
  await shot('2-slip');
  await T('refund-slip-done').click();

  check(`${tag}: the bill is marked Refunded`, await until(() => row(target).getByTestId('refunded-tag').isVisible(), 3000));
  check(`${tag}: no second refund, no reprint`, await row(target).getByTestId('refund').isDisabled() && await row(target).getByTestId('reprint').isDisabled());
  check(`${tag}: the other bill can still be refunded`, await row(kept).getByTestId('refund').isEnabled());
  await shot('3-orders');
  check(`${tag}: server has the refund, audited`, sql(`s.status, (SELECT count(*) FROM audit a WHERE a.action='sale.refund' AND a.entity_id=s.id)) FROM sale s WHERE s.receipt_no='${target}' AND s.device_id='${deviceId}'`)[0].join() === 'refunded,1');

  // Close the drawer: 500.00 float + 10.50 cash taken; a cash refund took 10.50 back out.
  const expected = method === 'cash' ? 500 : 510.5;
  await T('more-menu').click(); await T('tab-shift').click();
  await T('counted-cash').fill(String(expected)); await T('close-shift').click();
  await T('shift-slip-text').waitFor({ timeout: 15000 });
  const shiftSlip = await text('shift-slip-text');
  check(`${tag}: shift slip lists the refund and the cash matches`, /Refunded \(1\)/.test(shiftSlip) && /Cash matches/.test(shiftSlip), shiftSlip.split('\n').filter((l) => /Refund|Cash|UPI|SHORT|OVER/.test(l)).join(' / '));
  await shot('4-shift-slip');
  await T('slip-done').click();
  check(`${tag}: the server agrees with the slip`, await until(() => sql(`expected_cash_paise, variance_paise) FROM shift WHERE device_id='${deviceId}'`)[0]?.join() === `${Math.round(expected * 100)},0`, 15000));

  // Day close's Shifts table explains the expected figure with the cash refunded from that drawer.
  const today = sql(`(now() AT TIME ZONE timezone)::date::text) FROM outlet WHERE id='${outletId}'`)[0][0];
  const day = (await api('GET', `/outlets/${outletId}/day-close?date=${today}`, undefined, mgr)).json;
  const shiftId = sql(`id) FROM shift WHERE device_id='${deviceId}'`)[0][0];
  const dayRow = day?.totals?.shifts?.find((s) => s.id === shiftId);
  check(`${tag}: day close shows the cash refunded from this drawer`, dayRow?.refundedCash === (method === 'cash' ? 1050 : 0), JSON.stringify(dayRow));
  await ctx.close();
}

try {
  await run({ width: 1024, height: 768, method: 'cash' });
  await run({ width: 820, height: 1180, method: 'upi' });
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
} finally {
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-refund.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
