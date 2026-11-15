import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Me } from './api.ts';
import { Modal } from './Modal.tsx';
import type { MenuPayload } from './menuDraft.ts';
import { t as tr, tn, useT } from '../i18n.ts';

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
const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : tr('never'));
const ERRORS: Record<string, string> = { // shown through t()
  'store id already in use': 'Another outlet already uses that store id. Check it against the platform dashboard.',
  'webhook secret required': 'Enter the webhook secret the platform gave you.',
  'tablet not at this outlet': 'Pick a tablet at this outlet.',
  'person not at this outlet': 'Pick a person who works at this outlet.',
};

export function Platforms({ token }: { token: string }) {
  const tx = useT();
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
      if (m.status !== 200) return setError(tx('Your session has ended. Sign in again.'));
      const mine = m.body as Me;
      setMe(mine);
      const first = mine.outlets[0];
      if (first) setOutletId(first.id);
      if (mn.status === 200) setMenu(mn.body as MenuPayload);
    }).catch(() => setError(tx('Could not reach the server.')));
  }, [token]);

  const load = useCallback(async () => {
    if (!outletId) return;
    try {
      const [m, s] = await Promise.all([api(`/outlets/${outletId}/item-maps?channel=${channel}`, token), api(`/outlets/${outletId}/integrations`, token)]);
      if (m.status === 200) { setMaps(m.body.maps); setUnmapped(m.body.unmapped); }
      if (s.status === 200) setSetup(s.body as Setup);
      if (m.status !== 200 || s.status !== 200) setError(tx('Could not load this outlet.'));
    } catch { setError(tx('Could not reach the server.')); }
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
      if (r.status === 200) await load(); else setError(tx('Could not save that mapping. Check the platform id has no spaces.'));
    } catch { setError(tx('Could not reach the server.')); } finally { setBusy(false); }
  };
  const remove = async (m: Map) => {
    setBusy(true); setError('');
    try {
      const r = await api(`/outlets/${outletId}/item-maps/${m.id}`, token, { method: 'DELETE' });
      if (r.status === 200 || r.status === 404) { setRemoving(null); await load(); } else setError(tx('Could not remove that mapping.'));
    } catch { setError(tx('Could not reach the server.')); } finally { setBusy(false); }
  };

  const integration = setup?.integrations.find((i) => i.channel === channel) ?? null;
  const events = useMemo(() => (setup?.events ?? []).filter((e) => e.channel === channel), [setup, channel]);

  return (
    <main className="mgr">
      <div className="m-head">
        <h1>{tx('Online platforms')}</h1>
        <div className="m-filters" style={{ padding: 0 }}>
          {me && me.outlets.length > 1 && (
            <label>{tx('Outlet')}
              <select data-testid="plat-outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)}>
                {me.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          )}
          <div className="seg" role="radiogroup" aria-label={tx('Platform')}>
            {(['zomato', 'swiggy'] as const).map((c) => (
              <button key={c} data-testid={`plat-${c}`} role="radio" aria-checked={channel === c} className={channel === c ? 'active' : ''} onClick={() => setChannel(c)}>{NAME[c]}</button>
            ))}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="error" data-testid="plat-error">{error}</p>}
      {me && me.outlets.length === 0 && <p className="error">{tx('No outlet is assigned to you.')}</p>}

      {unmapped.length > 0 && (
        <section className="m-card" data-testid="plat-unmapped">
          <header><h2>{tx('Needs an item')} ({unmapped.length})</h2></header>
          <div className="m-row"><div className="main muted">{tx('These came on {platform} orders but match none of our items, so they were left off the bill. Pick the item each one is.', { platform: NAME[channel] })}</div></div>
          {unmapped.map((u) => <UnmappedRow key={u.externalItemId} u={u} items={items} channel={channel} busy={busy} onMap={mapOne} />)}
        </section>
      )}

      <section className="m-card" data-testid="plat-maps">
        <header><h2>{tx('{platform} items', { platform: NAME[channel] })}</h2></header>
        <AddMap items={items} channel={channel} busy={busy} onMap={mapOne} />
        {maps.length === 0 && <div className="m-row"><div className="main muted">{tx('No {platform} items mapped at this outlet yet.', { platform: NAME[channel] })}</div></div>}
        {maps.map((m) => (
          <div key={m.id} className="m-row" data-testid="plat-map">
            <div className="main">
              <b>{m.itemName}</b>
              <span>{NAME[channel]} id {m.externalItemId}</span>
              {!m.priced && <span className="warn" data-testid="plat-unpriced"> · {tx('No {platform} price: orders with it are refused. Add one in Menu.', { platform: NAME[channel] })}</span>}
            </div>
            <div className="m-row-actions"><button data-testid="plat-remove" disabled={busy} onClick={() => setRemoving(m)}>{tx('Remove')}</button></div>
          </div>
        ))}
      </section>

      {setup && <Connection key={`${outletId}-${channel}`} token={token} outletId={outletId} channel={channel} setup={setup} integration={integration} onSaved={load} />}

      <section className="m-card" data-testid="plat-events">
        <header><h2>{tx('Recent calls from {platform}', { platform: NAME[channel] })}</h2></header>
        {events.length === 0 && <div className="m-row"><div className="main muted">{tx('Nothing received yet.')}</div></div>}
        {events.map((e, i) => (
          <div key={i} className="m-row">
            <div className="main"><b className={e.result === 'rejected' ? 'warn' : ''}>{e.result === 'created' ? tx('Order received') : e.result === 'duplicate' ? tx('Sent again (ignored)') : tx('Refused')}</b>
              <span>{when(e.receivedAt)}{e.detail ? ` · ${e.detail}` : ''}</span></div>
          </div>
        ))}
      </section>

      {removing && (
        <Modal title={tx('Remove this mapping?')} onClose={() => setRemoving(null)}>
          <p>{tx('{platform} id {id} will no longer be {item}. New orders with it will be flagged for the kitchen and left off the bill.', { platform: NAME[channel], id: removing.externalItemId, item: removing.itemName })}</p>
          <div className="actions"><button onClick={() => setRemoving(null)}>{tx('Keep it')}</button>
            <button className="danger" data-testid="plat-remove-confirm" disabled={busy} onClick={() => void remove(removing)}>{tx('Remove')}</button></div>
        </Modal>
      )}
    </main>
  );
}

type ItemOpt = { id: string; name: string; priced: boolean };
type OnMap = (externalItemId: string, itemId: string) => Promise<void>;

function ItemSelect({ items, channel, value, onChange, testid }: { items: ItemOpt[]; channel: Channel; value: string; onChange: (v: string) => void; testid: string }) {
  const tx = useT();
  return (
    <select data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tx('Choose an item…')}</option>
      {items.map((i) => <option key={i.id} value={i.id} disabled={!i.priced}>{i.name}{i.priced ? '' : ` (${tx('no {platform} price', { platform: NAME[channel] })})`}</option>)}
    </select>
  );
}

function UnmappedRow({ u, items, channel, busy, onMap }: { u: Unmapped; items: ItemOpt[]; channel: Channel; busy: boolean; onMap: OnMap }) {
  const tx = useT();
  // Start on the item of the same name, if there is a sellable one.
  const [itemId, setItemId] = useState(() => items.find((i) => i.priced && i.name.toLowerCase() === u.name.toLowerCase())?.id ?? '');
  return (
    <div className="m-row" data-testid="plat-unmapped-row">
      <div className="main"><b>{u.name}</b><span>{NAME[channel]} id {u.externalItemId} · {tn(u.orders, 'on {n} order', 'on {n} orders')}, {tx('last')} {when(u.lastSeen)}</span></div>
      <div className="m-row-actions">
        <ItemSelect items={items} channel={channel} value={itemId} onChange={setItemId} testid="plat-unmapped-item" />
        <button className="primary" data-testid="plat-unmapped-save" disabled={!itemId || busy} title={itemId ? '' : tx('Choose an item first')} onClick={() => void onMap(u.externalItemId, itemId)}>{tx('Map')}</button>
      </div>
    </div>
  );
}

function AddMap({ items, channel, busy, onMap }: { items: ItemOpt[]; channel: Channel; busy: boolean; onMap: OnMap }) {
  const tx = useT();
  const [ext, setExt] = useState('');
  const [itemId, setItemId] = useState('');
  const valid = /^[\x21-\x7e]{1,64}$/.test(ext.trim());
  return (
    <div className="m-row">
      <div className="main"><input data-testid="plat-add-ext" placeholder={tx('{platform} item id', { platform: NAME[channel] })} value={ext} maxLength={64} onChange={(e) => setExt(e.target.value)} /></div>
      <div className="m-row-actions">
        <ItemSelect items={items} channel={channel} value={itemId} onChange={setItemId} testid="plat-add-item" />
        <button data-testid="plat-add-save" disabled={!valid || !itemId || busy} title={!valid ? tx('Type the platform id (no spaces)') : !itemId ? tx('Choose an item') : ''}
          onClick={() => void onMap(ext.trim(), itemId).then(() => { setExt(''); setItemId(''); })}>{tx('Add')}</button>
      </div>
    </div>
  );
}

function Connection({ token, outletId, channel, setup, integration, onSaved }: {
  token: string; outletId: string; channel: Channel; setup: Setup; integration: Integration | null; onSaved: () => Promise<void>;
}) {
  const tx = useT();
  const [storeId, setStoreId] = useState(integration?.externalStoreId ?? '');
  const [secret, setSecret] = useState('');
  const [userId, setUserId] = useState(integration?.serviceUserId ?? setup.users.find((u) => u.role === 'manager')?.id ?? '');
  const [deviceId, setDeviceId] = useState(integration?.deviceId ?? setup.devices[0]?.id ?? '');
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const secretOk = secret === '' ? !!integration : /^[\x21-\x7e]{16,200}$/.test(secret);
  const why = !/^[\x21-\x7e]{1,64}$/.test(storeId.trim()) ? tx('Enter the store id (no spaces)')
    : !secretOk ? (secret === '' ? tx('Enter the webhook secret') : tx('The secret is at least 16 characters, no spaces'))
    : !userId ? tx('Choose who orders are booked to') : !deviceId ? tx('Choose the tablet that receives orders') : '';

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { externalStoreId: storeId.trim(), serviceUserId: userId, deviceId, enabled, ...(secret ? { webhookSecret: secret } : {}) };
      const r = await api(`/outlets/${outletId}/integrations/${channel}`, token, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 200) { setSecret(''); setMsg({ ok: true, text: tx('Saved.') }); await onSaved(); }
      else setMsg({ ok: false, text: tx(ERRORS[r.body.error as string] ?? 'Could not save. Check each field.') });
    } catch { setMsg({ ok: false, text: tx('Could not reach the server.') }); } finally { setBusy(false); }
  };

  return (
    <section className="m-card" data-testid="plat-connection">
      <header><h2>{tx('Connection')}</h2>
        <span className="muted" data-testid="plat-status">{!integration ? tx('Not set up') : !integration.enabled ? tx('Turned off') : tx('On · last order call {time}', { time: when(integration.lastEventAt) })}</span>
      </header>
      <div className="m-form">
        <label className="m-field">{tx('Store id (from the {platform} partner dashboard)', { platform: NAME[channel] })}
          <input data-testid="plat-store" value={storeId} maxLength={64} onChange={(e) => setStoreId(e.target.value)} /></label>
        <label className="m-field">{tx('Webhook secret')}
          <input data-testid="plat-secret" type="password" autoComplete="off" value={secret} maxLength={200}
            placeholder={integration ? tx('Saved. Type a new one only to replace it') : tx('At least 16 characters')} onChange={(e) => setSecret(e.target.value)} /></label>
        <label className="m-field">{tx('Orders arrive on tablet')}
          <select data-testid="plat-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {setup.devices.length === 0 && <option value="">{tx('No tablet at this outlet')}</option>}
            {setup.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        <label className="m-field">{tx('Orders are booked to')}
          <select data-testid="plat-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{tx('Choose a person…')}</option>
            {setup.users.map((u) => <option key={u.id} value={u.id}>{u.name} ({tx(u.role)})</option>)}
          </select></label>
        <label className="m-field inline"><input data-testid="plat-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {tx('Take orders from {platform}', { platform: NAME[channel] })}</label>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'muted' : 'error'} data-testid="plat-save-msg">{msg.text}</p>}
        <div className="m-dialog-actions">
          <button className="primary" data-testid="plat-save" disabled={!!why || busy} title={why} onClick={() => void save()}>{busy ? tx('Saving…') : tx('Save')}</button>
        </div>
      </div>
    </section>
  );
}
