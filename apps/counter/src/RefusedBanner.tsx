import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { formatRupees, paise } from '@pos/shared';
import { db, type LocalSale } from './db.ts';
import { acknowledgeRefused, refusedWhy, unacknowledgedRefused } from './refused.ts';

interface Shown { sale: LocalSale; table: string | null }

function useRefused(): Shown[] {
  const [v, setV] = useState<Shown[]>([]);
  useEffect(() => {
    const sub = liveQuery(async () => {
      const rows = await unacknowledgedRefused();
      return Promise.all(rows.map(async (sale) => {
        const t = sale.tableId ? await db.entities.get(['dining_table', sale.tableId]) : undefined;
        return { sale, table: t && t.data.isDefault !== true ? String(t.data.code) : null };
      }));
    }).subscribe({ next: setV, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
  }, []);
  return v;
}

const amount = (s: LocalSale) => s.payments.map((p) => `₹${formatRupees(paise(p.amountPaise))} ${p.method === 'cash' ? 'cash' : 'UPI'}`).join(' + ');

/**
 * Step 7d: a payment this tablet took was refused by the server. Shown on Sell and Shift until a manager acknowledges it
 * (Manager tools, on this tablet). It does not block selling or closing the shift.
 */
export function RefusedBanner() {
  const rows = useRefused();
  if (!rows.length) return null;
  return (
    <div data-testid="refused-banner" className="banner refused" role="alert">
      {rows.map(({ sale, table }) => (
        <p key={sale.id} data-testid="refused-row">
          <b>Receipt {sale.receiptNo}</b>{table ? ` (table ${table})` : ''}, {amount(sale)}: refused by the server, {refusedWhy(sale.refused?.reason)}.
          {' '}The customer paid: refund them or hand the money to a manager. A manager clears this under Manager tools.
        </p>
      ))}
    </div>
  );
}

/** In Manager tools: the refused payments this tablet holds, each acknowledged online by the signed-in manager. */
export function RefusedAck({ token, outletId }: { token: string; outletId: string }) {
  const rows = useRefused();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  if (!rows.length) return null;
  const ack = async (saleId: string) => {
    setError('');
    setBusy(saleId);
    try { await acknowledgeRefused({ token, outletId, saleId }); } catch (e) { setError(e instanceof Error ? e.message : 'Could not record it.'); } finally { setBusy(''); }
  };
  return (
    <section data-testid="mgr-refused">
      <h3>Payments the server refused on this tablet</h3>
      {rows.map(({ sale, table }) => (
        <p key={sale.id}>
          Receipt {sale.receiptNo}{table ? ` (table ${table})` : ''}, {amount(sale)}, {refusedWhy(sale.refused?.reason)}.{' '}
          <button data-testid="mgr-refused-ack" disabled={!!busy} onClick={() => ack(sale.id)}>{busy === sale.id ? 'Recording…' : 'I have dealt with it'}</button>
        </p>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
