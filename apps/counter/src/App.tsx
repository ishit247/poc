import { useCallback, useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { currentShift, db, getMeta, type DeviceInfo, type LocalShift } from './db.ts';
import { enrol, pull, push } from './sync.ts';
import { loadMenu, type MenuView } from './menu.ts';
import type { Actor } from './sale.ts';
import { PinScreen } from './PinScreen.tsx';
import { Sell } from './Sell.tsx';
import { Orders } from './Orders.tsx';
import { Shift } from './Shift.tsx';
import { useLogoUrl } from './logo.ts';
import { Branding } from './Branding.tsx';
import { DayClose, ManagerLogin } from './manager/index.ts';

function useLive<T>(query: () => Promise<T>, initial: T): T {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setV, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
  }, []);
  return v;
}

export function App() {
  const [device, setDevice] = useState<DeviceInfo | null | undefined>(undefined);
  useEffect(() => {
    void navigator.storage?.persist?.(); // ask the browser not to evict the sales database
    void getMeta('device').then((d) => setDevice(d ?? null));
  }, []);
  if (device === undefined) return <main className="center">Loading…</main>;
  if (!device) return <EnrolScreen onDone={setDevice} />;
  return <Counter device={device} />;
}

function EnrolScreen({ onDone }: { onDone: (d: DeviceInfo) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await enrol(code);
      await pull(d);
      onDone(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enrol.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="center">
      <Branding />
      <h1>Set up this counter</h1>
      <p>Ask your manager for an enrolment code and type it here. This tablet must be online for this step.</p>
      <input data-testid="enrol-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enrolment code" autoCapitalize="off" autoComplete="off" />
      <button data-testid="enrol-go" className="primary" disabled={busy || !code.trim()} onClick={go}>{busy ? 'Setting up…' : 'Set up'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

function Counter({ device }: { device: DeviceInfo }) {
  const [menu, setMenu] = useState<MenuView | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [tab, setTab] = useState<'sell' | 'orders' | 'shift'>('sell');
  // null = not in manager tools; '' = signing in; otherwise the session token. Memory only, never stored.
  const [mgr, setMgr] = useState<string | null>(null);
  const shift = useLive(() => currentShift().then((s) => s ?? null), undefined as LocalShift | null | undefined);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncError, setSyncError] = useState('');
  const pending = useLive(() => db.outbox.filter((r) => !r.rejected).count(), 0);
  const parked = useLive(() => db.outbox.filter((r) => !!r.rejected).count(), 0);
  const lastPush = useLive(async () => (await getMeta('lastPush')) ?? '', '');
  const logoUrl = useLogoUrl();
  const lastPull = useLive(async () => (await getMeta('lastPull')) ?? '', '');

  const refresh = useCallback(async () => setMenu(await loadMenu()), []);
  const sync = useCallback(async () => {
    // Push first (it shrinks the "waiting" count), but never let a failed push stop the menu from updating.
    let pushed = true;
    try { await push(device); } catch { pushed = false; }
    try {
      await pull(device);
      setSyncError(pushed ? '' : 'Sales could not be sent just now. They are safe on this tablet and will be retried.');
      setOnline(true);
    } catch {
      setSyncError('Could not reach the server.');
      setOnline(false);
    }
    await refresh();
  }, [device, refresh]);

  useEffect(() => {
    void refresh();
    void sync();
    const on = () => { setOnline(true); void sync(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const timer = setInterval(() => { if (navigator.onLine) void sync(); }, 60_000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(timer); };
  }, [sync, refresh]);

  if (!menu) return <main className="center">Loading…</main>;
  return (
    <div className="shell">
      <header>
        {logoUrl && <img data-testid="logo" className="logo" src={logoUrl} alt="" />}
        <strong>{device.outletName}</strong> <span className="muted">· counter {device.counterCode}</span>
        <span className="spacer" />
        <span data-testid="sync-status" className={online ? 'ok' : 'warn'}>{online ? '● Online' : '● Offline'}</span>
        <span data-testid="pending" className="muted" title="Sales waiting to reach the server">{pending} waiting{lastPush ? ` · last sent ${new Date(lastPush).toLocaleTimeString()}` : ''}</span>
        <button data-testid="sync-now" onClick={sync}>Sync</button>
        {actor && (
          <>
            <span data-testid="who">{actor.name}</span>
            <button data-testid="sign-out" onClick={() => setActor(null)}>Sign out</button>
          </>
        )}
      </header>
      {parked > 0 && <div data-testid="parked" className="banner" role="alert">{parked} record{parked === 1 ? ' was' : 's were'} not accepted by the server. Tell your manager; do not clear this tablet.</div>}
      {syncError && <div className="banner" role="status">{syncError} {lastPull ? 'Working offline with the menu from ' + new Date(lastPull).toLocaleString() + '.' : ''}</div>}
      {mgr !== null && !actor ? (
        mgr ? <DayClose token={mgr} onDone={() => setMgr(null)} /> : <ManagerLogin onToken={setMgr} onCancel={() => setMgr(null)} />
      ) : !actor ? (
        <>
          <PinScreen staff={menu.staff} onSignedIn={(a) => { setActor(a); setTab('sell'); }} />
          <p className="center"><button data-testid="mgr-open" onClick={() => setMgr('')}>Manager: close the day</button></p>
        </>
      ) : actor.role === 'cashier' && shift === null && tab !== 'shift' ? (
        // A cashier with no open drawer cannot take money: send them to open one first.
        <Shift device={device} actor={actor} shift={undefined} onSync={sync} />
      ) : (
        <>
          <nav>
            <button data-testid="tab-sell" className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')}>Sell</button>
            <button data-testid="tab-orders" className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Open orders</button>
            {actor.role === 'cashier' && <button data-testid="tab-shift" className={tab === 'shift' ? 'active' : ''} onClick={() => setTab('shift')}>Shift</button>}
          </nav>
          {tab === 'sell' ? <Sell device={device} actor={actor} menu={menu} /> : tab === 'orders' ? <Orders device={device} actor={actor} /> : <Shift device={device} actor={actor} shift={shift ?? undefined} onSync={sync} />}
        </>
      )}
    </div>
  );
}
