// Phase 12 step 8: real-browser run of the whole counter flow, one tablet through one business day, against the
// Docker stack on :8080 with installed Edge at 1024x768. Owed since phase 4: offline sales, reconnect, a tab killed
// mid-push, receipt-gap detection, shift close, day close, reprint, the online queue, the diet/tag filter row.
// Usage: node scripts/validate.mjs fresh --yes   then   node scripts/browser-flow.mjs
// It needs a fresh seed (it closes today's business day for School 1). Writes .validation/browser-flow.log.
// Dev data only: seeded tenant A, manager a1@example.test, staff PIN from scripts/seed.ts.
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
/** One query as tenant A in the dev database; rows come back as arrays of strings. */
function sql(q) {
  const s = `BEGIN; SELECT set_config('app.tenant_id','${TENANT_A}',true); SELECT 'R|'||concat_ws('|', ${q}; COMMIT;`;
  return execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', s]).toString()
    .split('\n').filter((l) => l.startsWith('R|')).map((l) => l.slice(2).split('|'));
}
/** Poll until f() is truthy, or give up after ms. Returns the last value. */
async function until(f, ms = 10000, every = 150) {
  const end = Date.now() + ms; let v;
  for (;;) { try { v = await f(); } catch { v = undefined; } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, every)); }
}
const rupeesToPaise = (s) => Math.round(Number(String(s).replace(/[^\d.]/g, '')) * 100);

const login = await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' });
const mgr = login.json.token;
const [[outletId, counterId]] = sql("o.id, c.id) FROM outlet o JOIN counter c ON c.outlet_id=o.id WHERE o.name='School 1 Canteen' AND c.code='C1'");
await api('PUT', `/outlets/${outletId}/table-mode`, { mode: 'default' }, mgr);
const code = (await api('POST', '/enrolment-codes', { outletId, counterId }, mgr)).json.code;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
await ctx.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; }); // no print dialog in a scripted run
const errors = [];
let page;
const T = (id) => page.getByTestId(id);
const text = async (id) => (await T(id).innerText()).trim();
const shot = (n) => page.screenshot({ path: `${out}/screens/flow-${n}.png` });
const pending = async () => Number((await text('pending')).match(/^(\d+)/)?.[1] ?? NaN);
const lineCount = () => page.locator('[data-testid="cart-lines"] li .name').count();
const item = (name) => T(`item-${name}`);
async function openPage() {
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
}
async function signIn() {
  await page.locator('[data-testid^="staff-"]').filter({ hasText: /cashier/i }).first().click();
  for (const d of PIN) await T(`key-${d}`).click();
  await T('pin-go').click();
}
/** Sell one item and pay it in cash (exact), returning the receipt number. */
async function cashSale(name = 'Samosa') {
  await T('tab-sell').click();
  await item(name).click();
  await T('pay-cash').click(); await T('confirm-pay').click();
  await T('receipt-no').waitFor();
  const no = await text('receipt-no');
  await T('new-sale').click();
  return no;
}
/** Remove one sale's events from this tablet's outbox: a receipt the server will never see. Raw IndexedDB, as Dexie would. */
const loseSale = (receiptNo) => page.evaluate(async (rno) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('counter'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const sale = (await all('sales')).find((x) => x.receiptNo === rno);
  const rows = (await all('outbox')).filter((r) => r.payload.saleId === sale.id);
  await new Promise((res) => { const tx = db.transaction('outbox', 'readwrite'); for (const r of rows) tx.objectStore('outbox').delete(r.seq); tx.oncomplete = res; });
  db.close();
  return { seq: sale.receiptSeq, removed: rows.length };
}, receiptNo);

const receipts = []; // every receipt this tablet issued, in order
let lost = null;
try {
  // 1. Enrol, sign in, open the drawer
  await openPage();
  await T('enrol-code').fill(code); await T('enrol-go').click();
  await signIn();
  await T('opening-cash').fill('500'); await T('open-shift').click();
  await T('tab-sell').click();
  await T('search').waitFor();
  const [[deviceId]] = sql(`d.id) FROM device d WHERE d.counter_id='${counterId}' ORDER BY d.enrolled_at DESC LIMIT 1`);
  check('enrolled, signed in, shift open', (await text('sync-status')).includes('Online'));

  // 2. Diet and tag filter row (not exercised in step 6)
  await T('tags-toggle').click(); // the Tags section starts collapsed
  check('filter row shows this tenant\'s tags only', (await T('filter-Hot').count()) === 1 && (await T('filter-Spicy').count()) === 0);
  await T('filter-Hot').click();
  const hot = await until(async () => { const n = await page.locator('button.item:not([data-testid^="pop-"])').allInnerTexts(); return n.length ? n : null; }, 3000);
  const hotNames = (hot ?? []).map((s) => s.split('\n')[0].trim());
  check('a tag filter shows only items with that tag', hotNames.length > 0 && hotNames.every((n) => ['Samosa', 'Tea'].includes(n)), hotNames.join(', '));
  await T('filter-veg').click();
  const veg = (await page.locator('button.item:not([data-testid^="pop-"])').allInnerTexts()).map((s) => s.split('\n')[0].trim());
  check('a diet filter shows only items with that mark', veg.length > 0 && veg.every((n) => ['Samosa', 'Veg Sandwich', 'Cold Coffee'].includes(n)), veg.join(', '));
  await T('filter-veg').click();
  check('clearing the filter brings Tea back', await until(() => item('Tea').isVisible(), 3000));

  // 3. Cash by quick code, then UPI
  const samosaCode = (await item('Samosa').locator('.code').innerText()).trim();
  await T('search').fill(samosaCode); await T('add-code').click();
  check('quick code adds the item', await until(async () => (await lineCount()) === 1, 3000));
  await T('pay-cash').click(); await T('confirm-pay').click(); await T('receipt-no').waitFor();
  receipts.push(await text('receipt-no')); await T('new-sale').click();
  await item('Tea').click(); await T('pay-upi').click(); await T('confirm-pay').click(); await T('receipt-no').waitFor();
  receipts.push(await text('receipt-no')); await T('new-sale').click();
  check('cash and UPI sales issue consecutive receipts', receipts.length === 2 && receipts[0] !== receipts[1], receipts.join(', '));

  // 4. Save an order, pay it from the Open orders tab, reprint it
  await item('Samosa').click(); await item('Tea').click();
  await until(async () => (await lineCount()) === 2, 3000);
  const savedTotal = await text('total');
  await T('save-order').click();
  await T('tab-orders').click();
  check('saved order is listed under Open orders', await until(async () => (await T('order').count()) === 1, 3000));
  check('listed with its total', (await T('order').innerText()).includes(savedTotal.replace(/^.*?₹/, '')), savedTotal);
  await T('pay-order').click(); await T('confirm-pay').click(); await T('receipt-no').waitFor();
  receipts.push(await text('receipt-no')); await T('new-sale').click();
  await T('tab-orders').click();
  check('paid order leaves the list', await until(async () => (await T('no-orders').count()) === 1, 3000));
  await T('reprint').first().click();
  check('reprint shows the copy', (await page.locator('main').innerText()).includes('(reprint)'));
  await T('print').click();
  check('Print copy calls print once', await until(() => page.evaluate(() => window.__prints === 1), 3000));
  await T('new-sale').click();
  await shot('1-orders');

  // 5. Offline: two sales, a reload, offline sign-in, then reconnect
  await until(async () => (await pending()) === 0, 15000);
  await ctx.setOffline(true);
  check('header says Offline', await until(async () => (await text('sync-status')).includes('Offline'), 3000));
  receipts.push(await cashSale('Samosa'));
  receipts.push(await cashSale('Tea'));
  check('offline sales wait in the outbox', (await until(async () => (await pending()) >= 2, 3000)) === true, `${await pending()} waiting`);
  await page.reload();
  await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 10000 });
  check('app reloads with no network (service worker)', true);
  await signIn();
  await T('search').waitFor();
  check('offline PIN sign-in after reload', true);
  check('outbox survives the reload', (await pending()) >= 2, `${await pending()} waiting`);
  await shot('2-offline');
  await ctx.setOffline(false);
  const t0 = Date.now();
  const drained = await until(async () => (await pending()) === 0, 20000);
  check('outbox drains on reconnect', !!drained, `${Date.now() - t0} ms`);

  // The network drops while a sync is in flight: its last request (the open-orders pull) was already answered, and lands
  // after the `offline` event. Held on purpose (fetched, then delivered 1.5 s later) so the race happens every run.
  // Kept apart from the offline reload above: while a route is set, Chromium requests skip the service worker.
  let held = 0;
  const lastOfSync = (url) => /\/api\/sync\/orders\?/.test(String(url));
  await page.route(lastOfSync, async (route) => {
    const resp = await route.fetch();
    held++;
    await page.waitForTimeout(1500);
    await route.fulfill({ response: resp });
  });
  await T('sync-now').click();
  await until(async () => held > 0, 5000);
  await ctx.setOffline(true);
  await page.waitForTimeout(2500); // the held pull is delivered meanwhile
  await page.unroute(lastOfSync);
  check('header stays Offline after a sync that was in flight', (await text('sync-status')).includes('Offline'), await text('sync-status'));
  await ctx.setOffline(false);
  check('and says Online again on reconnect', await until(async () => (await text('sync-status')).includes('Online'), 10000));

  // 6. Tab killed mid-push: the server applies the batch, the tablet never hears back, the tab closes
  let hit = false;
  await page.route('**/api/sync/push', async (route) => { await route.fetch(); hit = true; await route.abort('failed'); });
  const killed = await cashSale('Samosa');
  receipts.push(killed);
  check('push reached the server before the tab died', await until(() => hit, 8000));
  await page.close();
  await openPage();
  await signIn();
  await T('search').waitFor();
  check('reopened tab resends and drains', !!(await until(async () => (await pending()) === 0, 20000)));
  const [[killedRows, killedStatus]] = sql(`count(*), max(status)) FROM sale WHERE receipt_no='${killed}' AND COALESCE(paid_device_id, device_id)='${deviceId}'`);
  check('the resent sale exists once on the server, paid', killedRows === '1' && killedStatus === 'paid', `${killedRows} row(s), ${killedStatus}`);

  // 7. A receipt that never reaches the server (gap detection)
  await ctx.setOffline(true);
  await until(async () => (await text('sync-status')).includes('Offline'), 3000);
  const lostNo = await cashSale('Tea');
  receipts.push(lostNo);
  lost = await loseSale(lostNo);
  receipts.push(await cashSale('Samosa'));
  await ctx.setOffline(false);
  await until(async () => (await pending()) === 0, 20000);
  check('a lost receipt was removed from the outbox', lost.removed >= 1, `receipt ${lostNo}, seq ${lost.seq}, ${lost.removed} event(s)`);

  // 8. Online order (manual provider): new, accept, ready, hand over
  await T('tab-orders').click(); await T('tab-online').click();
  if (await until(() => T('online-pin').isVisible().then((v) => v || T('online-add').isVisible()), 5000) && (await T('online-pin').isVisible())) {
    await T('online-pin').fill(PIN); await T('online-connect-go').click();
  }
  await T('online-add').click();
  await T('online-ext').fill('BR-8001');
  await T('online-item').selectOption({ label: 'Samosa' }); // the seed prices Samosa on Zomato
  await T('online-add-line').click();
  await T('online-save').click();
  const st = () => page.locator('[data-testid="online-order"]').first().getAttribute('data-status');
  check('online order received', (await until(async () => (await st()) === 'received', 5000)) === true);
  await T('online-accept').click(); check('accepted', await until(async () => (await st()) === 'accepted', 5000));
  await T('online-ready').click(); check('ready', await until(async () => (await st()) === 'ready', 5000));
  await T('online-handover').click();
  check('handed over', await until(async () => (await st().catch(() => null)) !== 'ready' || (await T('online-empty').count()) === 1, 5000));
  await shot('3-online');

  // 9. Close the shift
  await T('more-menu').click(); await T('tab-shift').click();
  await T('counted-cash').fill('700'); await T('close-shift').click();
  await T('shift-slip-text').waitFor({ timeout: 15000 });
  const slip = await text('shift-slip-text');
  check('shift slip shows cash sales, counted cash and the variance', /cash sales/i.test(slip) && /counted cash/i.test(slip) && /(cash matches|short|over)/i.test(slip));
  await shot('4-shift-slip');
  await T('slip-done').click();
  await until(async () => (await pending()) === 0, 15000);
  const [[shiftClosed, counted]] = sql(`count(*) FILTER (WHERE closed_at IS NOT NULL), max(counted_cash_paise)) FROM shift WHERE device_id='${deviceId}'`);
  check('server has the shift closed with the count', shiftClosed === '1' && counted === '70000', `${shiftClosed} closed, counted ${counted}`);

  // 10. Server agrees with the tablet, sale by sale
  const server = sql(`receipt_no, status) FROM sale WHERE COALESCE(paid_device_id, device_id)='${deviceId}' AND receipt_no IS NOT NULL ORDER BY receipt_seq`);
  const expected = receipts.filter((r) => r !== lostNo);
  check('every receipt but the lost one is on the server, paid', JSON.stringify(server.map((r) => r[0])) === JSON.stringify(expected) && server.every((r) => r[1] === 'paid'), `${server.length}/${receipts.length}`);
  const [[rejected]] = sql(`count(*)) FROM sync_event WHERE device_id='${deviceId}' AND outcome='rejected'`);
  check('no event was rejected', rejected === '0', rejected);
  const [[reprints]] = sql(`count(*)) FROM audit WHERE action='sale.reprinted' AND entity_id=(SELECT id FROM sale WHERE receipt_no='${receipts[2]}' AND COALESCE(paid_device_id, device_id)='${deviceId}')`);
  check('reprint recorded in the audit trail', reprints === '1', reprints);

  // 11. Manager: day close with the gap shown, then reports.
  // The seed leaves, per outlet, a drawer and a waiter's open order from 2026-01-01; both block today's close, as a
  // forgotten drawer would. Both are cleared through the day-close screen below.
  // (The seed's unaccepted Swiggy order is expired and voided by the server's expiry job; online orders are not voided here.)
  const stale = sql(`id) FROM sale WHERE outlet_id='${outletId}' AND status='open' AND channel='counter' AND business_date < current_date`);
  await T('more-menu').click(); await T('sign-out').click();
  await T('mgr-open').click();
  await T('mgr-email').fill('a1@example.test'); await T('mgr-password').fill('dev-password-123'); await T('mgr-login').click();
  await T('mgr-tab-close').click();
  await T('mgr-date').waitFor();
  if (await T('mgr-outlet').count()) await T('mgr-outlet').selectOption(outletId); // shown only for several outlets
  await T('mgr-totals').waitFor({ timeout: 10000 });
  await T('mgr-sub-drawers').click(); // Close the day shows one section at a time
  if (await T('mgr-force-open').count()) {
    await T('mgr-force-open').first().click();
    await T('mgr-force-cash').fill('500'); await T('mgr-force-go').click();
    check('manager force-closes the forgotten drawer', !!(await until(async () => (await T('mgr-force-open').count()) === 0, 8000)));
  }
  await T('mgr-sub-orders').click();
  const listed = await page.locator('[data-testid="mgr-open-order"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-order-id')));
  check('day close lists the stale open order with its lines', stale.length > 0 && stale.every(([id]) => listed.includes(id))
    && /\d+ × \S/.test(await page.locator('[data-testid="mgr-open-order"]').first().innerText()), `${listed.length} listed, ${stale.length} stale`);
  for (const [id] of stale) {
    const row = page.locator(`[data-testid="mgr-open-order"][data-order-id="${id}"]`);
    await row.locator('[data-testid="mgr-void-open"]').click();
    check('void needs a reason', await row.locator('[data-testid="mgr-void-go"]').isDisabled());
    await row.locator('[data-testid="mgr-void-reason"]').fill('stale order from the seed');
    await row.locator('[data-testid="mgr-void-go"]').click();
    await until(async () => (await row.count()) === 0, 8000);
  }
  check('stale open order voided from the day-close screen; the blocker clears', !!(await until(async () => (await T('mgr-open-count').count()) === 0, 8000))
    && sql(`count(*)) FROM sale WHERE outlet_id='${outletId}' AND status='open'`)[0][0] === '0', `${stale.length} voided`);
  const [[voidAudits]] = sql(`count(*)) FROM audit WHERE action='order.void' AND entity_id IN (${stale.map(([id]) => `'${id}'`).join(',') || 'NULL'})`);
  check('each void is in the audit trail', voidAudits === String(stale.length), voidAudits);
  const date = await T('mgr-date').inputValue();
  check('day close shows the missing receipt', !!(await until(async () => (await page.locator('[data-testid="mgr-gap"]').allInnerTexts()).some((g) => g.includes(String(lost.seq))), 5000)));
  const [[gross]] = sql(`COALESCE(sum(total_paise),0)) FROM sale WHERE outlet_id='${outletId}' AND business_date='${date}' AND status='paid'`);
  const shownGross = rupeesToPaise(await text('mgr-gross'));
  check('gross on screen equals the server\'s paid sales', String(shownGross) === gross, `${shownGross} vs ${gross}`);
  await shot('5-day-close');
  await T('mgr-sub-tablets').click();
  for (const box of await page.locator('[data-testid="mgr-blockers"] input[type=checkbox]').all()) await box.check(); // other seeded tablets, if any
  const closable = await until(() => T('mgr-close').isEnabled(), 5000);
  check('nothing holds the day open', !!closable, closable ? '' : (await T('mgr-blockers').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  if (closable) {
    await T('mgr-close').click();
    check('day closed', !!(await until(() => T('mgr-closed').isVisible(), 10000)));
    const [[dayClosed]] = sql(`count(*)) FROM business_day WHERE outlet_id='${outletId}' AND date='${date}' AND closed_at IS NOT NULL`);
    check('server has the business day closed', dayClosed === '1', dayClosed);
  }
  await T('mgr-tab-reports').click();
  check('reports load with a total', !!(await until(async () => /\d/.test(await text('rep-total')), 10000)));
  await shot('6-reports');
  check('no sideways scroll on manager screens', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
  await shot('failure').catch(() => {});
} finally {
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-flow.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
