import { useState } from 'react';
import { formatRupees, paise, parseRupees, type Paise, type Tender } from '@pos/shared';

type Mode = 'cash' | 'upi' | 'split';
const rs = (n: number) => formatRupees(paise(n));

/** Builds the tenders from what was typed. Throws a RangeError with a message fit to show. */
function build(mode: Mode, total: Paise, cashIn: string, splitCash: string, ref: string): Tender[] {
  const money = (s: string, what: string): Paise => {
    try { return parseRupees(s); } catch { throw new RangeError(`Enter ${what} as rupees, like 150 or 150.50.`); }
  };
  if (mode === 'upi') return [{ method: 'upi', amountPaise: total, upiRef: ref }];
  if (mode === 'cash') return [{ method: 'cash', amountPaise: total, tenderedPaise: cashIn.trim() ? money(cashIn, 'the cash received') : total }];
  const c = money(splitCash, 'the cash part');
  if (c <= 0 || c >= total) throw new RangeError('The cash part must be more than 0 and less than the total.');
  return [
    { method: 'cash', amountPaise: c, tenderedPaise: cashIn.trim() ? money(cashIn, 'the cash received') : c },
    { method: 'upi', amountPaise: paise(total - c), upiRef: ref },
  ];
}

export function PayDialog({ total, onConfirm, onCancel }: { total: Paise; onConfirm: (t: Tender[]) => Promise<void>; onCancel: () => void }) {
  const [mode, setMode] = useState<Mode>('cash');
  const [cashIn, setCashIn] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  let change = 0;
  try {
    const cash = build(mode, total, cashIn, splitCash, ref).find((x) => x.method === 'cash');
    if (cash?.method === 'cash') change = cash.tenderedPaise - cash.amountPaise;
  } catch { /* shown on confirm */ }

  const confirm = async () => {
    setError('');
    setBusy(true);
    try {
      await onConfirm(build(mode, total, cashIn, splitCash, ref));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed.');
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-label="Take payment">
      <div className="dialog">
        <h2>Take payment · ₹{rs(total)}</h2>
        <div className="modes">
          {(['cash', 'upi', 'split'] as const).map((m) => <button key={m} data-testid={`mode-${m}`} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); setError(''); }}>{m === 'upi' ? 'UPI' : m[0]!.toUpperCase() + m.slice(1)}</button>)}
        </div>
        {mode === 'split' && <label>Cash part (₹)<input data-testid="split-cash" inputMode="decimal" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></label>}
        {mode !== 'upi' && (
          <label>Cash received (₹)
            <input data-testid="cash-in" inputMode="decimal" value={cashIn} onChange={(e) => setCashIn(e.target.value)} placeholder={mode === 'cash' ? rs(total) : ''} />
          </label>
        )}
        {mode !== 'cash' && <label>UPI reference (optional)<input data-testid="upi-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
        {mode !== 'upi' && <p data-testid="change" className="change">Change to give: ₹{rs(change)}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button data-testid="confirm-pay" className="primary" onClick={confirm} disabled={busy}>Confirm payment</button>
        </div>
      </div>
    </div>
  );
}
