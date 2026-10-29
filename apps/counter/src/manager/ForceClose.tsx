import { useState } from 'react';
import { parseRupees } from '@pos/shared';
import type { Blockers } from './api.ts';

/**
 * A drawer its cashier cannot close. The manager counts the cash and enters it; the server works out the
 * variance. If the cashier's tablet later tries to close the same drawer, the server refuses and keeps this count.
 */
export function ForceClose({ shift, onClose }: { shift: Blockers['openShifts'][number]; onClose: (countedPaise: number) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    let counted: number;
    try { counted = parseRupees(cash); } catch { return setError('Enter the counted cash as rupees, like 500 or 500.50.'); }
    setBusy(true);
    try { await onClose(counted); } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  return (
    <p className="warn" data-testid="mgr-shift">
      {shift.cashier} still has a drawer open (since {new Date(shift.openedAt).toLocaleTimeString()}).{' '}
      {!open ? <button data-testid="mgr-force-open" onClick={() => setOpen(true)}>Close it for them</button> : (
        <span className="row">
          <input data-testid="mgr-force-cash" inputMode="decimal" value={cash} onChange={(e) => { setCash(e.target.value); setError(''); }} placeholder="Cash counted, ₹" />
          <button data-testid="mgr-force-go" className="primary" disabled={busy || !cash.trim()} onClick={go}>{busy ? 'Closing…' : 'Close drawer'}</button>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </span>
      )}
      {error && <span className="error" role="alert"> {error}</span>}
    </p>
  );
}
