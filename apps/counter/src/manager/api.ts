import { formatRupees, paise } from '@pos/shared';

// Manager tools are online-only and never stored on the tablet: the session token lives in memory and
// is gone on reload. Day close needs the server's view of every tablet, so there is nothing to do offline.

export interface Me { name: string; outlets: { id: string; name: string; timezone: string; today: string }[] }
export interface Totals {
  paidSales: number; grossPaise: number; taxPaise: number; cashPaise: number; upiPaise: number; onlineGrossPaise: number;
  voids: number; voidTotalPaise: number; refunds: number; refundTotalPaise: number; varianceTotalPaise: number;
  shifts: { id: string; cashier: string; counter: string; float: number; counted: number; expected: number; variance: number }[];
  lateAdjustments?: { id: string; businessDate: string; receiptNo: string; status: string; totalPaise: number }[];
  receiptGaps?: { deviceId: string; counter: string; missing: number[] }[];
}
export interface Device { id: string; label: string | null; counter: string; lastSeenAt: string | null; outboxPending: number | null; blocking: boolean }
export interface Blockers { openShifts: { id: string; cashier: string; openedAt: string }[]; openSales: number; devices: Device[] }
export interface Preview {
  date: string; closed: boolean; closedAt?: string; provisional?: boolean;
  blockers?: Blockers; totals: Totals | null; lateAdjustments: NonNullable<Totals['lateAdjustments']>; receiptGaps?: NonNullable<Totals['receiptGaps']>;
}

export const rs = (n: number) => formatRupees(paise(n));

export const api = async (path: string, token: string, init: RequestInit = {}) => {
  const r = await fetch(`/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
