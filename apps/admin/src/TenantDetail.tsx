import { useCallback, useEffect, useState } from 'react';
import { api, counterUrl, inviteLink, setCounterUrl, type Manager, type Outlet, type Tenant, type TemplateRow } from './api.ts';
import { SUGGESTION_NOTE } from './Catalog.tsx';
import { Confirm, Modal } from './Modal.tsx';
import { toast } from './toast.tsx';

interface Issued { name: string; token: string; expiresAt: string }
type Tab = 'overview' | 'outlets' | 'managers' | 'menu' | 'status';

export function TenantDetail({ tenantId, isOwner }: { tenantId: string; isOwner: boolean }) {
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  const load = useCallback(async () => {
    const [t, o] = await Promise.all([api<Tenant>(`/platform/tenants/${tenantId}`), api(`/platform/tenants/${tenantId}/outlets`)]);
    setTenant(t.status === 200 ? t.body : null);
    if (o.status === 200) { setOutlets(o.body.outlets); setManagers(o.body.managers); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const back = () => { window.location.hash = ''; };
  if (tenant === undefined) return <p>Loading…</p>;
  if (tenant === null) return <><p>Tenant not found.</p><button className="btn" onClick={back}>Back</button></>;

  const fail = (status: number, fallback: string) => setError(status === 403 ? 'Only an owner can do this.' : fallback);
  const pending = managers.filter((m) => m.invited && !m.acceptedInvite && m.active).length;
  const tabs: [Tab, string, number][] = [['overview', 'Overview', 0], ['outlets', 'Outlets', 0], ['managers', 'Managers', pending], ['menu', 'Menu', 0], ['status', 'Status', 0]];
  return (
    <>
      <div className="crumbs"><a href="#" data-testid="back" onClick={(e) => { e.preventDefault(); back(); }}>Tenants</a><span>›</span><b>{tenant.name}</b></div>
      <div className="pagehead">
        <div>
          <h1 data-testid="tenant-title">{tenant.name} {tenant.suspendedAt ? <span className="pill bad"><i />Suspended</span> : <span className="pill ok"><i />Active</span>}</h1>
          <div className="muted">{tenant.subdomain ? `${tenant.subdomain} · ` : ''}{tenant.devices} enrolled device{tenant.devices === 1 ? '' : 's'}</div>
        </div>
        <span className="sp" />
        {isOwner && <button className="btn danger" onClick={() => setTab('status')}>{tenant.suspendedAt ? 'Reactivate…' : 'Suspend…'}</button>}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([k, label, n]) => (
          <button key={k} className="tab" role="tab" data-testid={`tab-${k}`} aria-selected={tab === k} onClick={() => setTab(k)}>{label}{n > 0 && <span className="badge">{n}</span>}</button>
        ))}
      </div>
      {error && <div className="alert bad" role="alert"><span>⚠</span><div className="grow">{error}</div></div>}

      {tab === 'overview' && <Overview tenant={tenant} outlets={outlets} managers={managers} pending={pending} go={setTab} />}
      {tab === 'outlets' && <OutletsSection tenantId={tenantId} outlets={outlets} isOwner={isOwner} onChanged={load} onError={(s) => fail(s, 'Could not add the outlet. Counter names may use letters, digits and hyphens.')} />}
      {tab === 'managers' && <ManagersSection tenantId={tenantId} outlets={outlets} managers={managers} isOwner={isOwner} issued={issued} onDone={() => setIssued(null)}
        onIssued={(i) => { setIssued(i); void load(); }} onError={(s, m) => fail(s, m)} />}
      {tab === 'menu' && <SeedSection tenantId={tenantId} isOwner={isOwner} />}
      {tab === 'status' && <SuspendSection tenant={tenant} isOwner={isOwner} onChanged={() => { setTab('overview'); void load(); }} onError={(s) => fail(s, 'Could not change the status.')} />}
    </>
  );
}

function Overview({ tenant, outlets, managers, pending, go }: { tenant: Tenant; outlets: Outlet[]; managers: Manager[]; pending: number; go: (t: Tab) => void }) {
  const counters = outlets.reduce((a, o) => a + o.counters.length, 0);
  const steps: { done: boolean; title: string; detail: string; tab: Tab; cta: string }[] = [
    { done: outlets.length > 0, title: 'Add an outlet with its counters', detail: outlets.length ? `${outlets.length} outlet${outlets.length === 1 ? '' : 's'}, ${counters} counter${counters === 1 ? '' : 's'}` : 'A manager needs an outlet before they can enrol a tablet.', tab: 'outlets', cta: 'Add outlet' },
    { done: managers.length > 0, title: 'Invite the manager', detail: managers.length ? `${managers.length - pending} active, ${pending} invite pending` : 'They choose their own password from a one-time link.', tab: 'managers', cta: 'Invite manager' },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <>
      <section className="card" data-testid="checklist">
        <header><h2>Setup checklist</h2><span className="sp" /><span className={`pill ${next < 0 ? 'ok' : 'warn'}`}>{next < 0 ? 'Complete' : `${steps.filter((s) => !s.done).length} left`}</span></header>
        {steps.map((s, i) => (
          <div key={s.title} className={`step ${s.done ? 'done' : i === next ? 'next' : ''}`}>
            <div className="ic">{s.done ? '✓' : i + 1}</div>
            <div><b>{s.title}</b><span className="d">{s.detail}</span></div>
            <button className={`btn sm ${s.done ? 'ghost' : i === next ? 'primary' : ''}`} onClick={() => go(s.tab)}>{s.done ? 'View' : s.cta}</button>
          </div>
        ))}
        <div className="step">
          <div className="ic">+</div>
          <div><b>Seed the menu from a template</b><span className="d">Optional: start from a catalog template instead of an empty menu.</span></div>
          <button className="btn sm" onClick={() => go('menu')}>Seed menu</button>
        </div>
      </section>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi"><small>Outlets</small><div className="v">{outlets.length}</div></div>
        <div className="kpi"><small>Managers</small><div className="v">{managers.length}</div></div>
        <div className="kpi"><small>Devices</small><div className="v">{tenant.devices}</div></div>
      </div>
    </>
  );
}

function OutletsSection({ tenantId, outlets, isOwner, onChanged, onError }: {
  tenantId: string; outlets: Outlet[]; isOwner: boolean; onChanged: () => void; onError: (status: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [counters, setCounters] = useState('C1, C2');
  const [busy, setBusy] = useState(false);
  const list = counters.split(',').map((s) => s.trim()).filter(Boolean);
  const add = async () => {
    setBusy(true);
    const r = await api(`/platform/tenants/${tenantId}/outlets`, { body: { name, counters: list.length ? list : ['C1'] } });
    setBusy(false);
    if (r.status === 201) { setName(''); setAdding(false); toast('Outlet added.'); onChanged(); } else { setAdding(false); onError(r.status); }
  };
  return (
    <section className="card" aria-label="Outlets">
      <header><h2>Outlets and counters</h2><span className="sp" />{isOwner && <button className="btn primary sm" data-testid="outlet-new" onClick={() => setAdding(true)}>＋ Add outlet</button>}</header>
      <div className="body">
        {outlets.length === 0 ? <div className="alert info"><span>ⓘ</span><div className="grow">No outlets yet. A manager needs an outlet before they can enrol a tablet.</div></div> : (
          <div className="outlets" data-testid="outlet-list">
            {outlets.map((o) => (
              <div className="ocard" key={o.id}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b>{o.name}</b><span className="sp" /><span className="pill">{o.counters.length} counter{o.counters.length === 1 ? '' : 's'}</span></div>
                <div className="chips">{o.counters.map((c) => <span key={c.id} className="chip">{c.code}</span>)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {adding && (
        <Modal title="Add outlet" onClose={() => setAdding(false)}>
          <label className="f">Outlet name<input data-testid="outlet-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. School 3 Canteen" autoComplete="off" autoFocus /></label>
          <label className="f">Counters (comma separated)<input data-testid="outlet-counters" value={counters} onChange={(e) => setCounters(e.target.value)} autoComplete="off" /></label>
          <div className="chips">{list.map((c, i) => <span key={i} className="chip">{c}</span>)}</div>
          <div className="hint">Counter names may use letters, digits and hyphens.</div>
          <div className="acts"><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" data-testid="outlet-add" disabled={busy || !name.trim()} onClick={add}>Add outlet</button></div>
        </Modal>
      )}
    </section>
  );
}

function ManagersSection({ tenantId, outlets, managers, isOwner, issued, onDone, onIssued, onError }: {
  tenantId: string; outlets: Outlet[]; managers: Manager[]; isOwner: boolean; issued: Issued | null; onDone: () => void;
  onIssued: (i: Issued) => void; onError: (status: number, message: string) => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState(counterUrl());
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? '?';

  const invite = async () => {
    setBusy(true);
    const r = await api(`/platform/tenants/${tenantId}/managers`, { body: { name, email, outletIds: picked } });
    setBusy(false);
    setInviting(false);
    if (r.status === 201) { onIssued({ name, token: r.body.invite, expiresAt: r.body.inviteExpiresAt }); setName(''); setEmail(''); setPicked([]); }
    else onError(r.status, r.status === 409 ? 'That email is already used by a manager (emails are unique across all tenants).' : 'Could not create the manager.');
  };
  const reinvite = async (m: Manager) => {
    const r = await api(`/platform/tenants/${tenantId}/managers/${m.id}/invite`, { method: 'POST', body: {} });
    if (r.status === 200) onIssued({ name: m.name, token: r.body.invite, expiresAt: r.body.inviteExpiresAt });
    else onError(r.status, 'Could not create a new link.');
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const link = issued ? inviteLink(issued.token) : '';

  return (
    <>
      {issued && (
        <section className="card" data-testid="invite-panel" aria-label="Invite link" style={{ borderColor: 'var(--primary)' }}>
          <header style={{ background: 'var(--primary-50)' }}><h2>Invite link for {issued.name}</h2><span className="sp" /><span className="pill warn">Shown once</span></header>
          <div className="body">
            <div className="muted">Send this to {issued.name} yourself (phone, WhatsApp). It works once and expires {new Date(issued.expiresAt).toLocaleString()}. It is shown only now; if lost, create a new one.</div>
            <div className="copyrow">
              <input data-testid="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
              <button className="btn primary" data-testid="invite-copy" onClick={() => { void navigator.clipboard?.writeText(link); toast('Link copied'); }}>Copy link</button>
            </div>
            <label className="f">Counter app address in the link
              <input data-testid="counter-url" value={base} style={{ maxWidth: 340 }} onChange={(e) => { setBase(e.target.value); setCounterUrl(e.target.value); }} />
            </label>
            <div><button className="btn" onClick={onDone}>Done</button></div>
          </div>
        </section>
      )}
      <section className="card" aria-label="Managers">
        <header><h2>Managers</h2><span className="sp" />
          {isOwner && <button className="btn primary sm" data-testid="manager-new" disabled={outlets.length === 0} title={outlets.length === 0 ? 'Add an outlet first' : undefined} onClick={() => setInviting(true)}>＋ Invite manager</button>}
        </header>
        {managers.length === 0 ? <div className="body"><div className="alert info"><span>ⓘ</span><div className="grow">No manager yet. {outlets.length === 0 ? 'Add an outlet first, then invite one.' : 'Invite one to get this tenant started.'}</div></div></div> : (
          <table data-testid="manager-table">
            <thead><tr><th>Name</th><th>Email</th><th>Outlets</th><th>Status</th><th /></tr></thead>
            <tbody>
              {managers.map((m) => (
                <tr key={m.id}>
                  <td className="tname">{m.name}</td><td>{m.email}</td>
                  <td>{m.outletIds.map(outletName).join(', ') || '—'}</td>
                  <td>{!m.active ? <span className="pill">Inactive</span> : m.acceptedInvite || !m.invited ? <span className="pill ok"><i />Active</span> : m.invitePending ? <span className="pill warn"><i />Invite pending</span> : <span className="pill bad"><i />Invite expired</span>}</td>
                  <td className="num">{isOwner && m.invited && !m.acceptedInvite && <button className="btn sm" data-testid={`reinvite-${m.email}`} onClick={() => void reinvite(m)}>New link</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {inviting && (
        <Modal title="Invite a manager" onClose={() => setInviting(false)}>
          <label className="f">Name<input data-testid="manager-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus /></label>
          <label className="f">Email<input data-testid="manager-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="off" autoComplete="off" /><span className="hint">Emails are unique across all tenants.</span></label>
          <div className="f">Outlets they manage
            {outlets.map((o) => (
              <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, fontWeight: 400, color: 'var(--fg)' }}>
                <input type="checkbox" data-testid={`pick-${o.name}`} checked={picked.includes(o.id)} onChange={() => toggle(o.id)} style={{ width: 18, height: 18, minHeight: 0 }} /> {o.name}
              </label>
            ))}
          </div>
          <div className="acts"><button className="btn" onClick={() => setInviting(false)}>Cancel</button>
            <button className="btn primary" data-testid="manager-invite" disabled={busy || !name.trim() || !/\S+@\S+/.test(email) || picked.length === 0} onClick={invite}>Create and get invite link</button></div>
        </Modal>
      )}
    </>
  );
}

function SeedSection({ tenantId, isOwner }: { tenantId: string; isOwner: boolean }) {
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [picked, setPicked] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void api<TemplateRow[]>('/platform/catalog-templates').then((r) => setTemplates(r.status === 200 ? r.body : []));
  }, []);

  const chosen = templates?.find((t) => t.id === picked);
  const seed = async () => {
    setBusy(true);
    const r = await api(`/platform/tenants/${tenantId}/seed-catalog`, { body: { templateId: picked } });
    setBusy(false);
    setConfirming(false);
    if (r.status === 201) setResult({ ok: true, text: `Menu seeded: ${r.body.categories} categories and ${r.body.items} items copied from “${chosen?.name}”.` });
    else setResult({ ok: false, text: r.status === 409 ? 'This tenant already has a menu, so nothing was copied. Seeding is only possible while the menu is empty.'
      : r.status === 403 ? 'Only an owner can do this.' : r.status === 404 ? 'That template no longer exists. Reload and pick another.' : 'Could not seed the menu.' });
  };

  return (
    <section className="card" aria-label="Seed menu">
      <header><h2>Seed menu from template</h2></header>
      <div className={`body${isOwner ? '' : ' readonly'}`}>
        <div className="muted">Copies the template’s categories, items, HSN/SAC codes, GST rates and counter prices into this tenant once; the manager edits the menu afterwards. {SUGGESTION_NOTE} Seeding does not switch GST on for any outlet.</div>
        {templates && templates.length === 0 ? <div className="alert info"><span>ⓘ</span><div className="grow">No templates yet. <a href="#/catalog/new">Create one</a> first.</div></div> : (
          <div className="field-row">
            <label className="f">Template
              <select data-testid="seed-template" value={picked} onChange={(e) => { setPicked(e.target.value); setConfirming(false); setResult(null); }}>
                <option value="">Pick a template…</option>
                {templates?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.items} items)</option>)}
              </select>
            </label>
            <div style={{ alignSelf: 'end', flex: '0 0 auto' }}><button className="btn primary" data-testid="seed-start" disabled={!picked || confirming} onClick={() => setConfirming(true)}>Seed menu…</button></div>
          </div>
        )}
        {confirming && chosen && (
          <div className="alert warn" data-testid="seed-confirm"><span>⚠</span>
            <div className="grow">Copy {chosen.categories} categories and {chosen.items} items from “{chosen.name}” into this tenant? This is only possible while the menu is empty.</div>
            <button className="btn sm primary" data-testid="seed-go" disabled={busy} onClick={seed}>Yes, seed the menu</button>
            <button className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        )}
        {result && <div className={`alert ${result.ok ? 'ok' : 'bad'}`} role={result.ok ? 'status' : 'alert'} data-testid="seed-result"><span>{result.ok ? '✓' : '⚠'}</span><div className="grow">{result.text}</div></div>}
      </div>
    </section>
  );
}

function SuspendSection({ tenant, isOwner, onChanged, onError }: { tenant: Tenant; isOwner: boolean; onChanged: () => void; onError: (status: number) => void }) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const suspended = !!tenant.suspendedAt;
  const go = async () => {
    const r = await api(`/platform/tenants/${tenant.id}/${suspended ? 'reactivate' : 'suspend'}`, { body: { reason } });
    if (r.status === 200) { setReason(''); toast(suspended ? 'Tenant reactivated' : 'Tenant suspended'); onChanged(); } else onError(r.status);
  };
  return (
    <>
      <section className="card danger-zone" aria-label="Status">
        <header><h2>{suspended ? 'Reactivate this tenant' : 'Suspend this tenant'}</h2></header>
        <div className={`body${isOwner ? '' : ' readonly'}`}>
          <div className="muted">{suspended ? 'Managers, devices and sync work again.' : 'Managers cannot sign in and tablets cannot sync. Counters keep selling offline.'}</div>
          <label className="f">Reason (required, recorded in the audit trail)
            <input data-testid="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unpaid invoice, requested by owner" style={{ maxWidth: 460 }} />
          </label>
          <div><button className={`btn ${suspended ? 'primary' : 'danger solid'}`} data-testid="status-go" disabled={reason.trim().length < 3} onClick={() => setAsking(true)}>{suspended ? 'Reactivate tenant' : 'Suspend tenant'}</button></div>
        </div>
      </section>
      {!isOwner && <div className="alert info"><span>ⓘ</span><div className="grow">Support accounts are read-only. Ask an owner to change a tenant’s status.</div></div>}
      {asking && <Confirm title={suspended ? 'Reactivate this tenant?' : 'Suspend this tenant?'} danger={!suspended} label={suspended ? 'Reactivate' : 'Suspend'}
        message={suspended ? `${tenant.name}’s managers, devices and sync will work again.` : `${tenant.name}’s managers will be signed out and tablets cannot sync. Counters keep selling offline.`}
        onClose={() => setAsking(false)} onYes={() => void go()} />}
    </>
  );
}
