import { useEffect, useState } from 'react';
import { api } from './api.ts';

interface OutletWithCounters { id: string; name: string; counters: { id: string; code: string }[] }

// Shown on a blank tablet after a manager signs in: pick the counter, get a one-use code, and either enrol this
// tablet with it straight away or read it out for another one. The session token stays in memory.
export function EnrolCodeMaker({ token, onUseCode, onBack }: { token: string; onUseCode: (code: string) => void; onBack: () => void }) {
  const [outlets, setOutlets] = useState<OutletWithCounters[] | null>(null);
  const [outletId, setOutletId] = useState('');
  const [counterId, setCounterId] = useState('');
  const [code, setCode] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api('/me', token).then((r) => {
      if (r.status !== 200) { setError('Could not load your outlets.'); return; }
      const list = r.body.outlets as OutletWithCounters[];
      setOutlets(list);
      const first = list[0];
      if (first) { setOutletId(first.id); setCounterId(first.counters[0]?.id ?? ''); }
    });
  }, [token]);

  const outlet = outlets?.find((o) => o.id === outletId);
  const make = async () => {
    setBusy(true);
    setError('');
    const r = await api('/enrolment-codes', token, { method: 'POST', body: JSON.stringify({ outletId, counterId }) });
    setBusy(false);
    if (r.status === 403 && r.body.error === 'tenant suspended') { setError('This account is suspended. Contact support.'); return; }
    if (r.status !== 200) { setError('Could not create a code.'); return; }
    setCode(r.body.code as string);
    setExpires(new Date(r.body.expiresAt as string).toLocaleTimeString());
  };

  if (!outlets) return <main className="center">{error || 'Loading…'}</main>;
  return (
    <main className="center">
      <h1>Create an enrolment code</h1>
      {outlets.length === 0 ? <p>No outlet is assigned to you yet. Ask the platform operator.</p> : (
        <>
          <label>Outlet{' '}
            <select data-testid="code-outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setCounterId(outlets.find((o) => o.id === e.target.value)?.counters[0]?.id ?? ''); setCode(''); }}>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label>Counter{' '}
            <select data-testid="code-counter" value={counterId} onChange={(e) => { setCounterId(e.target.value); setCode(''); }}>
              {outlet?.counters.map((k) => <option key={k.id} value={k.id}>{k.code}</option>)}
            </select>
          </label>
          {code ? (
            <>
              <p className="muted">One use, valid until {expires}.</p>
              <code data-testid="code-value" style={{ wordBreak: 'break-all', maxWidth: 420 }}>{code}</code>
              <button data-testid="code-use" className="primary" onClick={() => onUseCode(code)}>Set up this tablet now</button>
            </>
          ) : (
            <button data-testid="code-make" className="primary" disabled={busy || !counterId} onClick={make}>{busy ? 'Creating…' : 'Create code'}</button>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button data-testid="code-back" onClick={onBack}>Back</button>
    </main>
  );
}
