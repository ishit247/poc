// A running order (D15) is the fold of its line events. The tablet folds what it holds; the server folds what it
// has ingested. Both must reach the same lines from the same SET of events, whatever order they arrived in and
// however often one was retried, so the fold is defined on the set, not on the arrival sequence:
//
//   1. Events are identified by (deviceId, seq). Copies of one event are one event.
//   2. Events are ordered by device time, then device id, then seq: a total order every reader agrees on.
//      (The tablet keeps its event time non-decreasing, as it does for receipt numbers, so within one device this
//      agrees with seq.)
//   3. A line's add and the table in `order.opened` are BASE values. A change or move overrides its base whatever
//      the clocks say, because nobody can change a line they have not seen. Between changes (or moves), the latest wins.
//   4. A removal is final. A line is never deleted from the fold; it is marked removed.
//   5. Disagreements that should not happen (two different adds with one lineId, two different opens for one sale)
//      resolve to the earliest event and are reported as anomalies, never silently merged.
import { totals, type CartLine, type CartTotals } from './cart.ts';
import { paise, type Paise } from './money.ts';
import type { OrderEvent, OrderLineAdded, OrderOpened } from './events.ts';
import { DEFAULT_SETTINGS, type TradingSettings } from './settings.ts';

/** An order event as received: its payload plus the outbox identity of the device that wrote it. */
export interface OrderEnvelope {
  deviceId: string;
  seq: number;
  payload: OrderEvent;
}

export interface FoldedLine extends CartLine {
  lineId: string;
  addedBy: string;
  addedAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

export type OrderAnomaly =
  | { kind: 'open_conflict' } // a second order.opened for this sale, with different content
  | { kind: 'line_conflict'; lineId: string } // a second add for this lineId, with different content
  | { kind: 'orphan'; lineId: string }; // a change or removal for a line whose add has not arrived

export interface OrderFold {
  saleId: string;
  opened: OrderOpened | null; // null until the open event arrives
  tableId: string | null;
  lines: FoldedLine[]; // every line ever added, removed ones included, in event order of their adds
  anomalies: OrderAnomaly[];
}

const timeOf = (p: OrderEvent): string => (p.type === 'order.opened' ? p.createdAtDevice : p.at);

/** The total order on events (rule 2). Negative when a comes first. */
export function compareOrderEvents(a: OrderEnvelope, b: OrderEnvelope): number {
  const ta = Date.parse(timeOf(a.payload));
  const tb = Date.parse(timeOf(b.payload));
  if (ta !== tb) return ta - tb;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return a.seq - b.seq;
}

/** JSON with object keys sorted, so two copies of one payload compare equal whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** What a line IS (item, price, qty, sale), not who wrote it when: a re-queued copy of an add is still the same line. */
const addContent = ({ at: _at, by: _by, ...what }: OrderLineAdded) => canonical(what);

/**
 * Folds the events of ONE sale into its lines. Throws on input that no honest device can produce: an event for
 * another sale, or one (deviceId, seq) carrying two different payloads.
 */
export function foldOrder(saleId: string, events: readonly OrderEnvelope[]): OrderFold {
  const unique = new Map<string, OrderEnvelope>();
  for (const e of events) {
    if (e.payload.saleId !== saleId) throw new RangeError(`event for sale ${e.payload.saleId} folded into ${saleId}`);
    const id = `${e.deviceId}\u0000${e.seq}`;
    const seen = unique.get(id);
    if (!seen) unique.set(id, e);
    else if (canonical(seen.payload) !== canonical(e.payload)) throw new RangeError(`device ${e.deviceId} seq ${e.seq} has two different payloads`);
  }
  const sorted = [...unique.values()].sort(compareOrderEvents);

  let opened: OrderOpened | null = null;
  let movedTo: string | null = null;
  const adds = new Map<string, OrderLineAdded>();
  const qty = new Map<string, number>();
  const removed = new Map<string, { by: string; at: string }>();
  const anomalies: OrderAnomaly[] = [];
  const lineConflicts = new Set<string>();

  for (const { payload: p } of sorted) {
    switch (p.type) {
      case 'order.opened':
        if (!opened) opened = p;
        else if (canonical(opened) !== canonical(p) && !anomalies.some((a) => a.kind === 'open_conflict')) anomalies.push({ kind: 'open_conflict' });
        break;
      case 'order.line_added': {
        const first = adds.get(p.lineId);
        if (!first) adds.set(p.lineId, p);
        else if (addContent(first) !== addContent(p) && !lineConflicts.has(p.lineId)) {
          lineConflicts.add(p.lineId);
          anomalies.push({ kind: 'line_conflict', lineId: p.lineId });
        }
        break;
      }
      case 'order.line_changed':
        qty.set(p.lineId, p.qty); // sorted, so the last one set is the latest
        break;
      case 'order.line_removed':
        if (!removed.has(p.lineId)) removed.set(p.lineId, { by: p.by, at: p.at });
        break;
      case 'order.moved':
        movedTo = p.tableId;
        break;
    }
  }

  const orphans = [...new Set([...qty.keys(), ...removed.keys()])].filter((id) => !adds.has(id)).sort();
  for (const lineId of orphans) anomalies.push({ kind: 'orphan', lineId });

  const lines: FoldedLine[] = [...adds.values()].map((a) => {
    const r = removed.get(a.lineId);
    return {
      lineId: a.lineId, itemId: a.itemId, name: a.name, unitPaise: paise(a.unitPaise), gstRateBp: a.gstRateBp,
      qty: qty.get(a.lineId) ?? a.qty, addedBy: a.by, addedAt: a.at, removedBy: r?.by ?? null, removedAt: r?.at ?? null,
    };
  });

  return { saleId, opened, tableId: movedTo ?? opened?.tableId ?? null, lines, anomalies };
}

export const liveLines = (f: OrderFold): FoldedLine[] => f.lines.filter((l) => l.removedAt === null);

/** A line row on a CLOSED (paid, refunded or void) sale of the same table visit. */
export interface ClosedLine {
  lineId: string;
  qty: number;
  removed: boolean;
}

/**
 * What the table visit's one open sale holds, given the fold of ALL its events and the rows its closed sales froze.
 * A line with a row on a closed sale is settled there; only the live quantity beyond what the closed sales took (raised
 * on another device before the payment arrived) is still open, under the same lineId. Every other line is open exactly
 * as folded, removed ones included. Pure: the server writes the result (step 4), and the same rule can run on a tablet.
 */
export function openLines(f: OrderFold, closed: readonly ClosedLine[]): FoldedLine[] {
  const frozen = new Set(closed.map((r) => r.lineId));
  const taken = new Map<string, number>();
  for (const r of closed) if (!r.removed) taken.set(r.lineId, (taken.get(r.lineId) ?? 0) + r.qty);
  const out: FoldedLine[] = [];
  for (const l of f.lines) {
    if (!frozen.has(l.lineId)) out.push(l);
    else if (l.removedAt === null && l.qty > (taken.get(l.lineId) ?? 0)) out.push({ ...l, qty: l.qty - (taken.get(l.lineId) ?? 0) });
  }
  return out;
}

type TotalSettings = Pick<TradingSettings, 'gstRounding' | 'billRoundTo'>;

/** The order's money: the same totals() a counter sale uses, over the live lines only. */
export function orderTotals(f: OrderFold, s: TotalSettings = DEFAULT_SETTINGS): CartTotals {
  return totals(liveLines(f), s);
}

/** What a v2 payment says it paid for. */
export interface PaidLine {
  lineId: string;
  qty: number;
}

/** Live quantity the payment did not cover: a whole unpaid line, or the excess of a paid line raised elsewhere. */
export interface LateLine {
  line: FoldedLine;
  qty: number;
  partial: boolean; // true: the excess of a paid line, which becomes a new line (new lineId) on the split-off order
}

/** A line event the payment overrode: the paid quantity stands, this is recorded `already_paid`. */
export interface Overridden {
  lineId: string;
  kind: 'removed' | 'reduced'; // removed elsewhere, or lowered elsewhere below what was paid
  foldQty: number;
}

export type PaymentCheck =
  | { kind: 'defer'; missing: string[] } // paid lines whose add this fold has not seen: retry when they arrive
  | { kind: 'mismatch'; expectedPaise: Paise } // the paid lines at the paid quantities total differently here
  | { kind: 'ok'; paid: FoldedLine[]; late: LateLine[]; overridden: Overridden[]; totals: CartTotals };

/**
 * Checks a v2 payment against a fold. The payment wins: each paid line is paid at the PAID quantity, even if the fold
 * has it removed or at another quantity. Only a line the fold has never seen defers (its price is unknown), and only a
 * total that disagrees at the paid quantities is refused, which no honest tablet produces. Pure: the caller acts on it.
 */
export function checkPayment(f: OrderFold, paidLines: readonly PaidLine[], totalPaise: number, s: TotalSettings = DEFAULT_SETTINGS): PaymentCheck {
  const want = new Map(paidLines.map((l) => [l.lineId, l.qty]));
  if (want.size !== paidLines.length) throw new RangeError('paid lines must be unique');
  const byId = new Map(f.lines.map((l) => [l.lineId, l]));
  const missing = paidLines.map((l) => l.lineId).filter((id) => !byId.has(id));
  if (missing.length) return { kind: 'defer', missing };

  const paid = f.lines.filter((l) => want.has(l.lineId)).map((l) => ({ ...l, qty: want.get(l.lineId)!, removedBy: null, removedAt: null }));
  const t = totals(paid, s);
  if (t.total !== totalPaise) return { kind: 'mismatch', expectedPaise: t.total };

  const late: LateLine[] = [];
  const overridden: Overridden[] = [];
  for (const l of f.lines) {
    const paidQty = want.get(l.lineId);
    const live = l.removedAt === null;
    if (paidQty === undefined) {
      if (live) late.push({ line: l, qty: l.qty, partial: false });
    } else if (!live) overridden.push({ lineId: l.lineId, kind: 'removed', foldQty: l.qty });
    else if (l.qty > paidQty) late.push({ line: l, qty: l.qty - paidQty, partial: true });
    else if (l.qty < paidQty) overridden.push({ lineId: l.lineId, kind: 'reduced', foldQty: l.qty });
  }
  return { kind: 'ok', paid, late, overridden, totals: t };
}
