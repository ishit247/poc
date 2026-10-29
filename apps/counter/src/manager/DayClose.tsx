import { useCallback, useEffect, useState } from 'react';
import { api, rs, type Me, type Preview } from './api.ts';
import { ForceClose } from './ForceClose.tsx';

export function DayClose({ token, onDone }: { token: string; onDone: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState('');
  const [date, setDate] = useState('');
  const [view, setView] = useState<Preview | null>(null);
  const [acked, setAcked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) return setError('Your session has ended. Sign in again.');
      const m = r.body as Me;
      setMe(m);
      if (m.outlets[0]) { setOutletId(m.outlets[0].id); setDate(m.outlets[0].today); }
    }).catch(() => setError('Could not reach the server.'));
  }, [token]);

  const load = useCallback(async () => {
    if (!outletId || !date) return;
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/day-close?date=${date}`, token);
      if (r.status !== 200) return setError('Could not load this day.');
      setView(r.body as Preview);
      setAcked([]);
    } catch { setError('Could not reach the server.'); }
  }, [outletId, date, token]);
  useEffect(() => { setView(null); void load(); }, [load]);

  const close = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/day-close`, token, { method: 'POST', body: JSON.stringify({ date, acknowledgedDeviceIds: acked }) });
      if (r.status === 409 && r.body.error === 'cannot close') setError('Something changed while you were looking. Check the list below and try again.');
      else if (r.status !== 200) setError(r.body.error === 'already closed' ? 'This day was already closed.' : 'Could not close the day.');
      await load();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };

  const outlet = me?.outlets.find((o) => o.id === outletId);
  const b = view?.blockers;
  const stuck = b ? b.devices.filter((d) => d.blocking && !acked.includes(d.id)) : [];
  const canClose = !!view && !view.closed && !!b && b.openShifts.length === 0 && b.openSales === 0 && stuck.length === 0;
  const t = view?.totals;

  return (
    <main className="mgr">
      <div className="row">
        <h1>Close the day</h1>
        <span className="spacer" />
        <span className="muted">{me?.name}</span>
        <button data-testid="mgr-exit" onClick={onDone}>Sign out</button>
      </div>
      {me && me.outlets.length === 0 && <p className="error">No outlet is assigned to you.</p>}
      {me && me.outlets.length > 0 && (
        <div className="row">
          {me.outlets.length > 1 && (
            <select data-testid="mgr-outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setDate(me.outlets.find((o) => o.id === e.target.value)!.today); }}>
              {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <input data-testid="mgr-date" type="date" value={date} max={outlet?.today} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {view?.closed && <p data-testid="mgr-closed" className="ok">Closed {view.closedAt ? new Date(view.closedAt).toLocaleString() : ''}. These figures are final.</p>}
      {view && !view.closed && view.provisional && <p className="muted">This day is still running, so the figures can still change.</p>}

      {b && !view?.closed && (
        <section data-testid="mgr-blockers">
          <h2>Before you can close</h2>
          {b.openShifts.length === 0 && b.openSales === 0 && b.devices.every((d) => !d.blocking) && <p className="ok">Nothing is holding this day open.</p>}
          {b.openShifts.map((s) => (
            <ForceClose key={s.id} shift={s} onClose={async (counted) => {
              const r = await api(`/outlets/${outletId}/shifts/${s.id}/force-close`, token, { method: 'POST', body: JSON.stringify({ countedCashPaise: counted }) });
              if (r.status === 409) setError('That drawer was already closed.');
              else if (r.status !== 200) setError('Could not close that drawer.');
              await load();
            }} />
          ))}
          {b.openSales > 0 && <p className="warn">{b.openSales} open order{b.openSales === 1 ? '' : 's'} not yet paid or voided.</p>}
          {b.devices.map((d) => (
            <p key={d.id} className={d.blocking ? 'warn' : 'muted'} data-testid={`mgr-device-${d.counter}`}>
              Counter {d.counter}{d.label ? ` (${d.label})` : ''}: {d.outboxPending === null ? 'never reported' : `${d.outboxPending} unsent`}
              {' · last heard '}{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}
              {d.blocking && (
                <label> <input type="checkbox" checked={acked.includes(d.id)} style={{ width: 'auto', minHeight: 0 }}
                  onChange={(e) => setAcked(e.target.checked ? [...acked, d.id] : acked.filter((x) => x !== d.id))} />
                  {' '}Close without it. {d.outboxPending} record{d.outboxPending === 1 ? '' : 's'} on that tablet will count as late.</label>
              )}
            </p>
          ))}
        </section>
      )}

      {view && !view.closed && !t && <p data-testid="mgr-empty" className="muted">Nothing has been sold at this outlet on {date} yet.</p>}
      {t && (
        <section data-testid="mgr-totals">
          <h2>{view?.closed ? 'Totals' : 'Totals so far'}</h2>
          <table>
            <tbody>
              <tr><td>Paid sales</td><td>{t.paidSales}</td></tr>
              <tr><td>Gross</td><td data-testid="mgr-gross">{rs(t.grossPaise)}</td></tr>
              <tr><td>of which tax</td><td>{rs(t.taxPaise)}</td></tr>
              <tr><td>Cash</td><td>{rs(t.cashPaise)}</td></tr>
              <tr><td>UPI</td><td>{rs(t.upiPaise)}</td></tr>
              <tr><td>Online</td><td>{rs(t.onlineGrossPaise)}</td></tr>
              <tr><td>Voids</td><td>{t.voids} ({rs(t.voidTotalPaise)})</td></tr>
              <tr><td>Refunds</td><td>{t.refunds} ({rs(t.refundTotalPaise)})</td></tr>
              <tr><td>Drawer variance</td><td className={t.varianceTotalPaise === 0 ? '' : 'warn'}>{rs(t.varianceTotalPaise)}</td></tr>
            </tbody>
          </table>
          {t.shifts.length > 0 && (
            <>
              <h3>Shifts</h3>
              <table>
                <thead><tr><th>Counter</th><th>Cashier</th><th>Float</th><th>Counted</th><th>Expected</th><th>Variance</th></tr></thead>
                <tbody>
                  {t.shifts.map((s) => <tr key={s.id}><td>{s.counter}</td><td>{s.cashier}</td><td>{rs(s.float)}</td><td>{rs(s.counted)}</td><td>{rs(s.expected)}</td><td className={s.variance === 0 ? '' : 'warn'}>{rs(s.variance)}</td></tr>)}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {view && (view.closed ? t?.receiptGaps : view.receiptGaps)?.map((g) => (
        <p key={g.deviceId} className="warn" data-testid="mgr-gap">Counter {g.counter}: receipt {g.missing.join(', ')} never reached the server.</p>
      ))}
      {view && (view.lateAdjustments.length > 0 || (t?.lateAdjustments?.length ?? 0) > 0) && (
        <section data-testid="mgr-late">
          <h3>Sales from earlier days that arrived late</h3>
          {(view.closed ? t?.lateAdjustments ?? [] : view.lateAdjustments).map((a) => <p key={a.id}>{a.receiptNo} · {a.businessDate} · {a.status} · {rs(a.totalPaise)}</p>)}
        </section>
      )}

      {view && !view.closed && <button data-testid="mgr-close" className="primary" disabled={!canClose || busy} onClick={close}>{busy ? 'Closing…' : `Close ${date}`}</button>}
    </main>
  );
}
