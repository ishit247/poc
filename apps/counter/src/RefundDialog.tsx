import { useEffect, useState } from 'react';
import { formatRupees, paise, renderRefundSlip } from '@pos/shared';
import type { DeviceInfo, LocalSale } from './db.ts';
import type { Actor } from './sale.ts';
import { signInOnline } from './online.ts';
import { refundByMethod, refundSale } from './refund.ts';
import { localSettings } from './order.ts';
import { t, useT } from './i18n.ts';

const rs = (n: number) => formatRupees(paise(n));
type Rows = ReturnType<typeof refundByMethod>;

/** "₹6.00 cash from this drawer, ₹4.50 UPI to pay back". */
export const payoutText = (rows: Rows) =>
  rows.map((r) => `₹${rs(r.amountPaise)} ${r.method === 'cash' ? t('cash from this drawer') : t('UPI to pay back')}`).join(', ');

/**
 * Refund a whole paid bill (docs/refunds-plan.md): the dialog names what goes back by which way, takes a reason and the
 * cashier's PIN typed again. The PIN opens a server session and the server checks it again on the refund itself.
 * Online only; nothing changes on the tablet unless the server says the refund is done.
 */
export function RefundDialog({ sale, device, actor, onCancel, onDone }: {
  sale: LocalSale; device: DeviceInfo; actor: Actor; onCancel: () => void; onDone: (rows: Rows, reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = refundByMethod(sale);
  const ready = reason.trim() !== '' && pin.length >= 6 && !busy;
  // The manager's list (Settings → Selling rules), as last pulled.
  const [presets, setPresets] = useState<string[]>([]);
  useEffect(() => { void localSettings().then((s) => setPresets(s.refundReasons)); }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [busy, onCancel]);

  const go = async () => {
    setError('');
    setBusy(true);
    try {
      const s = await signInOnline(device.credential, actor.id, pin);
      if (!s.ok) throw new Error(`${s.message} ${t('Nothing was refunded.')}`);
      const done = await refundSale({ actor, token: s.token, saleId: sale.id, reason, pin });
      onDone(done, reason.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not refund. Nothing was changed.'));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('Refund this bill')} onClick={(e) => e.stopPropagation()}>
        <h2>{t('Refund {no}?', { no: sale.receiptNo ?? '' })}</h2>
        <p style={{ margin: 0 }}>
          <span className="muted">{sale.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</span><br />
          <b data-testid="refund-payout">{payoutText(rows)}</b>
        </p>
        {/* Not a login form: no password-type field here, so the browser does not paste a saved email into Reason.
            The PIN is masked with CSS (.pin-mask) instead. */}
        <label>{t('Reason (required)')}
          <input data-testid="refund-reason" name="refund-reason" list="refund-reasons" value={reason} maxLength={200} autoComplete="off"
            placeholder={t('Pick one or type')} onChange={(e) => { setReason(e.target.value); setError(''); }} />
          <datalist id="refund-reasons" data-testid="refund-reason-options">{presets.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        {presets.length > 0 && (
          <div className="reason-picks">
            {presets.map((r) => (
              <button key={r} type="button" data-testid="refund-reason-pick" className={reason === r ? 'active' : ''} onClick={() => { setReason(r); setError(''); }}>{r}</button>
            ))}
          </div>
        )}
        <label>{t('Your PIN')}
          <input data-testid="refund-pin" name="refund-pin" className="pin-mask" type="text" inputMode="numeric" autoComplete="off" value={pin} maxLength={8}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) void go(); }} />
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>{t('The whole bill is refunded. This can’t be undone and is recorded against your name. Needs internet.')}</p>
        {error && <p className="error" role="alert" data-testid="refund-error" style={{ margin: 0 }}>{error}</p>}
        <div className="actions">
          <button data-testid="refund-cancel" onClick={onCancel} disabled={busy}>{t('Keep bill')}</button>
          <button data-testid="refund-go" className="danger solid" disabled={!ready}
            title={!reason.trim() ? t('Give a reason first.') : pin.length < 6 ? t('Type your PIN.') : undefined}
            onClick={() => void go()}>{busy ? t('Refunding…') : `${t('Refund')} ₹${rs(sale.totalPaise)}`}</button>
        </div>
      </div>
    </div>
  );
}

/** The refund slip (58 mm) with Print, after the server has refunded the bill. Kept with the drawer cash. */
export function RefundSlip({ sale, device, actor, rows, reason, onClose }: {
  sale: LocalSale; device: DeviceInfo; actor: Actor; rows: Rows; reason: string; onClose: () => void;
}) {
  const t = useT();
  const [at] = useState(() => new Date().toISOString());
  const text = renderRefundSlip({
    outletName: device.outletName, counterCode: device.counterCode, receiptNo: sale.receiptNo ?? '', cashier: actor.name,
    refundedAt: at, timeZone: device.timezone, reason, refunds: rows,
  });
  return (
    <main className="center">
      <p className="no-print" data-testid="refund-done">{t('Refunded')}: {payoutText(rows)}. {t('Keep this slip with the cash.')}</p>
      <div className="receipt print-area" data-testid="refund-slip"><pre data-testid="refund-slip-text">{text.join('\n')}</pre></div>
      <div className="no-print">
        <button data-testid="print" onClick={() => window.print()}>{t('Print')}</button>{' '}
        <button data-testid="refund-slip-done" className="primary" onClick={onClose}>{t('Done')}</button>
      </div>
    </main>
  );
}
