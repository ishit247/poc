import { useCallback, useEffect, useState } from 'react';
import { api, rs, type Me } from './api.ts';
import { useT } from '../i18n.ts';

interface Line { externalOrderId: string; grossPaise: number; payoutPaise: number; result: 'matched' | 'amount_mismatch' | 'unknown_order'; ourPaise: number | null; orderStatus: string | null }
interface Missing { externalOrderId: string; ourPaise: number; businessDate: string }
interface Summary { lines: number; matched: number; amountMismatch: number; unknownOrder: number; notDelivered: number; missing: number; grossPaise: number; payoutPaise: number; commissionPaise: number; missingPaise: number }
interface Report { id: string; channel: string; filename: string; periodFrom: string; periodTo: string; uploadedAt: string; uploadedBy: string; lines: Line[]; missing: Missing[]; summary: Summary }
interface Row { id: string; channel: string; filename: string; periodFrom: string; periodTo: string; uploadedAt: string; lines: number; problems: number }

const MAX_BYTES = 1_400_000;
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
const RESULT_TEXT = { matched: 'Matches', amount_mismatch: 'Amount differs', unknown_order: 'We have no such order' } as const; // shown through t()

export function Settlements({ token }: { token: string }) {
  const t = useT();
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
      if (r.status !== 200) return setError(t('Your session has ended. Sign in again.'));
      const m = r.body as Me;
      setMe(m);
      if (m.outlets[0]) { setOutletId(m.outlets[0].id); setTo(m.outlets[0].today); setFrom(shift(m.outlets[0].today, -6)); }
    }).catch(() => setError(t('Could not reach the server.')));
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
    if (file.size > MAX_BYTES) return setError(t('That file is too large. Split it into smaller periods.'));
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await api(`/outlets/${outletId}/settlement-imports`, token, { method: 'POST', body: JSON.stringify({ channel, filename: file.name.slice(0, 200), periodFrom: from, periodTo: to, csv }) });
      if (r.status === 201) { setReport(r.body as Report); setFile(null); setFileKey((k) => k + 1); await loadPast(); }
      else if (r.status === 422) { setFaults(r.body.errors); setError(`${t('The file was not imported. Fix these and upload it again.')}${r.body.moreErrors ? ` (${t('{n} more not shown.', { n: r.body.moreErrors })})` : ''}`); }
      else if (r.body.error === 'invalid period') setError(t('The period must start on or before its end, and cover at most 93 days.'));
      else setError(t('Could not import the file.'));
    } catch { setError(t('Could not read the file or reach the server.')); } finally { setBusy(false); }
  };

  const open = async (id: string) => {
    setError('');
    try {
      const r = await api(`/outlets/${outletId}/settlement-imports/${id}`, token);
      if (r.status === 200) setReport(r.body as Report); else setError(t('Could not open that import.'));
    } catch { setError(t('Could not reach the server.')); }
  };

  const s = report?.summary;
  const [over, setOver] = useState(false);
  const pick = (f: File | undefined) => { if (f) { setFile(f); setFaults([]); setError(''); } };
  const stat = (label: string, value: string | number, testid?: string, bad = false) => (
    <div className="m-kpi"><small>{label}</small><div className={`v${bad ? ' warn' : ''}`} data-testid={testid}>{value}</div></div>
  );
  return (
    <main className="mgr">
      <div className="m-head"><h1>{t('Platform settlements')}</h1></div>
      {me && me.outlets.length === 0 && <p className="error">{t('No outlet is assigned to you.')}</p>}
      {me && me.outlets.length > 0 && (
        <section className="m-card">
          <header><h2>{t('Import a payout statement')}</h2></header>
          <div className="m-form">
            <div className="muted">{t('Upload the payout statement a platform sent. It is compared with our orders and reported; nothing we recorded is changed.')}</div>
            <div className="m-filters" style={{ padding: 0 }}>
              {me.outlets.length > 1 && (
                <label>{t('Outlet')}
                  <select data-testid="set-outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setFaults([]); setError(''); }}>
                    {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              <label>{t('Platform')}
                <select data-testid="set-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'zomato' | 'swiggy')}>
                  <option value="zomato">Zomato</option><option value="swiggy">Swiggy</option>
                </select>
              </label>
              <label>{t('From')} <input data-testid="set-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label>{t('To')} <input data-testid="set-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
            <label className={`m-drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}>
              <strong>{file ? file.name : t('Drop the CSV here')}</strong>
              <span className="muted">{file ? `${Math.max(1, Math.round(file.size / 1024))} KB · ${t('ready to import')}` : t('or click to choose a file')}</span>
              <span className="muted" style={{ fontSize: 13 }}>{t('.csv, up to {n} MB', { n: Math.round((MAX_BYTES / 1_000_000) * 10) / 10 })}</span>
              <input key={fileKey} data-testid="set-file" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <div className="m-dialog-actions">
              {file && <button onClick={() => { setFile(null); setFileKey((k) => k + 1); }}>{t('Remove file')}</button>}
              <button data-testid="set-send" className="primary" disabled={!file || !from || !to || busy} onClick={send}>{busy ? t('Importing…') : t('Import and compare')}</button>
            </div>
          </div>
        </section>
      )}
      {error && <div className="m-alert bad" role="alert" data-testid="set-error"><span>⚠</span><div className="grow">{error}</div></div>}
      {faults.length > 0 && (
        <ul data-testid="set-faults" className="m-card" style={{ margin: 0, padding: '10px 14px 10px 32px' }}>{faults.map((f, i) => <li key={i}>{f.row > 0 ? `${t('Row')} ${f.row}: ` : ''}{f.message}</li>)}</ul>
      )}

      {report && s && (
        <section data-testid="set-report" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{report.filename}</h2>
            <div className="muted">{report.channel} · {report.periodFrom} {t('to')} {report.periodTo} · {t('uploaded by')} {report.uploadedBy}</div>
          </div>
          <div className="m-kpis">
            {stat(t('Lines in the statement'), s.lines)}
            {stat(t('Match our orders'), s.matched, 'set-matched')}
            {stat(t('Amount differs'), s.amountMismatch, 'set-mismatch', s.amountMismatch > 0)}
            {stat(t('We have no such order'), s.unknownOrder, 'set-unknown', s.unknownOrder > 0)}
            {stat(t('Paid, not delivered by us'), s.notDelivered, 'set-undelivered', s.notDelivered > 0)}
            <div className="m-kpi"><small>{t('Delivered, not in the statement')}</small><div className={`v${s.missing ? ' warn' : ''}`} data-testid="set-missing">{s.missing} ({rs(s.missingPaise)})</div></div>
            <div className="m-kpi" style={{ gridColumn: 'span 2' }}><small>{t('Gross / payout / commission')}</small><div className="v" style={{ fontSize: 20 }}>{rs(s.grossPaise)} / {rs(s.payoutPaise)} / {rs(s.commissionPaise)}</div></div>
          </div>

          {report.lines.some((l) => l.result !== 'matched' || (l.orderStatus && l.orderStatus !== 'handed_over')) && (
            <section className="m-card">
              <header><h2>{t('Lines to look at')}</h2></header>
              <div className="m-scroll">
                <table className="m-table" data-testid="set-problems">
                  <thead><tr><th>{t('Order')}</th><th className="num">{t('Platform says')}</th><th className="num">{t('We have')}</th><th>{t('Problem')}</th></tr></thead>
                  <tbody>
                    {report.lines.filter((l) => l.result !== 'matched' || (l.orderStatus && l.orderStatus !== 'handed_over')).map((l) => (
                      <tr key={l.externalOrderId}>
                        <td>{l.externalOrderId}</td><td className="num">{rs(l.grossPaise)}</td><td className="num">{l.ourPaise === null ? '—' : rs(l.ourPaise)}</td>
                        <td className="warn">{l.result !== 'matched' ? t(RESULT_TEXT[l.result]) : t('Matches, but we {status} it', { status: l.orderStatus!.replace('_', ' ') })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {report.missing.length > 0 && (
            <section className="m-card">
              <header><h2>{t('Delivered by us, not in the statement')}</h2></header>
              <div className="m-scroll">
                <table className="m-table" data-testid="set-missing-list">
                  <thead><tr><th>{t('Order')}</th><th>{t('Day')}</th><th className="num">{t('Amount')}</th></tr></thead>
                  <tbody>{report.missing.map((m) => <tr key={m.externalOrderId}><td>{m.externalOrderId}</td><td>{m.businessDate}</td><td className="num">{rs(m.ourPaise)}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      )}

      {past.length > 0 && (
        <section className="m-card" data-testid="set-past">
          <header><h2>{t('Earlier imports')}</h2></header>
          <div className="m-scroll">
            <table className="m-table">
              <thead><tr><th>{t('File')}</th><th>{t('Platform')}</th><th>{t('Period')}</th><th>{t('Result')}</th><th /></tr></thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.id}>
                    <td>{p.filename}</td><td style={{ textTransform: 'capitalize' }}>{p.channel}</td><td>{p.periodFrom} {t('to')} {p.periodTo}</td>
                    <td><span className={`m-pill ${p.problems ? 'warn' : 'ok'}`}>{p.problems ? t('{n} to check', { n: p.problems }) : t('All match')}</span></td>
                    <td className="num"><button className="sm" data-testid={`set-open-${p.filename}`} onClick={() => open(p.id)}>{t('Open')}</button></td>
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
