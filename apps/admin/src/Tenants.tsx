import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Health, type Tenant } from './api.ts';
import { Modal } from './Modal.tsx';
import { toast } from './toast.tsx';

const open = (id: string) => { window.location.hash = `#/tenant/${id}`; };
export const SubdomainPattern = /^[a-z0-9-]+$/;

export function Tenants({ isOwner }: { isOwner: boolean }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'suspended'>('all');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const [t, h] = await Promise.all([api<Tenant[]>('/platform/tenants'), api<Health[]>('/platform/health?staleHours=24&quietHours=24')]);
    if (t.status === 200) setTenants(t.body);
    if (h.status === 200) setHealth(Object.fromEntries(h.body.map((x) => [x.id, x])));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const warnings = (t: Tenant) => health[t.id]?.warnings ?? [];
  const rows = useMemo(() => (tenants ?? []).filter((t) =>
    (`${t.name} ${t.subdomain ?? ''}`).toLowerCase().includes(q.toLowerCase())
    && (filter === 'all' || (filter === 'suspended' ? !!t.suspendedAt : warnings(t).length > 0))), [tenants, q, filter, health]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = tenants ?? [];
  const attention = all.filter((t) => warnings(t).length > 0).length;
  return (
    <>
      <div className="pagehead">
        <h1>Tenants</h1><span className="sp" />
        {isOwner && <button className="btn primary" data-testid="tenant-new" onClick={() => setCreating(true)}>＋ New tenant</button>}
      </div>
      <div className="kpis">
        <div className="kpi"><small>Tenants</small><div className="v">{all.length}</div><div className="d">{all.filter((t) => !t.suspendedAt).length} active</div></div>
        <div className="kpi"><small>Enrolled devices</small><div className="v">{all.reduce((a, t) => a + t.devices, 0)}</div><div className="d">across all tenants</div></div>
        <div className="kpi"><small>Outlets</small><div className="v">{all.reduce((a, t) => a + t.outlets, 0)}</div><div className="d">in total</div></div>
        <div className="kpi"><small>Need attention</small><div className="v" style={{ color: attention ? 'var(--warn)' : undefined }}>{attention}</div><div className="d">with a health warning</div></div>
      </div>
      <section className="card">
        <div className="toolbar">
          <input type="search" data-testid="tenant-search" placeholder="Search tenants…" aria-label="Search tenants" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
          <select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ width: 'auto' }}>
            <option value="all">All statuses</option><option value="attention">Needs attention</option><option value="suspended">Suspended</option>
          </select>
          <span className="sp" /><span className="hint">{rows.length} of {all.length}</span>
        </div>
        {!tenants ? <div className="body">Loading…</div> : (
          <table data-testid="tenant-table">
            <thead><tr><th>Tenant</th><th className="num">Outlets</th><th className="num">Devices</th><th>Status</th><th>Health</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 30, textAlign: 'center' }}>No tenants match.</td></tr>}
              {rows.map((t) => {
                const w = warnings(t);
                return (
                  <tr key={t.id} className="clickable" tabIndex={0} onClick={() => open(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(t.id); }}>
                    <td><a className="tname" href={`#/tenant/${t.id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>{t.name}</a><div className="tsub">{t.subdomain ?? 'no subdomain'}</div></td>
                    <td className="num">{t.outlets}</td><td className="num">{t.devices}</td>
                    <td>{t.suspendedAt ? <span className="pill bad"><i />Suspended</span> : <span className="pill ok"><i />Active</span>}</td>
                    <td><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{w.length === 0 ? <span className="pill ok"><i />OK</span> : w.map((x) => <span key={x.code} className={`pill ${x.severity === 'alert' ? 'bad' : 'warn'}`}><i />{x.message}</span>)}</div></td>
                    <td className="num"><span className="muted">›</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      {creating && <NewTenant onClose={() => setCreating(false)} />}
    </>
  );
}

function NewTenant({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const badSub = subdomain !== '' && !SubdomainPattern.test(subdomain);
  const create = async () => {
    setBusy(true);
    setError('');
    const r = await api<Tenant>('/platform/tenants', { body: { name, ...(subdomain ? { subdomain: subdomain.toLowerCase() } : {}) } });
    setBusy(false);
    if (r.status === 201) { toast('Tenant created. Add an outlet next.'); onClose(); window.location.hash = `#/tenant/${r.body.id}`; return; }
    setError(r.status === 409 ? 'That subdomain is taken.' : r.status === 400 ? 'Name is required; the subdomain may use lowercase letters, digits and hyphens, and some names are reserved.' : 'Could not create the tenant.');
  };
  return (
    <Modal title="New tenant" onClose={onClose}>
      <label className="f">Business name
        <input data-testid="tenant-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sunrise Foods" autoComplete="off" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !badSub && !busy) void create(); }} />
      </label>
      <label className="f">Subdomain (optional)
        <input data-testid="tenant-subdomain" className={badSub ? 'err' : ''} value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="sunrise" autoCapitalize="off" autoComplete="off" />
        <span className="hint">Lowercase letters, digits and hyphens.</span>
      </label>
      {badSub && <div className="fielderr">Use lowercase letters, digits and hyphens only.</div>}
      {error && <div className="fielderr" role="alert">{error}</div>}
      <div className="hint">Next: add an outlet with its counters, then invite the manager.</div>
      <div className="acts">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" data-testid="tenant-create" disabled={busy || !name.trim() || badSub} onClick={create}>Create tenant</button>
      </div>
    </Modal>
  );
}
