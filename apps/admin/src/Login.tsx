import { useState } from 'react';
import { api, setToken, type Admin } from './api.ts';

export function Login({ onSignedIn, notice }: { onSignedIn: (a: Admin) => void; notice: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError('');
    const r = await api('/platform/login', { body: { email, password, code: code.trim() } });
    if (r.status === 200) {
      setToken(r.body.token);
      const me = await api<Admin>('/platform/me');
      if (me.status === 200) { onSignedIn(me.body); return; }
    }
    setBusy(false);
    setError(r.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Email, password or code is not right.');
    setCode('');
  };
  return (
    <main className="center">
      <h1>Platform console</h1>
      {notice && <p className="warn" role="status">{notice}</p>}
      <input data-testid="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoCapitalize="off" autoComplete="username" />
      <input data-testid="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
      <input data-testid="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Authenticator code" autoComplete="one-time-code" maxLength={10}
        onKeyDown={(e) => { if (e.key === 'Enter' && email && password && code) void go(); }} />
      <button data-testid="login" className="primary" disabled={busy || !email || !password || !code} onClick={go}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
