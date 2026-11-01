import { useCallback, useEffect, useState } from 'react';
import { api, type Health, type Tenant } from './api.ts';

export function Tenants({ isOwner }: { isOwner: boolean }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, h] = await Promise.all([api<Tenant[]>('/platform/tenants'), api<Health[]>('/platform/health?staleHours=24&quietHours=24')]);
    if (t.status === 200) setTenants(t.body);
    if (h.status === 200) setHealth(Object.fromEntries(h.body.map((x) => [x.id, x])));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    setError('');
    const r = await api<Tenant>('/platform/tenants', { body: { name, ...(subdomain ? { subdomain: subdomain.toLowerCase() } : {}) } });
    setBusy(false);
    if (r.status === 201) { window.location.hash = `#/tenant/${r.body.id}`; return; }
    setError(r.status === 409 ? 'That subdomain is taken.' : r.status === 400 ? 'Name is required; the subdomain may use lowercase letters, digits and hyphens, and some names are reserved.' : 'Could not create the tenant.');
  };

  return (
    <>
      <h1>Tenants</h1>
      {isOwner && (
        <section className="card" aria-label="New tenant">
          <h2>New tenant</h2>
          <div className="row">
            <input data-testid="tenant-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" />
            <input data-testid="tenant-subdomain" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="Subdomain (optional)" autoCapitalize="off" />
            <button data-testid="tenant-create" className="primary" disabled={busy || !name.trim()} onClick={create}>Create</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="muted">Next: add an outlet with its counters, then invite the manager.</p>
        </section>
      )}
      {!tenants ? <p>Loading…</p> : (
        <table data-testid="tenant-table">
          <thead><tr><th>Name</th><th>Subdomain</th><th>Outlets</th><th>Devices</th><th>Status</th><th>Health</th></tr></thead>
          <tbody>
            {tenants.map((t) => {
              const w = health[t.id]?.warnings ?? [];
              return (
                <tr key={t.id}>
                  <td><a href={`#/tenant/${t.id}`}>{t.name}</a></td>
                  <td>{t.subdomain ?? '—'}</td>
                  <td>{t.outlets}</td>
                  <td>{t.devices}</td>
                  <td>{t.suspendedAt ? <span className="warn">Suspended</span> : <span className="ok">Active</span>}</td>
                  <td>{w.length === 0 ? <span className="ok">OK</span> : w.map((x) => <div key={x.code} className={x.severity === 'alert' ? 'error' : 'warn'}>{x.message}</div>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
