import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api, setToken, type Admin } from './api.ts';

const DIGITS = 6;

export function Login({ onSignedIn, notice }: { onSignedIn: (a: Admin) => void; notice: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState<string[]>(Array(DIGITS).fill(''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const code = digits.join('');
  const ready = !!email && !!password && code.length === DIGITS;

  const go = async () => {
    setBusy(true);
    setError('');
    const r = await api('/platform/login', { body: { email, password, code } });
    if (r.status === 200) {
      setToken(r.body.token);
      const me = await api<Admin>('/platform/me');
      if (me.status === 200) { onSignedIn(me.body); return; }
    }
    setBusy(false);
    setError(r.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Email, password or code is not right.');
    setDigits(Array(DIGITS).fill(''));
    boxes.current[0]?.focus();
  };
  const setAt = (i: number, v: string) => setDigits((d) => d.map((x, k) => (k === i ? v : x)));
  const key = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
    if (e.key === 'Enter' && ready && !busy) void go();
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, DIGITS);
    if (!t) return;
    e.preventDefault();
    setDigits(Array.from({ length: DIGITS }, (_, k) => t[k] ?? ''));
    boxes.current[Math.min(t.length, DIGITS - 1)]?.focus();
  };

  return (
    <main className="loginwrap">
      <form className="card login" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void go(); }}>
        <div className="brand"><div className="logo" style={{ background: 'var(--primary)', color: '#fff' }}>B</div><div><b>Platform console</b><small className="muted" style={{ display: 'block' }}>Sign in to continue</small></div></div>
        {notice && <div className="alert warn" role="status"><span>⚠</span><div className="grow">{notice}</div></div>}
        <label className="f">Email
          <input data-testid="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="off" autoComplete="username" autoFocus />
        </label>
        <label className="f">Password
          <input data-testid="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <div className="f" role="group" aria-label="Authenticator code" data-testid="code">
          Authenticator code
          <div className="otp">
            {digits.map((d, i) => (
              <input key={i} ref={(el) => { boxes.current[i] = el; }} data-testid={`code-${i}`} type="text" inputMode="numeric" maxLength={1} value={d} aria-label={`Digit ${i + 1}`}
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(-1); setAt(i, v); if (v && i < DIGITS - 1) boxes.current[i + 1]?.focus(); }}
                onKeyDown={(e) => key(i, e)} onPaste={paste} />
            ))}
          </div>
          <span className="hint">Open your authenticator app and enter the 6-digit code.</span>
        </div>
        {error && <div className="fielderr" role="alert">{error}</div>}
        <button type="submit" data-testid="login" className="btn primary" disabled={busy || !ready} style={{ minHeight: 46 }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
