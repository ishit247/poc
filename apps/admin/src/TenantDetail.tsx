import { useCallback, useEffect, useState } from 'react';
import { api, counterUrl, inviteLink, setCounterUrl, type Manager, type Outlet, type Tenant } from './api.ts';

interface Issued { name: string; token: string; expiresAt: string }

export function TenantDetail({ tenantId, isOwner, onBack }: { tenantId: string; isOwner: boolean; onBack: () => void }) {
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState('');
  const [base, setBase] = useState(counterUrl());

  const load = useCallback(async () => {
    const [t, o] = await Promise.all([api<Tenant>(`/platform/tenants/${tenantId}`), api(`/platform/tenants/${tenantId}/outlets`)]);
    setTenant(t.status === 200 ? t.body : null);
    if (o.status === 200) { setOutlets(o.body.outlets); setManagers(o.body.managers); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  if (tenant === undefined) return <p>Loading…</p>;
  if (tenant === null) return <><p>Tenant not found.</p><button onClick={onBack}>Back</button></>;

  const fail = (status: number, fallback: string) => setError(status === 403 ? 'Only an owner can do this.' : fallback);
  return (
    <>
      <p><button data-testid="back" onClick={onBack}>← All tenants</button></p>
      <h1 data-testid="tenant-title">{tenant.name} {tenant.suspendedAt && <span className="warn">(suspended)</span>}</h1>
      <p className="muted">{tenant.subdomain ? `Subdomain ${tenant.subdomain} · ` : ''}{tenant.devices} enrolled device{tenant.devices === 1 ? '' : 's'}</p>
      {error && <p className="error" role="alert">{error}</p>}

      <OutletsSection tenantId={tenantId} outlets={outlets} isOwner={isOwner} onChanged={load} onError={(s) => fail(s, 'Could not add the outlet. Counter names may use letters, digits and hyphens.')} />

      <ManagersSection tenantId={tenantId} outlets={outlets} managers={managers} isOwner={isOwner}
        onIssued={(i) => { setIssued(i); void load(); }} onError={(s, m) => fail(s, m)} />

      {issued && (
        <section className="card invite" data-testid="invite-panel" aria-label="Invite link">
          <h2>Invite link for {issued.name}</h2>
          <p>Send this to {issued.name} yourself (phone, WhatsApp). It works once and expires {new Date(issued.expiresAt).toLocaleString()}. It is shown only now; if lost, create a new one.</p>
          <input data-testid="invite-link" readOnly value={inviteLink(issued.token)} onFocus={(e) => e.currentTarget.select()} style={{ maxWidth: '100%' }} />
          <div className="row">
            <button data-testid="invite-copy" className="primary" onClick={() => void navigator.clipboard?.writeText(inviteLink(issued.token))}>Copy link</button>
            <button onClick={() => setIssued(null)}>Done</button>
          </div>
          <label className="muted">Counter app address in the link{' '}
            <input data-testid="counter-url" value={base} onChange={(e) => { setBase(e.target.value); setCounterUrl(e.target.value); }} />
          </label>
        </section>
      )}

      {isOwner && <SuspendSection tenant={tenant} onChanged={load} onError={(s) => fail(s, 'Could not change the status.')} />}
    </>
  );
}

function OutletsSection({ tenantId, outlets, isOwner, onChanged, onError }: {
  tenantId: string; outlets: Outlet[]; isOwner: boolean; onChanged: () => void; onError: (status: number) => void;
}) {
  const [name, setName] = useState('');
  const [counters, setCounters] = useState('C1, C2');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const list = counters.split(',').map((s) => s.trim()).filter(Boolean);
    const r = await api(`/platform/tenants/${tenantId}/outlets`, { body: { name, counters: list.length ? list : ['C1'] } });
    setBusy(false);
    if (r.status === 201) { setName(''); onChanged(); } else onError(r.status);
  };
  return (
    <section className="card" aria-label="Outlets">
      <h2>Outlets and counters</h2>
      {outlets.length === 0 ? <p className="muted">No outlets yet. A manager needs an outlet before they can enrol a tablet.</p> : (
        <ul data-testid="outlet-list">
          {outlets.map((o) => <li key={o.id}><strong>{o.name}</strong> — counters {o.counters.map((c) => c.code).join(', ')}</li>)}
        </ul>
      )}
      {isOwner && (
        <div className="row">
          <input data-testid="outlet-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Outlet name" />
          <input data-testid="outlet-counters" value={counters} onChange={(e) => setCounters(e.target.value)} placeholder="Counters, comma separated" />
          <button data-testid="outlet-add" className="primary" disabled={busy || !name.trim()} onClick={add}>Add outlet</button>
        </div>
      )}
    </section>
  );
}

function ManagersSection({ tenantId, outlets, managers, isOwner, onIssued, onError }: {
  tenantId: string; outlets: Outlet[]; managers: Manager[]; isOwner: boolean;
  onIssued: (i: Issued) => void; onError: (status: number, message: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? '?';

  const invite = async () => {
    setBusy(true);
    const r = await api(`/platform/tenants/${tenantId}/managers`, { body: { name, email, outletIds: picked } });
    setBusy(false);
    if (r.status === 201) { setName(''); setEmail(''); setPicked([]); onIssued({ name, token: r.body.invite, expiresAt: r.body.inviteExpiresAt }); }
    else onError(r.status, r.status === 409 ? 'That email is already used by a manager (emails are unique across all tenants).' : 'Could not create the manager.');
  };
  const reinvite = async (m: Manager) => {
    const r = await api(`/platform/tenants/${tenantId}/managers/${m.id}/invite`, { method: 'POST', body: {} });
    if (r.status === 200) onIssued({ name: m.name, token: r.body.invite, expiresAt: r.body.inviteExpiresAt });
    else onError(r.status, 'Could not create a new link.');
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <section className="card" aria-label="Managers">
      <h2>Managers</h2>
      {managers.length === 0 ? <p className="muted">No manager yet.</p> : (
        <table data-testid="manager-table">
          <thead><tr><th>Name</th><th>Email</th><th>Outlets</th><th>Status</th><th /></tr></thead>
          <tbody>
            {managers.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td>{m.email}</td>
                <td>{m.outletIds.map(outletName).join(', ') || '—'}</td>
                <td>{!m.active ? 'Inactive' : m.acceptedInvite || !m.invited ? <span className="ok">Active</span> : m.invitePending ? <span className="warn">Invite pending</span> : <span className="error">Invite expired</span>}</td>
                <td>{isOwner && m.invited && !m.acceptedInvite && <button data-testid={`reinvite-${m.email}`} onClick={() => void reinvite(m)}>New link</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isOwner && (
        outlets.length === 0 ? <p className="muted">Add an outlet first.</p> : (
          <>
            <div className="row">
              <input data-testid="manager-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Manager name" />
              <input data-testid="manager-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Manager email" autoCapitalize="off" />
            </div>
            <div className="row">
              <span>Outlets:</span>
              {outlets.map((o) => (
                <label key={o.id} className="check"><input type="checkbox" data-testid={`pick-${o.name}`} checked={picked.includes(o.id)} onChange={() => toggle(o.id)} /> {o.name}</label>
              ))}
            </div>
            <button data-testid="manager-invite" className="primary" disabled={busy || !name.trim() || !email.trim() || picked.length === 0} onClick={invite}>Create manager and invite link</button>
          </>
        )
      )}
    </section>
  );
}

function SuspendSection({ tenant, onChanged, onError }: { tenant: Tenant; onChanged: () => void; onError: (status: number) => void }) {
  const [reason, setReason] = useState('');
  const suspended = !!tenant.suspendedAt;
  const go = async () => {
    const r = await api(`/platform/tenants/${tenant.id}/${suspended ? 'reactivate' : 'suspend'}`, { body: { reason } });
    if (r.status === 200) { setReason(''); onChanged(); } else onError(r.status);
  };
  return (
    <section className="card" aria-label="Status">
      <h2>{suspended ? 'Reactivate' : 'Suspend'}</h2>
      <p className="muted">{suspended ? 'Managers, devices and sync work again.' : 'Managers cannot sign in and tablets cannot sync. Counters keep selling offline.'}</p>
      <div className="row">
        <input data-testid="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
        <button data-testid="status-go" className={suspended ? 'primary' : ''} disabled={reason.trim().length < 3} onClick={go}>{suspended ? 'Reactivate' : 'Suspend'}</button>
      </div>
    </section>
  );
}
