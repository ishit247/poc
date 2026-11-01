import { useCallback, useEffect, useState } from 'react';
import { api, rs, type Me } from './api.ts';

interface Line { externalOrderId: string; grossPaise: number; payoutPaise: number; result: 'matched' | 'amount_mismatch' | 'unknown_order'; ourPaise: number | null; orderStatus: string | null }
interface Missing { externalOrderId: string; ourPaise: number; businessDate: string }
interface Summary { lines: number; matched: number; amountMismatch: number; unknownOrder: number; notDelivered: number; missing: number; grossPaise: number; payoutPaise: number; commissionPaise: number; missingPaise: number }
interface Report { id: string; channel: string; filename: string; periodFrom: string; periodTo: string; uploadedAt: string; uploadedBy: string; lines: Line[]; missing: Missing[]; summary: Summary }
interface Row { id: string; channel: string; filename: string; periodFrom: string; periodTo: string; uploadedAt: string; lines: number; problems: number }

const MAX_BYTES = 1_400_000;
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
const RESULT_TEXT = { matched: 'Matches', amount_mismatch: 'Amount differs', unknown_order: 'We have no such order' } as const;

export function Settlements({ token }: { token: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState('');
  const [channel, setChannel] = useState<'zomato' | 'swiggy'>('zomato');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0); // a file input cannot be cleared by state; a new key makes a fresh one
  const [past, setPast] = useState<Row[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [faults, setFaults] = useState<{ row: number; message: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) return setError('Your session has ended. Sign in again.');
      const m = r.body as Me;
      setMe(m);
      if (m.outlets[0]) { setOutletId(m.outlets[0].id); setTo(m.outlets[0].today); setFrom(shift(m.outlets[0].today, -6)); }
    }).catch(() => setError('Could not reach the server.'));
  }, [token]);

  const loadPast = useCallback(async () => {
    if (!outletId) return;
    try {
      const r = await api(`/outlets/${outletId}/settlement-imports`, token);
      if (r.status === 200) setPast(r.body as Row[]);
    } catch { /* the list is a convenience; an upload reports its own errors */ }
  }, [outletId, token]);
  useEffect(() => { setReport(null); void loadPast(); }, [loadPast]);

  const send = async () => {
    if (!file) return;
    setError(''); setFaults([]);
    if (file.size > MAX_BYTES) return setError('That file is too large. Split it into smaller periods.');
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await api(`/outlets/${outletId}/settlement-imports`, token, { method: 'POST', body: JSON.stringify({ channel, filename: file.name.slice(0, 200), periodFrom: from, periodTo: to, csv }) });
      if (r.status === 201) { setReport(r.body as Report); setFile(null); setFileKey((k) => k + 1); await loadPast(); }
      else if (r.status === 422) { setFaults(r.body.errors); setError(`The file was not imported. Fix these and upload it again.${r.body.moreErrors ? ` (${r.body.moreErrors} more not shown.)` : ''}`); }
      else if (r.body.error === 'invalid period') setError('The period must start on or before its end, and cover at most 93 days.');
      else setError('Could not import the file.');
    } catch { setError('Could not read the file or reach the server.'); } finally { setBusy(false); }
  };

  const open = async (id: string) => {
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/settlement-imports/${id}`, token);
      if (r.status === 200) setReport(r.body as Report); else setError('Could not open that import.');
    } catch { setError('Could not reach the server.'); }
  };

  const s = report?.summary;
  return (
    <main className="mgr">
      <h1>Platform settlements</h1>
      <p className="muted">Upload the payout statement a platform sent. It is compared with our orders and reported; nothing we recorded is changed.</p>
      {me && me.outlets.length === 0 && <p className="error">No outlet is assigned to you.</p>}
      {me && me.outlets.length > 0 && (
        <div className="row wrap">
          {me.outlets.length > 1 && (
            <select data-testid="set-outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setFaults([]); setError(''); }}>
              {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <select data-testid="set-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'zomato' | 'swiggy')}>
            <option value="zomato">Zomato</option><option value="swiggy">Swiggy</option>
          </select>
          <label>From <input data-testid="set-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input data-testid="set-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <input key={fileKey} data-testid="set-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setFaults([]); setError(''); }} />
          <button data-testid="set-send" className="primary" disabled={!file || !from || !to || busy} onClick={send}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      )}
      {error && <p className="error" role="alert" data-testid="set-error">{error}</p>}
      {faults.length > 0 && (
        <ul data-testid="set-faults">{faults.map((f, i) => <li key={i}>{f.row > 0 ? `Row ${f.row}: ` : ''}{f.message}</li>)}</ul>
      )}

      {report && s && (
        <section data-testid="set-report">
          <h2>{report.filename}</h2>
          <p className="muted">{report.channel} · {report.periodFrom} to {report.periodTo} · uploaded by {report.uploadedBy}</p>
          <table>
            <tbody>
              <tr><td>Lines in the statement</td><td>{s.lines}</td></tr>
              <tr><td>Match our orders</td><td data-testid="set-matched">{s.matched}</td></tr>
              <tr><td>Amount differs</td><td data-testid="set-mismatch" className={s.amountMismatch ? 'warn' : ''}>{s.amountMismatch}</td></tr>
              <tr><td>We have no such order</td><td data-testid="set-unknown" className={s.unknownOrder ? 'warn' : ''}>{s.unknownOrder}</td></tr>
              <tr><td>Paid but not delivered by us</td><td data-testid="set-undelivered" className={s.notDelivered ? 'warn' : ''}>{s.notDelivered}</td></tr>
              <tr><td>Delivered but not in the statement</td><td data-testid="set-missing" className={s.missing ? 'warn' : ''}>{s.missing} ({rs(s.missingPaise)})</td></tr>
              <tr><td>Gross / payout / commission</td><td>{rs(s.grossPaise)} / {rs(s.payoutPaise)} / {rs(s.commissionPaise)}</td></tr>
            </tbody>
          </table>

          {report.lines.some((l) => l.result !== 'matched' || (l.orderStatus && l.orderStatus !== 'handed_over')) && (
            <>
              <h3>Lines to look at</h3>
              <div className="scroll">
                <table data-testid="set-problems">
                  <thead><tr><th>Order</th><th>Platform says</th><th>We have</th><th>Problem</th></tr></thead>
                  <tbody>
                    {report.lines.filter((l) => l.result !== 'matched' || (l.orderStatus && l.orderStatus !== 'handed_over')).map((l) => (
                      <tr key={l.externalOrderId}>
                        <td>{l.externalOrderId}</td><td>{rs(l.grossPaise)}</td><td>{l.ourPaise === null ? '—' : rs(l.ourPaise)}</td>
                        <td className="warn">{l.result !== 'matched' ? RESULT_TEXT[l.result] : `Matches, but we ${l.orderStatus!.replace('_', ' ')} it`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {report.missing.length > 0 && (
            <>
              <h3>Delivered by us, not in the statement</h3>
              <div className="scroll">
                <table data-testid="set-missing-list">
                  <thead><tr><th>Order</th><th>Day</th><th>Amount</th></tr></thead>
                  <tbody>{report.missing.map((m) => <tr key={m.externalOrderId}><td>{m.externalOrderId}</td><td>{m.businessDate}</td><td>{rs(m.ourPaise)}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {past.length > 0 && (
        <section data-testid="set-past">
          <h3>Earlier imports</h3>
          <div className="scroll">
            <table>
              <tbody>
                {past.map((p) => (
                  <tr key={p.id}>
                    <td>{p.filename}</td><td>{p.channel}</td><td>{p.periodFrom} to {p.periodTo}</td>
                    <td className={p.problems ? 'warn' : ''}>{p.problems ? `${p.problems} to check` : 'all match'}</td>
                    <td><button data-testid={`set-open-${p.filename}`} onClick={() => open(p.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
