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
  status: 'open' | 'paid';
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
}

/** An event waiting to sync. `seq` is the device order the server will replay. */
export interface OutboxRow { seq?: number; eventId: string; createdAt: string; payload: OutboxEvent }

export type MetaValue =
  | { key: 'device'; value: DeviceInfo }
  | { key: 'cursor'; value: number }
  | { key: 'receiptCounter'; value: ReceiptCounter }
  | { key: 'lastPull'; value: string };

class CounterDb extends Dexie {
  meta!: Table<MetaValue, string>;
  entities!: Table<Entity, [string, string]>;
  pinState!: Table<{ userId: string; state: PinAttemptState }, string>;
  sales!: Table<LocalSale, string>;
  outbox!: Table<OutboxRow, number>;

  constructor() {
    super('counter');
    this.version(1).stores({
      meta: 'key',
      entities: '[type+id], type',
      pinState: 'userId',
      sales: 'id, status, createdBy',
      outbox: '++seq, eventId',
    });
  }
}

export const db = new CounterDb();

export async function getMeta<K extends MetaValue['key']>(key: K): Promise<Extract<MetaValue, { key: K }>['value'] | undefined> {
  return (await db.meta.get(key))?.value as any;
}
