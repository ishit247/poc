// The tablet's local database (IndexedDB via Dexie). Everything the counter needs to sell
// with no network lives here: the pulled catalogue and staff, the receipt counter, open
// orders, and the outbox of events waiting to sync (push is phase 4).
import Dexie, { type Table } from 'dexie';
import type { OutboxEvent, PinAttemptState, ReceiptCounter, PaymentRecord } from '@pos/shared';

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
  status: 'open' | 'paid' | 'void';
  createdBy: string;
  createdByName: string;
  channel: 'counter';
  businessDate: string;
  createdAt: string;
  menuVersion: number;
  lines: { itemId: string; name: string; unitPaise: number; gstRateBp: number; qty: number; netPaise: number; taxPaise: number }[];
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

/** The tenant's logo, cached so the header and receipt show it with no network. Keyed by content hash. */
export interface LogoRow { sha: string; type: string; bytes: ArrayBuffer }

export type MetaValue =
  | { key: 'device'; value: DeviceInfo }
  | { key: 'cursor'; value: number }
  | { key: 'receiptCounter'; value: ReceiptCounter }
  | { key: 'lastPull'; value: string }
  | { key: 'lastPush'; value: string };

class CounterDb extends Dexie {
  meta!: Table<MetaValue, string>;
  entities!: Table<Entity, [string, string]>;
  pinState!: Table<{ userId: string; state: PinAttemptState }, string>;
  sales!: Table<LocalSale, string>;
  outbox!: Table<OutboxRow, number>;
  logo!: Table<LogoRow, string>;
  shifts!: Table<LocalShift, string>;

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
