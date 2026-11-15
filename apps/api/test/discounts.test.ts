// Bill discounts through push and ingest, against a real Postgres (docs/discounts-plan.md). A discount is part of the
// sale (whole sale) or of the payment (running order); the server refuses arithmetic that is not true and only flags a
// discount over the cap in force.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, totals, paise, type CartLine, type DiscountRule, type TradingSettings } from '@pos/shared';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const PIN = '482913';
const DATE = '2026-05-22'; // a day no other suite closes
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
interface Env { eventId: string; seq: number; createdAt: string; payload: any }
interface Res { eventId: string; status: string; reason?: string }
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const statuses = (r: Res[]) => r.map((x) => (x.reason ? `${x.status}:${x.reason}` : x.status));
type Discount = DiscountRule & { reason: string };

/** Tenant A's selling rules as they are now (another suite may have changed them and put them back). */
async function rules(): Promise<TradingSettings> {
  const r = await withTenant(A, async (c) => (await c.query('SELECT gst_rounding, bill_round_to, discount_max_bp FROM tenant_setting')).rows[0]);
  return { ...DEFAULT_SETTINGS, gstRounding: r.gst_rounding, billRoundTo: r.bill_round_to, discountMaxBp: r.discount_max_bp };
}

class Tab {
  seq = 0;
  receipt = Date.now() % 100_000;
  constructor(readonly app: App, readonly cred: string, readonly deviceId: string, readonly outletId: string,
              readonly cashierId: string, readonly teaId: string, readonly coffeeId: string, readonly tableId: string) {}

  static async enrol(app: App): Promise<Tab> {
    const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token as string;
    const o = await withTenant(A, async (c) => (await c.query(
      `SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id,
              (SELECT id FROM dining_table WHERE outlet_id = o.id AND is_default AND deleted_at IS NULL) AS table_id
         FROM outlet o WHERE o.name = 'School 1 Canteen'`)).rows[0]);
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
    const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
    const id = (sql: string) => withTenant(A, async (c) => (await c.query(sql)).rows[0].id as string);
    return new Tab(app, cred, cred.split('.')[1]!, o.id, await id("SELECT id FROM app_user WHERE name = 'School 1 Canteen cashier'"),
      await id("SELECT id FROM item WHERE name = 'Tea'"), await id("SELECT id FROM item WHERE name = 'Cold Coffee'"), o.table_id);
  }
  ev(payload: unknown): Env { return { eventId: crypto.randomUUID(), seq: ++this.seq, createdAt: new Date().toISOString(), payload }; }
  /** 2 x Tea at 5% and 1 x Cold Coffee at 18%: mixed rates, so the split and the per-line rounding both matter. */
  cart(): CartLine[] {
    return [
      { itemId: this.teaId, name: 'Tea', unitPaise: paise(1015), gstRateBp: 500, qty: 2 },
      { itemId: this.coffeeId, name: 'Cold Coffee', unitPaise: paise(6033), gstRateBp: 1800, qty: 1 },
    ];
  }
  /** A whole sale with `discount`, priced by the shared rule, and its payment. */
  async sale(discount: Discount | null, o: { shiftId?: string; method?: 'cash' | 'upi' } = {}) {
    const t = totals(this.cart(), await rules(), discount);
    const saleId = crypto.randomUUID();
    const created = this.ev({
      type: 'sale.created', schemaVersion: 1, saleId, channel: 'counter', createdBy: this.cashierId, businessDate: DATE,
      createdAtDevice: new Date().toISOString(), menuVersion: 1,
      lines: t.lines.map((l) => ({ itemId: l.itemId, name: l.name, unitPaise: l.unitPaise, gstRateBp: l.gstRateBp, qty: l.qty, netPaise: l.net, discountPaise: l.discount, taxPaise: l.tax })),
      subtotalPaise: t.subtotal, discount, discountPaise: t.discount, taxPaise: t.tax, roundOffPaise: t.roundOff, totalPaise: t.total,
    });
    const n = ++this.receipt;
    const cash = (o.method ?? 'cash') === 'cash';
    const paid = this.ev({
      type: 'payment.taken', schemaVersion: 1, saleId, ...(o.shiftId ? { shiftId: o.shiftId } : {}), businessDate: DATE,
      receiptNo: `C1-${DATE.replaceAll('-', '')}-${n}`, receiptSeq: n,
      payments: [{ method: o.method ?? 'cash', amountPaise: t.total, tenderedPaise: cash ? t.total : null, changePaise: 0, upiRef: null }],
    });
    return { saleId, created, paid, t };
  }
  pay(saleId: string, lines: { lineId: string; qty: number; discountPaise?: number }[], totalPaise: number, discount: Discount | null) {
    const n = ++this.receipt;
    return this.ev({ type: 'payment.taken', schemaVersion: 2, saleId, businessDate: DATE, receiptNo: `C1-${DATE.replaceAll('-', '')}-${n}`, receiptSeq: n,
      payments: [{ method: 'cash', amountPaise: totalPaise, tenderedPaise: totalPaise, changePaise: 0, upiRef: null }], lines, discount, totalPaise });
  }
  async push(events: Env[]): Promise<Res[]> {
    const r = await this.app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${this.cred}` }, payload: { events } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().results;
  }
}

const saleRow = (id: string) => withTenant(A, async (c) => (await c.query(
  `SELECT status, flags, subtotal_paise::int AS subtotal, discount_paise::int AS discount, discount_bp, discount_reason AS reason,
          tax_paise::int AS tax, round_off_paise::int AS "roundOff", total_paise::int AS total FROM sale WHERE id = $1`, [id])).rows[0]);
const lineRows = (id: string) => withTenant(A, async (c) => (await c.query(
  `SELECT line_id, line_total_paise::int AS net, discount_paise::int AS discount, tax_paise::int AS tax
     FROM sale_line WHERE sale_id = $1 AND removed_at IS NULL`, [id])).rows);

test('a discounted whole sale is applied: the sale, its lines\' shares and GST, the payment', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const s = await t.sale({ kind: 'percent', value: 500, reason: 'Staff meal' }); // 5%, under the seeded 10% cap
  assert.deepEqual(statuses(await t.push([s.created, s.paid])), ['applied', 'applied']);
  const row = await saleRow(s.saleId);
  assert.deepEqual({ ...row, flags: row.flags.filter((f: string) => f !== 'sold_unavailable') }, {
    status: 'paid', flags: [], subtotal: s.t.subtotal, discount: s.t.discount, discount_bp: 500, reason: 'Staff meal',
    tax: s.t.tax, roundOff: s.t.roundOff, total: s.t.total,
  });
  assert.equal(s.t.discount, 403); // 5% of 80.63, half up
  const lines = (await lineRows(s.saleId)).sort((a, b) => a.net - b.net);
  // 101.46 and 301.54, the paisa left over to the larger remainder: 101 + 302 = 403; GST on 19.29 and 57.31.
  assert.deepEqual(lines.map((l) => [l.net, l.discount, l.tax]), s.t.lines.map((l) => [l.net, l.discount, l.tax]));
  assert.deepEqual(lines.map((l) => l.discount), [101, 302]);
  const paid = await withTenant(A, async (c) => (await c.query('SELECT sum(amount_paise)::int AS n FROM payment WHERE sale_id = $1', [s.saleId])).rows[0].n);
  assert.equal(paid, s.t.total);

  // A flat amount: no percentage is stored.
  const f = await t.sale({ kind: 'amount', value: 250, reason: 'Late order' });
  assert.deepEqual(statuses(await t.push([f.created, f.paid])), ['applied', 'applied']);
  const fr = await saleRow(f.saleId);
  assert.deepEqual([fr.discount, fr.discount_bp, fr.reason], [250, null, 'Late order']);
});

test('discount arithmetic that is not true is rejected with a reason; nothing is written', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const bad = async (mutate: (p: any) => void, reason: string) => {
    const s = await t.sale({ kind: 'percent', value: 500, reason: 'Staff meal' });
    mutate(s.created.payload);
    assert.deepEqual(statuses(await t.push([s.created])), [`rejected:${reason}`], reason);
    assert.equal(await saleRow(s.saleId), undefined, `${reason}: nothing written`);
  };
  // A share moved from one line to the other: the bill still adds up, the split does not.
  await bad((p) => { p.lines[0].discountPaise += 1; p.lines[1].discountPaise -= 1; }, 'line_discount_mismatch');
  // GST on the gross line instead of the discounted one.
  await bad((p) => {
    const gross = Math.floor((p.lines[0].netPaise * 500 + 5000) / 10000);
    p.totalPaise += gross - p.lines[0].taxPaise; p.taxPaise += gross - p.lines[0].taxPaise; p.lines[0].taxPaise = gross;
  }, 'line_tax_mismatch');
  // The discount amount does not match the percentage given.
  await bad((p) => { p.discountPaise += 1; p.totalPaise -= 1; p.lines[0].discountPaise += 1; }, 'discount_mismatch');
  // Nothing left to pay.
  await bad((p) => { p.discount = { kind: 'amount', value: p.subtotalPaise, reason: 'x' }; }, 'discount_invalid');
  // A discount needs a reason; a total that ignores the discount does not parse.
  await bad((p) => { p.discount.reason = ' '; }, 'invalid_payload');
  await bad((p) => { p.totalPaise += p.discountPaise; }, 'invalid_payload');
  // A discount amount with no discount.
  await bad((p) => { p.discount = null; }, 'invalid_payload');
});

test('a discount over the cap in force is accepted and flagged, never refused', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const cap = (await rules()).discountMaxBp;
  const over = await t.sale({ kind: 'percent', value: cap + 100, reason: 'Complaint' });
  const flat = await t.sale({ kind: 'amount', value: Math.ceil((t.cart().reduce((a, l) => a + l.unitPaise * l.qty, 0) * (cap + 1)) / 10000), reason: 'Complaint' });
  const within = await t.sale({ kind: 'percent', value: cap, reason: 'Complaint' });
  assert.deepEqual(statuses(await t.push([over, flat, within].flatMap((s) => [s.created, s.paid]))), Array(6).fill('applied'));
  assert.ok((await saleRow(over.saleId)).flags.includes('over_discount_cap'));
  assert.ok((await saleRow(flat.saleId)).flags.includes('over_discount_cap'));
  assert.ok(!(await saleRow(within.saleId)).flags.includes('over_discount_cap'));
});

test('a running-order payment with a discount: shares in the payment\'s line order, lines that came after undiscounted', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const tableId = await withTenant(A, async (c) => (await c.query(
    'INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, $3) RETURNING id', [A, t.outletId, `D${Math.random().toString(36).slice(2, 8)}`])).rows[0].id);
  const [s, l1, l2, l3] = Array.from({ length: 4 }, () => crypto.randomUUID()) as [string, string, string, string];
  const at = () => new Date().toISOString();
  const add = (lineId: string, unit: number, gst: number, qty: number) => t.ev({
    type: 'order.line_added', schemaVersion: 2, saleId: s, lineId, itemId: t.teaId, name: 'Tea', unitPaise: unit, gstRateBp: gst, qty, by: t.cashierId, at: at() });
  const opened = t.ev({ type: 'order.opened', schemaVersion: 2, saleId: s, tableId, createdBy: t.cashierId, businessDate: DATE, createdAtDevice: at(), menuVersion: 1 });
  // Two lines of equal net, so the paisa left over goes by the payment's order.
  assert.deepEqual(statuses(await t.push([opened, add(l1, 500, 500, 1), add(l2, 500, 1800, 1)])), Array(3).fill('applied'));

  const d: Discount = { kind: 'amount', value: 101, reason: 'Regular customer' };
  const order = [l2, l1]; // the cashier's screen listed l2 first
  const priced = totals(order.map((id) => ({ itemId: id, name: 'Tea', unitPaise: paise(500), gstRateBp: id === l1 ? 500 : 1800, qty: 1 })), await rules(), d);
  assert.deepEqual(priced.lines.map((l) => l.discount), [51, 50]);
  const paidLines = order.map((lineId, i) => ({ lineId, qty: 1, discountPaise: priced.lines[i]!.discount }));

  // Tampered: a share moved between lines; the discount left out of the payment; nothing left to pay.
  const moved = paidLines.map((l, i) => ({ ...l, discountPaise: l.discountPaise + (i === 0 ? -1 : 1) }));
  assert.deepEqual(statuses(await t.push([t.pay(s, moved, priced.total, d)])), ['rejected:payment_total_mismatch']);
  assert.deepEqual(statuses(await t.push([t.pay(s, paidLines, priced.total, null)])), ['rejected:payment_total_mismatch']);
  assert.deepEqual(statuses(await t.push([t.pay(s, paidLines, 1, { kind: 'amount', value: 1000, reason: 'x' })])), ['rejected:discount_invalid']);
  assert.equal((await saleRow(s)).status, 'open', 'refusals changed nothing');

  // A line added on another device before the payment arrived: it is split off, and carries no discount.
  assert.deepEqual(statuses(await t.push([add(l3, 700, 500, 1)])), ['applied']);
  assert.deepEqual(statuses(await t.push([t.pay(s, paidLines, priced.total, d)])), ['applied']);
  const row = await saleRow(s);
  assert.deepEqual([row.status, row.discount, row.discount_bp, row.reason, row.total], ['paid', 101, null, 'Regular customer', priced.total]);
  const lines = await lineRows(s);
  assert.deepEqual(Object.fromEntries(lines.map((l) => [l.line_id, [l.discount, l.tax]])), {
    [l2]: [51, priced.lines[0]!.tax], [l1]: [50, priced.lines[1]!.tax],
  });
  const split = await withTenant(A, async (c) => (await c.query(`SELECT id FROM sale WHERE order_root_id = $1 AND id <> $1`, [s])).rows[0].id as string);
  const sr = await saleRow(split);
  assert.deepEqual([sr.status, sr.discount, sr.reason], ['open', 0, null]);
  assert.deepEqual((await lineRows(split)).map((l) => [l.line_id, l.discount]), [[l3, 0]]);
});

test('an order payment over the cap is accepted and flagged', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const tableId = await withTenant(A, async (c) => (await c.query(
    'INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, $3) RETURNING id', [A, t.outletId, `D${Math.random().toString(36).slice(2, 8)}`])).rows[0].id);
  const s = crypto.randomUUID(), l = crypto.randomUUID();
  const at = new Date().toISOString();
  await t.push([
    t.ev({ type: 'order.opened', schemaVersion: 2, saleId: s, tableId, createdBy: t.cashierId, businessDate: DATE, createdAtDevice: at, menuVersion: 1 }),
    t.ev({ type: 'order.line_added', schemaVersion: 2, saleId: s, lineId: l, itemId: t.teaId, name: 'Tea', unitPaise: 2000, gstRateBp: 500, qty: 1, by: t.cashierId, at }),
  ]);
  const d: Discount = { kind: 'percent', value: (await rules()).discountMaxBp + 500, reason: 'Complaint' };
  const priced = totals([{ itemId: l, name: 'Tea', unitPaise: paise(2000), gstRateBp: 500, qty: 1 }], await rules(), d);
  assert.deepEqual(statuses(await t.push([t.pay(s, [{ lineId: l, qty: 1, discountPaise: priced.discount }], priced.total, d)])), ['applied']);
  assert.ok((await saleRow(s)).flags.includes('over_discount_cap'));
});

test('a refund of a discounted sale pays back what was paid, after the discount', async () => {
  const app = buildApp();
  const t = await Tab.enrol(app);
  const signIn = await app.inject({ method: 'POST', url: '/device/pin-signin', headers: { authorization: `Device ${t.cred}` }, payload: { userId: t.cashierId, pin: PIN } });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const shiftId = await withTenant(A, async (c) => (await c.query(
    `INSERT INTO shift (id, tenant_id, outlet_id, device_id, user_id, opened_at, opening_cash_paise) VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 0) RETURNING id`,
    [A, t.outletId, t.deviceId, t.cashierId])).rows[0].id as string);
  const s = await t.sale({ kind: 'percent', value: 800, reason: 'Staff meal' }, { shiftId, method: 'upi' });
  assert.deepEqual(statuses(await t.push([s.created, s.paid])), ['applied', 'applied']);
  const r = await app.inject({ method: 'POST', url: `/sales/${s.saleId}/refund`, headers: bearer(signIn.json().token), payload: { reason: 'wrong item', pin: PIN } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().refunds, [{ method: 'upi', amountPaise: s.t.total }]);
  assert.ok(s.t.discount > 0 && s.t.total === s.t.subtotal - s.t.discount + s.t.tax + s.t.roundOff, 'the discounted total');
  const row = await saleRow(s.saleId);
  assert.deepEqual([row.status, row.discount], ['refunded', s.t.discount]);
});
