import { useCallback, useEffect, useMemo, useState } from 'react';
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
const isDay = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const niceStep = (x: number) => { const p = 10 ** Math.floor(Math.log10(x || 1)); const f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const chartPref = () => { try { return localStorage.getItem('mgr.chart') !== 'off'; } catch { return true; } };

export function Reports({ token }: { token: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState(''); // '' = every outlet of mine
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('sales');
  const [by, setBy] = useState('day');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [today, setToday] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [chart, setChart] = useState(chartPref);
  const [metricKey, setMetricKey] = useState('');
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) return setError('Your session has ended. Sign in again.');
      const m = r.body as Me;
      setMe(m);
      const t = m.outlets.map((o) => o.today).sort()[0];
      if (t) { setToday(t); setTo(t); setFrom(shift(t, -6)); }
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
    setBusy(true); setError(''); setPage(1); setPicked(null);
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

  const range = (days: number) => { if (today) { setTo(today); setFrom(shift(today, -(days - 1))); } };
  const activeDays = today && to === today ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 0;
  const toggleChart = (on: boolean) => { setChart(on); try { localStorage.setItem('mgr.chart', on ? 'on' : 'off'); } catch { /* a convenience only */ } };

  const byOptions = KINDS.find((k) => k.id === kind)!.by;
  const cell = (c: Col, v: string | number | null) => (v === null ? '—' : c.kind === 'paise' ? rs(Number(v)) : String(v));

  // Paging is client-side: the server already caps the range, so the whole answer is in hand.
  const rows = result?.rows ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(page, pages);
  const slice = rows.slice((cur - 1) * size, cur * size);

  // The chart plots one numeric column against the first column. Days run left to right; anything else is a top-10 list.
  const numeric = result?.columns.filter((c) => c.kind !== 'text') ?? [];
  const metric = numeric.find((c) => c.key === metricKey) ?? numeric.find((c) => c.kind === 'paise') ?? numeric[0];
  const dayCol = rows.length > 1 ? result?.columns.find((c) => rows.every((r) => isDay(r[c.key]))) : undefined;
  const labelCol = dayCol ?? result?.columns.find((c) => c.kind === 'text') ?? result?.columns[0];
  const dayChart = !!dayCol;
  // One point per label: several outlets on the same day add up into one bar.
  const series = useMemo(() => {
    if (!result || !metric || !labelCol) return [];
    const by = new Map<string, { label: string; v: number; idx: number[] }>();
    rows.forEach((r, i) => {
      const label = String(r[labelCol.key] ?? '');
      const p = by.get(label) ?? { label, v: 0, idx: [] };
      p.v += Number(r[metric.key] ?? 0); p.idx.push(i); by.set(label, p);
    });
    const pts = [...by.values()];
    return dayChart ? pts.sort((a, b) => a.label.localeCompare(b.label)) : pts.sort((a, b) => b.v - a.v).slice(0, 10);
  }, [result, metric, labelCol, rows, dayChart]);
  const showChart = chart && !!metric && series.length > 0;
  const fmt = (v: number) => (metric?.kind === 'paise' ? rs(v) : String(v));
  const onPage = new Set(slice.map((_, k) => (cur - 1) * size + k));
  const readout = picked !== null && series[picked] ? `${series[picked]!.label} · ${metric!.label}: ${fmt(series[picked]!.v)}` : '';

  const svg = () => {
    const W = 340, H = 200, L = 46, R = 8, T = 10, B = 24, iw = W - L - R, ih = H - T - B;
    const max = Math.max(1, ...series.map((p) => p.v));
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step || step;
    const axis = (v: number) => (metric?.kind === 'paise' ? (v / 100 >= 1000 ? `${(v / 100000).toFixed(v % 100000 ? 1 : 0)}k` : String(Math.round(v / 100))) : String(v));
    const slot = iw / series.length, bw = Math.max(2, slot * 0.7);
    const ticks: number[] = []; for (let g = 0; g <= top; g += step) ticks.push(g);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric!.label} by day`}>
        {ticks.map((g) => { const y = T + ih - (g / top) * ih; return <g key={g}><line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--line)" /><text x={L - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{axis(g)}</text></g>; })}
        {series.map((p, k) => {
          const h = (p.v / top) * ih, x = L + k * slot + (slot - bw) / 2;
          return (
            <g key={p.label} className="bar" opacity={p.idx.some((i) => onPage.has(i)) ? 1 : 0.35} onMouseEnter={() => setPicked(k)} onClick={() => setPicked(k)}>
              <rect x={x} y={T + ih - h} width={bw} height={h} fill="var(--primary)" />
              <rect x={x - 1} y={T} width={bw + 2} height={ih} fill="transparent" />
            </g>
          );
        })}
        {[0, Math.floor((series.length - 1) / 2), series.length - 1].map((k, n) => series[k] && (
          <text key={n} x={n === 0 ? L : n === 2 ? W - R : L + k * slot + slot / 2} y={H - 6} textAnchor={n === 0 ? 'start' : n === 2 ? 'end' : 'middle'} fontSize="10" fill="var(--muted)">{series[k].label.slice(5)}</text>
        ))}
      </svg>
    );
  };

  return (
    <main className="mgr">
      <div className="m-head">
        <h1>Reports</h1>
        <span className="spacer" />
        <label className="m-switch"><input data-testid="rep-chart-toggle" type="checkbox" checked={chart} onChange={(e) => toggleChart(e.target.checked)} /><span className="trk" />Chart</label>
        <button data-testid="rep-csv" disabled={!ready || busy || !result} onClick={download}>⬇ Download CSV</button>
      </div>
      {me && me.outlets.length === 0 && <p className="error">No outlet is assigned to you.</p>}
      {me && me.outlets.length > 0 && (
        <section className="m-card">
          <div className="m-filters">
            {me.outlets.length > 1 && (
              <label>Outlet
                <select data-testid="rep-outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)}>
                  <option value="">All my outlets</option>
                  {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            )}
            <label>Report
              <select data-testid="rep-kind" value={kind} onChange={(e) => { const k = e.target.value as typeof kind; setKind(k); setBy(KINDS.find((x) => x.id === k)!.by[0]?.[0] ?? ''); setMetricKey(''); }}>
                {KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            {byOptions.length > 0 && (
              <label>Group by
                <select data-testid="rep-by" value={by} onChange={(e) => { setBy(e.target.value); setMetricKey(''); }}>
                  {byOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
            )}
            <label>From <input data-testid="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input data-testid="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <div className="m-chips" role="group" aria-label="Quick range">
              {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, name]) => <button key={d} className={activeDays === d ? 'active' : ''} aria-pressed={activeDays === d} onClick={() => range(d as number)}>{name}</button>)}
            </div>
          </div>
          {result?.provisional && <div className="m-alert" data-testid="rep-provisional" style={{ margin: '0 14px 12px' }}><span>⚠</span><div className="grow">Includes today, so these figures are provisional until the day is closed.</div></div>}
          {error && <div className="m-alert bad" role="alert" data-testid="rep-error" style={{ margin: '0 14px 12px' }}><span>⚠</span><div className="grow">{error}</div></div>}
        </section>
      )}
      {busy && !result && <p className="muted">Loading…</p>}
      {result && (
        <div className={`m-repgrid${showChart ? ' chart' : ''}`}>
          <section className="m-card">
            <div className="m-scroll">
              <table className="m-table" data-testid="rep-table">
                <thead><tr>{result.columns.map((c, i) => <th key={c.key} className={`${c.kind === 'text' ? '' : 'num'}${showChart && i > 0 && result.columns.length > 6 && i >= result.columns.length - 2 ? ' hide-chart' : ''}`}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={result.columns.length} className="muted" style={{ padding: 28, textAlign: 'center' }}>Nothing in these dates.</td></tr>}
                  {slice.map((r, k) => (
                    <tr key={(cur - 1) * size + k}>{result.columns.map((c, i) => <td key={c.key} className={`${c.kind === 'text' ? '' : 'num'}${showChart && i > 0 && result.columns.length > 6 && i >= result.columns.length - 2 ? ' hide-chart' : ''}`}>{cell(c, r[c.key] ?? null)}</td>)}</tr>
                  ))}
                </tbody>
                {result.totals && (
                  <tfoot>
                    <tr data-testid="rep-total"><th>Total</th>{result.columns.slice(1).map((c, j) => <th key={c.key} className={`num${showChart && result.columns.length > 6 && j + 1 >= result.columns.length - 2 ? ' hide-chart' : ''}`}>{result.totals![c.key] === undefined ? '' : cell(c, result.totals![c.key]!)}</th>)}</tr>
                  </tfoot>
                )}
              </table>
            </div>
            {rows.length > 0 && (
              <div className="m-pager">
                <span className="muted">{(cur - 1) * size + 1}–{Math.min(cur * size, rows.length)} of {rows.length}</span>
                <span className="spacer" />
                <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>Rows
                  <select data-testid="rep-size" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>{[10, 25, 50].map((n) => <option key={n}>{n}</option>)}</select>
                </label>
                {pages > 1 && (
                  <div className="btns">
                    <button aria-label="Previous page" disabled={cur === 1} onClick={() => setPage(cur - 1)}>‹</button>
                    {Array.from({ length: pages }, (_, p) => p + 1).filter((p) => pages <= 7 || p === 1 || p === pages || Math.abs(p - cur) <= 1).map((p, i, all) => (
                      <span key={p} style={{ display: 'contents' }}>
                        {i > 0 && p - all[i - 1]! > 1 && <span className="muted" style={{ alignSelf: 'center' }}>…</span>}
                        <button aria-label={`Page ${p}`} aria-current={p === cur ? 'page' : undefined} onClick={() => setPage(p)}>{p}</button>
                      </span>
                    ))}
                    <button aria-label="Next page" disabled={cur === pages} onClick={() => setPage(cur + 1)}>›</button>
                  </div>
                )}
              </div>
            )}
          </section>

          {showChart && metric && (
            <section className="m-card" data-testid="rep-chart">
              <header><h2>{metric.label}{dayChart ? ' by day' : ': top 10'}</h2><span className="spacer" />
                {numeric.length > 1 && (
                  <select aria-label="Chart measure" value={metric.key} onChange={(e) => setMetricKey(e.target.value)} style={{ minHeight: 36, borderRadius: 8, fontSize: 14 }}>
                    {numeric.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                )}
              </header>
              <div className="m-chart">
                {dayChart ? svg() : series.map((p) => (
                  <div key={p.label} className="m-hbar"><span className="lab" title={p.label}>{p.label}</span><span className="trk"><i style={{ width: `${(p.v / Math.max(1, series[0]!.v)) * 100}%` }} /></span><span className="val">{fmt(p.v)}</span></div>
                ))}
                {dayChart && <div className="m-readout">{readout || 'Hover or tap a bar. Bars for the rows on this page are highlighted.'}</div>}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
