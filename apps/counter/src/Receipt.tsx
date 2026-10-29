import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { useLogoUrl } from './logo.ts';

const rs = (n: number) => formatRupees(paise(n));

/** On-screen only. Printing and the final receipt layout come in phase 5. */
export function Receipt({ sale, device, onClose }: { sale: LocalSale; device: DeviceInfo; onClose: () => void }) {
  const logoUrl = useLogoUrl();
  return (
    <main className="center">
      <div className="receipt" data-testid="receipt">
        {logoUrl && <img data-testid="receipt-logo" className="receipt-logo" src={logoUrl} alt="" />}
        <h2>{device.outletName}</h2>
        {sale.receiptNo ? <p>Receipt <b data-testid="receipt-no">{sale.receiptNo}</b></p> : <p><b data-testid="saved">Order saved</b>. A cashier will take payment.</p>}
        <p className="muted">{new Date(sale.createdAt).toLocaleString()} · {sale.createdByName}</p>
        <ul>
          {sale.lines.map((l) => <li key={l.itemId}><span>{l.qty} × {l.name}</span><span>₹{rs(l.netPaise)}</span></li>)}
        </ul>
        <dl className="sums">
          <dt>Subtotal</dt><dd>₹{rs(sale.subtotalPaise)}</dd>
          {sale.taxPaise > 0 && (<><dt>GST</dt><dd>₹{rs(sale.taxPaise)}</dd></>)}
          {sale.roundOffPaise !== 0 && (<><dt>Round off</dt><dd>{sale.roundOffPaise < 0 ? '−' : '+'}₹{rs(Math.abs(sale.roundOffPaise))}</dd></>)}
          <dt className="total">Total</dt><dd className="total">₹{rs(sale.totalPaise)}</dd>
        </dl>
        {sale.payments.map((p, i) => (
          <p key={i} className="muted">{p.method === 'upi' ? 'UPI' : 'Cash'} ₹{rs(p.amountPaise)}{p.changePaise > 0 ? ` · change ₹${rs(p.changePaise)}` : ''}</p>
        ))}
      </div>
      <button data-testid="new-sale" className="primary" onClick={onClose}>New sale</button>
    </main>
  );
}
