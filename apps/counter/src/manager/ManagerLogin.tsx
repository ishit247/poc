import { useState } from 'react';

export function ManagerLogin({ onToken, onCancel }: { onToken: (t: string) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (r.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
      if (!r.ok) throw new Error('Email or password is not right.');
      onToken((await r.json()).token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server. Manager sign-in needs a connection.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="center">
      <h1>Manager sign-in</h1>
      <input data-testid="mgr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoCapitalize="off" autoComplete="username" />
      <input data-testid="mgr-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
      <div>
        <button data-testid="mgr-cancel" onClick={onCancel}>Back</button>{' '}
        <button data-testid="mgr-login" className="primary" disabled={busy || !email || !password} onClick={go}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
