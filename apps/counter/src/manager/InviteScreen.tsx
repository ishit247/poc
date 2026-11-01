import { useState } from 'react';

const MIN_PASSWORD = 12; // same floor as the API (security/password.ts)

// Opened from the link the platform operator passes on: https://<host>/#invite=<token>. The fragment is never sent
// to a server or logged by the proxy. The manager chooses their own password; the operator never sees it.
export function InviteScreen({ token, onDone }: { token: string; onDone: (email: string) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again !== '' && again !== password;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/invite/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
      if (r.status === 403) throw new Error('This account is suspended. Contact support.');
      if (r.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
      if (r.status === 401) throw new Error('This link has expired or was already used. Ask for a new one.');
      if (!r.ok) throw new Error('Could not set the password.');
      onDone((await r.json()).email as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="center">
      <h1>Welcome — choose your password</h1>
      <p>You will use it with your email to sign in as manager.</p>
      <input data-testid="invite-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`New password (${MIN_PASSWORD}+ characters)`} autoComplete="new-password" />
      <input data-testid="invite-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Type it again" autoComplete="new-password" />
      {mismatch && <p className="error">The two passwords differ.</p>}
      <button data-testid="invite-go" className="primary" disabled={busy || password.length < MIN_PASSWORD || password !== again} onClick={go}>{busy ? 'Saving…' : 'Save password'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
