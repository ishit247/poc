import { useEffect, useState } from 'react';
import { formatRupees, paise, renderReceipt } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { useLogoUrl } from './logo.ts';
import { outletInfo, toReceiptView } from './receipt.ts';

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const rs =(n: number) => formatRupees(paise(n));

/**
 * A paid sale shows the exact text that prints (58 mm, 32 columns) and a Print button that uses the
 * browser's print dialog. A reprint is marked on the paper, and `onReprint` lets the caller record it.
 * An order that is saved but not yet paid has no receipt: it shows a confirmation only.
 */
export function Receipt({ sale, device, reprint = false, onReprint, onClose }: {
  sale: LocalSale; device: DeviceInfo; reprint?: boolean; onReprint?: () => Promise<void>; onClose: () => void;
}) {
  const logoUrl = useLogoUrl();
  const [text, setText] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!sale.receiptNo) return;
    void outletInfo().then((o) => setText(renderReceipt(toReceiptView(sale, device, o, reprint))));
  }, [sale, device, reprint]);

  const print = async () => {
    setProblem('');
    try {
      // The reprint is recorded BEFORE the paper comes out: no copy without a trail.
      if (reprint && onReprint) await onReprint();
      window.print();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not print.');
    }
  };

  if (!sale.receiptNo) {
    return (
      <main className="center">
        <button data-testid="new-sale" className="primary" onClick={onClose}>New sale</button>
        <div className="receipt" data-testid="receipt">
          <h2>{device.outletName}</h2>
          <p><b data-testid="saved">Order saved</b>. A cashier will take payment.</p>
          <p className="muted">{new Date(sale.createdAt).toLocaleString()} · {sale.createdByName}</p>
          <ul>{sale.lines.map((l) => <li key={l.itemId}><span>{l.qty} × {l.name}</span><span>₹{rs(l.netPaise)}</span></li>)}</ul>
          <p><b>₹{rs(sale.totalPaise)}</b></p>
        </div>
      </main>
    );
  }
  return (
    <main className="center">
      <div className="no-print toolbar">
        <button data-testid="print" className="icon-btn" title={reprint ? 'Print copy' : 'Print'} aria-label={reprint ? 'Print copy' : 'Print'} onClick={print}>
          <svg {...svgProps}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" /></svg>
        </button>
        <button data-testid="new-sale" className="icon-btn primary" title={reprint ? 'Close' : 'New sale'} aria-label={reprint ? 'Close' : 'New sale'} onClick={onClose}>
          <svg {...svgProps}><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <span className="muted"><b data-testid="receipt-no">{sale.receiptNo}</b>{reprint ? ' (reprint)' : ''}</span>
      </div>
      {problem && <p role="alert" className="no-print">{problem}</p>}
      <div className="receipt print-area" data-testid="receipt">
        {logoUrl && <img data-testid="receipt-logo" className="receipt-logo" src={logoUrl} alt="" />}
        <pre data-testid="receipt-text">{text ? text.join('\n') : ''}</pre>
      </div>
    </main>
  );
}
