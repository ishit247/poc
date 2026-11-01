import { useCallback, useEffect, useState } from 'react';
import { api, rs, type Me } from './api.ts';

interface Col { key: string; label: string; kind: 'text' | 'int' | 'paise' }
interface Result { provisional: boolean; columns: Col[]; rows: Record<string, string | number | null>[]; totals: Record<string, number> | null }

const KINDS = [
  { id: 'sales', name: 'Sales', by: [['day', 'by day'], ['outlet', 'by outlet'], ['counter', 'by counter'], ['cashier', 'by person'], ['channel', 'by channel']] },
  { id: 'items', name: 'Items', by: [['item', 'by item'], ['category', 'by category']] },
  { id: 'hourly', name: 'Busy hours', by: [] },
  { id: 'voids', name: 'Voids and refunds', by: [] },
  { id: 'variance', name: 'Cash variance', by: [] },
  { id: 'unavailable', name: 'Sold while unavailable', by: [] },
  { id: 'online', name: 'Online orders', by: [] },
  { id: 'settlement', name: 'Settlement mismatches', by: [] },
  { id: 'sync', name: 'Tablet sync health', by: [] },
] as const;

const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);

export function Reports({ token }: { token: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState(''); // '' = every outlet of mine
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('sales');
  const [by, setBy] = useState('day');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) return setError('Your session has ended. Sign in again.');
      const m = r.body as Me;
      setMe(m);
      const today = m.outlets.map((o) => o.today).sort()[0];
      if (today) { setTo(today); setFrom(shift(today, -6)); }
    }).catch(() => setError('Could not reach the server.'));
  }, [token]);

  const path = useCallback((format: 'json' | 'csv') => {
    const q = new URLSearchParams({ from, to, format });
    if (outletId) q.set('outletId', outletId);
    const opts = KINDS.find((k) => k.id === kind)!.by;
    if (opts.length) q.set('by', by);
    return `/reports/${kind}?${q}`;
  }, [from, to, outletId, kind, by]);

  const ready = Boolean(me && from && to);
  useEffect(() => {
    if (!ready) return;
    let stale = false; // an answer for settings the manager has since changed must not overwrite the newer one
    setBusy(true); setError('');
    api(path('json'), token).then((r) => {
      if (stale) return;
      if (r.status === 200) setResult(r.body as Result);
      else { setResult(null); setError(r.status === 400 ? (r.body.error === 'invalid request' ? 'Check the dates.' : String(r.body.error)) : 'Could not load the report.'); }
    }).catch(() => { if (!stale) setError('Could not reach the server.'); }).finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [ready, path, token]);

  // The file is fetched with the session header, so it cannot be a plain link.
  const download = async () => {
    setError('');
    try {
      const r = await fetch(`/api${path('csv')}`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return setError('Could not download the file.');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `report-${kind}-${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Could not reach the server.'); }
  };

  const byOptions = KINDS.find((k) => k.id === kind)!.by;
  const cell = (c: Col, v: string | number | null) => (v === null ? '—' : c.kind === 'paise' ? rs(Number(v)) : String(v));
  return (
    <main className="mgr">
      <h1>Reports</h1>
      {me && me.outlets.length === 0 && <p className="error">No outlet is assigned to you.</p>}
      {me && me.outlets.length > 0 && (
        <div className="row wrap">
          {me.outlets.length > 1 && (
            <select data-testid="rep-outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)}>
              <option value="">All my outlets</option>
              {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <select data-testid="rep-kind" value={kind} onChange={(e) => { const k = e.target.value as typeof kind; setKind(k); setBy(KINDS.find((x) => x.id === k)!.by[0]?.[0] ?? ''); }}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          {byOptions.length > 0 && (
            <select data-testid="rep-by" value={by} onChange={(e) => setBy(e.target.value)}>
              {byOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <label>From <input data-testid="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input data-testid="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button data-testid="rep-csv" disabled={!ready || busy || !result} onClick={download}>Download CSV</button>
        </div>
      )}
      {error && <p className="error" role="alert" data-testid="rep-error">{error}</p>}
      {result?.provisional && <p className="warn" data-testid="rep-provisional">Includes today, so these figures are provisional until the day is closed.</p>}
      {busy && !result && <p className="muted">Loading…</p>}
      {result && (
        <div className="scroll">
          <table data-testid="rep-table">
            <thead><tr>{result.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {result.rows.length === 0 && <tr><td colSpan={result.columns.length} className="muted">Nothing in these dates.</td></tr>}
              {result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key}>{cell(c, r[c.key] ?? null)}</td>)}</tr>)}
              {result.totals && (
                <tr data-testid="rep-total"><th>Total</th>{result.columns.slice(1).map((c) => <th key={c.key}>{result.totals![c.key] === undefined ? '' : cell(c, result.totals![c.key]!)}</th>)}</tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
