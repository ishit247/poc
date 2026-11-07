import { useEffect, useState } from 'react';
import { renderReceipt, type ReceiptView } from '@pos/shared';
import type { DeviceInfo } from './db.ts';
import { useLogoUrl } from './logo.ts';
import { outletInfo } from './receipt.ts';

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

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
    <main className="center">
      <div className="no-print toolbar">
        <button data-testid="draft-print" className="icon-btn" title="Print" aria-label="Print" disabled={!text} onClick={print}>
          <svg {...svgProps}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" /></svg>
        </button>
        <button data-testid="draft-close" className="icon-btn primary" title="Close" aria-label="Close" onClick={onClose}>
          <svg {...svgProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <span className="muted">Draft bill</span>
      </div>
      {problem && <p role="alert" className="error no-print">{problem}</p>}
      <div className="receipt print-area" data-testid="draft-bill">
        {logoUrl && <img className="receipt-logo" src={logoUrl} alt="" />}
        <pre data-testid="draft-bill-text">{text ? text.join('\n') : ''}</pre>
      </div>
    </main>
  );
}
