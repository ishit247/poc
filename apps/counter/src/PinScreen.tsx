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

  if (!who) {
    return (
      <main className="center">
        <h1>Who is working?</h1>
        <div className="tiles">
          {staff.map((s) => (
            <button key={s.id} data-testid={`staff-${s.name}`} className="tile" onClick={() => { setWho(s); setPin(''); setMessage(''); }}>
              {s.name}<small>{s.role}</small>
            </button>
          ))}
        </div>
      </main>
    );
  }
  return (
    <main className="center">
      <h1>{who.name}</h1>
      <div data-testid="pin-dots" className="dots" aria-label={`${pin.length} digits entered`}>{'●'.repeat(pin.length) || ' '}</div>
      <div className="pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} data-testid={`key-${d}`} onClick={() => press(d)}>{d}</button>)}
        <button onClick={() => { setWho(null); setPin(''); }}>Back</button>
        <button data-testid="key-0" onClick={() => press('0')}>0</button>
        <button data-testid="key-del" onClick={() => setPin(pin.slice(0, -1))}>⌫</button>
      </div>
      <button data-testid="pin-go" className="primary" disabled={busy || pin.length < 6} onClick={() => submit(pin)}>Sign in</button>
      {message && <p data-testid="pin-message" className="error" role="alert">{message}</p>}
    </main>
  );
}
