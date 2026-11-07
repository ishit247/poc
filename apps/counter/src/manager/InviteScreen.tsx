import { useState } from 'react';
import { EnrolShell } from '../EnrolShell.tsx';

const MIN_PASSWORD = 12; // same floor as the API (security/password.ts)

// Opened from the link the platform operator passes on: https://<host>/#invite=<token>. The fragment is never sent
// to a server or logged by the proxy. The manager chooses their own password; the operator never sees it.
export function InviteScreen({ token, onDone }: { token: string; onDone: (email: string) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const longEnough = password.length >= MIN_PASSWORD;
  const matches = again !== '' && again === password;
  const level = password.length >= 16 ? 3 : longEnough ? 2 : password.length > 0 ? 1 : 0;
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
  const type = show ? 'text' : 'password';
  return (
    <EnrolShell step={1} note="Choose your password, then sign in to set up the counters.">
      <h1>Welcome. Choose your password</h1>
      <p className="lead">You will use it with your email to sign in as manager. Nobody else sees it.</p>
      <label className="m-field">New password
        <span className="m-pw">
          <input data-testid="invite-password" type={type} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`${MIN_PASSWORD} or more characters`} autoComplete="new-password" />
          <button type="button" className="ghost sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
        </span>
      </label>
      <div className="en-meter" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={level >= n ? `l${level}` : ''} />)}</div>
      <label className="m-field">Type it again
        <input data-testid="invite-again" type={type} value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Same password" autoComplete="new-password" />
      </label>
      <ul className="en-reqs">
        <li className={longEnough ? 'ok' : ''}><span className="tick">✓</span>At least {MIN_PASSWORD} characters</li>
        <li className={matches ? 'ok' : ''}><span className="tick">✓</span>Both passwords match</li>
      </ul>
      <button data-testid="invite-go" className="primary block" disabled={busy || !longEnough || !matches} onClick={go}>{busy ? 'Saving…' : 'Save password'}</button>
      {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
    </EnrolShell>
  );
}
