import { useState } from 'react';
import { signInWithPin } from './auth.ts';
import type { Actor } from './sale.ts';
import type { MenuView } from './menu.ts';

export function PinScreen({ staff, onSignedIn }: { staff: MenuView['staff']; onSignedIn: (a: Actor) => void }) {
  const [who, setWho] = useState<MenuView['staff'][number] | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  if (staff.length === 0) return <main className="center">No staff on this tablet yet. Connect to the internet and press Sync.</main>;

  const submit = async (value: string) => {
    if (!who || busy) return;
    setBusy(true);
    try {
      const r = await signInWithPin(who.id, who.pinVerifier, value);
      if (r.kind === 'ok') return onSignedIn({ id: who.id, name: who.name, role: who.role });
      setPin('');
      setMessage(r.kind === 'locked'
        ? `Too many wrong PINs. Try again at ${new Date(r.lockedUntil).toLocaleTimeString()}, or ask a manager to unlock you.`
        : 'Wrong PIN.');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => { if (pin.length < 8) { setMessage(''); setPin(pin + d); } };

  const initial = (n: string) => n.trim().split(/\s+/).pop()!.charAt(0).toUpperCase();
  if (!who) {
    return (
      <main className="center">
        <h1>Who is working?</h1>
        <div className="pin-tiles">
          {staff.map((s) => (
            <button key={s.id} data-testid={`staff-${s.name}`} className="tile" onClick={() => { setWho(s); setPin(''); setMessage(''); }}>
              <span className="avatar">{initial(s.name)}</span>
              <span><b>{s.name}</b><small>{s.role}</small></span>
            </button>
          ))}
        </div>
      </main>
    );
  }
  return (
    <main className="center">
      <button className="ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setWho(null); setPin(''); setMessage(''); }}>‹ Not you?</button>
      <div className="pin-wrap">
        <div className="who">
          <span className="avatar" style={{ width: 64, height: 64, fontSize: 26 }}>{initial(who.name)}</span>
          <h1 style={{ margin: 0 }}>{who.name}</h1>
          <small className="muted" style={{ textTransform: 'capitalize' }}>{who.role} · enter your PIN</small>
          <div data-testid="pin-dots" className="pin-dots" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: Math.max(6, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
          </div>
          {message && <p data-testid="pin-message" className="error" role="alert" style={{ margin: 0 }}>{message}</p>}
          <button data-testid="pin-go" className="primary" style={{ minWidth: 200 }} disabled={busy || pin.length < 6} onClick={() => submit(pin)}>{busy ? 'Checking…' : 'Sign in'}</button>
        </div>
        <div className="pin-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} data-testid={`key-${d}`} onClick={() => press(d)}>{d}</button>)}
          <button className="ghost" onClick={() => { setPin(''); setMessage(''); }}>Clear</button>
          <button data-testid="key-0" onClick={() => press('0')}>0</button>
          <button data-testid="key-del" className="ghost" aria-label="Delete" onClick={() => setPin(pin.slice(0, -1))}>⌫</button>
        </div>
      </div>
    </main>
  );
}
