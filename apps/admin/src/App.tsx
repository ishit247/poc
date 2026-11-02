import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setExpiredHandler, setToken, type Admin } from './api.ts';
import { Login } from './Login.tsx';
import { Catalog } from './Catalog.tsx';
import { Tenants } from './Tenants.tsx';
import { TenantDetail } from './TenantDetail.tsx';

const tenantFromHash = () => /^#\/tenant\/([0-9a-f-]{36})$/i.exec(window.location.hash)?.[1] ?? '';
/** null: not on a catalog page; '' the list; otherwise a template id. */
const catalogFromHash = () => {
  const m = /^#\/catalog(?:\/([0-9a-f-]{36}))?$/i.exec(window.location.hash);
  return m ? (m[1] ?? '') : null;
};

export function App() {
  const [admin, setAdmin] = useState<Admin | null | undefined>(getToken() ? undefined : null);
  const [tenantId, setTenantId] = useState(tenantFromHash());
  const [catalog, setCatalog] = useState(catalogFromHash());
  const [notice, setNotice] = useState('');

  const signedOut = useCallback((why = '') => { setToken(''); setAdmin(null); setNotice(why); }, []);
  useEffect(() => { setExpiredHandler(() => signedOut('Your session ended. Sign in again.')); }, [signedOut]);
  useEffect(() => {
    if (admin !== undefined) return;
    void api<Admin>('/platform/me').then((r) => setAdmin(r.status === 200 ? r.body : null));
  }, [admin]);
  useEffect(() => {
    const on = () => { setTenantId(tenantFromHash()); setCatalog(catalogFromHash()); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (admin === undefined) return <main className="center">Loading…</main>;
  if (!admin) return <Login notice={notice} onSignedIn={(a) => { setNotice(''); setAdmin(a); }} />;
  const isOwner = admin.role === 'owner';
  return (
    <div className="shell">
      <header>
        <strong>Platform console</strong>
        <a href="#" data-testid="nav-tenants">Tenants</a>
        <a href="#/catalog" data-testid="nav-catalog">Catalog templates</a>
        <span className="spacer" />
        <span data-testid="who" className="muted">{admin.name} · {admin.role}</span>
        <button data-testid="sign-out" onClick={async () => { await api('/platform/logout', { method: 'POST', body: {} }); signedOut(); }}>Sign out</button>
      </header>
      <div className="page">
        {catalog !== null
          ? <Catalog isOwner={isOwner} templateId={catalog} />
          : tenantId
            ? <TenantDetail tenantId={tenantId} isOwner={isOwner} onBack={() => { window.location.hash = ''; }} />
            : <Tenants isOwner={isOwner} />}
      </div>
    </div>
  );
}
