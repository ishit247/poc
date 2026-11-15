import { useEffect, useState, type ComponentProps } from 'react';
import { liveQuery } from 'dexie';
import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import { payOrder, recentReceipts, recordReprint, visibleOpenOrders, type Actor } from './sale.ts';
import { PayDialog } from './PayDialog.tsx';
import { localSettings, orderDiscount, orderDue } from './order.ts';
import { Receipt } from './Receipt.tsx';
import { DraftBill, discountedBill, type DraftLine, type DraftTotals } from './DraftBill.tsx';
import { RefundDialog, RefundSlip } from './RefundDialog.tsx';
import { whyNotRefundableEach } from './refund.ts';
import { useT } from './i18n.ts';

const rs = (n: number) => formatRupees(paise(n));
/** 08:51:41 PM: two-digit hours, so the rows of a list line up. */
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const PrintIcon = () => (
  <svg {...svgProps}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" /></svg>
);

export function Orders({ device, actor }: { device: DeviceInfo; actor: Actor }) {
  const t = useT();
  const [orders, setOrders] = useState<LocalSale[]>([]);
  const [paying, setPaying] = useState<LocalSale | null>(null);
  const [done, setDone] = useState<LocalSale | null>(null);
  const [copy, setCopy] = useState<LocalSale | null>(null);
  const [bill, setBill] = useState<{ lines: DraftLine[]; totals: DraftTotals; discount: ComponentProps<typeof DraftBill>['discount'] } | null>(null);
  /** The bill as it will be paid: with the order's saved discount, if one applies. */
  const showBill = async (o: LocalSale) => {
    const rule = orderDiscount(o);
    setBill(rule ? discountedBill(o.lines, await localSettings(), rule) : {
      lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, unitPaise: l.unitPaise, netPaise: l.netPaise, gstRateBp: l.gstRateBp, taxPaise: l.taxPaise })),
      totals: { subtotalPaise: o.subtotalPaise, taxPaise: o.taxPaise, roundOffPaise: o.roundOffPaise, totalPaise: o.totalPaise },
      discount: null,
    });
  };
  const [recent, setRecent] = useState<{ sale: LocalSale; whyNot: string | null }[]>([]);
  const [refunding, setRefunding] = useState<LocalSale | null>(null);
  const [refunded, setRefunded] = useState<{ sale: LocalSale; rows: { method: 'cash' | 'upi'; amountPaise: number }[]; reason: string } | null>(null);

  useEffect(() => {
    const sub = liveQuery(() => visibleOpenOrders(actor)).subscribe({ next: setOrders });
    return () => sub.unsubscribe();
  }, [actor]);
  useEffect(() => {
    if (actor.role !== 'cashier') return; // a waiter never sees paid receipts
    // Live on the outbox and the drawer too: a bill becomes refundable once it has synced.
    const sub = liveQuery(async () => {
      const sales = await recentReceipts();
      const why = await whyNotRefundableEach(sales, actor);
      return sales.map((sale) => ({ sale, whyNot: why.get(sale.id) ?? null }));
    }).subscribe({ next: setRecent });
    return () => sub.unsubscribe();
  }, [actor]);

  if (refunded) return <RefundSlip {...refunded} device={device} actor={actor} onClose={() => setRefunded(null)} />;
  if (done) return <Receipt sale={done} device={device} onClose={() => setDone(null)} />;
  if (copy) return <Receipt sale={copy} device={device} reprint onReprint={() => recordReprint({ actor, saleId: copy.id })} onClose={() => setCopy(null)} />;
  if (bill) {
    return (
      <DraftBill
        lines={bill.lines} totals={bill.totals} discount={bill.discount}
        device={device} staffName={actor.name} onClose={() => setBill(null)}
      />
    );
  }
  return (
    <main className="orders">
      <h2>{actor.role === 'cashier' ? t('Open orders') : t('Your open orders')}</h2>
      {orders.length === 0 && <p className="muted" data-testid="no-orders">{t('No open orders.')}</p>}
      <ul>
        {orders.map((o) => (
          <li key={o.id} data-testid="order">
            <div className="what">
              <span className="muted"><span className="when">{when(o.createdAt)}</span> · {o.createdByName}</span>
              <div>{o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</div>
            </div>
            <span className="row">
              <b className="amt">₹{rs(orderDue(o))}</b>
              {actor.role === 'cashier' && <button data-testid="pay-order" className="pay-btn" onClick={() => setPaying(o)}>{t('Pay')}</button>}
              <button data-testid="print-order" className="icon-btn" title={t('Print bill')} aria-label={t('Print bill')} onClick={() => void showBill(o)}><PrintIcon /></button>
            </span>
          </li>
        ))}
      </ul>
      {actor.role === 'cashier' && recent.length > 0 && (
        <>
          <h2>{t('Recent receipts')}</h2>
          <ul>
            {recent.map(({ sale: s, whyNot }) => {
              const isRefunded = s.status === 'refunded';
              return (
                <li key={s.id} data-testid="recent-receipt" data-status={s.status}>
                  <div className="what">
                    <span className="muted"><span className="when">{when(s.createdAt)}</span> ·</span> {s.receiptNo}
                    {isRefunded && <span className="warn" data-testid="refunded-tag"> · {t('Refunded')}</span>}
                  </div>
                  <span className="row">
                    <b className="amt">₹{rs(s.totalPaise)}</b>
                    {/* One slot: Refund on a paid bill, the same button disabled (with why) on any other. */}
                    <button data-testid="refund" className="refund-btn" disabled={whyNot !== null} title={whyNot ?? t('Refund the whole bill')}
                      onClick={() => setRefunding(s)}>{t('Refund')}</button>
                    <button data-testid="reprint" className="icon-btn" disabled={isRefunded} title={isRefunded ? t('Refunded: no copy of the receipt') : t('Reprint')} aria-label={t('Reprint')} onClick={() => setCopy(s)}><PrintIcon /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {refunding && (
        <RefundDialog sale={refunding} device={device} actor={actor} onCancel={() => setRefunding(null)}
          onDone={(rows, reason) => { setRefunded({ sale: refunding, rows, reason }); setRefunding(null); }} />
      )}
      {paying && (
        <PayDialog
          lines={paying.lines}
          total={paise(paying.totalPaise)}
          discountable={paying.kind === 'order'} initialDiscount={orderDiscount(paying)}
          onCancel={() => setPaying(null)}
          onConfirm={async (tenders, discount) => {
            setDone(await payOrder({ device, actor, saleId: paying.id, tenders, discount, settings: discount ? await localSettings() : undefined }));
            setPaying(null);
          }}
        />
      )}
    </main>
  );
}
