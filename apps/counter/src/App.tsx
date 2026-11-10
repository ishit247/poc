import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { currentShift, db, getMeta, type DeviceInfo, type LocalShift } from './db.ts';
import { enrol, onDeviceRejected, pull, pullOrders, push, watchOrders } from './sync.ts';
import { loadMenu, type MenuView } from './menu.ts';
import type { Actor } from './sale.ts';
import { PinScreen } from './PinScreen.tsx';
import { Sell } from './Sell.tsx';
import { OnlineQueue } from './OnlineQueue.tsx';
import { Orders } from './Orders.tsx';
import { Shift } from './Shift.tsx';
import { useLogoUrl } from './logo.ts';
import { EnrolShell } from './EnrolShell.tsx';
import { EnrolCodeMaker, InviteScreen, ManagerLogin, ManagerTools } from './manager/index.ts';
import { RefusedBanner } from './RefusedBanner.tsx';
import { isRefusedPayment } from './refused.ts';
import { getFont, getTheme, setFont, setTheme, type FontSize, type Theme } from './prefs.ts';

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
  const [notice, setNotice] = useState('');
  // The server no longer accepts this tablet's credential. Forget the device and the server-side copies (menu, cursors)
  // so set-up starts clean, but KEEP the outbox and local sales: nothing the cashier typed is thrown away.
  useEffect(() => onDeviceRejected(() => {
    void (async () => {
      await db.transaction('rw', [db.meta, db.entities, db.outbox, db.shifts, db.sales, db.orderEvents, db.visits, db.pinState], async () => {
        await db.meta.bulkDelete(['device', 'cursor', 'orderCursor', 'ordersPrimed', 'lastPull']);
        await db.entities.clear();
        // Nothing waiting to be sent means every local shift, sale and order was already delivered to a server that no
        // longer knows us. Left behind, an old shift (opened by a user id that no longer exists) would block all payments.
        // With unsent events we keep everything: those sales are the only copy.
        if ((await db.outbox.filter((r) => !r.rejected).count()) === 0) {
          await Promise.all([db.shifts.clear(), db.sales.clear(), db.orderEvents.clear(), db.visits.clear(), db.pinState.clear()]);
        }
      });
      setNotice('This counter is no longer recognised by the server (it was removed, or the server was reset). Please set it up again.');
      setDevice(null);
    })();
  }), []);
  // A manager invite link carries its token in the fragment: `/#invite=<token>`.
  const [invite, setInvite] = useState(() => /^#invite=(.+)$/.exec(window.location.hash)?.[1] ?? '');
  const [invitedEmail, setInvitedEmail] = useState('');
  if (invite) {
    return <InviteScreen token={invite} onDone={(email) => {
      history.replaceState(null, '', window.location.pathname); // the token is spent: drop it from the address bar
      setInvitedEmail(email);
      setInvite('');
    }} />;
  }
  if (device === undefined) return <main className="center">Loading…</main>;
  if (!device) return <EnrolScreen onDone={(d) => { setNotice(''); setDevice(d); }} invitedEmail={invitedEmail} notice={notice} />;
  return <Counter device={device} />;
}

function EnrolScreen({ onDone, invitedEmail, notice }: { onDone: (d: DeviceInfo) => void; invitedEmail: string; notice: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  // Which part of the set-up is running: the code is checked and the tablet registered, then the menu and staff are loaded.
  const [phase, setPhase] = useState<'idle' | 'enrol' | 'pull'>('idle');
  // 'code' = type a code; 'login' / 'maker' = a manager makes one on this tablet. The token is memory only.
  const [stage, setStage] = useState<'code' | 'login' | 'maker'>(invitedEmail ? 'login' : 'code');
  const [mgr, setMgr] = useState('');
  const go = async (use = code) => {
    setPhase('enrol');
    setError('');
    try {
      const d = await enrol(use);
      setPhase('pull');
      await pull(d);
      onDone(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enrol.');
      setStage('code');
      setPhase('idle');
    }
  };
  if (phase !== 'idle') {
    const rows = [['enrol', 'Checking the code and registering this tablet'], ['pull', 'Downloading the menu and staff list']] as const;
    return (
      <EnrolShell step={2}>
        <h1>Setting up…</h1>
        <p className="lead">Keep this tablet online. It only takes a moment.</p>
        <div className="en-prog" data-testid="enrol-progress" role="status">
          {rows.map(([p, label], i) => {
            const state = p === phase ? 'run' : i < rows.findIndex(([x]) => x === phase) ? 'done' : 'wait';
            return <div key={p} className={`en-prow ${state}`}><span className="st">{state === 'done' ? '✓' : i + 1}</span><b>{label}</b></div>;
          })}
        </div>
      </EnrolShell>
    );
  }
  if (stage === 'login') return <EnrolShell step={1}><ManagerLogin initialEmail={invitedEmail} onToken={(t) => { setMgr(t); setStage('maker'); }} onCancel={() => setStage('code')} /></EnrolShell>;
  if (stage === 'maker') return <EnrolShell step={1}><EnrolCodeMaker token={mgr} onBack={() => { setMgr(''); setStage('code'); }} onUseCode={(c) => { setCode(c); setMgr(''); void go(c); }} /></EnrolShell>;
  const paste = async () => { try { setCode((await navigator.clipboard.readText()).trim()); setError(''); } catch { /* no clipboard access: the manager types it */ } };
  return (
    <EnrolShell step={1}>
      <h1>Set up this counter</h1>
      <p className="lead">Type the enrolment code your manager gave you. Each code works once.</p>
      {notice && <div data-testid="enrol-notice" className="m-alert bad" role="alert"><span>⚠</span><div className="grow">{notice}</div></div>}
      <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) void go(); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="m-field">Enrolment code
          <span className="en-input">
            <input data-testid="enrol-code" className={`en-code${error ? ' err' : ''}`} value={code} onChange={(e) => { setCode(e.target.value); setError(''); }} placeholder="Paste or type the code" autoCapitalize="off" autoComplete="off" spellCheck={false} autoFocus aria-invalid={!!error} />
            <button type="button" onClick={paste}>Paste</button>
          </span>
        </label>
        {error && <div className="en-err" role="alert"><span>⚠</span><span>{error}</span></div>}
        <button type="submit" data-testid="enrol-go" className="primary block" disabled={!code.trim()}>Set up this counter</button>
      </form>
      <div className="en-or">or</div>
      <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>Are you the manager?
        <button type="button" className="ghost sm" data-testid="enrol-manager" onClick={() => setStage('login')}>Sign in to create a code</button>
      </div>
    </EnrolShell>
  );
}

function Counter({ device }: { device: DeviceInfo }) {
  const [menu, setMenu] = useState<MenuView | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [tab, setTab] = useState<'sell' | 'orders' | 'shift'>('sell');
  const [ordersView, setOrdersView] = useState<'home' | 'online'>('home'); // inside Orders: this counter's open orders, or the online queue
  const [onlineWaiting, setOnlineWaiting] = useState(0);
  // null = not in manager tools; '' = signing in; otherwise the session token. Memory only, never stored.
  const [mgr, setMgr] = useState<string | null>(null);
  const [mgrName, setMgrName] = useState(''); // for the More menu's profile row
  const shift = useLive(() => currentShift().then((s) => s ?? null), undefined as LocalShift | null | undefined);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncError, setSyncError] = useState('');
  const pending = useLive(() => db.outbox.filter((r) => !r.rejected).count(), 0);
  // A refused payment (step 7d) has its own banner, which says what to do; this one is for everything else.
  const parked = useLive(() => db.outbox.filter((r) => !!r.rejected && !isRefusedPayment(r)).count(), 0);
  const lastPush = useLive(async () => (await getMeta('lastPush')) ?? '', '');
  const logoUrl = useLogoUrl();
  const lastPull = useLive(async () => (await getMeta('lastPull')) ?? '', '');

  const refresh = useCallback(async () => setMenu(await loadMenu()), []);
  const running = useRef<Promise<void> | null>(null);
  const sync = useCallback((): Promise<void> => {
    // One at a time: the timer, the network coming back and a fresh order change can all ask at once.
    running.current ??= (async () => {
      // Push first (it shrinks the "waiting" count), but never let a failed push stop the menu from updating.
      let pushed = true;
      try { await push(device); } catch { pushed = false; }
      try {
        await pull(device);
        await pullOrders(device); // other devices' open orders (phase 12 step 7)
        setSyncError(pushed ? '' : 'Sales could not be sent just now. They are safe on this tablet and will be retried.');
        // Not `true`: the network can drop while this pull is in flight, and the `offline` event that came meanwhile
        // must not be overwritten by a request that had already left.
        setOnline(navigator.onLine);
      } catch {
        setSyncError('Could not reach the server.');
        setOnline(false);
      }
      await refresh();
    })().finally(() => { running.current = null; });
    return running.current;
  }, [device, refresh]);

  // Something new in the outbox (an order changed, a sale was made): send it soon, so the outlet's other devices see
  // it within a second or two rather than at the next minute. A change made while a sync runs is caught when the
  // count changes again as that sync drains the outbox.
  useEffect(() => {
    if (pending === 0 || !navigator.onLine) return;
    const t = setTimeout(() => { void sync(); }, 800);
    return () => clearTimeout(t);
  }, [pending, sync]);

  // The server nudges when an order at this outlet changes; the tablet then pulls open orders.
  useEffect(() => watchOrders(device), [device]);

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
  // A cashier with no open drawer cannot take money: send them to open one first.
  const needShift = !!actor && actor.role === 'cashier' && shift === null && tab !== 'shift';
  return (
    <div className="shell">
      <header>
        {logoUrl && <img data-testid="logo" className="logo" src={logoUrl} alt="" />}
        <strong>{device.outletName}</strong> <span className="muted">· {device.counterCode}</span>
        <span className="spacer" />
        <span data-testid="sync-status" className={online ? 'ok' : 'warn'} title={online ? 'Online' : 'Offline'} aria-label={online ? 'Online' : 'Offline'}>●</span>
        <span data-testid="pending" className="muted" title={`Sales waiting to reach the server${lastPush ? ` · last sent ${new Date(lastPush).toLocaleTimeString()}` : ''}`}>
          {pending}{lastPush ? ` · ${new Date(lastPush).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button data-testid="sync-now" className="iconbtn" aria-label="Sync now" title="Sync now" onClick={sync}>⟳</button>
        {actor && !needShift && (
          <div className="seg" role="tablist">
            <button data-testid="tab-sell" role="tab" className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')}>Sell</button>
            <button data-testid="tab-orders" role="tab" className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Orders{onlineWaiting > 0 && <span data-testid="online-badge" className="badge">{onlineWaiting}</span>}</button>
          </div>
        )}
        <span className="spacer" />
        <MoreMenu actor={actor ?? undefined} manager={mgr !== null && !actor ? { name: mgrName, signedIn: !!mgr } : undefined}
          onShift={actor?.role === 'cashier' ? () => setTab('shift') : undefined}
          onSignOut={actor ? () => setActor(null) : mgr ? () => { setMgr(null); setMgrName(''); } : undefined}
          onManager={!actor && mgr === null ? () => setMgr('') : undefined} />
      </header>
      {parked > 0 && <div data-testid="parked" className="banner" role="alert">{parked} record{parked === 1 ? ' was' : 's were'} not accepted by the server. Tell your manager; do not clear this tablet.</div>}
      {syncError && <div className="banner" role="status">{syncError} {lastPull ? 'Working offline with the menu from ' + new Date(lastPull).toLocaleString() + '.' : ''}</div>}
      {mgr !== null && !actor ? (
        mgr ? <ManagerTools token={mgr} outletId={device.outletId} deviceId={device.deviceId} onProfile={setMgrName} /> : <main className="center"><ManagerLogin onToken={setMgr} onCancel={() => setMgr(null)} /></main>
      ) : !actor ? (
        <>
          <PinScreen staff={menu.staff} onSignedIn={(a) => { setActor(a); setTab('sell'); }} />
        </>
      ) : needShift ? (
        <><RefusedBanner /><Shift device={device} actor={actor} shift={undefined} onSync={sync} /></>
      ) : (
        <>
          {(tab === 'sell' || tab === 'shift') && <RefusedBanner />}
          {tab === 'orders' && actor.role === 'cashier' && (
            <div className="seg sub" role="tablist">
              <button data-testid="orders-home" role="tab" className={ordersView === 'home' ? 'active' : ''} onClick={() => setOrdersView('home')}>Home</button>
              <button data-testid="tab-online" role="tab" className={ordersView === 'online' ? 'active' : ''} onClick={() => setOrdersView('online')}>Online{onlineWaiting > 0 && <span className="badge">{onlineWaiting}</span>}</button>
            </div>
          )}
          {tab === 'sell' ? <Sell device={device} actor={actor} menu={menu} /> : tab === 'orders' ? (ordersView === 'home' || actor.role !== 'cashier' ? <Orders device={device} actor={actor} /> : null) : tab === 'shift' ? <Shift device={device} actor={actor} shift={shift ?? undefined} onSync={sync} /> : null}
          {actor.role === 'cashier' && <OnlineQueue device={device} actor={actor} menu={menu} hidden={!(tab === 'orders' && ordersView === 'online')} onCount={setOnlineWaiting} />}
        </>
      )}
    </div>
  );
}

/** The ⋮ menu: who is signed in (cashier or manager), text size, theme, the drawer (Shift) and, set apart in red, Sign out. Closes on any tap outside it. */
function MoreMenu({ actor, manager, onShift, onSignOut, onManager }: { actor?: Actor; manager?: { name: string; signedIn: boolean }; onShift?: () => void; onSignOut?: () => void; onManager?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [font, setFontState] = useState<FontSize>(getFont);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const who = actor ? { name: actor.name, role: actor.role } : manager?.signedIn ? { name: manager.name || 'Manager', role: 'manager' } : null;
  return (
    <div className="more" ref={ref}>
      <button data-testid="more-menu" className="iconbtn" aria-label="More" aria-expanded={open} onClick={() => setOpen(!open)}>⋮</button>
      {open && (
        <div className="popmenu" role="menu">
          {who && <div className="profile" data-testid="who"><span className="avatar">{who.name.charAt(0).toUpperCase()}</span><span style={{ display: 'flex', flexDirection: 'column' }}><b>{who.name}</b><small>{who.role}</small></span></div>}
          {who && <hr className="sep" />}
          <div className="prefrow"><span>Text</span>
            <div className="seg">
              {(['s', 'm', 'l'] as const).map((f) => <button key={f} data-testid={`font-${f}`} className={font === f ? 'active' : ''} aria-pressed={font === f} onClick={() => { setFont(f); setFontState(f); }}>{f.toUpperCase()}</button>)}
            </div>
          </div>
          <div className="prefrow"><span>Theme</span>
            <div className="seg">
              {([['dark', 'D'], ['light', 'L']] as const).map(([t, label]) => <button key={t} data-testid={`theme-${t}`} className={theme === t ? 'active' : ''} aria-pressed={theme === t} aria-label={`${t} theme`} onClick={() => { setTheme(t); setThemeState(t); }}>{label}</button>)}
            </div>
          </div>
          {(onShift || onManager) && <hr className="sep" />}
          {onShift && <button role="menuitem" data-testid="tab-shift" onClick={() => { setOpen(false); onShift(); }}>Shift</button>}
          {onManager && <button role="menuitem" data-testid="mgr-open" onClick={() => { setOpen(false); onManager(); }}>Manager tools</button>}
          {onSignOut && <hr className="sep" />}
          {onSignOut && <button role="menuitem" className="danger" data-testid={manager ? 'mgr-exit' : 'sign-out'} onClick={() => { setOpen(false); onSignOut(); }}>Sign out</button>}
        </div>
      )}
    </div>
  );
}
