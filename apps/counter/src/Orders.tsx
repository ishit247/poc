import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { payOrder, visibleOpenOrders, type Actor } from './sale.ts';
import { PayDialog } from './PayDialog.tsx';
import { Receipt } from './Receipt.tsx';

const rs = (n: number) => formatRupees(paise(n));

export function Orders({ device, actor }: { device: DeviceInfo; actor: Actor }) {
  const [orders, setOrders] = useState<LocalSale[]>([]);
  const [paying, setPaying] = useState<LocalSale | null>(null);
  const [done, setDone] = useState<LocalSale | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => visibleOpenOrders(actor)).subscribe({ next: setOrders });
    return () => sub.unsubscribe();
  }, [actor]);

  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;
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
