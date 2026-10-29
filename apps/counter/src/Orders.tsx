import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { payOrder, recentReceipts, recordReprint, visibleOpenOrders, type Actor } from './sale.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';

const rs = (n: number) => formatRupees(paise(n));

export function Orders({ device, actor }: { device: DeviceInfo; actor: Actor }) {
  const [orders, setOrders] = useState<LocalSale[]>([]);
  const [paying, setPaying] = useState<LocalSale | null>(null);
  const [done, setDone] = useState<LocalSale | null>(null);
  const [copy, setCopy] = useState<LocalSale | null>(null);
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
  return (
    <main className="orders">
      <h2>{actor.role === 'cashier' ? 'Open orders' : 'Your open orders'}</h2>
      {orders.length === 0 && <p className="muted" data-testid="no-orders">No open orders.</p>}
      <ul>
        {orders.map((o) => (
          <li key={o.id} data-testid="order">
            <div>
              <b>₹{rs(o.totalPaise)}</b> <span className="muted">{new Date(o.createdAt).toLocaleTimeString()} · {o.createdByName}</span>
              <div>{o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</div>
            </div>
            {actor.role === 'cashier' && <button data-testid="pay-order" className="primary" onClick={() => setPaying(o)}>Pay</button>}
          </li>
        ))}
      </ul>
      {actor.role === 'cashier' && recent.length > 0 && (
        <>
          <h2>Recent receipts</h2>
          <ul>
            {recent.map((s) => (
              <li key={s.id} data-testid="recent-receipt">
                <div><b>₹{rs(s.totalPaise)}</b> <span className="muted">{s.receiptNo} · {new Date(s.createdAt).toLocaleTimeString()}</span></div>
                <button data-testid="reprint" onClick={() => setCopy(s)}>Reprint</button>
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
