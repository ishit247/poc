// Two-browser run of phase 12 step 7 ("12b"): two tablets at one outlet, in restaurant (map) mode, against the Docker
// stack on :8080 with installed Edge. Each browser context is its own device (its own IndexedDB and credential).
// Usage: node scripts/browser-tables.mjs   (stack up, api and counter images rebuilt). Writes
// .validation/browser-tables.log and screenshots in .validation/screens/. Dev data only: seeded tenant A.
//
// What it checks: a waiter's order on one device appears on the other's table map without anyone pressing sync (the
// server's nudge); either device adds to the other's order and both show the same lines; a line added offline arrives
// once the device is back; payment stays with the device that opened the order, and paying frees the table on both.
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

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: 'localhost', port: 8080, path: '/api' + path, method,
      headers: { host: 'tenant-a.localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const sql = "BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true); SELECT o.id||' '||c.id FROM outlet o JOIN counter c ON c.outlet_id=o.id WHERE o.name='School 1 Canteen' AND c.code='C1'; COMMIT;";
const [outletId, counterId] = execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', sql]).toString()
  .split('\n').find((l) => /^[0-9a-f-]{36} [0-9a-f-]{36}$/.test(l)).split(' ');
await api('PUT', `/outlets/${outletId}/table-mode`, { mode: 'map' }, mgr);
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const [shared, own, voided] = [`S${tag}`, `O${tag}`, `V${tag}`]; // fresh tables, so earlier runs' orders are not on them
for (const code of [shared, own, voided]) {
  const r = await api('POST', `/outlets/${outletId}/tables`, { code }, mgr);
  if (r.status !== 201) throw new Error(`table ${code}: ${r.status}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

/** One tablet: enrolled, signed in as `role`, on the Sell screen. */
async function tablet(name, role, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  const code = (await api('POST', '/enrolment-codes', { outletId, counterId }, mgr)).json.code;
  await page.goto(BASE);
  await page.getByTestId('enrol-code').fill(code); await page.getByTestId('enrol-go').click();
  await page.locator('[data-testid^="staff-"]').filter({ hasText: new RegExp(role, 'i') }).first().click();
  for (const d of PIN) await page.getByTestId(`key-${d}`).click();
  await page.getByTestId('pin-go').click();
  const opening = page.getByTestId('opening-cash');
  await Promise.race([opening.waitFor({ timeout: 5000 }).catch(() => {}), page.getByTestId('tab-sell').waitFor({ timeout: 5000 }).catch(() => {})]);
  if (await opening.isVisible().catch(() => false)) { await opening.fill('500'); await page.getByTestId('open-shift').click(); }
  await page.getByTestId('tab-sell').click();
  await page.getByTestId('table-strip').waitFor({ timeout: 15000 });
  const T = (id) => page.getByTestId(id);
  return {
    ctx, page, T,
    shot: (n) => page.screenshot({ path: `${out}/screens/${n}.png` }),
    lines: () => page.locator('[data-testid="cart-lines"] li .name').count(),
    item: (i = 0) => page.locator('button.item:not([disabled])').nth(i),
    busy: async (code) => ((await T(`table-${code}`).getAttribute('class')) ?? '').includes('busy'),
    /** Polls until `f` is true (IndexedDB live queries and the pull land a moment later); returns the milliseconds it took, or -1. */
    until: async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return Date.now() - t0; await page.waitForTimeout(100); } return -1; },
  };
}

try {
  const a = await tablet('A', 'cashier', { width: 1024, height: 768 }); // the counter
  const b = await tablet('B', 'waiter', { width: 768, height: 1024 });  // a waiter's tablet, portrait
  await a.T(`table-${shared}`).waitFor({ timeout: 15000 });
  await b.T(`table-${shared}`).waitFor({ timeout: 15000 });
  check('both tablets list the new tables', true);

  // B seats the table and rings an item. A sees it with no sync pressed: the server nudges, A pulls.
  await b.T(`table-${shared}`).click();
  await b.item(0).click();
  check('B: first item opens the table\'s order', (await b.until(async () => (await b.lines()) === 1)) >= 0);
  const seen = await a.until(() => a.busy(shared));
  check('A: B\'s table turns busy without pressing sync', seen >= 0, seen >= 0 ? `${seen} ms` : 'not within 8 s');
  await a.T(`table-${shared}`).click();
  check('A: B\'s order shows its line', (await a.until(async () => (await a.lines()) === 1)) >= 0);
  check('A: marked as another device\'s order', await a.T('other-device').isVisible());
  check('A: can take payment for B\'s order (7b)', await a.T('pay-cash').isEnabled() && await a.T('pay-upi').isEnabled());
  await a.shot('t1-a-sees-b-order');

  // A adds to B's order; B (still on that table) shows it.
  await a.item(1).click();
  check('A: its line is added to B\'s order', (await a.until(async () => (await a.lines()) === 2)) >= 0);
  const back = await b.until(async () => (await b.lines()) === 2);
  check('B: A\'s line appears on B\'s order', back >= 0, back >= 0 ? `${back} ms` : 'not within 8 s');
  check('both show the same total', (await a.T('total').innerText()) === (await b.T('total').innerText()), await a.T('total').innerText());
  await b.shot('t2-b-sees-a-line-768x1024');

  // B goes offline and adds a line: A does not see it until B is back, then it does.
  await b.ctx.setOffline(true);
  await b.item(2).click();
  check('B offline: the line is on B', (await b.until(async () => (await b.lines()) === 3)) >= 0);
  await a.page.waitForTimeout(2500);
  check('A: an offline device\'s line has not arrived', (await a.lines()) === 2);
  await b.ctx.setOffline(false);
  const late = await a.until(async () => (await a.lines()) === 3, 15000);
  check('A: the line arrives once B is back online', late >= 0, late >= 0 ? `${late} ms` : 'not within 15 s');

  // 7b: the counter takes payment for the waiter's order, all three lines; the table frees on the waiter's tablet too.
  const theirTotal = await a.T('total').innerText();
  await a.T('pay-cash').click(); await a.T('confirm-pay').click();
  await a.T('receipt-no').waitFor();
  const r1 = await a.T('receipt-no').innerText();
  check('A: paid B\'s order, receipt issued here', true, `${r1} ${theirTotal}`);
  await a.shot('t3a-a-paid-b-order');
  await a.T('new-sale').click();
  const gone = await b.until(async () => !(await b.busy(shared)));
  check('B: the table A paid frees', gone >= 0, gone >= 0 ? `${gone} ms` : 'not within 8 s');
  check('B: nothing left on it', (await b.lines()) === 0);
  check('A: that table is free here too', (await a.until(async () => !(await a.busy(shared)))) >= 0);
  await b.shot('t3b-b-table-freed-768x1024');

  // The other way round: A's own order, which B adds to. A pays for both lines; the table frees on both tablets.
  await a.T(`table-${own}`).click();
  await a.item(0).click();
  check('A: its own order opens', (await a.until(async () => (await a.lines()) === 1)) >= 0);
  check('B: A\'s table turns busy', (await b.until(() => b.busy(own))) >= 0);
  await b.T(`table-${own}`).click();
  check('B: sees A\'s line', (await b.until(async () => (await b.lines()) === 1)) >= 0);
  await b.item(1).click(); // a different item from A's, so it is a second line
  check('A: B\'s line arrives on A\'s own order', (await a.until(async () => (await a.lines()) === 2)) >= 0);
  check('A: its own order is payable', await a.T('pay-cash').isEnabled() && !(await a.T('other-device').isVisible()));
  const total = await a.T('total').innerText();
  await a.T('pay-cash').click(); await a.T('confirm-pay').click();
  await a.T('receipt-no').waitFor();
  const r2 = await a.T('receipt-no').innerText();
  check('A: paid, receipt issued', true, `${r2} ${total}`);
  const seq = (r) => Number(r.trim().split('-').pop());
  check('A: one receipt series across both orders (the next number)', seq(r2) === seq(r1) + 1, `${r1} then ${r2}`);
  await a.shot('t4-a-paid-both-lines');
  await a.T('new-sale').click();
  const freed = await b.until(async () => !(await b.busy(own)));
  check('B: the paid table frees', freed >= 0, freed >= 0 ? `${freed} ms` : 'not within 8 s');
  check('A: the paid table is free here too', !(await a.busy(own)));
  // The server's record of the 7b payment: rung up on B, paid on A (another device), on A's receipt number.
  const q = `BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true);
    SELECT s.status||' '||(s.paid_device_id <> s.device_id)||' '||s.receipt_no FROM sale s JOIN dining_table dt ON dt.id = s.table_id
     WHERE dt.code = '${shared}' AND dt.outlet_id = '${outletId}'; COMMIT;`;
  const rec = execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', q]).toString()
    .split('\n').filter((l) => /^(paid|open|void) /.test(l));
  check('server: B\'s order is paid on A, on A\'s receipt', rec.length === 1 && rec[0].startsWith('paid true ') && r1.includes(rec[0].split(' ')[2]), rec.join(' | '));

  // 7c: the counter (cashier) voids the waiter tablet's order, with a reason; the table frees on the waiter's tablet.
  await b.T(`table-${voided}`).click();
  await b.item(0).click();
  check('B: its own order opens, and B may void it', (await b.until(async () => (await b.lines()) === 1)) >= 0 && await b.T('void-order').isVisible());
  check('A: B\'s order on the void table turns busy', (await a.until(() => a.busy(voided))) >= 0);
  await a.T(`table-${voided}`).click();
  await a.until(async () => (await a.lines()) === 1);
  await a.T('void-order').click();
  check('A: Void needs a reason', !(await a.T('void-go').isEnabled()));
  await a.T('void-reason').fill('guest walked out');
  await a.T('void-go').click();
  check('A: the order is voided here, the table free', (await a.until(async () => (await a.T('sell-message').innerText().catch(() => '')) === 'Order voided.' && !(await a.busy(voided)))) >= 0);
  await a.shot('t5a-a-voided-b-order');
  const dropped = await b.until(async () => !(await b.busy(voided)) && (await b.lines()) === 0);
  check('B: the voided order drops off its tablet', dropped >= 0, dropped >= 0 ? `${dropped} ms` : 'not within 8 s');
  await b.shot('t5b-b-order-voided-768x1024');

  // A waiter may not void the counter's order; the counter voids its own.
  await a.T(`table-${voided}`).click();
  await a.item(0).click();
  await a.until(async () => (await a.lines()) === 1);
  await b.until(() => b.busy(voided));
  await b.T(`table-${voided}`).click(); // B still has its voided order chosen; tapping the table opens the one now on it
  check('B: sees A\'s new order on the table', (await b.until(async () => (await b.lines()) === 1)) >= 0);
  check('B (waiter): no Void on an order someone else opened', !(await b.T('void-order').isVisible()));
  await a.T('void-order').click(); await a.T('void-reason').fill('rung by mistake'); await a.T('void-go').click();
  check('A: voids its own order', (await a.until(async () => !(await a.busy(voided)))) >= 0);
  check('B: and it drops off B', (await b.until(async () => !(await b.busy(voided)))) >= 0);

  const vq = `BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true);
    SELECT s.status||'|'||s.void_reason||'|'||(SELECT count(*) FROM audit au WHERE au.action = 'order.voided' AND au.entity_id::text = s.id::text AND au.actor_kind = 'user'
                                                  AND (au.detail->>'deviceId' <> au.detail->>'openedOnDeviceId'))
      FROM sale s JOIN dining_table dt ON dt.id = s.table_id WHERE dt.code = '${voided}' AND dt.outlet_id = '${outletId}' ORDER BY s.received_at; COMMIT;`;
  const vrec = execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-c', vq]).toString()
    .split('\n').filter((l) => /^(paid|open|void)\|/.test(l));
  check('server: both void with their reasons; B\'s audited as voided on another device, A\'s own not',
    vrec.join(',') === 'void|guest walked out|1,void|rung by mistake|0', vrec.join(' , '));
  for (const t of [a, b]) check(`${t === a ? 'A' : 'B'}: no sideways scroll`, await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} catch (e) {
  check('run completed', false, String(e).split('\n')[0]);
} finally {
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  await api('PUT', `/outlets/${outletId}/table-mode`, { mode: 'default' }, mgr);
  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} passed${failed.length ? '; failed: ' + failed.map((f) => f.name).join(', ') : ''}`;
  fs.writeFileSync(`${out}/browser-tables.log`, results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n' + summary + '\n');
  console.log(summary);
  process.exit(failed.length ? 1 : 0);
}
