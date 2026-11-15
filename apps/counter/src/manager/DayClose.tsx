import { useCallback, useEffect, useState } from 'react';
import { api, rs, type Me, type Preview } from './api.ts';
import { ForceClose } from './ForceClose.tsx';
import { VoidOrder } from './VoidOrder.tsx';
import { t as tr, tn, useT } from '../i18n.ts';

type Sub = 'overview' | 'drawers' | 'orders' | 'tablets' | 'totals';
const pretty = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const pct = (part: number, whole: number) => (whole > 0 ? tr('{n}% of sales', { n: Math.round((part / whole) * 100) }) : '');
const Count = ({ n }: { n: number }) => <span className={`m-count${n ? '' : ' ok'}`}>{n || '✓'}</span>;

/**
 * Close the day. A sticky bar at the top says whether the day can close and holds the Close button; below it one section at
 * a time (Overview, Drawers, Orders, Tablets, Totals) so the manager is never looking at everything at once. Every section
 * stays in the page (just hidden) so what the manager typed in one is not lost when they look at another.
 */
export function DayClose({ token, onBlockers }: { token: string; onBlockers?: (n: number) => void }) {
  const tx = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState('');
  const [date, setDate] = useState('');
  const [view, setView] = useState<Preview | null>(null);
  const [acked, setAcked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<Sub>('overview');
  const [showHealthy, setShowHealthy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) return setError(tx('Your session has ended. Sign in again.'));
      const m = r.body as Me;
      setMe(m);
      if (m.outlets[0]) { setOutletId(m.outlets[0].id); setDate(m.outlets[0].today); }
    }).catch(() => setError(tx('Could not reach the server.')));
  }, [token]);

  const load = useCallback(async () => {
    if (!outletId || !date) return;
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/day-close?date=${date}`, token);
      if (r.status !== 200) return setError(tx('Could not load this day.'));
      setView(r.body as Preview);
      setAcked([]);
    } catch { setError(tx('Could not reach the server.')); }
  }, [outletId, date, token]);
  useEffect(() => { setView(null); void load(); }, [load]);

  const close = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/day-close`, token, { method: 'POST', body: JSON.stringify({ date, acknowledgedDeviceIds: acked }) });
      if (r.status === 409 && r.body.error === 'cannot close') setError(tx('Something changed while you were looking. Check the sections below and try again.'));
      else if (r.status !== 200) setError(r.body.error === 'already closed' ? tx('This day was already closed.') : tx('Could not close the day.'));
      await load();
    } catch { setError(tx('Could not reach the server.')); } finally { setBusy(false); }
  };

  const outlet = me?.outlets.find((o) => o.id === outletId);
  const b = view?.blockers;
  const t = view?.totals;
  const isClosed = !!view?.closed;
  const nDrawers = b?.openShifts.length ?? 0;
  const nOrders = b?.openSales ?? 0;
  const stuck = b ? b.devices.filter((d) => d.blocking && !acked.includes(d.id)) : [];
  const healthy = b ? b.devices.filter((d) => !d.blocking || acked.includes(d.id)) : [];
  const canClose = !!view && !isClosed && !!b && nDrawers === 0 && nOrders === 0 && stuck.length === 0;
  const sections = (nDrawers ? 1 : 0) + (nOrders ? 1 : 0) + (stuck.length ? 1 : 0);
  useEffect(() => { onBlockers?.(view && !isClosed ? sections : 0); }, [view, isClosed, sections, onBlockers]);

  const gaps = (isClosed ? t?.receiptGaps : view?.receiptGaps) ?? [];
  const refused = (isClosed ? t?.refusedReceipts : view?.refusedReceipts) ?? [];
  const late = isClosed ? t?.lateAdjustments ?? [] : view?.lateAdjustments ?? [];
  const exceptions = gaps.length + refused.filter((x) => !x.acknowledgedAt).length;

  const row = (n: number, label: string, okText: string, todoText: string, to: Sub) => (
    <div className="m-check">
      <div className={`ic ${n ? 'warn' : 'ok'}`}>{n ? '!' : '✓'}</div>
      <div><b>{label}</b><span className="d">{n ? todoText : okText}</span></div>
      <span className={`m-pill ${n ? 'warn' : 'ok'}`}>{n ? tx('{n} to do', { n }) : tx('Done')}</span>
      <button className={`sm${n ? '' : ' ghost'}`} data-testid={`mgr-review-${to}`} onClick={() => setSub(to)}>{n ? tx('Review') : tx('View')}</button>
    </div>
  );
  const summary = [nDrawers && tn(nDrawers, '{n} drawer', '{n} drawers'), nOrders && tn(nOrders, '{n} order', '{n} orders'), stuck.length && tn(stuck.length, '{n} tablet', '{n} tablets')].filter(Boolean).join(' · ');

  return (
    <main className="mgr">
      <div className={`m-cmd ${isClosed || canClose ? 'ready' : 'blocked'}`}>
        <div className="status" data-testid={isClosed ? 'mgr-closed' : undefined}>
          <div className="ic">{isClosed ? '🔒' : canClose ? '✓' : '!'}</div>
          <div style={{ minWidth: 0 }}>
            <div className="t">
              {!view ? tx('Loading…') : isClosed ? tx('{date} is closed', { date: pretty(date) }) : canClose ? tx('Ready to close {date}', { date: pretty(date) }) : tn(sections, '{n} thing to sort out before you can close', '{n} things to sort out before you can close')}
            </div>
            <div className="s">
              {!view ? '' : isClosed ? tx('Closed {time}. These figures are final.', { time: view.closedAt ? new Date(view.closedAt).toLocaleString() : '' })
                : canClose ? tx('Nothing is holding this day open.') : summary}
            </div>
          </div>
        </div>
        {me && me.outlets.length > 1 && (
          <select data-testid="mgr-outlet" aria-label={tx('Outlet')} value={outletId} onChange={(e) => { setOutletId(e.target.value); setDate(me.outlets.find((o) => o.id === e.target.value)!.today); }}>
            {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        {me && me.outlets.length > 0 && <input data-testid="mgr-date" aria-label={tx('Business date')} type="date" value={date} max={outlet?.today} onChange={(e) => e.target.value && setDate(e.target.value)} />}
        {view && !isClosed && <button data-testid="mgr-close" className="primary" disabled={!canClose || busy} onClick={close}>{busy ? tx('Closing…') : tx('Close {date}', { date: pretty(date) })}</button>}
      </div>

      {me && me.outlets.length === 0 && <p className="error">{tx('No outlet is assigned to you.')}</p>}
      {error && <div className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div></div>}

      <div className="m-subnav" role="tablist">
        <button role="tab" aria-selected={sub === 'overview'} className={sub === 'overview' ? 'active' : ''} data-testid="mgr-sub-overview" onClick={() => setSub('overview')}>{tx('Overview')}</button>
        {!isClosed && <button role="tab" aria-selected={sub === 'drawers'} className={sub === 'drawers' ? 'active' : ''} data-testid="mgr-sub-drawers" onClick={() => setSub('drawers')}>{tx('Drawers')} {b && <Count n={nDrawers} />}</button>}
        {!isClosed && <button role="tab" aria-selected={sub === 'orders'} className={sub === 'orders' ? 'active' : ''} data-testid="mgr-sub-orders" onClick={() => setSub('orders')}>{tx('Orders')} {b && <Count n={nOrders} />}</button>}
        {!isClosed && <button role="tab" aria-selected={sub === 'tablets'} className={sub === 'tablets' ? 'active' : ''} data-testid="mgr-sub-tablets" onClick={() => setSub('tablets')}>{tx('Tablets')} {b && <Count n={stuck.length} />}</button>}
        <button role="tab" aria-selected={sub === 'totals'} className={sub === 'totals' ? 'active' : ''} data-testid="mgr-sub-totals" onClick={() => setSub('totals')}>{tx('Totals')} {view && exceptions > 0 && <span className="m-count">{exceptions}</span>}</button>
      </div>

      {/* Overview: the whole day at a glance, each blocker one tap away */}
      <div hidden={sub !== 'overview'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {view && !isClosed && view.provisional && <div className="m-alert info"><span>ⓘ</span><div className="grow">{tx('This day is still running, so the figures can still change.')}</div></div>}
        {t && (
          <div className="m-kpis" data-testid="mgr-totals">
            <div className="m-kpi main"><small>{tx('Gross sales')}</small><div className="v">₹<span data-testid="mgr-gross">{rs(t.grossPaise)}</span></div><div className="d">{tn(t.paidSales, '{n} paid sale', '{n} paid sales')} · {tx('tax')} ₹{rs(t.taxPaise)}</div></div>
            <div className="m-kpi"><small>{tx('Cash')}</small><div className="v">₹{rs(t.cashPaise)}</div><div className="d">{pct(t.cashPaise, t.grossPaise)}</div></div>
            <div className="m-kpi"><small>UPI</small><div className="v">₹{rs(t.upiPaise)}</div><div className="d">{pct(t.upiPaise, t.grossPaise)}</div></div>
            <div className="m-kpi"><small>{tx('Online')}</small><div className="v">₹{rs(t.onlineGrossPaise)}</div><div className="d">{pct(t.onlineGrossPaise, t.grossPaise)}</div></div>
          </div>
        )}
        {view && !isClosed && !t && <p data-testid="mgr-empty" className="muted" style={{ margin: 0 }}>{tx('Nothing has been sold at this outlet on {date} yet.', { date: pretty(date) })}</p>}
        {b && !isClosed && (
          <section className="m-card">
            <header><h2>{tx('Before you can close')}</h2></header>
            {row(nDrawers, tx('Drawers'), tx('Every drawer is closed.'), tn(nDrawers, '{n} drawer still open. Count the cash and close.', '{n} drawers still open. Count the cash and close.'), 'drawers')}
            {row(nOrders, tx('Open orders'), tx('Every order is paid or voided.'), tn(nOrders, '{n} order not yet paid or voided.', '{n} orders not yet paid or voided.'), 'orders')}
            {row(stuck.length, tx('Tablets'), tx('Every tablet has sent its records.'), tn(stuck.length, '{n} tablet with records not yet sent.', '{n} tablets with records not yet sent.'), 'tablets')}
          </section>
        )}
        {view && !isClosed && exceptions > 0 && (
          <div className="m-alert"><span>⚠</span><div className="grow">{tn(exceptions, '{n} exception to look at in Totals (missing receipts or refused payments).', '{n} exceptions to look at in Totals (missing receipts or refused payments).')}</div><button className="sm" onClick={() => setSub('totals')}>{tx('Review')}</button></div>
        )}
      </div>

      {b && !isClosed && (
        <div data-testid="mgr-blockers" style={{ display: 'contents' }}>
          <section className="m-card" hidden={sub !== 'drawers'}>
            <header><h2>{tx('Open drawers')}</h2><span className={`m-pill ${nDrawers ? 'warn' : 'ok'}`}>{nDrawers ? tx('{n} open', { n: nDrawers }) : tx('All closed')}</span><span className="spacer" /><span className="muted" style={{ fontSize: 14 }}>{tx('Count the cash, then close each drawer.')}</span></header>
            {nDrawers === 0 && <div className="m-row"><b className="ok">{tx('✓ Every drawer is closed')}</b></div>}
            {b.openShifts.map((s) => (
              <ForceClose key={s.id} shift={s} onClose={async (counted) => {
                const r = await api(`/outlets/${outletId}/shifts/${s.id}/force-close`, token, { method: 'POST', body: JSON.stringify({ countedCashPaise: counted }) });
                if (r.status === 409) setError(tx('That drawer was already closed.'));
                else if (r.status !== 200) setError(tx('Could not close that drawer.'));
                await load();
              }} />
            ))}
          </section>

          <section className="m-card" hidden={sub !== 'orders'}>
            <header><h2>{tx('Open orders')}</h2>{nOrders > 0 ? <span className="m-pill warn" data-testid="mgr-open-count">{tx('{n} not yet paid or voided', { n: nOrders })}</span> : <span className="m-pill ok">{tx('None open')}</span>}</header>
            {nOrders === 0 && <div className="m-row"><b className="ok">{tx('✓ No open orders')}</b></div>}
            {b.openOrders.map((o) => (
              <VoidOrder key={o.id} order={o} today={outlet?.today ?? date} onVoid={async (reason) => {
                const r = await api(`/orders/${o.id}/void`, token, { method: 'POST', body: JSON.stringify({ reason }) });
                if (r.status === 404) setError(tx('That order is no longer open (paid or voided elsewhere).'));
                else if (r.status !== 200) setError(tx('Could not void that order.'));
                await load();
              }} />
            ))}
            {nOrders > b.openOrders.length && <div className="m-row"><span className="muted">{tx('Showing the first {n}; void these and the rest appear.', { n: b.openOrders.length })}</span></div>}
          </section>

          <section className="m-card" hidden={sub !== 'tablets'}>
            <header><h2>{tx('Tablets')}</h2><span className={`m-pill ${stuck.length ? 'warn' : 'ok'}`}>{stuck.length ? tx('{a} synced, {b} need a decision', { a: healthy.length, b: stuck.length }) : tx('All {n} accounted for', { n: b.devices.length })}</span></header>
            {stuck.map((d) => (
              <div key={d.id} className="m-row" data-testid={`mgr-device-${d.counter}`}>
                <div className="main">
                  <b><span className="warn">●</span> {tx('Counter')} {d.counter}{d.label ? ` (${d.label})` : ''}</b>
                  <span>{d.outboxPending === null ? tx('Never reported') : tx('{n} unsent', { n: d.outboxPending })} · {tx('last heard')} {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : tx('never')}</span>
                </div>
                <label className="m-ack"><input type="checkbox" checked={acked.includes(d.id)} onChange={(e) => setAcked(e.target.checked ? [...acked, d.id] : acked.filter((x) => x !== d.id))} />
                  <span>{tx('Close without it')}<br /><small className="muted" style={{ fontWeight: 400 }}>{tn(d.outboxPending ?? 0, '{n} record on that tablet will count as late.', '{n} records on that tablet will count as late.')}</small></span>
                </label>
              </div>
            ))}
            {healthy.length > 0 && (
              <div className="m-row">
                <div className="main"><b className="ok">● {tn(healthy.length, '{n} tablet synced', '{n} tablets synced')}</b><span>{tx('Nothing waiting to be sent.')}</span></div>
                <button className="sm ghost" onClick={() => setShowHealthy(!showHealthy)}>{showHealthy ? tx('Hide') : tx('Show')}</button>
              </div>
            )}
            {showHealthy && healthy.map((d) => (
              <div key={d.id} className="m-row" data-testid={`mgr-device-${d.counter}`}>
                <div className="main"><b>{tx('Counter')} {d.counter}{d.label ? ` (${d.label})` : ''}</b><span>{d.outboxPending === null ? tx('Never reported') : tx('{n} unsent', { n: d.outboxPending })} · {tx('last heard')} {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : tx('never')}</span></div>
              </div>
            ))}
          </section>
        </div>
      )}

      <div hidden={sub !== 'totals'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {view && !t && <p className="muted" style={{ margin: 0 }}>{tx('Nothing has been sold on {date} yet.', { date: pretty(date) })}</p>}
        {t && (
          <>
            <div className="m-cols">
              <section className="m-card">
                <header><h2>{isClosed ? tx('Payment mix') : tx('Payment mix so far')}</h2></header>
                <table className="m-table">
                  <tbody>
                    <tr><td>{tx('Paid sales')}</td><td className="num">{t.paidSales}</td></tr>
                    <tr><td>{tx('Cash')}</td><td className="num">₹{rs(t.cashPaise)}</td></tr>
                    <tr><td>UPI</td><td className="num">₹{rs(t.upiPaise)}</td></tr>
                    <tr><td>{tx('Online')}</td><td className="num">₹{rs(t.onlineGrossPaise)}</td></tr>
                    <tr><td>{tx('of which tax')}</td><td className="num">₹{rs(t.taxPaise)}</td></tr>
                  </tbody>
                  <tfoot><tr><td>{tx('Gross')}</td><td className="num">₹{rs(t.grossPaise)}</td></tr></tfoot>
                </table>
              </section>
              <section className="m-card">
                <header><h2>{tx('Exceptions')}</h2></header>
                <table className="m-table">
                  <tbody>
                    <tr><td>{tx('Voids')}</td><td className="num">{t.voids} · ₹{rs(t.voidTotalPaise)}</td></tr>
                    <tr><td>{tx('Refunds')}</td><td className="num">{t.refunds} · ₹{rs(t.refundTotalPaise)}</td></tr>
                    {/* Days closed before discounts existed froze totals without this line. */}
                    {t.discountPaise !== undefined && (
                      <tr><td title={tx('Bill discounts given at payment. Gross sales above is already after them.')}>{tx('Discounts')}</td>
                        <td className="num" data-testid="dc-discounts">{t.discountedSales ?? 0} · ₹{rs(t.discountPaise)}</td></tr>
                    )}
                    {/* Days closed before 2026-11-15 froze totals without this line. */}
                    {t.onlineNotCompleted !== undefined && (
                      <tr><td title={tx('Rejected, cancelled or expired platform orders received this day. Not in Voids.')}>{tx('Online not completed')}</td>
                        <td className="num" data-testid="dc-online-not-completed">{t.onlineNotCompleted} · ₹{rs(t.onlineNotCompletedPaise ?? 0)}</td></tr>
                    )}
                    <tr><td>{tx('Drawer variance')}</td><td className={`num${t.varianceTotalPaise === 0 ? '' : ' warn'}`}>₹{rs(t.varianceTotalPaise)}</td></tr>
                  </tbody>
                </table>
              </section>
            </div>
            {t.shifts.length > 0 && (
              <section className="m-card">
                <header><h2>{tx('Shifts')}</h2></header>
                <div className="m-scroll">
                  <table className="m-table">
                    <thead><tr><th>{tx('Counter')}</th><th>{tx('Cashier')}</th><th className="num">{tx('Float')}</th><th className="num">{tx('Counted')}</th><th className="num">{tx('Expected')}</th><th className="num">{tx('Variance')}</th></tr></thead>
                    <tbody>
                      {t.shifts.map((s) => (
                        <tr key={s.id}>
                          <td>{s.counter}</td><td>{s.cashier}</td><td className="num">{rs(s.float)}</td><td className="num">{rs(s.counted)}</td>
                          <td className="num">{rs(s.expected)}{s.refused ? <span className="warn" data-testid="mgr-shift-refused"> ({tx('of which {amt} refused', { amt: rs(s.refused) })})</span> : null}
                            {s.refundedCash ? <span className="muted" data-testid="mgr-shift-refunded"> ({tx('after {amt} cash refunded', { amt: rs(s.refundedCash) })})</span> : null}</td>
                          <td className={`num${s.variance === 0 ? '' : ' warn'}`}>{rs(s.variance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
        {gaps.map((g) => (
          <div key={g.deviceId} className="m-alert" data-testid="mgr-gap"><span>⚠</span><div className="grow">{tx('Counter {c}: receipt {r} never reached the server.', { c: g.counter, r: g.missing.join(', ') })}</div></div>
        ))}
        {refused.map((x) => (
          <div key={x.eventId} className="m-alert" data-testid="mgr-refused-receipt"><span>⚠</span>
            <div className="grow">
              {tx('Counter {c}: receipt {r} was paid', { c: x.counter, r: x.receiptNo ?? '' })} ({x.cashPaise ? `₹${rs(x.cashPaise)} ${tx('Cash')}` : ''}{x.cashPaise && x.upiPaise ? ' + ' : ''}{x.upiPaise ? `₹${rs(x.upiPaise)} UPI` : ''}) {tx('but refused:')}
              {' '}{x.reason === 'sale_void' ? tx('the order was voided on another device first') : tx('the table was already paid on another counter')}.
              {x.afterDrawerClosed && <b data-testid="mgr-refused-late"> {tx("It arrived after that drawer was closed, so its cash is not in that shift's expected figure: count it separately.")}</b>}
              {x.acknowledgedAt ? ` ${tx('Dealt with by {name}.', { name: x.acknowledgedBy ?? tx('a manager') })}` : ` ${tx('Not yet dealt with.')}`}
            </div>
          </div>
        ))}
        {late.length > 0 && (
          <section className="m-card" data-testid="mgr-late">
            <header><h2>{tx('Sales from earlier days that arrived late')}</h2></header>
            {late.map((a) => <div key={a.id} className="m-row"><span>{a.receiptNo} · {a.businessDate} · {a.status}</span><b>₹{rs(a.totalPaise)}</b></div>)}
          </section>
        )}
      </div>
    </main>
  );
}
