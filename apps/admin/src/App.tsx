import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setExpiredHandler, setToken, type Admin } from './api.ts';
import { Login } from './Login.tsx';
import { Tenants } from './Tenants.tsx';
import { TenantDetail } from './TenantDetail.tsx';

const tenantFromHash = () => /^#\/tenant\/([0-9a-f-]{36})$/i.exec(window.location.hash)?.[1] ?? '';

export function App() {
  const [admin, setAdmin] = useState<Admin | null | undefined>(getToken() ? undefined : null);
  const [tenantId, setTenantId] = useState(tenantFromHash());
  const [notice, setNotice] = useState('');

  const signedOut = useCallback((why = '') => { setToken(''); setAdmin(null); setNotice(why); }, []);
  useEffect(() => { setExpiredHandler(() => signedOut('Your session ended. Sign in again.')); }, [signedOut]);
  useEffect(() => {
    if (admin !== undefined) return;
    void api<Admin>('/platform/me').then((r) => setAdmin(r.status === 200 ? r.body : null));
  }, [admin]);
  useEffect(() => {
    const on = () => setTenantId(tenantFromHash());
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
        <span className="spacer" />
        <span data-testid="who" className="muted">{admin.name} · {admin.role}</span>
        <button data-testid="sign-out" onClick={async () => { await api('/platform/logout', { method: 'POST', body: {} }); signedOut(); }}>Sign out</button>
      </header>
      <div className="page">
        {tenantId
          ? <TenantDetail tenantId={tenantId} isOwner={isOwner} onBack={() => { window.location.hash = ''; }} />
          : <Tenants isOwner={isOwner} />}
      </div>
    </div>
  );
}
