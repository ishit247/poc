import { useEffect, useState } from 'react';
import { formatRupees, paise, renderReceipt } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { useLogoUrl } from './logo.ts';
import { outletInfo, toReceiptView } from './receipt.ts';

const rs = (n: number) => formatRupees(paise(n));

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
        <div className="receipt" data-testid="receipt">
          <h2>{device.outletName}</h2>
          <p><b data-testid="saved">Order saved</b>. A cashier will take payment.</p>
          <p className="muted">{new Date(sale.createdAt).toLocaleString()} · {sale.createdByName}</p>
          <ul>{sale.lines.map((l) => <li key={l.itemId}><span>{l.qty} × {l.name}</span><span>₹{rs(l.netPaise)}</span></li>)}</ul>
          <p><b>₹{rs(sale.totalPaise)}</b></p>
        </div>
        <button data-testid="new-sale" className="primary" onClick={onClose}>New sale</button>
      </main>
    );
  }
  return (
    <main className="center">
      <p className="no-print">Receipt <b data-testid="receipt-no">{sale.receiptNo}</b>{reprint ? ' (reprint)' : ''}</p>
      <div className="receipt print-area" data-testid="receipt">
        {logoUrl && <img data-testid="receipt-logo" className="receipt-logo" src={logoUrl} alt="" />}
        <pre data-testid="receipt-text">{text ? text.join('\n') : ''}</pre>
      </div>
      {problem && <p role="alert" className="no-print">{problem}</p>}
      <div className="no-print">
        <button data-testid="print" onClick={print}>{reprint ? 'Print copy' : 'Print'}</button>{' '}
        <button data-testid="new-sale" className="primary" onClick={onClose}>{reprint ? 'Close' : 'New sale'}</button>
      </div>
    </main>
  );
}
