import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldOrder, orderTotals, checkPayment, liveLines, exclusiveLine, OutboxEvent, OrderEvent as OrderEventSchema,
  type OrderEnvelope, type OrderEvent, type FoldedLine,
} from '../src/index.ts';

// --- fixtures
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SALE = uid(1);
const T0 = Date.parse('2026-11-06T10:00:00+05:30');
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (s: number) => iso(T0 + s * 1000);
const env = (deviceId: string, seq: number, payload: OrderEvent): OrderEnvelope => ({ deviceId, seq, payload });
const V = { schemaVersion: 2 as const, saleId: SALE };
const open = (tableId: string, s = 0): OrderEvent =>
  ({ ...V, type: 'order.opened', tableId, createdBy: uid(90), businessDate: '2026-11-06', createdAtDevice: sec(s), menuVersion: 3 });
const add = (line: number, qty: number, s: number, price = 1000, by = uid(90)): OrderEvent =>
  ({ ...V, type: 'order.line_added', lineId: uid(100 + line), itemId: uid(200 + line), name: `item ${line}`, unitPaise: price, gstRateBp: 500, qty, by, at: sec(s) });
const change = (line: number, qty: number, s: number, by = uid(91)): OrderEvent => ({ ...V, type: 'order.line_changed', lineId: uid(100 + line), qty, by, at: sec(s) });
const remove = (line: number, s: number, by = uid(91)): OrderEvent => ({ ...V, type: 'order.line_removed', lineId: uid(100 + line), by, at: sec(s) });
const move = (tableId: string, s: number): OrderEvent => ({ ...V, type: 'order.moved', tableId, by: uid(91), at: sec(s) });
const line = (f: ReturnType<typeof foldOrder>, n: number) => f.lines.find((l) => l.lineId === uid(100 + n));

// --- rules, one test each

test('order fold: a change overrides its add even from a device whose clock is behind', () => {
  // A adds at 10:00:30; B saw it through sync and changes it, but B's clock says 10:00:05.
  const f = foldOrder(SALE, [env('A', 1, open(uid(50))), env('A', 2, add(1, 1, 30)), env('B', 1, change(1, 4, 5))]);
  assert.equal(line(f, 1)!.qty, 4);
});

test('order fold: between two changes the later wins, whatever order they arrive in; equal times fall back to device id', () => {
  const a = env('A', 2, change(1, 2, 20));
  const b = env('B', 1, change(1, 3, 10));
  const base = [env('A', 1, add(1, 1, 0))];
  assert.equal(line(foldOrder(SALE, [...base, a, b]), 1)!.qty, 2);
  assert.equal(line(foldOrder(SALE, [b, ...base, a]), 1)!.qty, 2);
  const tieA = env('A', 3, change(1, 7, 30));
  const tieB = env('B', 2, change(1, 8, 30));
  assert.equal(line(foldOrder(SALE, [...base, tieB, tieA]), 1)!.qty, 8); // 'B' > 'A'
});

test('order fold: a removal is final and leaves the money; the line stays visible as removed', () => {
  const f = foldOrder(SALE, [env('A', 1, add(1, 1, 0)), env('A', 2, add(2, 1, 1, 500)), env('B', 1, remove(1, 5)), env('A', 3, change(1, 9, 50)), env('A', 4, remove(1, 60))]);
  const l = line(f, 1)!;
  assert.equal(l.removedAt, sec(5)); // the first removal is the one recorded
  assert.equal(l.removedBy, uid(91));
  assert.equal(f.lines.length, 2);
  assert.deepEqual(liveLines(f).map((x) => x.lineId), [uid(102)]);
  assert.equal(orderTotals(f).total, 525);
});

test('order fold: a change before its add is an orphan until the add arrives, then applies', () => {
  const early = foldOrder(SALE, [env('B', 1, change(1, 3, 10)), env('B', 2, remove(2, 11))]);
  assert.deepEqual(early.lines, []);
  assert.deepEqual(early.anomalies, [{ kind: 'orphan', lineId: uid(101) }, { kind: 'orphan', lineId: uid(102) }]);
  const later = foldOrder(SALE, [env('B', 1, change(1, 3, 10)), env('A', 1, add(1, 1, 0))]);
  assert.equal(line(later, 1)!.qty, 3);
  assert.deepEqual(later.anomalies, []);
});

test('order fold: one lineId added twice: same content is one line; different content keeps the earliest and is reported', () => {
  const again = foldOrder(SALE, [env('A', 1, add(1, 2, 0)), env('A', 7, add(1, 2, 40, 1000, uid(92)))]);
  assert.equal(again.lines.length, 1);
  assert.deepEqual(again.anomalies, []);
  const clash = foldOrder(SALE, [env('B', 1, add(1, 5, 9, 700)), env('A', 1, add(1, 2, 3)), env('C', 1, add(1, 6, 20, 800))]);
  assert.equal(clash.lines.length, 1);
  assert.equal(line(clash, 1)!.qty, 2);
  assert.equal(line(clash, 1)!.unitPaise, 1000);
  assert.deepEqual(clash.anomalies, [{ kind: 'line_conflict', lineId: uid(101) }]);
});

test('order fold: table comes from the open, a move overrides it whatever the clocks, the latest move wins', () => {
  assert.equal(foldOrder(SALE, [env('A', 1, add(1, 1, 0))]).tableId, null);
  assert.equal(foldOrder(SALE, [env('A', 1, open(uid(50), 100))]).tableId, uid(50));
  assert.equal(foldOrder(SALE, [env('A', 1, open(uid(50), 100)), env('B', 1, move(uid(51), 2))]).tableId, uid(51));
  assert.equal(foldOrder(SALE, [env('B', 2, move(uid(52), 9)), env('A', 1, open(uid(50), 100)), env('B', 1, move(uid(51), 2))]).tableId, uid(52));
  const twice = foldOrder(SALE, [env('A', 1, open(uid(50), 0)), env('B', 1, open(uid(51), 1))]);
  assert.equal(twice.opened!.tableId, uid(50));
  assert.deepEqual(twice.anomalies, [{ kind: 'open_conflict' }]);
});

test('order fold: refuses another sale\'s event and one (device, seq) with two payloads; key order does not matter', () => {
  assert.throws(() => foldOrder(uid(2), [env('A', 1, add(1, 1, 0))]), RangeError);
  assert.throws(() => foldOrder(SALE, [env('A', 1, add(1, 1, 0)), env('A', 1, add(1, 2, 0))]), RangeError);
  const p = add(1, 1, 0);
  const reordered = Object.fromEntries(Object.entries(p).reverse()) as OrderEvent;
  assert.equal(foldOrder(SALE, [env('A', 1, p), env('A', 1, reordered)]).lines.length, 1);
});

const paidLine = (n: number, qty: number) => ({ lineId: uid(100 + n), qty });

test('order payment: defer on unseen lines, refuse a total wrong at the paid quantities, split off unpaid lines', () => {
  const evs = [env('A', 1, open(uid(50))), env('A', 2, add(1, 2, 1)), env('B', 1, add(2, 1, 2, 500)), env('B', 2, add(3, 1, 3, 300)), env('B', 3, remove(3, 4))];
  const f = foldOrder(SALE, evs);
  assert.deepEqual(checkPayment(f, [paidLine(1, 2), paidLine(9, 1)], 2100), { kind: 'defer', missing: [uid(109)] });
  assert.deepEqual(checkPayment(f, [paidLine(1, 2)], 2000), { kind: 'mismatch', expectedPaise: 2100 });
  assert.deepEqual(checkPayment(f, [paidLine(1, 1)], 2100), { kind: 'mismatch', expectedPaise: 1050 }); // priced at the PAID qty
  const ok = checkPayment(f, [paidLine(1, 2)], 2100);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.deepEqual(ok.paid.map((l) => l.lineId), [uid(101)]);
  assert.deepEqual(ok.late.map((l) => [l.line.lineId, l.qty, l.partial]), [[uid(102), 1, false]]); // removed line 3: neither
  assert.deepEqual(ok.overridden, []);
  assert.equal(ok.totals.total, 2100);
  assert.throws(() => checkPayment(f, [paidLine(1, 2), paidLine(1, 2)], 4200), RangeError);
});

test('order payment: the payment wins over a removal or a change that reached the server first', () => {
  // The cashier paid for line 1 x2, line 2 x1, line 3 x3. Before the payment arrived: line 1 was removed elsewhere,
  // line 2 raised to 4, line 3 lowered to 1.
  const f = foldOrder(SALE, [
    env('A', 1, add(1, 2, 0)), env('A', 2, add(2, 1, 1, 500)), env('A', 3, add(3, 3, 2, 300)),
    env('B', 1, remove(1, 10)), env('B', 2, change(2, 4, 11)), env('B', 3, change(3, 1, 12)),
  ]);
  const ok = checkPayment(f, [paidLine(1, 2), paidLine(2, 1), paidLine(3, 3)], 2100 + 525 + 945);
  assert.equal(ok.kind, 'ok');
  if (ok.kind !== 'ok') return;
  assert.deepEqual(ok.paid.map((l) => [l.lineId, l.qty, l.removedAt]), [[uid(101), 2, null], [uid(102), 1, null], [uid(103), 3, null]]);
  assert.deepEqual(ok.late.map((l) => [l.line.lineId, l.qty, l.partial]), [[uid(102), 3, true]]); // the extra 3 of line 2
  assert.deepEqual(ok.overridden, [{ lineId: uid(101), kind: 'removed', foldQty: 2 }, { lineId: uid(103), kind: 'reduced', foldQty: 1 }]);
});

test('order events: v2 shapes parse; payment v1 and v2 both accepted; v2 must add up and name its lines', () => {
  for (const e of [open(uid(50)), add(1, 1, 0), change(1, 2, 0), remove(1, 0), move(uid(51), 0)]) {
    assert.ok(OutboxEvent.safeParse(e).success, e.type);
    assert.ok(OrderEventSchema.safeParse(e).success, e.type);
    assert.ok(!OutboxEvent.safeParse({ ...e, schemaVersion: 1 }).success, `${e.type} at v1`);
  }
  assert.ok(!OutboxEvent.safeParse(change(1, 0, 0)).success, 'qty 0 is a removal, not a change');
  assert.ok(!OutboxEvent.safeParse({ ...add(1, 1, 0), lineId: 'x' }).success);
  const pay = { type: 'payment.taken', saleId: SALE, businessDate: '2026-11-06', receiptNo: 'C1-20261106-1', receiptSeq: 1,
    payments: [{ method: 'cash', amountPaise: 1500, tenderedPaise: 2000, changePaise: 500, upiRef: null }, { method: 'upi', amountPaise: 600, tenderedPaise: null, changePaise: 0, upiRef: null }] };
  assert.ok(OutboxEvent.safeParse({ ...pay, schemaVersion: 1 }).success);
  const v2 = { ...pay, schemaVersion: 2, lines: [paidLine(1, 2), paidLine(2, 1)], totalPaise: 2100 };
  assert.ok(OutboxEvent.safeParse(v2).success);
  assert.ok(!OutboxEvent.safeParse({ ...v2, totalPaise: 2000 }).success, 'payments must add up to the total');
  assert.ok(!OutboxEvent.safeParse({ ...v2, lines: [] }).success);
  assert.ok(!OutboxEvent.safeParse({ ...v2, lines: [paidLine(1, 2), paidLine(1, 1)] }).success);
  assert.ok(!OutboxEvent.safeParse({ ...v2, lines: [paidLine(1, 0)] }).success);
  assert.ok(!OutboxEvent.safeParse({ ...pay, schemaVersion: 2 }).success, 'v2 without lines');
  assert.ok(!OutboxEvent.safeParse({ ...v2, schemaVersion: 3 }).success);
});

// --- properties over generated histories

/** mulberry32: small, seeded, good enough to explore histories reproducibly. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

/**
 * A plausible history: one device opens, up to three add, change, remove and move. Every device sees every earlier
 * line (it only ever changes lines that exist). With `skewed`, each device's clock runs on its own offset and pace;
 * without, all share one strictly increasing clock, so event order equals generation order.
 */
function history(seed: number, skewed: boolean): OrderEnvelope[] {
  const r = rng(seed);
  const devices = Array.from({ length: 1 + r.int(3) }, (_, i) => ({ id: `dev-${i}`, seq: 0, clock: T0 + (skewed ? r.int(120_000) - 60_000 : 0) }));
  let shared = T0;
  const tick = (d: (typeof devices)[number]) => {
    if (skewed) d.clock += 1 + r.int(5_000);
    else d.clock = shared += 1 + r.int(5_000);
    return iso(d.clock);
  };
  const out: OrderEnvelope[] = [];
  const emit = (d: (typeof devices)[number], p: OrderEvent) => out.push({ deviceId: d.id, seq: ++d.seq, payload: p });
  const lines: string[] = [];
  const opener = devices[0]!;
  emit(opener, { ...V, type: 'order.opened', tableId: uid(50), createdBy: uid(90), businessDate: '2026-11-06', createdAtDevice: tick(opener), menuVersion: 1 });
  const steps = 1 + r.int(40);
  for (let i = 0; i < steps; i++) {
    const d = r.pick(devices);
    const by = uid(90 + r.int(3));
    const roll = r.next();
    if (!lines.length || roll < 0.4) {
      const lineId = uid(1000 + lines.length);
      lines.push(lineId);
      emit(d, { ...V, type: 'order.line_added', lineId, itemId: uid(200 + r.int(5)), name: 'x', unitPaise: 1 + r.int(50_000), gstRateBp: r.pick([0, 500, 1200, 1800]), qty: 1 + r.int(5), by, at: tick(d) });
    } else if (roll < 0.7) emit(d, { ...V, type: 'order.line_changed', lineId: r.pick(lines), qty: 1 + r.int(9), by, at: tick(d) });
    else if (roll < 0.9) emit(d, { ...V, type: 'order.line_removed', lineId: r.pick(lines), by, at: tick(d) });
    else emit(d, { ...V, type: 'order.moved', tableId: uid(50 + r.int(4)), by, at: tick(d) });
  }
  return out;
}

/** The obvious fold: apply events one by one in the order they happened. Only valid when that order is unambiguous. */
function replay(events: OrderEnvelope[]): { tableId: string | null; lines: FoldedLine[] } {
  let tableId: string | null = null;
  const lines = new Map<string, FoldedLine>();
  for (const { payload: p } of events) {
    if (p.type === 'order.opened') tableId = p.tableId;
    else if (p.type === 'order.moved') tableId = p.tableId;
    else if (p.type === 'order.line_added') lines.set(p.lineId, { lineId: p.lineId, itemId: p.itemId, name: p.name, unitPaise: p.unitPaise as FoldedLine['unitPaise'], gstRateBp: p.gstRateBp, qty: p.qty, addedBy: p.by, addedAt: p.at, removedBy: null, removedAt: null });
    else if (p.type === 'order.line_changed') lines.get(p.lineId)!.qty = p.qty;
    else { const l = lines.get(p.lineId)!; if (!l.removedAt) { l.removedAt = p.at; l.removedBy = p.by; } }
  }
  return { tableId, lines: [...lines.values()] };
}

function shuffle<T>(xs: T[], r: ReturnType<typeof rng>): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = r.int(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

const SEEDS = 400;

test('order fold property: with one shared clock, the fold equals replaying events as they happened', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const h = history(seed, false);
    const f = foldOrder(SALE, h);
    const want = replay(h);
    assert.deepEqual({ tableId: f.tableId, lines: f.lines }, want, `seed ${seed}`);
    assert.deepEqual(f.anomalies, [], `seed ${seed}`);
  }
});

test('order fold property: any delivery order, any retries, any clock skew: the same fold', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const h = history(seed, true);
    const r = rng(seed * 7919);
    const want = foldOrder(SALE, h);
    for (let k = 0; k < 5; k++) {
      const retried = h.filter(() => r.next() < 0.3).map((e) => ({ ...e, payload: Object.fromEntries(Object.entries(e.payload).reverse()) as OrderEvent }));
      assert.deepEqual(foldOrder(SALE, shuffle([...h, ...retried], r)), want, `seed ${seed} shuffle ${k}`);
    }
    // Union: every line any device added is in the fold, exactly once.
    const added = new Set(h.flatMap((e) => (e.payload.type === 'order.line_added' ? [e.payload.lineId] : [])));
    assert.deepEqual(new Set(want.lines.map((l) => l.lineId)), added, `seed ${seed} union`);
    assert.equal(want.lines.length, added.size, `seed ${seed} no duplicate lines`);
  }
});

test('order fold property: the total is the sum of the live lines, removed lines count for nothing', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const f = foldOrder(SALE, history(seed, true));
    const t = orderTotals(f, { gstRounding: 'half_up', billRoundTo: 0 });
    const live = f.lines.filter((l) => l.removedAt === null);
    assert.equal(t.total, live.reduce((s, l) => s + exclusiveLine(l.unitPaise, l.qty, l.gstRateBp).total, 0), `seed ${seed}`);
    assert.equal(t.lines.length, live.length, `seed ${seed}`);
    // Paying for every live line is always accepted at the fold's own total, with nothing late.
    if (live.length) {
      const c = checkPayment(f, live.map((l) => ({ lineId: l.lineId, qty: l.qty })), t.total, { gstRounding: 'half_up', billRoundTo: 0 });
      assert.equal(c.kind, 'ok', `seed ${seed}`);
      if (c.kind === 'ok') assert.deepEqual([c.late.length, c.overridden.length], [0, 0], `seed ${seed}`);
    }
  }
});
