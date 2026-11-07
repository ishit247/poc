import { useEffect, useState } from 'react';
import { renderReceipt, type ReceiptView } from '@pos/shared';
import type { DeviceInfo } from './db.ts';
import { useLogoUrl } from './logo.ts';
import { outletInfo } from './receipt.ts';

export interface DraftLine { name: string; qty: number; unitPaise: number; netPaise: number; gstRateBp: number; taxPaise: number }
export interface DraftTotals { subtotalPaise: number; taxPaise: number; roundOffPaise: number; totalPaise: number }

/**
 * The bill before payment, for a customer who wants to see (or check) it first. Same 58 mm layout as the receipt,
 * headed DRAFT BILL: it takes no receipt number and writes nothing, so printing it twice changes no record.
 */
export function DraftBill({ lines, totals, device, staffName, onClose }: {
  lines: DraftLine[]; totals: DraftTotals; device: DeviceInfo; staffName: string; onClose: () => void;
}) {
  const logoUrl = useLogoUrl();
  const [text, setText] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void outletInfo().then((o) => {
      const view: ReceiptView = {
        outletName: device.outletName, address: o.address, gstEnabled: o.gstEnabled, gstin: o.gstin, fssaiNo: o.fssaiNo,
        receiptNo: 'DRAFT', at: new Date().toISOString(), timezone: device.timezone, staffName, reprint: false, draft: true,
        lines, ...totals, payments: [],
      };
      setText(renderReceipt(view));
    });
  }, [lines, totals, device, staffName]);

  const print = () => {
    setProblem('');
    try { window.print(); } catch (e) { setProblem(e instanceof Error ? e.message : 'Could not print.'); }
  };

  return (
    <div className="overlay" role="dialog" aria-label="Draft bill">
      <div className="dialog">
        <div className="receipt print-area" data-testid="draft-bill">
          {logoUrl && <img className="receipt-logo" src={logoUrl} alt="" />}
          <pre data-testid="draft-bill-text">{text ? text.join('\n') : ''}</pre>
        </div>
        {problem && <p role="alert" className="error no-print">{problem}</p>}
        <div className="row no-print">
          <button data-testid="draft-print" className="primary" disabled={!text} onClick={print}>Print</button>
          <button data-testid="draft-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
