import { useState } from 'react';
import { EnrolShell } from '../EnrolShell.tsx';
import { t, useT } from '../i18n.ts';

const MIN_PASSWORD = 12; // same floor as the API (security/password.ts)

// Opened from the link the platform operator passes on: https://<host>/#invite=<token>. The fragment is never sent
// to a server or logged by the proxy. The manager chooses their own password; the operator never sees it.
export function InviteScreen({ token, onDone }: { token: string; onDone: (email: string) => void }) {
  const t = useT();
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
      if (r.status === 403) throw new Error(t('This account is suspended. Contact support.'));
      if (r.status === 429) throw new Error(t('Too many attempts. Wait a minute and try again.'));
      if (r.status === 401) throw new Error(t('This link has expired or was already used. Ask for a new one.'));
      if (!r.ok) throw new Error(t('Could not set the password.'));
      onDone((await r.json()).email as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not reach the server.'));
    } finally {
      setBusy(false);
    }
  };
  const type = show ? 'text' : 'password';
  return (
    <EnrolShell step={1} note={t('Choose your password, then sign in to set up the counters.')}>
      <h1>{t('Welcome. Choose your password')}</h1>
      <p className="lead">{t('You will use it with your email to sign in as manager. Nobody else sees it.')}</p>
      <label className="m-field">{t('New password')}
        <span className="m-pw">
          <input data-testid="invite-password" type={type} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('{n} or more characters', { n: MIN_PASSWORD })} autoComplete="new-password" />
          <button type="button" className="ghost sm" onClick={() => setShow(!show)}>{show ? t('Hide') : t('Show')}</button>
        </span>
      </label>
      <div className="en-meter" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={level >= n ? `l${level}` : ''} />)}</div>
      <label className="m-field">{t('Type it again')}
        <input data-testid="invite-again" type={type} value={again} onChange={(e) => setAgain(e.target.value)} placeholder={t('Same password')} autoComplete="new-password" />
      </label>
      <ul className="en-reqs">
        <li className={longEnough ? 'ok' : ''}><span className="tick">✓</span>{t('At least {n} characters', { n: MIN_PASSWORD })}</li>
        <li className={matches ? 'ok' : ''}><span className="tick">✓</span>{t('Both passwords match')}</li>
      </ul>
      <button data-testid="invite-go" className="primary block" disabled={busy || !longEnough || !matches} onClick={go}>{busy ? t('Saving…') : t('Save password')}</button>
      {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
    </EnrolShell>
  );
}
