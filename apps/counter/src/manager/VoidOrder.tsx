import { useState } from 'react';
import { rs, type OpenOrder } from './api.ts';
import { Modal } from './Modal.tsx';

/**
 * An open order holding the day open (a past day's forgotten table, an order nobody paid). The manager voids it
 * with a reason; the server checks it is still open and at one of their outlets, and writes the audit row.
 * An online order is not voided here: its state lives in the Online orders queue, so it is finished or cancelled there.
 */
export function VoidOrder({ order, today, onVoid }: { order: OpenOrder; today: string; onVoid: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const online = order.channel !== 'counter';
  const go = async () => {
    setBusy(true);
    try { await onVoid(reason.trim()); } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  const dismiss = () => { setOpen(false); setReason(''); setError(''); };
  const lines = order.lines.map((l) => `${l.qty} × ${l.name}`).join(', ') || 'no items';
  const old = order.businessDate < today; // the outlet's own today, not this tablet's
  return (
    <div className="m-row" data-testid="mgr-open-order" data-order-id={order.id}>
      <div className="main">
        <b>
          {order.table ? `Table ${order.table} · ` : ''}{rs(order.totalPaise)}
          {online && <span className="m-pill" style={{ marginLeft: 8 }}>{order.channel}</span>}
          {old && <span className="m-pill bad" style={{ marginLeft: 8 }}>From {order.businessDate}</span>}
        </b>
        <span>{lines} · opened by {order.openedBy ?? 'unknown'}{!old ? ` · ${order.businessDate}` : ''}</span>
      </div>
      {online ? <span className="muted" style={{ fontSize: 14, maxWidth: 220 }}>Finish or cancel it in the Online orders queue.</span>
        : <button className="sm danger" data-testid="mgr-void-open" onClick={() => setOpen(true)}>Void…</button>}
      {open && (
        <Modal title="Void this order?" onClose={dismiss}>
          <p className="muted" style={{ margin: 0 }}>{order.table ? `Table ${order.table} · ` : ''}{rs(order.totalPaise)} · {lines}</p>
          <label className="m-field">Reason (required)
            <input data-testid="mgr-void-reason" autoFocus value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); setError(''); }} placeholder="e.g. customer left, table forgotten" autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim() && !busy) void go(); }} />
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>This can’t be undone and is recorded against your name.</p>
          {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
          <div className="m-dialog-actions">
            <button onClick={dismiss}>Keep order</button>
            <button data-testid="mgr-void-go" className="danger solid" disabled={busy || !reason.trim()} onClick={go}>{busy ? 'Voiding…' : 'Void order'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
