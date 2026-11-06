import { useState } from 'react';
import { rs, type OpenOrder } from './api.ts';

/**
 * An open order holding the day open (a past day's forgotten table, an order nobody paid). The manager voids it
 * with a reason; the server checks it is still open and at one of their outlets, and writes the audit row.
 * An online order is not voided here: its state lives in the Online orders queue, so it is finished or cancelled there.
 */
export function VoidOrder({ order, onVoid }: { order: OpenOrder; onVoid: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const online = order.channel !== 'counter';
  const go = async () => {
    setBusy(true);
    try { await onVoid(reason.trim()); } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  const lines = order.lines.map((l) => `${l.qty} × ${l.name}`).join(', ') || 'no items';
  return (
    <div className="warn" data-testid="mgr-open-order" data-order-id={order.id}>
      <div>
        {order.businessDate}{order.table ? ` · table ${order.table}` : ''}{online ? ` · ${order.channel}` : ''} · {rs(order.totalPaise)}
        {' · opened by '}{order.openedBy ?? 'unknown'}
      </div>
      <div className="muted">{lines}</div>
      {online ? <span className="muted">Online order: finish or cancel it in the Online orders queue.</span>
        : !open ? <button data-testid="mgr-void-open" onClick={() => setOpen(true)}>Void</button> : (
          <span className="row">
            <input data-testid="mgr-void-reason" value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); setError(''); }} placeholder="Reason (required)" />
            <button data-testid="mgr-void-go" className="primary" disabled={busy || !reason.trim()} onClick={go}>{busy ? 'Voiding…' : 'Void order'}</button>
            <button onClick={() => { setOpen(false); setReason(''); }}>Cancel</button>
          </span>
        )}
      {error && <span className="error" role="alert"> {error}</span>}
    </div>
  );
}
