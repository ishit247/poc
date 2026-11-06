// The open-orders pull (phase 12 step 7, "12b"), against a real Postgres. What other devices rely on:
// a device sees every open table visit of its OWN outlet, whole (all applied order events and the lines closed sales
// took), and nothing of another outlet or tenant; the cursor never skips a change, including one that commits late;
// a visit that closes is sent once as closed; a split (late lines) is sent with its new open sale; the stream nudges
// the outlet's devices, and only them.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { foldOrder, liveLines, openLines, type OrderEnvelope } from '@pos/shared';
import { hostFor } from './hosts.js';
import { buildApp } from '../src/app.js';
import { pool, withTenant } from '../src/db.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
test.after(() => pool.end());

type App = ReturnType<typeof buildApp>;
interface Env { eventId: string; seq: number; createdAt: string; payload: any }
interface Res { eventId: string; status: string; reason?: string }
interface Visit {
  rootId: string; version: number; sales: { id: string; status: string; deviceId: string }[];
  open: null | { saleId: string; deviceId: string; closed: { lineId: string; qty: number; removed: boolean }[]; events: OrderEnvelope[] };
}
const DATE = '2026-05-22'; // a day no other suite closes

let clock = Date.now() - 3_600_000;
const tick = () => new Date((clock += 1000)).toISOString();
const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

class Tab {
  seq = 0;
  receipt = 0;
  constructor(readonly app: App, readonly tenant: string, readonly cred: string, readonly deviceId: string, readonly outletId: string,
              readonly waiterId: string, readonly teaId: string, readonly tableId: string) {}

  static async enrol(app: App, o: { tenant?: string; email?: string; outlet?: string } = {}): Promise<Tab> {
    const tenant = o.tenant ?? A, email = o.email ?? 'a1@example.test', outletName = o.outlet ?? 'School 1 Canteen';
    const mgr = (await app.inject({ method: 'POST', url: '/login', headers: { host: hostFor(tenant) }, payload: { email, password: 'dev-password-123' } })).json().token as string;
    const out = await withTenant(tenant, async (c) =>
      (await c.query(`SELECT o.id, (SELECT id FROM counter WHERE outlet_id = o.id ORDER BY code LIMIT 1) AS counter_id
                        FROM outlet o WHERE o.name = $1`, [outletName])).rows[0]);
    // A table of this suite's own: the visits it leaves open must not sit on the default table other suites use.
    out.table_id = await withTenant(tenant, async (c) => (await c.query(
      'INSERT INTO dining_table (tenant_id, outlet_id, code) VALUES ($1, $2, $3) RETURNING id', [tenant, out.id, `P${Math.random().toString(36).slice(2, 8)}`])).rows[0].id);
    const code = (await app.inject({ method: 'POST', url: '/enrolment-codes', headers: { authorization: `Bearer ${mgr}` }, payload: { outletId: out.id, counterId: out.counter_id } })).json().code;
    const cred = (await app.inject({ method: 'POST', url: '/enrol', payload: { code } })).json().credential as string;
    const one = (sql: string, args: unknown[]) => withTenant(tenant, async (c) => (await c.query(sql, args)).rows[0].id as string);
    return new Tab(app, tenant, cred, cred.split('.')[1]!, out.id,
      await one('SELECT id FROM app_user WHERE name = $1', [`${outletName} waiter`]),
      await one("SELECT id FROM item WHERE deleted_at IS NULL ORDER BY name LIMIT 1", []), out.table_id);
  }

  ev(payload: unknown): Env { return { eventId: crypto.randomUUID(), seq: ++this.seq, createdAt: new Date().toISOString(), payload }; }
  open(saleId: string) {
    return this.ev({ type: 'order.opened', schemaVersion: 2, saleId, tableId: this.tableId, createdBy: this.waiterId, businessDate: DATE, createdAtDevice: tick(), menuVersion: 1 });
  }
  add(saleId: string, lineId: string, qty: number) {
    return this.ev({ type: 'order.line_added', schemaVersion: 2, saleId, lineId, itemId: this.teaId, name: 'Tea', unitPaise: 1000, gstRateBp: 500, qty, by: this.waiterId, at: tick() });
  }
  change(saleId: string, lineId: string, qty: number) {
    return this.ev({ type: 'order.line_changed', schemaVersion: 2, saleId, lineId, qty, by: this.waiterId, at: tick() });
  }
  /** Pays the open sale for exactly these lines, at the total the server holds for them. */
  async payFor(saleId: string, lines: [string, number][]): Promise<Env> {
    const total = await withTenant(this.tenant, async (c) => Number((await c.query('SELECT total_paise FROM sale WHERE id = $1', [saleId])).rows[0].total_paise));
    const n = ++this.receipt;
    return this.ev({ type: 'payment.taken', schemaVersion: 2, saleId, businessDate: DATE, receiptNo: `C1-${DATE.replaceAll('-', '')}-${n}`, receiptSeq: n,
      payments: [{ method: 'cash', amountPaise: total, tenderedPaise: total, changePaise: 0, upiRef: null }],
      lines: lines.map(([lineId, qty]) => ({ lineId, qty })), totalPaise: total });
  }
  async push(events: Env[]): Promise<string[]> {
    const r = await this.app.inject({ method: 'POST', url: '/sync/push', headers: { authorization: `Device ${this.cred}` }, payload: { events } });
    assert.equal(r.statusCode, 200, r.body);
    return (r.json().results as Res[]).map((x) => (x.reason ? `${x.status}:${x.reason}` : x.status));
  }
  async page(cursor: number, fresh = false): Promise<{ cursor: number; hasMore: boolean; visits: Visit[] }> {
    const r = await this.app.inject({ method: 'GET', url: `/sync/orders?cursor=${cursor}${fresh ? '&fresh=1' : ''}`, headers: { authorization: `Device ${this.cred}` } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  /** Every page from `cursor` on (a first pass, `fresh`, from 0); the last cursor and the visits by root (a later page's copy wins). */
  async pullAll(cursor = 0, fresh = cursor === 0): Promise<{ cursor: number; visits: Map<string, Visit> }> {
    const visits = new Map<string, Visit>();
    for (;;) {
      const p = await this.page(cursor, fresh);
      for (const v of p.visits) visits.set(v.rootId, v);
      assert.ok(p.cursor >= cursor, 'the cursor never goes back');
      cursor = p.cursor;
      if (!p.hasMore) return { cursor, visits };
    }
  }
}

/** What a tablet would show for a pulled visit: the shared fold of its events, less what closed sales took. */
function shown(v: Visit): [string, number][] {
  const fold = foldOrder(v.rootId, v.open!.events.map((e) => ({ ...e, payload: { ...e.payload, saleId: v.rootId } })));
  return liveLines({ ...fold, lines: openLines(fold, v.open!.closed) })
    .map((l) => [l.lineId, l.qty] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function serverLines(saleId: string): Promise<[string, number][]> {
  return withTenant(A, async (c) => (await c.query(
    'SELECT line_id, qty FROM sale_line WHERE sale_id = $1 AND removed_at IS NULL ORDER BY line_id', [saleId])).rows.map((r) => [r.line_id, r.qty]));
}

test('a second device of the outlet pulls an open visit whole, and its fold is the server\'s open sale', async () => {
  const app = buildApp();
  const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
  const [s, l1, l2] = ids(3);
  assert.deepEqual(await x.push([x.open(s!), x.add(s!, l1!, 1), x.add(s!, l2!, 2)]), ['applied', 'applied', 'applied']);

  const { cursor, visits } = await y.pullAll();
  const v = visits.get(s!);
  assert.ok(v?.open, 'the other device\'s open order is in the pull');
  assert.equal(v.open.saleId, s);
  assert.equal(v.open.deviceId, x.deviceId, 'who may take payment for it');
  assert.equal(v.open.events.length, 3);
  assert.ok(v.open.events.every((e) => e.deviceId === x.deviceId && Number.isInteger(e.seq)));
  assert.deepEqual(v.open.closed, []);
  assert.deepEqual(shown(v), await serverLines(s!));

  // A rejected event is in the ledger, never in the visit: the fold must hold only what the server applied.
  const stranger = x.change(s!, l1!, 9);
  stranger.payload.by = crypto.randomUUID();
  assert.deepEqual(await x.push([stranger]), ['rejected:unknown_user']);
  assert.equal((await y.pullAll()).visits.get(s!)!.open!.events.length, 3, 'rejected events are not sent');

  // Nothing new: nothing sent. A change: the whole visit again, at a higher version.
  assert.deepEqual((await y.page(cursor)).visits, []);
  assert.deepEqual(await x.push([x.change(s!, l1!, 4)]), ['applied']);
  const next = await y.page(cursor);
  assert.deepEqual(next.visits.map((w) => w.rootId), [s]);
  assert.ok(next.visits[0]!.version > cursor);
  assert.equal(next.visits[0]!.open!.events.length, 4);
  assert.deepEqual(shown(next.visits[0]!), await serverLines(s!));
});

test('a visit that closes is sent once as closed, and a fresh device never sees it', async () => {
  const app = buildApp();
  const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
  const [s, l1] = ids(2);
  await x.push([x.open(s!), x.add(s!, l1!, 1)]);
  const before = await y.pullAll();
  assert.ok(before.visits.get(s!)?.open);

  assert.deepEqual(await x.push([await x.payFor(s!, [[l1!, 1]])]), ['applied']);
  const after = await y.page(before.cursor);
  const v = after.visits.find((w) => w.rootId === s);
  assert.ok(v, 'the closing is sent');
  assert.equal(v.open, null);
  assert.deepEqual(v.sales.map((z) => z.status), ['paid']);
  // Enough open visits that a first pass spans pages: the closed one must be skipped on every page, not just the first.
  const many = ids(101);
  await x.push(many.slice(0, 60).map((r) => x.open(r)));
  await x.push(many.slice(60).map((r) => x.open(r)));
  assert.equal((await y.pullAll(0)).visits.has(s!), false, 'a fresh pass skips a closed visit');
  assert.equal((await y.pullAll(0, false)).visits.get(s!)?.open, null, 'a device that holds visits is told it closed');
});

test('lines that arrive after a payment: the pull names the split as the open sale, and shows only the late lines', async () => {
  const app = buildApp();
  const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
  const [s, l1, l2] = ids(3);
  await x.push([x.open(s!), x.add(s!, l1!, 2)]);
  const paid = await x.payFor(s!, [[l1!, 2]]);
  assert.deepEqual(await y.push([y.add(s!, l2!, 1)]), ['applied']); // the waiter's line reaches the server first
  assert.deepEqual(await x.push([paid]), ['applied']);              // the cashier paid for what they saw

  const v = (await y.pullAll()).visits.get(s!);
  assert.ok(v?.open);
  assert.notEqual(v.open.saleId, s, 'the split, not the paid root');
  assert.equal(v.open.deviceId, x.deviceId, 'a split takes the root\'s device');
  assert.deepEqual(v.open.closed, [{ lineId: l1, qty: 2, removed: false }]);
  assert.deepEqual(shown(v), [[l2, 1]]);
  assert.deepEqual(shown(v), await serverLines(v.open.saleId));
  assert.deepEqual(v.sales.map((z) => z.status).sort(), ['open', 'paid']);
});

test('another outlet, or another tenant, never sees this outlet\'s visits', async () => {
  const app = buildApp();
  const x = await Tab.enrol(app);
  const [s] = ids(1);
  await x.push([x.open(s!)]);
  const other = await Tab.enrol(app, { email: 'a2@example.test', outlet: 'School 2 Canteen' });
  const tenantB = await Tab.enrol(app, { tenant: B, email: 'b1@example.test', outlet: 'Main Canteen' });
  const mine = await x.pullAll();
  assert.ok(mine.visits.has(s!));
  for (const t of [other, tenantB]) {
    const seen = await t.pullAll();
    assert.equal(seen.visits.has(s!), false);
    for (const v of seen.visits.values()) {
      for (const sale of v.sales) {
        const row = await withTenant(t.tenant, async (c) => (await c.query('SELECT outlet_id FROM sale WHERE id = $1', [sale.id])).rows[0]);
        assert.equal(row?.outlet_id, t.outletId, 'every visit pulled is the puller\'s own outlet');
      }
    }
  }
});

test('the app role cannot write the visit clock', async () => {
  for (const sql of ['INSERT INTO order_visit (tenant_id, root_id, outlet_id, version) SELECT tenant_id, root_id, outlet_id, 1 FROM order_visit LIMIT 1',
    'UPDATE order_visit SET version = 1', 'DELETE FROM order_visit']) {
    await assert.rejects(withTenant(A, (c) => c.query(sql)), /permission denied/, sql);
  }
});

test('a change that commits after a later one has been pulled is not skipped (versions are stamped at commit)', async () => {
  const app = buildApp();
  const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
  const [s1, s2] = ids(2);
  await x.push([x.open(s1!)]);
  const start = (await y.pullAll()).cursor;

  // A slow writer touches visit 1 and has not committed yet...
  const slow = await pool.connect();
  try {
    await slow.query('BEGIN');
    await slow.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    await slow.query("UPDATE sale SET flags = flags || ARRAY['pull_test'] WHERE id = $1", [s1]);
    // ...while another visit's change commits, and the other device pulls past it.
    await x.push([x.open(s2!)]);
    const mid = await y.page(start);
    assert.deepEqual(mid.visits.map((v) => v.rootId), [s2]);
    await slow.query('COMMIT');
    const late = await y.page(mid.cursor);
    assert.deepEqual(late.visits.map((v) => v.rootId), [s1], 'the late commit is above the cursor already handed out');
  } finally {
    slow.release();
  }
});

test('pages hold at most 100 visits and together miss none', async () => {
  const app = buildApp();
  const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
  const start = (await y.pullAll()).cursor;
  const roots = ids(130);
  for (let i = 0; i < roots.length; i += 65) assert.ok((await x.push(roots.slice(i, i + 65).map((r) => x.open(r)))).every((st) => st === 'applied'));
  const first = await y.page(start);
  assert.equal(first.visits.length, 100);
  assert.equal(first.hasMore, true);
  const rest = await y.pullAll(first.cursor);
  const seen = new Set([...first.visits.map((v) => v.rootId), ...rest.visits.keys()]);
  for (const r of roots) assert.ok(seen.has(r), 'no visit falls between pages');
  const versions = first.visits.map((v) => v.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'in version order');
});

test('the stream nudges the outlet\'s devices when an order changes, and not another outlet\'s', async () => {
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const stops: (() => void)[] = []; // closed in `finally`: an open SSE stream would keep app.close() waiting forever
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const [x, y] = [await Tab.enrol(app), await Tab.enrol(app)];
    const other = await Tab.enrol(app, { email: 'a2@example.test', outlet: 'School 2 Canteen' });
    const listen = (t: Tab) => {
      const ac = new AbortController();
      let text = '';
      const ready = fetch(`${base}/sync/orders/stream`, { headers: { authorization: `Device ${t.cred}` }, signal: ac.signal }).then(async (r) => {
        assert.equal(r.status, 200);
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) return; text += dec.decode(value); } } catch { /* aborted */ } })();
        while (!text.includes('event: ready')) await new Promise((res) => setTimeout(res, 10));
      });
      stops.push(() => ac.abort());
      return { ready, changed: () => text.includes('event: changed'), stop: () => ac.abort() };
    };
    const ly = listen(y), lo = listen(other);
    await Promise.all([ly.ready, lo.ready]);
    const [s] = ids(1);
    await x.push([x.open(s!)]);
    const until = Date.now() + 3000;
    while (!ly.changed() && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
    assert.ok(ly.changed(), 'the same outlet\'s device is nudged');
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(lo.changed(), false, 'another outlet\'s device is not');
    ly.stop(); lo.stop();

    const anon = await fetch(`${base}/sync/orders/stream`);
    assert.equal(anon.status, 401, 'no credential, no stream');
    await anon.body?.cancel();
  } finally {
    for (const stop of stops) stop();
    app.server.closeAllConnections();
    await app.close();
  }
});
