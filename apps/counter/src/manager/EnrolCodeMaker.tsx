import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { t, useT } from '../i18n.ts';

interface OutletWithCounters { id: string; name: string; counters: { id: string; code: string }[] }

// Shown on a blank tablet after a manager signs in: pick the counter, get a one-use code, and either enrol this
// tablet with it straight away or read it out for another one. The session token stays in memory.
// The caller wraps it in the enrolment frame.
export function EnrolCodeMaker({ token, onUseCode, onBack }: { token: string; onUseCode: (code: string) => void; onBack: () => void }) {
  const t = useT();
  const [outlets, setOutlets] = useState<OutletWithCounters[] | null>(null);
  const [outletId, setOutletId] = useState('');
  const [counterId, setCounterId] = useState('');
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) { setError(t('Could not load your outlets.')); return; }
      const list = r.body.outlets as OutletWithCounters[];
      setOutlets(list);
      const first = list[0];
      if (first) { setOutletId(first.id); setCounterId(first.counters[0]?.id ?? ''); }
    });
  }, [token]);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const outlet = outlets?.find((o) => o.id === outletId);
  const counter = outlet?.counters.find((k) => k.id === counterId);
  const reset = () => { setCode(''); setExpiresAt(0); };
  const make = async () => {
    setBusy(true);
    setError('');
    const r = await api('/enrolment-codes', token, { method: 'POST', body: JSON.stringify({ outletId, counterId }) });
    setBusy(false);
    if (r.status === 403 && r.body.error === 'tenant suspended') { setError(t('This account is suspended. Contact support.')); return; }
    if (r.status !== 200) { setError(t('Could not create a code.')); return; }
    setCode(r.body.code as string);
    setExpiresAt(new Date(r.body.expiresAt as string).getTime());
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError(t('Could not copy. Select the code and copy it by hand.')); }
  };

  if (!outlets) return <p>{error || t('Loading…')}</p>;
  return (
    <>
      <h1>{code ? t('Your code is ready') : t('Create an enrolment code')}</h1>
      <p className="lead">{code ? t('Use it on this tablet now, or read it out for another one.') : t('Choose which counter the new tablet will be.')}</p>
      {outlets.length === 0 ? <p>{t('No outlet is assigned to you yet. Ask the platform operator.')}</p> : code ? (
        <>
          <dl className="en-summary"><dt>{t('Outlet')}</dt><dd>{outlet?.name}</dd><dt>{t('Counter')}</dt><dd>{counter?.code}</dd></dl>
          <div className="en-codecard">
            <div className="top">
              <span className="m-pill ok">{t('One use')}</span>
              <span className={`m-pill ${left > 0 ? 'warn' : 'bad'}`}>{left > 0 ? t('Expires in {time}', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('Expired')}</span>
              <span className="spacer" />
              <button className="sm" data-testid="code-copy" onClick={copy}>{copied ? t('✓ Copied') : t('Copy')}</button>
            </div>
            <code data-testid="code-value">{code}</code>
          </div>
          <button data-testid="code-use" className="primary block" disabled={left === 0} onClick={() => onUseCode(code)}>{t('Set up this tablet now')}</button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button data-testid="code-back" onClick={onBack}>{t('Back')}</button>
            <button className="ghost" onClick={reset}>{t('Make a different code')}</button>
          </div>
        </>
      ) : (
        <>
          <label className="m-field">{t('Outlet')}
            <select data-testid="code-outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setCounterId(outlets.find((o) => o.id === e.target.value)?.counters[0]?.id ?? ''); }}>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <div className="m-field">{t('Counter')}
            <div className="en-choice" role="group" aria-label={t('Counter')}>
              {outlet?.counters.map((k) => <button key={k.id} data-testid={`code-counter-${k.code}`} className={k.id === counterId ? 'active' : ''} aria-pressed={k.id === counterId} onClick={() => setCounterId(k.id)}>{k.code}</button>)}
            </div>
          </div>
          <button data-testid="code-make" className="primary block" disabled={busy || !counterId} onClick={make}>{busy ? t('Creating…') : t('Create code')}</button>
          <button data-testid="code-back" onClick={onBack} style={{ alignSelf: 'flex-start' }}>{t('Back')}</button>
        </>
      )}
      {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
    </>
  );
}
