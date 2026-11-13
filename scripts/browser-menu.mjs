// The manager's Menu tab (docs/manager-menu-editor-plan.md steps 5-6), installed Edge at tablet sizes against the Docker
// stack on :8080. Usage: node scripts/browser-menu.mjs  (stack up, api and counter images rebuilt).
// Writes .validation/browser-menu.log and screenshots in .validation/screens/. Dev data only: seeded tenant A.
//
// What it checks: no horizontal scroll and 44px targets at 1024 and 820 wide; a price edit saves and the server has it;
// a new category with a new item (and a picture set after save) saves, the picture changes and is removed; a save that
// fails on one row (the item was deleted elsewhere) leaves the other edit unsaved; leaving with unsaved edits asks;
// Discard reverts; offline shows the banner and disables Save; bulk GST; delete with confirmation; CSV export, an unchanged
// re-import, an edited import (preview, load, Save, Excel-stripped code), and a file with the same item twice.
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
      headers: { host: 'tenant-a.localhost', ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const mgr = (await api('POST', '/login', { email: 'a1@example.test', password: 'dev-password-123' })).json.token;
const [outletId, counterId] = execFileSync('docker', ['exec', 'app-postgres-1', 'psql', '-U', 'pos_owner', '-d', 'pos', '-tA', '-F', '|', '-c',
  "BEGIN; SELECT set_config('app.tenant_id','00000000-0000-4000-8000-00000000000a',true); SELECT o.id||'|'||c.id FROM outlet o JOIN counter c ON c.outlet_id=o.id WHERE o.name='School 1 Canteen' AND c.code='C1'; COMMIT;"]).toString()
  .split('\n').find((l) => /^[0-9a-f-]{36}\|[0-9a-f-]{36}$/.test(l)).split('|');
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(`${out}/menu-test.png`, PNG);
const menu = async () => (await api('GET', '/menu', undefined, mgr)).json;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
const T = (id) => page.getByTestId(id);
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await page.waitForTimeout(100); } return false; };
const saved = () => until(async () => /Saved/.test(await page.locator('.me-status').innerText()));
const cell = (col, row) => page.locator(`[data-cell="${col}:${row}"]`);
const shot = (n) => page.screenshot({ path: `${out}/screens/menu-${n}.png` });

const code = (await api('POST', '/enrolment-codes', { outletId, counterId, label: `Menu ${tag}` }, mgr)).json.code;
await page.goto(BASE);
await T('enrol-code').fill(code); await T('enrol-go').click();
await page.locator('[data-testid^="staff-"]').first().waitFor({ timeout: 15000 });
const openMenu = async () => { await T('mgr-tab-menu').click(); await T('mgr-menu').waitFor(); await page.locator('.me-rail').waitFor(); };
await T('more-menu').click(); await T('mgr-open').click();
await T('mgr-email').fill('a1@example.test'); await T('mgr-password').fill('dev-password-123'); await T('mgr-login').click();
await openMenu();

// ---- layout ----
const layout = async (label) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const small = await page.evaluate(() => [...document.querySelectorAll('.me button, .me select, .me input:not([type=checkbox]), .me .me-chk')]
    .filter((e) => e.offsetParent)
    .map((e) => ({ h: e.offsetHeight /* layout px: the app's text-size zoom scales getBoundingClientRect */, t: `${e.className || e.tagName}:${(e.getAttribute('aria-label') || e.textContent || '').slice(0, 20)}` }))
    .filter((r) => r.h > 0 && r.h < 44));
  check(`${label}: no horizontal page scroll`, !wide);
  check(`${label}: every target at least 44px high`, small.length === 0, small.length ? `${small.length} too small, e.g. ${[...new Set(small.map((s) => `${s.t} ${s.h}px`))].slice(0, 4).join('; ')}` : '');
};
await page.locator('.me-rail button').nth(1).click();
await layout('1024');
await shot('1024');
await page.setViewportSize({ width: 820, height: 1180 });
await layout('820');
await shot('820');
await page.setViewportSize({ width: 1024, height: 768 });

// ---- 1. a price edit ----
const m0 = await menu();
const firstName = await cell('name', 0).inputValue();
const item0 = m0.items.find((i) => i.name === firstName);
const price0 = m0.prices.find((p) => p.itemId === item0.id && p.channel === 'counter');
check('Save is disabled with nothing changed', await T('me-save').isDisabled());
const newPaise = 5000 + (price0?.pricePaise === 5025 ? 50 : 25); // always a different amount from what the row has now
await cell('counter', 0).fill((newPaise / 100).toFixed(2)); await cell('counter', 0).press('Tab');
check('an edit enables Save and shows the change count', !(await T('me-save').isDisabled()) && /1 change/.test(await page.locator('.me-status').innerText()));
await T('me-save').click(); await saved();
const m1 = await menu();
check(`the saved price reached the server (${newPaise} paise)`, m1.prices.find((p) => p.itemId === item0.id && p.channel === 'counter')?.pricePaise === newPaise);
check('GST on that price is what the row showed', m1.prices.find((p) => p.itemId === item0.id && p.channel === 'counter')?.gstRateBp === (price0?.gstRateBp ?? 500));

// ---- 2. new category + item + picture ----
const catName = `Menu ${tag}`;
await T('me-add-cat').click();
await page.keyboard.type(catName); await page.keyboard.press('Tab');
await T('me-add-item').click();
await page.keyboard.type(`Test dish ${tag}`); await page.keyboard.press('Tab');
await cell('counter', 0).fill('33'); await cell('counter', 0).press('Tab');
const chooser = page.waitForEvent('filechooser');
await page.locator('.me-pic').first().click();
(await chooser).setFiles(`${out}/menu-test.png`);
check('a chosen picture shows at once, before Save', await until(async () => (await page.locator('.me-row .me-thumb').first().evaluate((e) => e.tagName)) === 'IMG'));
await T('me-save').click(); await saved();
const m2 = await menu();
const newCat = m2.categories.find((c) => c.name === catName);
const newItem = m2.items.find((i) => i.name === `Test dish ${tag}`);
check('the new category and item exist on the server', !!newCat && newItem?.categoryId === newCat.id);
check('the server gave the new item a quick code', /^[0-9]{2}$/.test(newItem?.code ?? ''), newItem?.code);
check('the new item\'s price is 3300 paise', m2.prices.find((p) => p.itemId === newItem?.id && p.channel === 'counter')?.pricePaise === 3300);
check('its picture was stored after Save', !!newItem?.imageSha256);
check('the saved picture shows in the grid from the server', await until(async () => (await page.locator('.me-row img.me-thumb').first().evaluate((e) => e.naturalWidth)) > 0));
await shot('new-item');

// remove the picture from the details dialog
await page.locator('.me-more').first().click();
await page.getByRole('button', { name: 'Remove picture' }).click();
await page.getByRole('button', { name: 'Done' }).click();
await T('me-save').click(); await saved();
check('Remove picture clears it on the server', (await menu()).items.find((i) => i.id === newItem.id)?.imageSha256 === null);

// ---- 3. a failing save does not half-apply ----
const p1 = (await api('POST', '/items', { categoryId: newCat.id, name: `Keep ${tag}` }, mgr)).json;
const p2 = (await api('POST', '/items', { categoryId: newCat.id, name: `Gone ${tag}` }, mgr)).json;
for (const i of [p1, p2]) await api('PUT', `/items/${i.id}/prices/counter`, { pricePaise: 1000, gstRateBp: 500 }, mgr);
await T('mgr-tab-reports').click(); await openMenu();
await page.getByTestId(`me-cat-${catName}`).click();
await api('DELETE', `/items/${p2.id}`, undefined, mgr); // someone else removes it while the manager has the screen open
const rowOf = async (name) => { const names = await page.locator('[data-col="name"]').evaluateAll((els) => els.map((e) => e.value)); return names.indexOf(name); };
const [rKeep, rGone] = [await rowOf(`Keep ${tag}`), await rowOf(`Gone ${tag}`)];
await cell('counter', rKeep).fill('55'); await cell('counter', rKeep).press('Tab');
await cell('counter', rGone).fill('66'); await cell('counter', rGone).press('Tab');
await T('me-save').click();
check('a save that fails shows why and says nothing was saved', await until(async () => /Nothing was saved/.test(await page.locator('.m-alert.bad').innerText().catch(() => ''))));
check('the failing row is marked', (await page.locator('.me-note').count()) >= 1);
check('the other edit was not applied on the server (all or nothing)', (await menu()).prices.find((p) => p.itemId === p1.id && p.channel === 'counter')?.pricePaise === 1000);
check('Reload is offered', await page.getByRole('button', { name: 'Reload' }).isVisible());
await shot('conflict');
await page.getByRole('button', { name: 'Reload' }).click();
check('after Reload the removed item is gone and the edit is cleared', await until(async () => (await rowOf(`Gone ${tag}`)) === -1 && (await cell('counter', await rowOf(`Keep ${tag}`)).inputValue()) === '10'));

// ---- 4. leave, discard ----
await page.getByTestId(`me-cat-${catName}`).click();
const rk = await rowOf(`Keep ${tag}`);
await cell('counter', rk).fill('12'); await cell('counter', rk).press('Tab');
await T('mgr-tab-reports').click();
check('leaving with unsaved edits asks first', await page.getByText('Leave without saving?').isVisible());
await page.getByRole('button', { name: 'Keep editing' }).click();
check('Keep editing stays on the Menu tab with the edit intact', (await cell('counter', rk).inputValue()) === '12');
await T('me-discard').click(); await T('me-confirm-discard').click();
check('Discard reverts the edit', await until(async () => (await cell('counter', await rowOf(`Keep ${tag}`)).inputValue()) === '10'));

// ---- 5. offline ----
await page.getByTestId(`me-cat-${catName}`).click();
const rk2 = await rowOf(`Keep ${tag}`);
await cell('counter', rk2).fill('13'); await cell('counter', rk2).press('Tab');
await ctx.setOffline(true);
check('offline: a banner says the menu needs a connection', await until(async () => /needs a connection/.test(await page.locator('.m-alert.info').innerText().catch(() => ''))));
check('offline: Save is disabled and the grid is read-only', (await T('me-save').isDisabled()) && (await cell('counter', rk2).isDisabled()));
await ctx.setOffline(false);
check('back online: the grid is editable again', await until(async () => !(await cell('counter', rk2).isDisabled())));
await T('me-discard').click(); await T('me-confirm-discard').click();

// ---- 6. bulk GST, delete with confirmation ----
await page.getByTestId(`me-cat-${catName}`).click();
await page.getByLabel('Select all shown').check();
await page.getByLabel('GST %', { exact: true }).first().fill('18');
await page.getByRole('button', { name: 'Set GST' }).click();
await T('me-save').click(); await saved();
const m3 = await menu();
const rowsHere = m3.items.filter((i) => i.categoryId === newCat.id);
check('bulk GST set 18% on every ticked item\'s prices', rowsHere.length >= 2 && m3.prices.filter((p) => rowsHere.some((i) => i.id === p.itemId)).every((p) => p.gstRateBp === 1800));
await page.getByLabel('Select all shown').check();
await T('me-delete').click();
check('delete asks, and says past sales keep the name', await page.getByText('Past sales keep the item').isVisible());
await T('me-confirm-delete').click();
check('an emptied category can then be deleted', !(await T('me-del-cat').isDisabled()));
await T('me-del-cat').click();
await T('me-save').click(); await saved();
const m4 = await menu();
check('items and category are gone from the server', !m4.categories.some((c) => c.id === newCat.id) && !m4.items.some((i) => i.categoryId === newCat.id));

// ---- 7. CSV export, edit, import, preview, save (step 7) ----
await T('me-csv').click();
await layout('CSV dialog');
const dl = page.waitForEvent('download');
await T('me-export').click();
const exported = fs.readFileSync(await (await dl).path(), 'utf8');
check('export: UTF-8 BOM and the agreed header', exported.startsWith('\u{FEFF}id,category,name,code,diet,hsn,gst,price_counter,price_zomato,price_swiggy,tags,description\r\n'));
check('export: the whole menu, one row per live item', exported.trim().split('\r\n').length - 1 === (await menu()).items.length);
const importFile = async (name, text) => {
  fs.writeFileSync(`${out}/${name}`, text);
  await T('me-csv').click();
  const fc = page.waitForEvent('filechooser');
  await T('me-import').click();
  (await fc).setFiles(`${out}/${name}`);
  await T('me-import-preview').waitFor();
  return T('me-import-preview').innerText();
};
const same = await importFile('menu-same.csv', exported);
check('the exported file imports back as all unchanged, and Load is disabled', /0 changed · 0 new/.test(same) && (await T('me-import-load').isDisabled()));
await shot('csv-unchanged');
await page.getByRole('button', { name: 'Cancel' }).click();

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csvCat = `CSV ${tag}`, csvDish = `CSV dish ${tag}`, csvTag = `csv${tag}`;
const edited = `id,category,name,code,price_counter,tags\r\n${item0.id},,${q(item0.name)},${item0.code},77.50,\r\n,${csvCat},${csvDish},7,40,${csvTag}\r\n`;
const prev = await importFile('menu-edited.csv', edited);
check('preview: 1 changed, 1 new, adds a category and a tag', /1 changed · 1 new/.test(prev) && /Adds 1 category and 1 tag/.test(prev), prev.replace(/\s+/g, ' ').slice(0, 120));
check('preview: says which columns the file leaves alone', /left as they are:.*diet.*HSN.*GST %/.test(prev));
await shot('csv-preview');
await T('me-import-load').click();
check('loaded into the grid, not saved', /changes/.test(await page.locator('.me-status').innerText()) && (await menu()).prices.find((p) => p.itemId === item0.id && p.channel === 'counter')?.pricePaise !== 7750);
await T('me-save').click(); await saved();
const m5 = await menu();
const cCat = m5.categories.find((c) => c.name === csvCat), cItem = m5.items.find((i) => i.name === csvDish), cTag = m5.tags.find((t) => t.name === csvTag);
check('after Save: the edited price is on the server', m5.prices.find((p) => p.itemId === item0.id && p.channel === 'counter')?.pricePaise === 7750);
check('after Save: new category, item with code 07 (Excel-stripped 7), price and new tag', !!cCat && cItem?.categoryId === cCat.id && cItem?.code === '07'
  && m5.prices.find((p) => p.itemId === cItem.id && p.channel === 'counter')?.pricePaise === 4000 && !!cTag && cItem.tagIds.includes(cTag.id));
check('import left the other items alone', m4.items.every((i) => m5.items.some((x) => x.id === i.id)));
const twice = await importFile('menu-twice.csv', `id,category,name,price_counter\r\n${item0.id},,${q(item0.name)},1\r\n,${q(m5.categories.find((c) => c.id === item0.categoryId).name)},${q(item0.name)},2\r\n`);
check('the same item twice is a problem and nothing loads', /same item as row 2/.test(twice) && (await T('me-import-load').isDisabled()));
await shot('csv-problem');
await page.getByRole('button', { name: 'Cancel' }).click();
await api('DELETE', `/items/${cItem.id}`, undefined, mgr); await api('DELETE', `/categories/${cCat.id}`, undefined, mgr); await api('DELETE', `/tags/${cTag.id}`, undefined, mgr);

// ---- restore ----
if (price0) await api('PUT', `/items/${item0.id}/prices/counter`, { pricePaise: price0.pricePaise, gstRateBp: price0.gstRateBp }, mgr);
else await api('DELETE', `/items/${item0.id}/prices/counter`, undefined, mgr);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
fs.writeFileSync(`${out}/browser-menu.log`, log.join('\n') + `\n${results.length - failed}/${results.length} passed\n`);
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
