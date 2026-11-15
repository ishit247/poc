import { useEffect, useState } from 'react';
import { renderReceipt, type BillDiscount, type ReceiptView, type TradingSettings } from '@pos/shared';
import type { DeviceInfo } from './db.ts';
import { priced, type BillLine } from './sale.ts';
import { useLogoUrl } from './logo.ts';
import { outletInfo } from './receipt.ts';

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export interface DraftLine { name: string; qty: number; unitPaise: number; netPaise: number; gstRateBp: number; taxPaise: number }
export interface DraftTotals { subtotalPaise: number; taxPaise: number; roundOffPaise: number; totalPaise: number }

/** A bill with a discount, priced as the sale will be: each line's tax on its discounted net, the discount line for the receipt. */
export function discountedBill(lines: readonly BillLine[], settings: TradingSettings, rule: BillDiscount) {
  const p = priced(lines, settings, rule);
  return {
    lines: p.lines.map((l): DraftLine => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise })),
    totals: { subtotalPaise: p.subtotalPaise, taxPaise: p.taxPaise, roundOffPaise: p.roundOffPaise, totalPaise: p.totalPaise } as DraftTotals,
    discount: { paise: p.discountPaise, bp: rule.kind === 'percent' ? rule.value : null, reason: rule.reason } as ReceiptView['discount'],
  };
}

/**
 * The bill before payment, for a customer who wants to see (or check) it first. Same 58 mm layout as the receipt,
 * headed DRAFT BILL: it takes no receipt number and writes nothing, so printing it twice changes no record.
 */
export function DraftBill({ lines, totals, discount = null, device, staffName, onClose }: {
  lines: DraftLine[]; totals: DraftTotals; discount?: ReceiptView['discount']; device: DeviceInfo; staffName: string; onClose: () => void;
}) {
  const logoUrl = useLogoUrl();
  const [text, setText] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void outletInfo().then((o) => {
      const view: ReceiptView = {
        outletName: device.outletName, address: o.address, gstEnabled: o.gstEnabled, gstin: o.gstin, fssaiNo: o.fssaiNo,
        receiptNo: 'DRAFT', at: new Date().toISOString(), timezone: device.timezone, staffName, reprint: false, draft: true,
        lines, ...totals, discount, payments: [],
      };
      setText(renderReceipt(view));
    });
  }, [lines, totals, discount, device, staffName]);

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
