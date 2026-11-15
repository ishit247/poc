import { useEffect, useMemo, useState } from 'react';
import { DISCOUNT_REASON_MAX, formatRupees, paise, parsePaise, parsePercentBp, parseRupees, type BillDiscount, type Paise, type Tender, type TradingSettings } from '@pos/shared';
import { localSettings } from './order.ts';
import { priced, type BillLine } from './sale.ts';

type Mode = 'cash' | 'upi' | 'split';
type Kind = BillDiscount['kind'];
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

const QUICK_CASH_RUPEES = [50, 100, 200, 500, 2000];

/**
 * Takes payment for `lines` (the bill on screen, in its order), whose total is `total`. A bill discount (docs/discounts-
 * plan.md) is offered up to the manager's cap when `discountable`; the tenders then follow the discounted total, and
 * `onConfirm` gets the discount to store with the sale. The store (sale.ts `priced`) refuses what this does not offer.
 */
export function PayDialog({ lines, total, discountable = true, initialMode = 'cash', onConfirm, onCancel }: {
  lines: readonly BillLine[]; total: Paise; discountable?: boolean; initialMode?: Mode;
  onConfirm: (t: Tender[], discount: BillDiscount | null) => Promise<void>; onCancel: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [cashIn, setCashIn] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<TradingSettings | null>(null);
  const [giving, setGiving] = useState(false); // the discount fields are open
  const [kind, setKind] = useState<Kind>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { void localSettings().then(setSettings); }, []);

  const cap = settings?.discountMaxBp ?? 0;
  const offWhy = !discountable ? 'This bill cannot take a discount.'
    : !settings ? 'Loading…'
    : cap === 0 ? 'Discounts are off. A manager can turn them on in Settings.' : undefined;

  // What the discount comes to, and why it cannot be given yet. Priced by the same function the store uses.
  const d = useMemo(() => {
    if (!giving || !settings) return { why: undefined, bill: null };
    const v = kind === 'percent' ? parsePercentBp(value) : parsePaise(value);
    if (!value.trim() || v === null) return { why: kind === 'percent' ? 'Type the discount, like 10 or 12.5 (%).' : 'Type the discount in rupees, like 50 or 50.50.', bill: null };
    const rule: BillDiscount = { kind, value: v, reason: reason.trim() || '-' };
    let bill;
    try { bill = priced(lines, settings, rule); } catch (e) { return { why: e instanceof Error ? e.message : 'Not allowed.', bill: null }; }
    if (!reason.trim()) return { why: 'Pick or type a reason for the discount.', bill };
    return { why: undefined, bill: { ...bill, discount: { ...rule, reason: reason.trim() } } };
  }, [giving, settings, kind, value, reason, lines]);
  const ready = giving ? (d.why === undefined && d.bill !== null) : true;
  const due = giving && d.bill ? paise(d.bill.totalPaise) : total;

  let change = 0;
  try {
    const cash = build(mode, due, cashIn, splitCash, ref).find((x) => x.method === 'cash');
    if (cash?.method === 'cash') change = cash.tenderedPaise - cash.amountPaise;
  } catch { /* shown on confirm */ }

  const confirm = async () => {
    setError('');
    setBusy(true);
    try {
      await onConfirm(build(mode, due, cashIn, splitCash, ref), giving ? d.bill!.discount : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed.');
      setBusy(false);
    }
  };
  const clearDiscount = () => { setGiving(false); setValue(''); setReason(''); setError(''); };

  return (
    <div className="overlay" role="dialog" aria-label="Take payment">
      <div className="dialog pay">
        <h2>Take payment · ₹<span data-testid="pay-due">{rs(due)}</span></h2>
        {giving && d.bill && (
          <p className="muted discount-summary" data-testid="discount-summary">
            Bill ₹{rs(total)}, discount −₹{rs(d.bill.discountPaise)} before GST, GST ₹{rs(d.bill.taxPaise)}
          </p>
        )}
        <div className="modes">
          {(['cash', 'upi', 'split'] as const).map((m) => <button key={m} data-testid={`mode-${m}`} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); setError(''); }}>{m === 'upi' ? 'UPI' : m[0]!.toUpperCase() + m.slice(1)}</button>)}
        </div>
        {mode === 'split' && <label>Cash part (₹)<input data-testid="split-cash" inputMode="decimal" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></label>}
        {mode !== 'upi' && (
          <label>Cash received (₹)
            <input data-testid="cash-in" inputMode="decimal" value={cashIn} onChange={(e) => setCashIn(e.target.value)} placeholder={mode === 'cash' ? rs(due) : ''} />
          </label>
        )}
        {mode !== 'cash' && <label>UPI reference (optional)<input data-testid="upi-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
        {mode === 'cash' && (
          <div className="quick" data-testid="quick-cash">
            <button data-testid="cash-exact" className={cashIn === '' ? 'active' : ''} onClick={() => setCashIn('')}>Exact</button>
            {QUICK_CASH_RUPEES.filter((v) => v * 100 >= due).map((v) => <button key={v} data-testid={`cash-${v}`} onClick={() => setCashIn(String(v))}>₹{v}</button>)}
          </div>
        )}
        {mode !== 'upi' && <p data-testid="change" className="change">Change to give: ₹{rs(change)}</p>}
        {giving && (
          <div className="discount-panel" data-testid="discount-panel">
            <div className="row">
              <div className="modes">
                {(['percent', 'amount'] as const).map((k) => (
                  <button key={k} data-testid={`discount-${k}`} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setValue(''); setError(''); }}>
                    {k === 'percent' ? '% off' : '₹ off'}
                  </button>
                ))}
              </div>
              <input data-testid="discount-value" aria-label={kind === 'percent' ? 'Discount, percent' : 'Discount, rupees'} inputMode="decimal" value={value}
                placeholder={kind === 'percent' ? `up to ${cap / 100}` : '0.00'} onChange={(e) => { setValue(e.target.value); setError(''); }} />
            </div>
            <input data-testid="discount-reason" aria-label="Discount reason" name="discount-reason" list="discount-reasons" value={reason} maxLength={DISCOUNT_REASON_MAX}
              autoComplete="off" placeholder="Reason (required): pick one or type" onChange={(e) => { setReason(e.target.value); setError(''); }} />
            <datalist id="discount-reasons">{settings?.discountReasons.map((r) => <option key={r} value={r} />)}</datalist>
            {!!settings?.discountReasons.length && (
              <div className="reason-picks">
                {settings.discountReasons.map((r) => (
                  <button key={r} type="button" data-testid="discount-reason-pick" className={reason === r ? 'active' : ''} onClick={() => { setReason(r); setError(''); }}>{r}</button>
                ))}
              </div>
            )}
            {d.why && value.trim() && <p className="muted" data-testid="discount-why" style={{ margin: 0 }}>{d.why}</p>}
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          {/* One slot: Discount opens the fields, No discount closes and clears them. Plain, never the primary. */}
          {giving
            ? <button data-testid="discount-clear" onClick={clearDiscount} disabled={busy}>No discount</button>
            : <button data-testid="discount-open" onClick={() => setGiving(true)} disabled={busy || !!offWhy} title={offWhy}>Discount</button>}
          <span className="spacer" />
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button data-testid="confirm-pay" className="primary" onClick={confirm} disabled={busy || !ready} title={!ready ? d.why : undefined}>Confirm payment</button>
        </div>
      </div>
    </div>
  );
}
