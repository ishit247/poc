import { useState } from 'react';

/** Manager sign-in form. Callers decide what surrounds it (the enrolment rail, or the counter's own header). */
export function ManagerLogin({ onToken, onCancel, initialEmail = '' }: { onToken: (t: string) => void; onCancel: () => void; initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
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
    <form className="m-login" onSubmit={(e) => { e.preventDefault(); if (!busy && email && password) void go(); }}>
      <div>
        <h1>Manager sign-in</h1>
        <div className="muted">Needs a connection. Your cashiers can keep selling.</div>
      </div>
      <label className="m-field">Email
        <input data-testid="mgr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoCapitalize="off" autoComplete="username" />
      </label>
      <label className="m-field">Password
        <span className="m-pw">
          <input data-testid="mgr-password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button type="button" className="ghost sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
        </span>
      </label>
      {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="m-btnpair">
        <button type="button" data-testid="mgr-cancel" onClick={onCancel}>Back</button>
        <button type="submit" data-testid="mgr-login" className="primary" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </form>
  );
}
