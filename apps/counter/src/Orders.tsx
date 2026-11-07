import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { payOrder, recentReceipts, recordReprint, visibleOpenOrders, type Actor } from './sale.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';
import { DraftBill } from './DraftBill.tsx';

const rs = (n: number) => formatRupees(paise(n));
/** 08:51:41 PM: two-digit hours, so the rows of a list line up. */
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const PrintIcon = () => (
  <svg {...svgProps}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" /></svg>
);

export function Orders({ device, actor }: { device: DeviceInfo; actor: Actor }) {
  const [orders, setOrders] = useState<LocalSale[]>([]);
  const [paying, setPaying] = useState<LocalSale | null>(null);
  const [done, setDone] = useState<LocalSale | null>(null);
  const [copy, setCopy] = useState<LocalSale | null>(null);
  const [bill, setBill] = useState<LocalSale | null>(null);
  const [recent, setRecent] = useState<LocalSale[]>([]);

  useEffect(() => {
    const sub = liveQuery(() => visibleOpenOrders(actor)).subscribe({ next: setOrders });
    return () => sub.unsubscribe();
  }, [actor]);
  useEffect(() => {
    if (actor.role !== 'cashier') return; // a waiter never sees paid receipts
    const sub = liveQuery(() => recentReceipts()).subscribe({ next: setRecent });
    return () => sub.unsubscribe();
  }, [actor]);

  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;
  if (copy) return <Receipt sale={copy} device={device} reprint onReprint={() => recordReprint({ actor, saleId: copy.id })} onClose={() => setCopy(null)} />;
  if (bill) {
    return (
      <DraftBill
        lines={bill.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise }))}
        totals={{ subtotalPaise: bill.subtotalPaise, taxPaise: bill.taxPaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise }}
        device={device} staffName={actor.name} onClose={() => setBill(null)}
      />
    );
  }
  return (
    <main className="orders">
      <h2>{actor.role === 'cashier' ? 'Open orders' : 'Your open orders'}</h2>
      {orders.length === 0 && <p className="muted" data-testid="no-orders">No open orders.</p>}
      <ul>
        {orders.map((o) => (
          <li key={o.id} data-testid="order">
            <div className="what">
              <span className="muted"><span className="when">{when(o.createdAt)}</span> · {o.createdByName}</span>
              <div>{o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</div>
            </div>
            <span className="row">
              <b className="amt">₹{rs(o.totalPaise)}</b>
              {actor.role === 'cashier' && <button data-testid="pay-order" className="pay-btn" onClick={() => setPaying(o)}>Pay</button>}
              <button data-testid="print-order" className="icon-btn" title="Print bill" aria-label="Print bill" onClick={() => setBill(o)}><PrintIcon /></button>
            </span>
          </li>
        ))}
      </ul>
      {actor.role === 'cashier' && recent.length > 0 && (
        <>
          <h2>Recent receipts</h2>
          <ul>
            {recent.map((s) => (
              <li key={s.id} data-testid="recent-receipt">
                <div className="what"><span className="muted"><span className="when">{when(s.createdAt)}</span> ·</span> {s.receiptNo}</div>
                <span className="row">
                  <b className="amt">₹{rs(s.totalPaise)}</b>
                  <button data-testid="reprint" className="icon-btn" title="Reprint" aria-label="Reprint" onClick={() => setCopy(s)}><PrintIcon /></button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {paying && (
        <PayDialog
          total={paise(paying.totalPaise)}
          onCancel={() => setPaying(null)}
          onConfirm={async (tenders) => { setDone(await payOrder({ device, actor, saleId: paying.id, tenders })); setPaying(null); }}
        />
      )}
    </main>
  );
}
