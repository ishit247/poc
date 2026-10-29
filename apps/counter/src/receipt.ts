// A paid local sale as the shared receipt layout wants it. The outlet's address, GSTIN and FSSAI
// number come from the last pull, so a receipt prints with no network.
import type { ReceiptView } from '@pos/shared';
import { db, type DeviceInfo, type LocalSale } from './db.ts';

export interface OutletInfo { gstEnabled: boolean; gstin: string | null; address: string | null; fssaiNo: string | null }

export async function outletInfo(): Promise<OutletInfo> {
  const d = (await db.entities.where('type').equals('outlet').first())?.data ?? {};
  return { gstEnabled: d.gstEnabled === true, gstin: d.gstin ?? null, address: d.address ?? null, fssaiNo: d.fssaiNo ?? null };
}

/** Only a paid sale has a receipt. A GST outlet without a GSTIN cannot happen (the database refuses it). */
export function toReceiptView(sale: LocalSale, device: DeviceInfo, outlet: OutletInfo, reprint: boolean): ReceiptView {
  if (!sale.receiptNo) throw new Error('an unpaid order has no receipt');
  return {
    outletName: device.outletName, address: outlet.address, gstEnabled: outlet.gstEnabled, gstin: outlet.gstin, fssaiNo: outlet.fssaiNo,
    receiptNo: sale.receiptNo, at: sale.createdAt, timezone: device.timezone, staffName: sale.createdByName, reprint,
    lines: sale.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise })),
    subtotalPaise: sale.subtotalPaise, taxPaise: sale.taxPaise, roundOffPaise: sale.roundOffPaise, totalPaise: sale.totalPaise,
    payments: sale.payments.map((p) => ({ method: p.method, amountPaise: p.amountPaise, changePaise: p.changePaise })),
  };
}
