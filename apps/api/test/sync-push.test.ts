// Push and ingest against a real Postgres. Each test enrols its own tablet(s), so tests do not share
// device sequence numbers or receipt numbers. The property under test (PLAN 7.10): after any
// sequence of faults and eventual connectivity, the cloud holds exactly what the cashiers did, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
interface Env { eventId: string; seq: number; createdAt: string; payload: any }
interface Res { eventId: string; status: string; reason?: string }

class Tablet {
  seq = 0;
  constructor(readonly app: App, readonly tenant: string, readonly cred: string, readonly deviceId: string, readonly outletId: string,
              readonly mgr: string, readonly cashierId: string, readonly teaId: string, readonly coffeeId: string) {}

  static async enrol(app: App, tenant: string, email: string, outletName: string): Promise<Tablet> {
    const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
    const o = await withTenant(tenant, async (c) =>
      (await c.query("SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id AND code = 'C1') AS counter_id FROM outlet o WHERE o.name = $1", [outletName])).rows[0]);
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: bearer(mgr), payload: { outletId: o.id, counterId: o.counter_id } })).json().code;
    const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
    const q = (sql: string, args: unknown[]) => withTenant(tenant, async (c) => (await c.query(sql, args)).rows[0].id as string);
    return new Tablet(app, tenant, cred, cred.split('.')[1]!, o.id, mgr,
      await q('SELECT id FROM app_user WHERE name = $1', [`${outletName} cashier`]),
      await q("SELECT id FROM item WHERE name = 'Tea'", []), await q("SELECT id FROM item WHERE name = 'Cold Coffee'", []));
  }

  event(payload: unknown, at = new Date().toISOString()): Env {
    return { eventId: crypto.randomUUID(), seq: ++this.seq, createdAt: at, payload };
  }

  /** A 2 x Tea sale at 10.00 + 5% GST = 21.00, and the payment for it. */
  sale(o: { date?: string; seq?: number; saleId?: string; itemId?: string; qty?: number; at?: string; createdBy?: string } = {}) {
    const saleId = o.saleId ?? crypto.randomUUID();
    const date = o.date ?? '2026-03-01';
    const qty = o.qty ?? 2;
    const net = 1000 * qty, tax = Math.floor((net * 500 + 5000) / 10000);
    const created = this.event({
      type: 'sale.created', schemaVersion: 1, saleId, channel: 'counter', createdBy: o.createdBy ?? this.cashierId, businessDate: date,
      createdAtDevice: o.at ?? new Date().toISOString(), menuVersion: 1,
      lines: [{ itemId: o.itemId ?? this.teaId, name: 'Tea', unitPaise: 1000, gstRateBp: 500, qty, netPaise: net, taxPaise: tax }],
      subtotalPaise: net, taxPaise: tax, roundOffPaise: 0, totalPaise: net + tax,
    }, o.at);
    const rseq = o.seq ?? 1;
    const paid = this.event({
      type: 'payment.taken', schemaVersion: 1, saleId, businessDate: date, receiptNo: `C1-${date.replaceAll('-', '')}-${rseq}`, receiptSeq: rseq,
      payments: [{ method: 'cash', amountPaise: net + tax, tenderedPaise: net + tax, changePaise: 0, upiRef: null }],
    }, o.at);
    return { saleId, created, paid, total: net + tax };
  }

  async push(events: Env[]): Promise<Res[]> {
    const r = await this.app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${this.cred}` }, payload: { events } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().results;
  }
  async tally() {
    return withTenant(this.tenant, async (c) => (await c.query(
      `SELECT (SELECT count(*)::int FROM sale WHERE device_id = $1) sales,
              (SELECT count(*)::int FROM sale WHERE device_id = $1 AND status = 'paid') paid,
              (SELECT count(*)::int FROM sale_line l JOIN sale s ON s.id = l.sale_id WHERE s.device_id = $1) lines,
              (SELECT COALESCE(sum(p.amount_paise), 0)::int FROM payment p JOIN sale s ON s.id = p.sale_id WHERE s.device_id = $1) takings,
              (SELECT count(*)::int FROM sync_event WHERE device_id = $1) ledger`, [this.deviceId])).rows[0]);
  }
  async saleRow(id: string) {
    return withTenant(this.tenant, async (c) => (await c.query('SELECT status, flags, receipt_no, business_date::text d, business_day_id, device_seq::int FROM sale WHERE id = $1', [id])).rows[0]);
  }
}
const statuses = (r: Res[]) => r.map((x) => x.status);

test('a sale and its payment are applied: paid, receipt, payment, lines, business day, ledger', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  assert.deepEqual(statuses(await t.push([s.created, s.paid])), ['applied', 'applied']);
  const row = await t.saleRow(s.saleId);
  assert.equal(row.status, 'paid');
  assert.equal(row.receipt_no, 'C1-20260301-1');
  assert.equal(row.d, '2026-03-01');
  assert.ok(row.business_day_id);
  assert.equal(row.device_seq, s.created.seq);
  assert.deepEqual(row.flags, []);
  assert.deepEqual(await t.tally(), { sales: 1, paid: 1, lines: 1, takings: s.total, ledger: 2 });
});

test('a retry after a lost response is a duplicate and changes nothing', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  await t.push([s.created, s.paid]); // the response is "lost"; the tablet sends it all again
  const again = await t.push([s.created, s.paid]);
  assert.deepEqual(statuses(again), ['duplicate', 'duplicate']);
  assert.deepEqual(await t.tally(), { sales: 1, paid: 1, lines: 1, takings: s.total, ledger: 2 });
});

test('the same batch pushed twice at once is applied once', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const sales = [t.sale({ seq: 1 }), t.sale({ seq: 2 }), t.sale({ seq: 3 })];
  const batch = sales.flatMap((s) => [s.created, s.paid]);
  const [r1, r2] = await Promise.all([t.push(batch), t.push(batch)]);
  const all = [...r1, ...r2].map((r) => r.status).sort();
  assert.equal(all.filter((s) => s === 'applied').length, 6);
  assert.equal(all.filter((s) => s === 'duplicate').length, 6);
  assert.deepEqual(await t.tally(), { sales: 3, paid: 3, lines: 3, takings: sales.reduce((a, s) => a + s.total, 0), ledger: 6 });
});

test('a payment that arrives before its sale is deferred, not lost, and applies once the sale arrives', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  assert.deepEqual(await t.push([s.paid]), [{ eventId: s.paid.eventId, status: 'deferred', reason: 'sale_not_yet_received' }]);
  assert.equal((await t.tally()).ledger, 0, 'a deferred event leaves no ledger row');
  assert.deepEqual(statuses(await t.push([s.created])), ['applied']);
  assert.deepEqual(statuses(await t.push([s.paid])), ['applied']);
  assert.equal((await t.tally()).paid, 1);
});

test('a batch in the wrong order is replayed in device order', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  assert.deepEqual(statuses(await t.push([s.paid, s.created])), ['applied', 'applied']);
  assert.equal((await t.saleRow(s.saleId)).status, 'paid');
});

test('sales that cannot be true are rejected with a reason, and the rejection is remembered', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const bad = async (mutate: (p: any) => void, reason: string) => {
    const s = t.sale();
    mutate(s.created.payload);
    const [r] = await t.push([s.created]);
    assert.deepEqual([r!.status, r!.reason], ['rejected', reason]);
    assert.equal(await t.saleRow(s.saleId), undefined, `${reason}: nothing written`);
    assert.deepEqual((await t.push([s.created]))[0], { eventId: s.created.eventId, status: 'rejected', reason }, 'sticky');
    return s;
  };
  await bad((p) => { p.lines[0].netPaise += 1; p.subtotalPaise += 1; p.totalPaise += 1; }, 'line_net_mismatch');
  await bad((p) => { p.lines[0].taxPaise += 1; p.taxPaise += 1; p.totalPaise += 1; }, 'line_tax_mismatch');
  await bad((p) => { p.subtotalPaise += 5; p.totalPaise += 5; }, 'subtotal_mismatch');
  await bad((p) => { p.taxPaise += 5; p.totalPaise += 5; }, 'tax_mismatch');
  await bad((p) => { p.roundOffPaise = 60; p.totalPaise += 60; }, 'round_off_too_large');
  await bad((p) => { p.channel = 'zomato'; }, 'channel_not_allowed');
  await bad((p) => { p.createdBy = crypto.randomUUID(); }, 'unknown_user');
  await bad((p) => { p.lines[0].itemId = crypto.randomUUID(); }, 'unknown_item');
  await bad((p) => { delete p.lines; }, 'invalid_payload');
  const refused = await bad((p) => { p.channel = 'swiggy'; }, 'channel_not_allowed');
  // A payment for a refused sale is refused too, rather than waiting forever.
  const pay = t.sale({ saleId: refused.saleId });
  assert.deepEqual((await t.push([pay.paid]))[0]!.reason, 'sale_rejected');
});

test('payments that do not cover the total, a wrong receipt number and a second payment are rejected', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  await t.push([s.created]);
  const short = structuredClone(s.paid); short.eventId = crypto.randomUUID(); short.seq = ++t.seq;
  short.payload.payments[0].amountPaise -= 100; short.payload.payments[0].tenderedPaise -= 100;
  assert.equal((await t.push([short]))[0]!.reason, 'payments_not_total');
  const wrongNo = structuredClone(s.paid); wrongNo.eventId = crypto.randomUUID(); wrongNo.seq = ++t.seq;
  wrongNo.payload.receiptNo = 'C9-20260301-1';
  assert.equal((await t.push([wrongNo]))[0]!.reason, 'bad_receipt_no');
  assert.equal((await t.saleRow(s.saleId)).status, 'open', 'rejections changed nothing');
  assert.deepEqual(statuses(await t.push([s.paid])), ['applied']);
  const twice = structuredClone(s.paid); twice.eventId = crypto.randomUUID(); twice.seq = ++t.seq;
  assert.equal((await t.push([twice]))[0]!.reason, 'already_paid');
  assert.equal((await t.tally()).takings, s.total, 'paid exactly once');
});

test('two sales claiming the same receipt number: the second is rejected by the database', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s1 = t.sale({ seq: 1 }), s2 = t.sale({ seq: 1 });
  const r = await t.push([s1.created, s1.paid, s2.created, s2.paid]);
  assert.deepEqual(statuses(r), ['applied', 'applied', 'applied', 'rejected']);
  assert.match(r[3]!.reason!, /^database:sale_receipt_uq$/);
  assert.equal((await t.saleRow(s2.saleId)).status, 'open');
});

test('policy differences are accepted and flagged, never thrown away', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  // Over the per-item cap (default 99) but arithmetically true.
  const big = t.sale({ qty: 150 });
  // Cold Coffee is out of stock at every seeded outlet.
  const oos = t.sale({ itemId: t.coffeeId, seq: 2 });
  // Rung up 10 minutes in the future by a wrong device clock.
  const skew = t.sale({ at: new Date(Date.now() + 10 * 60_000).toISOString(), seq: 3 });
  // GST rounded DOWN where the tenant's setting is half-up: 3 x 5.10 at 5% = 0.765 -> 76 (down) vs 77 (half-up).
  const odd = t.sale({ seq: 4 });
  const line = odd.created.payload.lines[0];
  Object.assign(line, { unitPaise: 510, qty: 3, netPaise: 1530, taxPaise: 76 });
  Object.assign(odd.created.payload, { subtotalPaise: 1530, taxPaise: 76, totalPaise: 1606 });
  odd.paid.payload.payments[0] = { method: 'cash', amountPaise: 1606, tenderedPaise: 1606, changePaise: 0, upiRef: null };
  const r = await t.push([big, oos, skew, odd].flatMap((s) => [s.created, s.paid]));
  assert.deepEqual(statuses(r), Array(8).fill('applied'), JSON.stringify(r));
  assert.deepEqual((await t.saleRow(big.saleId)).flags, ['over_qty_cap']);
  assert.deepEqual((await t.saleRow(oos.saleId)).flags, ['sold_unavailable']);
  assert.deepEqual((await t.saleRow(skew.saleId)).flags, ['clock_ahead']);
  assert.deepEqual((await t.saleRow(odd.saleId)).flags, ['settings_differ']);
});

test('unknown event types and future schema versions are turned away without being recorded', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  const future = structuredClone(s.created); future.payload.schemaVersion = 2;
  const odd = t.event({ type: 'shift.opened', schemaVersion: 1 });
  const r = await t.push([future, odd]);
  assert.deepEqual(r.map((x) => x.reason), ['unsupported_schema_version', 'unknown_event_type']);
  assert.equal((await t.tally()).ledger, 0);
  // A device cannot reuse a sequence number for a different event.
  await t.push([s.created]);
  const clash = t.sale(); clash.created.seq = s.created.seq;
  assert.equal((await t.push([clash.created]))[0]!.reason, 'seq_reused');
});

test('malformed requests are refused outright', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const post = (payload: unknown, auth = `Device ${t.cred}`) => app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: auth }, payload: payload as any });
  assert.equal((await post({ events: [] })).statusCode, 400);
  assert.equal((await post({ events: [{ eventId: 'nope', seq: 1, createdAt: 'x', payload: {} }] })).statusCode, 400);
  assert.equal((await post({ events: [t.sale().created], tenantId: B })).statusCode, 400, 'unknown keys are refused');
  assert.equal((await post({ events: Array.from({ length: 101 }, () => t.sale().created) })).statusCode, 400);
  assert.equal((await post({ events: [t.sale().created] }, 'Device nonsense')).statusCode, 401);
  const staff = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(A) }, payload: { email: 'a1@example.test', password: 'dev-password-123' } })).json().token;
  assert.equal((await post({ events: [t.sale().created] }, `Bearer ${staff}`)).statusCode, 403, 'a manager session is not a device');
});

test('a revoked tablet still delivers what it did before revocation, and nothing after', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const before = t.sale({ seq: 1, at: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal((await app.inject({ method: 'POST', url: `/devices/${t.deviceId}/revoke`, headers: bearer(t.mgr) })).statusCode, 200);
  const after = t.sale({ seq: 2, at: new Date(Date.now() + 3600_000).toISOString() });
  const r = await t.push([before.created, before.paid, after.created]);
  assert.deepEqual(r.map((x) => [x.status, x.reason]), [['applied', undefined], ['applied', undefined], ['rejected', 'after_revocation']]);
  assert.equal((await t.saleRow(before.saleId)).status, 'paid');
  assert.equal(await t.saleRow(after.saleId), undefined);
  const pull = await app.inject({ method: 'GET', url: '/sync/pull?cursor=0', headers: { authorization: `Device ${t.cred}` } });
  assert.equal(pull.statusCode, 401, 'revocation still ends everything but push');
  const alert = await withTenant(A, async (c) => (await c.query("SELECT count(*)::int n FROM audit WHERE action = 'sync.from_revoked_device' AND actor_id = $1", [t.deviceId])).rows[0].n);
  assert.equal(alert, 2, 'the manager can see that a revoked tablet delivered');
});

test('tenants are isolated: another tenant cannot touch a sale or reuse an event id as "seen"', async () => {
  const app = buildApp();
  const a = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const b = await Tablet.enrol(app, B, 'b1@example.test', 'Main Canteen');
  const s = a.sale();
  await a.push([s.created]);
  // B's tablet sends a payment for A's sale, and a "sale" reusing A's sale id and A's event id.
  const steal = b.sale({ saleId: s.saleId });
  const stolenPay = (await b.push([{ ...steal.paid, seq: 1 }]))[0]!;
  assert.equal(stolenPay.status, 'deferred', 'B cannot see A\'s sale');
  const replay = { ...steal.created, eventId: s.created.eventId, seq: 2 };
  const r = (await b.push([replay]))[0]!;
  assert.notEqual(r.status, 'duplicate', 'A\'s event id is not "already seen" for B');
  assert.equal((await a.saleRow(s.saleId)).status, 'open', 'A\'s sale untouched');
  assert.equal((await a.tally()).ledger, 1);
});

test('one tablet cannot pay another tablet\'s sale', async () => {
  const app = buildApp();
  const t1 = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const t2 = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t1.sale();
  await t1.push([s.created]);
  const pay = t2.sale({ saleId: s.saleId });
  assert.equal((await t2.push([pay.paid]))[0]!.reason, 'wrong_device');
  // Nor can it claim tablet 1's event as already seen.
  const clone = t2.sale();
  assert.deepEqual((await t2.push([{ ...clone.created, eventId: s.created.eventId }]))[0], { eventId: s.created.eventId, status: 'rejected', reason: 'event_id_conflict' });
  assert.equal((await t1.saleRow(s.saleId)).status, 'open');
});

test('the tablet receives the outlet\'s address and FSSAI number in pull', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  let cursor = 0, outlet: any;
  for (let page = 0; page < 50 && !outlet; page++) { // the outlet row may not be on the first page
    const j = (await app.inject({ method: 'GET', url: `/sync/pull?cursor=${cursor}`, headers: { authorization: `Device ${t.cred}` } })).json();
    outlet = j.changes.find((c: any) => c.type === 'outlet');
    cursor = j.cursor;
    if (!j.hasMore) break;
  }
  assert.ok(outlet, 'the outlet row is in the pull');
  assert.equal(outlet.data.address, 'School 1 Canteen, 12 Station Road, Pune 411001');
  assert.equal(outlet.data.fssaiNo, '11516034000797');
});

test('a reprint of a paid receipt is recorded with who and when; of anything else it is refused or waits', async () => {
  const app = buildApp();
  const t1 = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const t2 = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const reprint = (t: Tablet, saleId: string, by = t.cashierId) =>
    t.event({ type: 'print.reprinted', schemaVersion: 1, saleId, reprintedBy: by, at: new Date().toISOString() });
  const s = t1.sale();
  await t1.push([s.created]);
  assert.equal((await t1.push([reprint(t1, s.saleId)]))[0]!.reason, 'not_paid', 'an unpaid order has no receipt');
  await t1.push([s.paid]);
  assert.deepEqual(statuses(await t1.push([reprint(t1, s.saleId)])), ['applied']);
  const trail = () => withTenant(A, async (c) => (await c.query(
    "SELECT actor_id, detail->>'receiptNo' receipt FROM audit WHERE action = 'sale.reprinted' AND entity_id = $1", [s.saleId])).rows);
  assert.deepEqual(await trail(), [{ actor_id: t1.cashierId, receipt: 'C1-20260301-1' }]);
  const again = reprint(t1, s.saleId);
  await t1.push([again]); await t1.push([again]); // a retry does not add a second trail entry
  assert.equal((await trail()).length, 2);
  assert.equal((await t1.push([reprint(t1, s.saleId, crypto.randomUUID())]))[0]!.reason, 'unknown_user');
  assert.equal((await t2.push([reprint(t2, s.saleId)]))[0]!.reason, 'wrong_device');
  assert.equal((await t1.push([reprint(t1, crypto.randomUUID())]))[0]!.status, 'deferred');
});

test('an order saved before midnight and paid after takes the payment\'s date for its receipt', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale({ date: '2026-03-03' });
  s.paid.payload.businessDate = '2026-03-04';
  s.paid.payload.receiptNo = 'C1-20260304-1';
  assert.deepEqual(statuses(await t.push([s.created, s.paid])), ['applied', 'applied']);
  const row = await t.saleRow(s.saleId);
  assert.equal(row.d, '2026-03-04');
  assert.equal(row.receipt_no, 'C1-20260304-1');
});

test('the ledger is append-only for the app role', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const s = t.sale();
  await t.push([s.created]);
  for (const sql of ["UPDATE sync_event SET outcome = 'rejected', reason = 'x'", 'DELETE FROM sync_event']) {
    await assert.rejects(withTenant(A, (c) => c.query(sql)), /permission denied/, sql);
  }
});

test('a closed day takes a late arrival and flags it; the day stays closed', async () => {
  const app = buildApp();
  const t = await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen');
  const date = '2026-03-02';
  await withTenant(A, (c) => c.query("INSERT INTO business_day (tenant_id, outlet_id, date, closed_at) VALUES ($1, $2, $3, now()) ON CONFLICT (outlet_id, date) DO UPDATE SET closed_at = now()", [A, t.outletId, date]));
  const s = t.sale({ date });
  assert.deepEqual(statuses(await t.push([s.created])), ['applied']);
  assert.deepEqual((await t.saleRow(s.saleId)).flags, ['late_arrival'], 'flagged when the sale arrives, before any payment');
  assert.deepEqual(statuses(await t.push([s.paid])), ['applied']);
  assert.deepEqual((await t.saleRow(s.saleId)).flags, ['late_arrival'], 'and not flagged twice');
  const closed = await withTenant(A, async (c) => (await c.query('SELECT closed_at IS NOT NULL c FROM business_day WHERE outlet_id = $1 AND date = $2', [t.outletId, date])).rows[0].c);
  assert.equal(closed, true);
});

test('two tablets selling at once, with faults, add up to exactly what was rung up', async () => {
  const app = buildApp();
  const tablets = [await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen'), await Tablet.enrol(app, A, 'a1@example.test', 'School 1 Canteen')];
  // A small deterministic generator so a failure can be replayed.
  let x = 12345;
  const rnd = (n: number) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  const owed = tablets.map((t) => {
    const sales = Array.from({ length: 8 }, (_, i) => t.sale({ seq: i + 1, qty: 1 + rnd(5) }));
    return { t, sales, events: sales.flatMap((s) => [s.created, s.paid]) };
  });
  const pending = owed.map((o) => new Set(o.events.map((e) => e.eventId)));
  for (let round = 0; round < 40 && pending.some((p) => p.size); round++) {
    await Promise.all(owed.map(async (o, i) => {
      // Random subset, shuffled, with duplicates; the "response" is dropped half the time.
      const pick = o.events.filter(() => rnd(3) > 0);
      pick.push(...pick.filter(() => rnd(4) === 0));
      pick.sort(() => rnd(3) - 1);
      if (!pick.length) return;
      for (let k = 0; k < pick.length; k += 7) {
        const results = await o.t.push(pick.slice(k, k + 7));
        if (rnd(2)) for (const r of results) if (r.status === 'applied' || r.status === 'duplicate') pending[i]!.delete(r.eventId);
      }
    }));
  }
  // Connectivity returns: everything still owed is sent in order until the tablet is told it is done.
  for (const [i, o] of owed.entries()) {
    for (const r of await o.t.push(o.events)) if (r.status === 'applied' || r.status === 'duplicate') pending[i]!.delete(r.eventId);
    assert.equal(pending[i]!.size, 0);
    assert.deepEqual(await o.t.tally(), { sales: 8, paid: 8, lines: 8, takings: o.sales.reduce((a, s) => a + s.total, 0), ledger: 16 });
  }
});
