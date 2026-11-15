// Records the demo video: manager setup, cashier bill, hold, discount, refund. Taste Pure Veg, tablet size.
// Usage: node scripts/demo-video.mjs   (stack up on a fresh seed: `pnpm run up:fresh`, http://localhost:8080)
// Output: demo/taste-pos-demo.webm (+ demo/shots/failure.png on failure). Dev data only; logins from docs/test-accounts.md.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/counter/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8080';
const W = 1280, H = 800;
const PIN = '482913';
const out = 'demo';
fs.mkdirSync(`${out}/shots`, { recursive: true });
fs.rmSync(`${out}/raw`, { recursive: true, force: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: `${out}/raw`, size: { width: W, height: H } } });
// Caption bar at the bottom (the top of the app is working space), plus a dot that shows where each tap lands.
await ctx.addInitScript(() => {
  window.print = () => {};
  const mount = () => {
    if (document.getElementById('demo-cap')) return;
    const s = document.createElement('style');
    s.textContent = `#demo-cap{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;max-width:80%;padding:12px 24px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;font:600 20px/1.3 system-ui,sans-serif;text-align:center;pointer-events:none;transition:opacity .25s;opacity:0}
#demo-dot{position:fixed;z-index:99998;box-sizing:border-box;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;background:rgba(250,204,21,.55);border:3px solid #f59e0b;pointer-events:none;transition:transform .15s;left:-100px;top:-100px;opacity:0}`;
    document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'demo-cap'; document.body.appendChild(c);
    const d = document.createElement('div'); d.id = 'demo-dot'; document.body.appendChild(d);
  };
  window.__cap = (t) => { mount(); const c = document.getElementById('demo-cap'); c.textContent = t || ''; c.style.opacity = t ? '1' : '0'; };
  window.__dot = (x, y, press) => { mount(); const d = document.getElementById('demo-dot'); if (x === null) { d.style.opacity = '0'; return; } d.style.opacity = '1';
    // The app may zoom its page (font-size setting): measure how far a CSS pixel is from a viewport pixel and undo it.
    d.style.left = '100px'; d.style.top = '100px';
    const r = d.getBoundingClientRect();
    const zx = (r.left + r.width / 2) / 100, zy = (r.top + r.height / 2) / 100;
    d.style.left = x / (zx || 1) + 'px'; d.style.top = y / (zy || 1) + 'px'; d.style.transform = press ? 'scale(.7)' : 'scale(1)'; };
});
const page = await ctx.newPage();
const t0 = Date.now();
const tapLog = []; // "seconds x y w h" of each tap, to check the dot against the video frames
const T = (id) => page.getByTestId(id);
const beat = (ms = 700) => page.waitForTimeout(ms);
const cap = async (text, ms = 2200) => { await page.evaluate((t) => window.__cap?.(t), text); if (ms) await beat(ms); };
const scene = async (title, sub) => { await cap(`${title} — ${sub}`, 2800); };
/** Move the dot to the control, pause so the viewer sees it, then tap. */
async function tap(loc, after = 600) {
  const el = typeof loc === 'string' ? T(loc) : loc;
  await el.first().waitFor({ timeout: 15000 });
  await el.first().scrollIntoViewIfNeeded();
  // Measure only once the control has stopped moving (scrolling, dialogs opening, layout settling).
  let b = await el.first().boundingBox();
  for (let i = 0; i < 20; i++) {
    await beat(120);
    const n = await el.first().boundingBox();
    const same = n && b && Math.abs(n.x - b.x) < 0.5 && Math.abs(n.y - b.y) < 0.5;
    b = n;
    if (same) break;
  }
  await page.evaluate(([x, y]) => window.__dot?.(x, y, false), [b.x + b.width / 2, b.y + b.height / 2]);
  await beat(1000); // the recording trails the page a little: let the dot arrive and be seen before the tap
  await page.evaluate(([x, y]) => window.__dot?.(x, y, true), [b.x + b.width / 2, b.y + b.height / 2]);
  await beat(250);
  tapLog.push(`${((Date.now() - t0) / 1000 - 0.3).toFixed(1)} ${Math.round(b.x)} ${Math.round(b.y)} ${Math.round(b.width)} ${Math.round(b.height)}`);
  await el.first().click();
  await beat(250);
  await page.evaluate(() => window.__dot?.(null)).catch(() => {}); // gone once tapped: never left over a new screen
  await beat(Math.max(0, after - 250));}
async function type(id, text, after = 500) {
  await tap(id, 150);
  await T(id).fill('');
  await T(id).pressSequentially(text, { delay: 90 });
  await beat(after);
}
const text = async (id) => (await T(id).innerText()).trim();

try {
  await page.goto(BASE);
  await beat(800);

  // ── Scene 1: Manager sets up the device ─────────────────────────────────
  await scene('1 · Manager setup', 'turn a blank tablet into a Taste Pure Veg counter');
  await cap('A new tablet starts blank. The manager signs in to create a setup code.');
  await tap('enrol-manager');
  await type('mgr-email', 'manager@taste.test', 300);
  await type('mgr-password', 'dev-password-123', 300);
  await tap('mgr-login', 1200);
  await cap('Pick the outlet and the counter this tablet will run.');
  await tap('code-make', 1500);
  await cap('A one-time code, valid 15 minutes. Use it right here.', 2200);
  await tap('code-use', 1500);
  await cap('The tablet is enrolled to its counter. Staff now sign in with a PIN.', 2400);

  // Manager tools (before any cashier signs in): turn discounts on.
  await cap('Before opening, the manager switches on discounts in Settings.', 2000);
  await tap('more-menu', 400);
  await tap('mgr-open', 500);
  await type('mgr-email', 'manager@taste.test', 200);
  await type('mgr-password', 'dev-password-123', 200);
  await tap('mgr-login', 1000);
  await tap('mgr-tab-settings', 800);
  await T('set-discount-cap').waitFor();
  await cap('Set the largest discount a cashier may give: 15%.', 1500);
  await type('set-discount-cap', '15', 600);
  await tap('set-save', 1200);
  await cap('Saved. Cashiers can now give up to 15% off, with a reason.', 2200);
  await tap('more-menu', 400);
  await tap('mgr-exit', 800);

  // ── Scene 2: Cashier generates a bill ───────────────────────────────────
  await scene('2 · Cashier', 'sign in, open the drawer, bill a customer');
  await tap(page.locator('[data-testid^="staff-"]').filter({ hasText: /cashier/i }), 400);
  for (const d of PIN) await tap(`key-${d}`, 150);
  await tap('pin-go', 800);
  await cap('Count the cash in the drawer and open the shift.');
  await type('opening-cash', '500', 400);
  await tap('open-shift', 800);
  await tap('tab-sell', 600);

  // Real item names from the menu this tablet pulled.
  const names = (await page.locator('button.item:not([data-testid^="pop-"])').allInnerTexts()).map((s) => s.split('\n')[0].trim()).filter(Boolean);
  fs.writeFileSync(`${out}/items.txt`, names.join('\n'));
  const pick = (re, i) => names.find((n) => re.test(n)) ?? names[i];
  const A = pick(/tea/i, 0), B = pick(/sandwich/i, 1), C = pick(/momos/i, 2), D = pick(/samosa|coffee/i, 3);

  await cap('Tap items to build the bill. Tap again to add more.', 1500);
  await tap(`item-${A}`, 500);
  await tap(`item-${B}`, 500);
  await tap(`item-${B}`, 500);
  await cap('The bill shows each line, GST and the total as you go.', 2400);
  await tap('pay-cash', 800);
  await cap('Choose how the customer pays. Cash shows the change to give back.', 1800);
  await tap('cash-exact', 600).catch(() => {});
  await tap('confirm-pay', 1200);
  await T('receipt-no').waitFor();
  await cap('Bill paid. The receipt number is issued, ready to print.', 2600);
  await tap('new-sale', 800);

  // ── Scene 3: Hold a bill ────────────────────────────────────────────────
  await scene('3 · Hold a bill', 'park an order and serve the next customer');
  await tap(`item-${C}`, 400);
  await tap(`item-${D}`, 400);
  await cap('A customer is still deciding. Hold this order instead of making them wait.', 2400);
  await tap('held-btn', 700);
  await tap('hold', 1000);
  await cap('Held. The screen is clear for the next customer.', 2200);
  await tap(`item-${A}`, 400);
  await tap('pay-upi', 700);
  await tap('confirm-pay', 1000);
  await T('receipt-no').waitFor();
  await cap('The next customer pays by UPI and leaves.', 2000);
  await tap('new-sale', 800);
  await cap('Back to the held order: open Held orders and tap it.', 1800);
  await tap('held-btn', 700);
  await tap('held-order', 1000);
  await cap('The held order is back exactly as it was.', 2200);

  // ── Scene 4: Discount ───────────────────────────────────────────────────
  await scene('4 · Discount', 'a reason and a limit set by the manager');
  await tap('pay-cash', 800);
  await cap(`Total due: ₹${await text('pay-due')}. This customer gets a staff-meal discount.`, 2200);
  await tap('discount-open', 700);
  await type('discount-value', '10', 500);
  await cap('10% is within the 15% limit. A reason is required.', 1800);
  await tap(page.locator('[data-testid="discount-reason-pick"]').filter({ hasText: 'Staff meal' }), 600);
  await cap(`Due drops to ₹${await text('pay-due')} — the discount is taken before GST.`, 2800);
  await tap('cash-exact', 500).catch(() => {});
  await tap('confirm-pay', 1200);
  await T('receipt-no').waitFor();
  await cap("The receipt records the discount and its reason for the manager's reports.", 2800);
  await tap('new-sale', 800);

  // ── Scene 5: Refund ─────────────────────────────────────────────────────
  await scene('5 · Refund', 'wrong item served — give the money back');
  await tap('tab-orders', 800);
  await cap("Orders lists today's bills. Find the one to refund.", 1800);
  await tap(T('recent-receipt').first().getByTestId('refund'), 900);
  await cap(`The dialog says what is paid back: ${await text('refund-payout')}.`, 2800);
  await tap(page.locator('[data-testid="refund-reason-pick"]').filter({ hasText: 'Wrong item served' }), 700);
  await cap('A reason and the staff PIN are required. Nothing is refunded without both.', 2400);
  await type('refund-pin', PIN, 700);
  await tap('refund-go', 1200);
  await T('refund-slip-text').waitFor({ timeout: 10000 });
  await cap('Refund slip: the bill, the amount and the reason.', 2800);
  await tap('refund-slip-done', 900);
  await cap('The bill is now marked Refunded and cannot be refunded twice.', 2800);
  await cap('That is the day: setup, billing, hold, discount and refund.', 3000);
} catch (e) {
  console.error('FAILED:', e.message.split('\n')[0]);
  await page.screenshot({ path: `${out}/shots/failure.png` }).catch(() => {});
  process.exitCode = 1;
}

fs.writeFileSync(`${out}/taps.txt`, tapLog.join('\n'));
const video = page.video();
await ctx.close();
fs.copyFileSync(await video.path(), `${out}/taste-pos-demo.webm`);
await browser.close();
console.log('video:', `${out}/taste-pos-demo.webm`);
