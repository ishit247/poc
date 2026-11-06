// The tablet's local database (IndexedDB via Dexie). Everything the counter needs to sell
// with no network lives here: the pulled catalogue and staff, the receipt counter, open
// orders, and the outbox of events waiting to sync (push is phase 4).
import Dexie, { type Table } from 'dexie';
import type { ClosedLine, OrderEvent, OutboxEvent, PinAttemptState, ReceiptCounter, PaymentRecord } from '@pos/shared';

export interface DeviceInfo {
  credential: string;
  deviceId: string;
  tenantId: string;
  outletId: string;
  counterId: string;
  counterCode: string;
  outletName: string;
  timezone: string;
}

/** One pulled row, keyed by (type, id). Tombstones delete the row. */
export interface Entity { type: string; id: string; data: Record<string, any> }

export interface LocalSale {
  id: string;
  /**
   * 'refused' (step 7d): this device took the money and printed the receipt, and the server refused the payment
   * (`already_paid`: another device paid the table first; `sale_void`: another device voided the order first). Not paid,
   * not void: its receipt number stays used, its cash stays in this drawer's expected figure, and `refused` says why.
   */
  status: 'open' | 'paid' | 'void' | 'refused';
  refused?: { reason: string; eventId: string; at: string; ackAt?: string };
  createdBy: string;
  createdByName: string;
  channel: 'counter';
  businessDate: string;
  createdAt: string;
  menuVersion: number;
  /**
   * 'order' is a running order (phase 12, D15): its lines are the fold of its `orderEvents`, recomputed in the same
   * transaction as every event, and it is paid with `payment.taken` v2. Absent or 'whole' is a v1 sale written whole.
   */
  kind?: 'whole' | 'order';
  /** The table an order sits on (the outlet's default table in a cafe). Null or absent for a whole sale. */
  tableId?: string | null;
  /**
   * The table visit an order belongs to: the sale `order.opened` created (D15). Absent means the order is its own root.
   * A split (lines that reached the server after a payment) is a new sale id under the same root; its events name the root.
   */
  rootId?: string;
  /**
   * Set only on a view of ANOTHER device's order (a `visits` row): that device takes payment for it, and voids it.
   * Such an order never lives in `sales`, so shift close, receipts and cash totals cannot touch it.
   */
  ownerDeviceId?: string;
  /** Fold anomalies seen while merging another device's events: shown, not merged away (should not happen). */
  anomalies?: string[];
  /** For an order, the LIVE lines only, each with its lineId; removed lines stay in the fold, not here. */
  lines: { lineId?: string; itemId: string; name: string; unitPaise: number; gstRateBp: number; qty: number; netPaise: number; taxPaise: number }[];
  subtotalPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  receiptNo: string | null;
  receiptSeq: number | null;
  payments: PaymentRecord[];
  /** The shift whose drawer took the money. Null while open, and on sales paid before shifts existed. */
  shiftId?: string | null;
}

/** A till session on this tablet. `closedAt` set means the drawer was counted. */
export interface LocalShift {
  id: string;
  userId: string;
  userName: string;
  openedAt: string;
  openingCashPaise: number;
  closedAt: string | null;
  countedCashPaise: number | null;
  /** Set when a manager closed this drawer from the server. Their count stands; these are the server's figures. */
  closedByManager?: { expectedCashPaise: number; variancePaise: number };
}

/** An event waiting to sync. `seq` is the device order the server will replay. */
export interface OutboxRow {
  seq?: number; eventId: string; createdAt: string; payload: OutboxEvent;
  /** The server will never accept this event as sent. It stays here for a manager to look at, and is not resent. */
  rejected?: string;
}

/**
 * An order event this device wrote, kept while its order is open so the order can be refolded. `seq` is the SAME
 * number as its outbox row (written in one transaction), so (deviceId, seq) identifies it to the fold here and on the
 * server alike. The outbox row leaves on acknowledgement; this one leaves when the order is paid or voided.
 */
export interface OrderEventRow { deviceId: string; seq: number; saleId: string; payload: OrderEvent }

/**
 * A table visit as the server last sent it (`/sync/orders`, phase 12 step 7): every order event it has applied, from
 * any device (saleId renamed to the root), and the lines its closed sales took. Stored as pulled, so the cursor can
 * move past it safely; what the screen shows is derived from it and this device's own unsent events (order.ts).
 */
export interface VisitRow {
  rootId: string;
  /** The visit's open sale on the server: the root, or a split. */
  openSaleId: string;
  /** The device that opened the visit: it alone takes payment (a split keeps the root's device). */
  ownerDeviceId: string;
  events: { deviceId: string; seq: number; payload: OrderEvent }[];
  closed: ClosedLine[];
  /** Another device's order as this device shows it. Absent when this device owns it (then it is a `sales` row). */
  view?: LocalSale;
}

/** The tenant's logo, cached so the header and receipt show it with no network. Keyed by content hash. */
export interface LogoRow { sha: string; type: string; bytes: ArrayBuffer }

/** Item pictures, cached by content hash (see itemImages.ts). */
export interface ItemImageRow { sha: string; type: string; bytes: ArrayBuffer }

export type MetaValue =
  | { key: 'device'; value: DeviceInfo }
  | { key: 'cursor'; value: number }
  | { key: 'receiptCounter'; value: ReceiptCounter }
  | { key: 'lastPull'; value: string }
  | { key: 'lastPush'; value: string }
  /** The latest time stamped on an order event. Order event times never go backwards on one device (the fold needs it). */
  | { key: 'eventClock'; value: string }
  /** The open-orders pull: cursor, and whether a first full pass has finished (until then, closed visits are skipped). */
  | { key: 'orderCursor'; value: number }
  | { key: 'ordersPrimed'; value: boolean };

class CounterDb extends Dexie {
  meta!: Table<MetaValue, string>;
  entities!: Table<Entity, [string, string]>;
  pinState!: Table<{ userId: string; state: PinAttemptState }, string>;
  sales!: Table<LocalSale, string>;
  outbox!: Table<OutboxRow, number>;
  logo!: Table<LogoRow, string>;
  shifts!: Table<LocalShift, string>;
  itemImages!: Table<ItemImageRow, string>;
  orderEvents!: Table<OrderEventRow, [string, number]>;
  visits!: Table<VisitRow, string>;

  constructor() {
    super('counter');
    this.version(1).stores({
      meta: 'key',
      entities: '[type+id], type',
      pinState: 'userId',
      sales: 'id, status, createdBy',
      outbox: '++seq, eventId',
      logo: 'sha',
    });
    this.version(2).stores({ shifts: 'id, closedAt' });
    this.version(3).stores({ itemImages: 'sha' });
    // Phase 12: running orders. Existing sales need no upgrade: no `kind` means a whole sale, no `tableId` is no table.
    this.version(4).stores({ sales: 'id, status, createdBy, tableId', orderEvents: '[deviceId+seq], saleId' });
    // Phase 12 step 7: other devices' open orders, as pulled. New table only; nothing to upgrade.
    this.version(5).stores({ visits: 'rootId, openSaleId' });
  }
}

export const db = new CounterDb();

/** The drawer that is open on this tablet right now, if any. At most one: a closed shift keeps its row for the slip. */
export async function currentShift(): Promise<LocalShift | undefined> {
  return (await db.shifts.toArray()).find((s) => !s.closedAt);
}

export async function getMeta<K extends MetaValue['key']>(key: K): Promise<Extract<MetaValue, { key: K }>['value'] | undefined> {
  return (await db.meta.get(key))?.value as any;
}
