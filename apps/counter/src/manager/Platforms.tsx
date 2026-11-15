import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Me } from './api.ts';
import { Modal } from './Modal.tsx';
import type { MenuPayload } from './menuDraft.ts';

// Phase 9 setup, per outlet and platform: which of our items each platform item id is, and how the platform's
// webhook reaches this outlet. Routes: apps/api/src/routes/integrations.ts.

type Channel = 'zomato' | 'swiggy';
interface Map { id: string; externalItemId: string; itemId: string; itemName: string; priced: boolean }
interface Unmapped { externalItemId: string; name: string; orders: number; lastSeen: string }
interface Integration { channel: Channel; externalStoreId: string; serviceUserId: string; deviceId: string; enabled: boolean; lastEventAt: string | null }
interface Setup {
  integrations: Integration[]; devices: { id: string; name: string }[]; users: { id: string; name: string; role: string }[];
  events: { channel: Channel; result: 'created' | 'duplicate' | 'rejected'; detail: string | null; receivedAt: string }[];
}

const NAME: Record<Channel, string> = { zomato: 'Zomato', swiggy: 'Swiggy' };
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const ERRORS: Record<string, string> = {
  'store id already in use': 'Another outlet already uses that store id. Check it against the platform dashboard.',
  'webhook secret required': 'Enter the webhook secret the platform gave you.',
  'tablet not at this outlet': 'Pick a tablet at this outlet.',
  'person not at this outlet': 'Pick a person who works at this outlet.',
};

export function Platforms({ token }: { token: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState('');
  const [channel, setChannel] = useState<Channel>('zomato');
  const [menu, setMenu] = useState<MenuPayload | null>(null);
  const [maps, setMaps] = useState<Map[]>([]);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Map | null>(null);

  useEffect(() => {
    void Promise.all([api('/me', token), api('/menu', token)]).then(([m, mn]) => {
      if (m.status !== 200) return setError('Your session has ended. Sign in again.');
      const mine = m.body as Me;
      setMe(mine);
      const first = mine.outlets[0];
      if (first) setOutletId(first.id);
      if (mn.status === 200) setMenu(mn.body as MenuPayload);
    }).catch(() => setError('Could not reach the server.'));
  }, [token]);

  const load = useCallback(async () => {
    if (!outletId) return;
    try {
      const [m, s] = await Promise.all([api(`/outlets/${outletId}/item-maps?channel=${channel}`, token), api(`/outlets/${outletId}/integrations`, token)]);
      if (m.status === 200) { setMaps(m.body.maps); setUnmapped(m.body.unmapped); }
      if (s.status === 200) setSetup(s.body as Setup);
      if (m.status !== 200 || s.status !== 200) setError('Could not load this outlet.');
    } catch { setError('Could not reach the server.'); }
  }, [outletId, channel, token]);
  useEffect(() => { setError(''); void load(); }, [load]);

  // Items that can take a platform order: a live price on this channel (the rule createOrder applies on the server).
  const items = useMemo(() => {
    if (!menu) return [];
    const priced = new Set(menu.prices.filter((p) => p.channel === channel).map((p) => p.itemId));
    return menu.items.map((i) => ({ id: i.id, name: i.name, priced: priced.has(i.id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [menu, channel]);

  const mapOne = async (externalItemId: string, itemId: string) => {
    setBusy(true); setError('');
    try {
      const r = await api(`/outlets/${outletId}/item-maps`, token, { method: 'PUT', body: JSON.stringify({ channel, externalItemId, itemId }) });
      if (r.status === 200) await load(); else setError('Could not save that mapping. Check the platform id has no spaces.');
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  const remove = async (m: Map) => {
    setBusy(true); setError('');
    try {
      const r = await api(`/outlets/${outletId}/item-maps/${m.id}`, token, { method: 'DELETE' });
      if (r.status === 200 || r.status === 404) { setRemoving(null); await load(); } else setError('Could not remove that mapping.');
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };

  const integration = setup?.integrations.find((i) => i.channel === channel) ?? null;
  const events = useMemo(() => (setup?.events ?? []).filter((e) => e.channel === channel), [setup, channel]);

  return (
    <main className="mgr">
      <div className="m-head">
        <h1>Online platforms</h1>
        <div className="m-filters" style={{ padding: 0 }}>
          {me && me.outlets.length > 1 && (
            <label>Outlet
              <select data-testid="plat-outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)}>
                {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          )}
          <div className="seg" role="radiogroup" aria-label="Platform">
            {(['zomato', 'swiggy'] as const).map((c) => (
              <button key={c} data-testid={`plat-${c}`} role="radio" aria-checked={channel === c} className={channel === c ? 'active' : ''} onClick={() => setChannel(c)}>{NAME[c]}</button>
            ))}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="error" data-testid="plat-error">{error}</p>}
      {me && me.outlets.length === 0 && <p className="error">No outlet is assigned to you.</p>}

      {unmapped.length > 0 && (
        <section className="m-card" data-testid="plat-unmapped">
          <header><h2>Needs an item ({unmapped.length})</h2></header>
          <div className="m-row"><div className="main muted">These came on {NAME[channel]} orders but match none of our items, so they were left off the bill. Pick the item each one is.</div></div>
          {unmapped.map((u) => <UnmappedRow key={u.externalItemId} u={u} items={items} channel={channel} busy={busy} onMap={mapOne} />)}
        </section>
      )}

      <section className="m-card" data-testid="plat-maps">
        <header><h2>{NAME[channel]} items</h2></header>
        <AddMap items={items} channel={channel} busy={busy} onMap={mapOne} />
        {maps.length === 0 && <div className="m-row"><div className="main muted">No {NAME[channel]} items mapped at this outlet yet.</div></div>}
        {maps.map((m) => (
          <div key={m.id} className="m-row" data-testid="plat-map">
            <div className="main">
              <b>{m.itemName}</b>
              <span>{NAME[channel]} id {m.externalItemId}</span>
              {!m.priced && <span className="warn" data-testid="plat-unpriced"> · No {NAME[channel]} price: orders with it are refused. Add one in Menu.</span>}
            </div>
            <div className="m-row-actions"><button data-testid="plat-remove" disabled={busy} onClick={() => setRemoving(m)}>Remove</button></div>
          </div>
        ))}
      </section>

      {setup && <Connection key={`${outletId}-${channel}`} token={token} outletId={outletId} channel={channel} setup={setup} integration={integration} onSaved={load} />}

      <section className="m-card" data-testid="plat-events">
        <header><h2>Recent calls from {NAME[channel]}</h2></header>
        {events.length === 0 && <div className="m-row"><div className="main muted">Nothing received yet.</div></div>}
        {events.map((e, i) => (
          <div key={i} className="m-row">
            <div className="main"><b className={e.result === 'rejected' ? 'warn' : ''}>{e.result === 'created' ? 'Order received' : e.result === 'duplicate' ? 'Sent again (ignored)' : 'Refused'}</b>
              <span>{when(e.receivedAt)}{e.detail ? ` · ${e.detail}` : ''}</span></div>
          </div>
        ))}
      </section>

      {removing && (
        <Modal title="Remove this mapping?" onClose={() => setRemoving(null)}>
          <p>{NAME[channel]} id {removing.externalItemId} will no longer be {removing.itemName}. New orders with it will be flagged for the kitchen and left off the bill.</p>
          <div className="actions"><button onClick={() => setRemoving(null)}>Keep it</button>
            <button className="danger" data-testid="plat-remove-confirm" disabled={busy} onClick={() => void remove(removing)}>Remove</button></div>
        </Modal>
      )}
    </main>
  );
}

type ItemOpt = { id: string; name: string; priced: boolean };
type OnMap = (externalItemId: string, itemId: string) => Promise<void>;

function ItemSelect({ items, channel, value, onChange, testid }: { items: ItemOpt[]; channel: Channel; value: string; onChange: (v: string) => void; testid: string }) {
  return (
    <select data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose an item…</option>
      {items.map((i) => <option key={i.id} value={i.id} disabled={!i.priced}>{i.name}{i.priced ? '' : ` (no ${NAME[channel]} price)`}</option>)}
    </select>
  );
}

function UnmappedRow({ u, items, channel, busy, onMap }: { u: Unmapped; items: ItemOpt[]; channel: Channel; busy: boolean; onMap: OnMap }) {
  // Start on the item of the same name, if there is a sellable one.
  const [itemId, setItemId] = useState(() => items.find((i) => i.priced && i.name.toLowerCase() === u.name.toLowerCase())?.id ?? '');
  return (
    <div className="m-row" data-testid="plat-unmapped-row">
      <div className="main"><b>{u.name}</b><span>{NAME[channel]} id {u.externalItemId} · on {u.orders} order{u.orders === 1 ? '' : 's'}, last {when(u.lastSeen)}</span></div>
      <div className="m-row-actions">
        <ItemSelect items={items} channel={channel} value={itemId} onChange={setItemId} testid="plat-unmapped-item" />
        <button className="primary" data-testid="plat-unmapped-save" disabled={!itemId || busy} title={itemId ? '' : 'Choose an item first'} onClick={() => void onMap(u.externalItemId, itemId)}>Map</button>
      </div>
    </div>
  );
}

function AddMap({ items, channel, busy, onMap }: { items: ItemOpt[]; channel: Channel; busy: boolean; onMap: OnMap }) {
  const [ext, setExt] = useState('');
  const [itemId, setItemId] = useState('');
  const valid = /^[\x21-\x7e]{1,64}$/.test(ext.trim());
  return (
    <div className="m-row">
      <div className="main"><input data-testid="plat-add-ext" placeholder={`${NAME[channel]} item id`} value={ext} maxLength={64} onChange={(e) => setExt(e.target.value)} /></div>
      <div className="m-row-actions">
        <ItemSelect items={items} channel={channel} value={itemId} onChange={setItemId} testid="plat-add-item" />
        <button data-testid="plat-add-save" disabled={!valid || !itemId || busy} title={!valid ? 'Type the platform id (no spaces)' : !itemId ? 'Choose an item' : ''}
          onClick={() => void onMap(ext.trim(), itemId).then(() => { setExt(''); setItemId(''); })}>Add</button>
      </div>
    </div>
  );
}

function Connection({ token, outletId, channel, setup, integration, onSaved }: {
  token: string; outletId: string; channel: Channel; setup: Setup; integration: Integration | null; onSaved: () => Promise<void>;
}) {
  const [storeId, setStoreId] = useState(integration?.externalStoreId ?? '');
  const [secret, setSecret] = useState('');
  const [userId, setUserId] = useState(integration?.serviceUserId ?? setup.users.find((u) => u.role === 'manager')?.id ?? '');
  const [deviceId, setDeviceId] = useState(integration?.deviceId ?? setup.devices[0]?.id ?? '');
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const secretOk = secret === '' ? !!integration : /^[\x21-\x7e]{16,200}$/.test(secret);
  const why = !/^[\x21-\x7e]{1,64}$/.test(storeId.trim()) ? 'Enter the store id (no spaces)'
    : !secretOk ? (secret === '' ? 'Enter the webhook secret' : 'The secret is at least 16 characters, no spaces')
    : !userId ? 'Choose who orders are booked to' : !deviceId ? 'Choose the tablet that receives orders' : '';

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { externalStoreId: storeId.trim(), serviceUserId: userId, deviceId, enabled, ...(secret ? { webhookSecret: secret } : {}) };
      const r = await api(`/outlets/${outletId}/integrations/${channel}`, token, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 200) { setSecret(''); setMsg({ ok: true, text: 'Saved.' }); await onSaved(); }
      else setMsg({ ok: false, text: ERRORS[r.body.error as string] ?? 'Could not save. Check each field.' });
    } catch { setMsg({ ok: false, text: 'Could not reach the server.' }); } finally { setBusy(false); }
  };

  return (
    <section className="m-card" data-testid="plat-connection">
      <header><h2>Connection</h2>
        <span className="muted" data-testid="plat-status">{!integration ? 'Not set up' : !integration.enabled ? 'Turned off' : `On · last order call ${when(integration.lastEventAt)}`}</span>
      </header>
      <div className="m-form">
        <label className="m-field">Store id (from the {NAME[channel]} partner dashboard)
          <input data-testid="plat-store" value={storeId} maxLength={64} onChange={(e) => setStoreId(e.target.value)} /></label>
        <label className="m-field">Webhook secret
          <input data-testid="plat-secret" type="password" autoComplete="off" value={secret} maxLength={200}
            placeholder={integration ? 'Saved. Type a new one only to replace it' : 'At least 16 characters'} onChange={(e) => setSecret(e.target.value)} /></label>
        <label className="m-field">Orders arrive on tablet
          <select data-testid="plat-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {setup.devices.length === 0 && <option value="">No tablet at this outlet</option>}
            {setup.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        <label className="m-field">Orders are booked to
          <select data-testid="plat-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person…</option>
            {setup.users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select></label>
        <label className="m-field inline"><input data-testid="plat-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Take orders from {NAME[channel]}</label>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'muted' : 'error'} data-testid="plat-save-msg">{msg.text}</p>}
        <div className="m-dialog-actions">
          <button className="primary" data-testid="plat-save" disabled={!!why || busy} title={why} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </section>
  );
}
