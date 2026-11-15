import { useCallback, useEffect, useRef, useState } from 'react';
import { formatRupees, paise } from '@pos/shared';
import type { DeviceInfo } from './db.ts';
import type { Actor } from './sale.ts';
import type { MenuView } from './menu.ts';
import { t, useT } from './i18n.ts';
import { call, chime, countdown, signInOnline, unlockSound, watchQueue, type OnlineOrder } from './online.ts';

const rs = (n: number | string) => formatRupees(paise(Number(n)));
const REASONS = ['Out of stock', 'Too busy', 'Kitchen closed', 'Customer asked to cancel', 'Other'];
const NEXT_LABEL: Record<string, string> = { accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready', received: 'New' }; // shown through t()

/** The cashier's queue for Zomato/Swiggy orders keyed in by hand. Always mounted (hidden on other tabs) so the badge and chime keep working. */
export function OnlineQueue({ device, actor, menu, hidden, onCount }: {
  device: DeviceInfo; actor: Actor; menu: MenuView; hidden: boolean; onCount: (n: number) => void;
}) {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [declining, setDeclining] = useState<{ id: string; verb: 'rejected' | 'cancelled' } | null>(null);
  const [adding, setAdding] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const r = await call<OnlineOrder[]>(token, '/online-orders');
      if (r.status === 401) { setToken(null); return; }
      if (r.status !== 200) throw new Error(String(r.status));
      setOrders(r.body);
      setError('');
      const fresh = r.body.filter((o) => o.status === 'received').map((o) => o.id);
      if (seen.current && fresh.some((id) => !seen.current!.has(id))) chime();
      seen.current = new Set(fresh);
      onCount(fresh.length);
    } catch {
      setError(t('Needs internet. Orders are not updating.'));
    }
  }, [token, onCount]);

  useEffect(() => {
    if (!token) { onCount(0); return; }
    seen.current = null;
    void refresh();
    return watchQueue(token, () => void refresh(), setLive);
  }, [token, refresh, onCount]);
  // Poll while the stream is down (and as a slow safety net when it is up).
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => void refresh(), live ? 60_000 : 10_000);
    return () => clearInterval(t);
  }, [token, live, refresh]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // Back on the network: look again now, not at the next poll.
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [refresh]);
  // A different cashier means a different session.
  useEffect(() => { setToken(null); setOrders([]); }, [actor.id]);

  const move = async (id: string, body: object) => {
    if (!token) return;
    unlockSound();
    try {
      const r = await call<{ error?: string }>(token, `/online-orders/${id}/transition`, { method: 'POST', body });
      if (r.status === 409) setError(t('That order has already moved. Refreshed.'));
      else if (r.status !== 200) setError(t('Could not update the order.'));
      else setError('');
    } catch {
      setError(t('Needs internet. The order was not changed.'));
    }
    setDeclining(null);
    void refresh();
  };

  if (hidden && !token) return null;
  return (
    <main className="orders online" hidden={hidden} onPointerDown={unlockSound}>
      {!token ? <Connect device={device} actor={actor} onToken={setToken} /> : (
        <>
          <h2>{t('Online orders')} <small data-testid="online-live" className={live ? 'ok' : 'warn'}>{live ? t('● live') : t('● checking every 10 s')}</small>
            <button data-testid="online-add" className="primary" onClick={() => setAdding(true)}>{t('+ New order')}</button></h2>
          {error && <p role="alert" className="error" data-testid="online-error">{error}</p>}
          {orders.length === 0 && <p className="muted" data-testid="online-empty">{t('No online orders waiting.')}</p>}
          <ul>
            {orders.map((o) => (
              <li key={o.id} data-testid="online-order" data-status={o.status} className={o.status === 'received' ? 'fresh' : ''}>
                <div>
                  <b>{o.channel === 'zomato' ? 'Zomato' : 'Swiggy'} {o.externalOrderId}</b> <span className="muted">₹{rs(o.totalPaise)}{o.priceOverridden ? ` · ${t('price changed')}` : ''}</span>
                  <div><span className="chip">{t(NEXT_LABEL[o.status]!)}</span>
                    {o.status === 'received' && <span data-testid="online-countdown" className={countdown(o.acceptBy, now) === 'overdue' ? 'warn' : ''}>{' '}{t('accept within')} {countdown(o.acceptBy, now)}</span>}
                    {o.customerLabel && <span className="muted"> · {o.customerLabel}</span>}
                  </div>
                  {!!o.unmappedLines?.length && (
                    <div data-testid="online-unmapped" className="warn" role="note">
                      {t('Not on this bill, check the platform app')}: {o.unmappedLines.map((l) => `${l.qty} × ${l.name}`).join(', ')}
                    </div>
                  )}
                </div>
                <div className="actions">
                  {declining?.id === o.id ? (
                    <>
                      {REASONS.map((r) => <button key={r} data-testid="online-reason" onClick={() => void move(o.id, { to: declining.verb, reason: r })}>{t(r)}</button>)}
                      <button onClick={() => setDeclining(null)}>{t('Back')}</button>
                    </>
                  ) : (
                    <>
                      {o.status === 'received' && <button data-testid="online-accept" className="primary" onClick={() => void move(o.id, { to: 'accepted', prepMinutes: 15 })}>{t('Accept')}</button>}
                      {o.status === 'received' && <button data-testid="online-reject" onClick={() => setDeclining({ id: o.id, verb: 'rejected' })}>{t('Reject')}</button>}
                      {o.status === 'accepted' && <button data-testid="online-preparing" onClick={() => void move(o.id, { to: 'preparing' })}>{t('Preparing')}</button>}
                      {(o.status === 'accepted' || o.status === 'preparing') && <button data-testid="online-ready" className="primary" onClick={() => void move(o.id, { to: 'ready' })}>{t('Ready')}</button>}
                      {o.status === 'ready' && <button data-testid="online-handover" className="primary" onClick={() => void move(o.id, { to: 'handed_over' })}>{t('Handed over')}</button>}
                      {o.status !== 'received' && <button data-testid="online-cancel" onClick={() => setDeclining({ id: o.id, verb: 'cancelled' })}>{t('Cancel')}</button>}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {adding && <NewOrder token={token} menu={menu} onClose={() => { setAdding(false); void refresh(); }} />}
        </>
      )}
    </main>
  );
}

function Connect({ device, actor, onToken }: { device: DeviceInfo; actor: Actor; onToken: (t: string) => void }) {
  const t = useT();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await signInOnline(device.credential, actor.id, pin);
    setBusy(false);
    setPin('');
    if (r.ok) onToken(r.token); else setMessage(r.message);
  };
  return (
    <div className="center" data-testid="online-connect">
      <h2>{t('Online orders')}</h2>
      <p className="muted">{t('Enter your PIN again to connect to the server.')}</p>
      <input data-testid="online-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={8}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 6) void go(); }} />
      <button data-testid="online-connect-go" className="primary" disabled={busy || pin.length < 6} onClick={() => void go()}>{t('Connect')}</button>
      {message && <p role="alert" className="error" data-testid="online-connect-message">{message}</p>}
    </div>
  );
}

function NewOrder({ token, menu, onClose }: { token: string; menu: MenuView; onClose: () => void }) {
  const t = useT();
  const [channel, setChannel] = useState<'zomato' | 'swiggy'>('zomato');
  const [ext, setExt] = useState('');
  const [label, setLabel] = useState('');
  const [lines, setLines] = useState<{ itemId: string; qty: number }[]>([]);
  const [item, setItem] = useState(menu.entries[0]?.itemId ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const name = (id: string) => menu.entries.find((e) => e.itemId === id)?.name ?? id;

  const add = () => {
    if (!item) return;
    setLines((ls) => ls.some((l) => l.itemId === item) ? ls.map((l) => l.itemId === item ? { ...l, qty: Math.min(99, l.qty + 1) } : l) : [...ls, { itemId: item, qty: 1 }]);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await call<{ error?: string }>(token, '/online-orders', {
        method: 'POST', body: { channel, externalOrderId: ext.trim(), ...(label.trim() ? { customerLabel: label.trim() } : {}), lines },
      });
      if (r.status === 201 || r.status === 200) return onClose();
      setMessage(r.status === 422 ? t('An item has no price for this platform. Ask your manager to set it.') : r.status === 409 ? t('This tablet is not enrolled.') : t('Could not save the order.'));
    } catch {
      setMessage(t('Needs internet.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-label={t('New online order')} data-testid="online-new"><div className="dialog">
      <h2>{t('New online order')}</h2>
      <label>{t('Platform')} <select data-testid="online-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'zomato' | 'swiggy')}><option value="zomato">Zomato</option><option value="swiggy">Swiggy</option></select></label>
      <label>{t('Order number on the app')} <input data-testid="online-ext" value={ext} maxLength={64} onChange={(e) => setExt(e.target.value)} /></label>
      <label>{t('Where to (optional)')} <input data-testid="online-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} /></label>
      <div>
        <select data-testid="online-item" value={item} onChange={(e) => setItem(e.target.value)}>{menu.entries.map((e) => <option key={e.itemId} value={e.itemId}>{e.name}</option>)}</select>
        <button data-testid="online-add-line" onClick={add}>{t('Add')}</button>
      </div>
      <ul>{lines.map((l) => <li key={l.itemId}>{l.qty} × {name(l.itemId)} <button onClick={() => setLines(lines.filter((x) => x.itemId !== l.itemId))}>{t('Remove')}</button></li>)}</ul>
      {message && <p role="alert" className="error" data-testid="online-new-message">{message}</p>}
      <div className="actions">
        <button onClick={onClose}>{t('Cancel')}</button>
        <button data-testid="online-save" className="primary" disabled={busy || !ext.trim() || lines.length === 0} onClick={() => void save()}>{t('Save order')}</button>
      </div>
    </div></div>
  );
}
