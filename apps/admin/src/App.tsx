import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, getToken, setExpiredHandler, setToken, type Admin } from './api.ts';
import { Login } from './Login.tsx';
import { Catalog } from './Catalog.tsx';
import { Tenants } from './Tenants.tsx';
import { TenantDetail } from './TenantDetail.tsx';
import { Confirm } from './Modal.tsx';
import { Toaster } from './toast.tsx';
import { getFont, getTheme, setFont, setTheme, type FontSize, type Theme } from './prefs.ts';

const tenantFromHash = () => /^#\/tenant\/([0-9a-f-]{36})$/i.exec(window.location.hash)?.[1] ?? '';
/** null: not on a catalog page; '' the list; 'new' a blank template; otherwise a template id. */
const catalogFromHash = () => {
  const m = /^#\/catalog(?:\/(new|[0-9a-f-]{36}))?$/i.exec(window.location.hash);
  return m ? (m[1] ?? '') : null;
};

export function App() {
  const [admin, setAdmin] = useState<Admin | null | undefined>(getToken() ? undefined : null);
  const [tenantId, setTenantId] = useState(tenantFromHash());
  const [catalog, setCatalog] = useState(catalogFromHash());
  const [notice, setNotice] = useState('');
  // The catalog editor reports unsaved changes here, so leaving it (a nav link, Back) asks first.
  const [dirty, setDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  const signedOut = useCallback((why = '') => { setToken(''); setAdmin(null); setNotice(why); }, []);
  useEffect(() => { setExpiredHandler(() => signedOut('Your session ended. Sign in again.')); }, [signedOut]);
  useEffect(() => {
    if (admin !== undefined) return;
    void api<Admin>('/platform/me').then((r) => setAdmin(r.status === 200 ? r.body : null));
  }, [admin]);
  useEffect(() => {
    const on = () => { setTenantId(tenantFromHash()); setCatalog(catalogFromHash()); setDirty(false); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const go = (hash: string) => (e: MouseEvent) => {
    e.preventDefault();
    if (dirty) setLeaveTo(hash); else window.location.hash = hash;
  };

  if (admin === undefined) return <main className="loginwrap">Loading…</main>;
  if (!admin) return <Login notice={notice} onSignedIn={(a) => { setNotice(''); setAdmin(a); }} />;
  const isOwner = admin.role === 'owner';
  const onCatalog = catalog !== null;
  return (
    <div className="app">
      <header className="nav">
        <div className="brand"><div className="logo">B</div><b>Platform console</b></div>
        <nav className="navlinks" aria-label="Main">
          <a className="nl" href="#" data-testid="nav-tenants" aria-current={!onCatalog ? 'page' : undefined} onClick={go('')}>Tenants</a>
          <a className="nl" href="#/catalog" data-testid="nav-catalog" aria-current={onCatalog ? 'page' : undefined} onClick={go('#/catalog')}>Catalog</a>
        </nav>
        <span className="sp" />
        {!isOwner && <span className="pill warn" data-testid="read-only">Read-only</span>}
        <AccountMenu admin={admin} onSignOut={async () => { await api('/platform/logout', { method: 'POST', body: {} }); signedOut(); }} />
      </header>
      <div className={`content${onCatalog && catalog ? ' wide' : ''}`}>
        {onCatalog
          ? <Catalog key={catalog} isOwner={isOwner} templateId={catalog} onDirty={setDirty} go={go} />
          : tenantId
            ? <TenantDetail tenantId={tenantId} isOwner={isOwner} />
            : <Tenants isOwner={isOwner} />}
      </div>
      {leaveTo !== null && <Confirm title="Leave without saving?" message="Your unsaved changes to this template will be lost." label="Leave" danger onClose={() => setLeaveTo(null)} onYes={() => { setDirty(false); window.location.hash = leaveTo; }} />}
      <Toaster />
    </div>
  );
}

function AccountMenu({ admin, onSignOut }: { admin: Admin; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [font, setFontState] = useState<FontSize>(getFont);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const initials = admin.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="more" ref={ref}>
      <button className="avatar" data-testid="account-menu" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen(!open)}>{initials}</button>
      {open && (
        <div className="popmenu" role="menu">
          <div className="profile" data-testid="who"><div className="avatar" style={{ cursor: 'default' }}>{initials}</div><div><b>{admin.name}</b><small>{admin.email} · {admin.role}</small></div></div>
          <hr />
          <div className="prefrow">Text size
            <div className="seg">{(['s', 'm', 'l'] as const).map((f) => <button key={f} data-testid={`font-${f}`} aria-pressed={font === f} onClick={() => { setFont(f); setFontState(f); }}>{f.toUpperCase()}</button>)}</div>
          </div>
          <div className="prefrow">Theme
            <div className="seg">{(['light', 'dark'] as const).map((t) => <button key={t} data-testid={`theme-${t}`} aria-pressed={theme === t} onClick={() => { setTheme(t); setThemeState(t); }}>{t === 'light' ? 'Light' : 'Dark'}</button>)}</div>
          </div>
          <hr />
          <button className="menuitem danger" role="menuitem" data-testid="sign-out" onClick={() => { setOpen(false); onSignOut(); }}>⎋ Sign out</button>
        </div>
      )}
    </div>
  );
}
