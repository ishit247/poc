import { useState } from 'react';
import { parseRupees } from '@pos/shared';
import type { Blockers } from './api.ts';
import { Modal } from './Modal.tsx';

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
  const dismiss = () => { setOpen(false); setCash(''); setError(''); };
  return (
    <div className="m-row" data-testid="mgr-shift">
      <div className="main">
        <b>{shift.cashier}</b>
        <span>Drawer open since {new Date(shift.openedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <button className="sm" data-testid="mgr-force-open" onClick={() => setOpen(true)}>Count &amp; close</button>
      {open && (
        <Modal title="Close drawer" onClose={dismiss}>
          <p className="muted" style={{ margin: 0 }}>{shift.cashier}. Count the cash in the drawer and enter it. The server works out any difference.</p>
          <label className="m-field">Cash counted (₹)
            <input data-testid="mgr-force-cash" inputMode="decimal" autoFocus value={cash} onChange={(e) => { setCash(e.target.value); setError(''); }} placeholder="e.g. 500 or 500.50" autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter' && cash.trim() && !busy) void go(); }} />
          </label>
          {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="m-dialog-actions">
            <button onClick={dismiss}>Cancel</button>
            <button data-testid="mgr-force-go" className="primary" disabled={busy || !cash.trim()} onClick={go}>{busy ? 'Closing…' : 'Close drawer'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
