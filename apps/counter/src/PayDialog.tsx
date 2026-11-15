import { useEffect, useState } from 'react';
import { formatRupees, paise, parseRupees, type BillDiscount, type Paise, type Tender, type TradingSettings } from '@pos/shared';
import { DiscountFields, useDiscountForm } from './DiscountFields.tsx';
import { localSettings } from './order.ts';
import type { BillLine } from './sale.ts';
import { t, useT } from './i18n.ts';

type Mode = 'cash' | 'upi' | 'split';
const rs = (n: number) => formatRupees(paise(n));

/** Builds the tenders from what was typed. Throws a RangeError with a message fit to show. */
function build(mode: Mode, total: Paise, cashIn: string, splitCash: string, ref: string): Tender[] {
  const money = (s: string, what: string): Paise => {
    try { return parseRupees(s); } catch { throw new RangeError(t('Enter {what} as rupees, like 150 or 150.50.', { what: t(what) })); }
  };
  if (mode === 'upi') return [{ method: 'upi', amountPaise: total, upiRef: ref }];
  if (mode === 'cash') return [{ method: 'cash', amountPaise: total, tenderedPaise: cashIn.trim() ? money(cashIn, 'the cash received') : total }];
  const c = money(splitCash, 'the cash part');
  if (c <= 0 || c >= total) throw new RangeError(t('The cash part must be more than 0 and less than the total.'));
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
export function PayDialog({ lines, total, discountable = true, initialDiscount = null, initialMode = 'cash', onConfirm, onCancel }: {
  lines: readonly BillLine[]; total: Paise; discountable?: boolean; initialMode?: Mode;
  /** The discount saved on the order (or draft cart): the fields open with it filled in. `total` is the bill before it. */
  initialDiscount?: BillDiscount | null;
  onConfirm: (t: Tender[], discount: BillDiscount | null) => Promise<void>; onCancel: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [cashIn, setCashIn] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<TradingSettings | null>(null);
  const [giving, setGiving] = useState(initialDiscount !== null); // the discount fields are open
  useEffect(() => { void localSettings().then(setSettings); }, []);

  const cap = settings?.discountMaxBp ?? 0;
  const offWhy = !discountable ? t('This bill cannot take a discount.')
    : !settings ? t('Loading…')
    : cap === 0 ? t('Discounts are off. A manager can turn them on in Settings.') : undefined;

  // What the discount comes to, and why it cannot be given yet. Priced by the same function the store uses.
  const d = useDiscountForm(lines, settings, initialDiscount, giving);
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
      setError(e instanceof Error ? e.message : t('Payment failed.'));
      setBusy(false);
    }
  };
  const clearDiscount = () => { setGiving(false); d.reset(); setError(''); };

  return (
    <div className="overlay" role="dialog" aria-label={t('Take payment')}>
      <div className="dialog pay">
        <h2>{t('Take payment')} · ₹<span data-testid="pay-due">{rs(due)}</span></h2>
        {giving && d.bill && (
          <p className="muted discount-summary" data-testid="discount-summary">
            {t('Bill ₹{bill}, discount −₹{disc} before GST, GST ₹{gst}', { bill: rs(total), disc: rs(d.bill.discountPaise), gst: rs(d.bill.taxPaise) })}
          </p>
        )}
        <div className="modes">
          {(['cash', 'upi', 'split'] as const).map((m) => <button key={m} data-testid={`mode-${m}`} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); setError(''); }}>{m === 'upi' ? 'UPI' : t(m === 'cash' ? 'Cash' : 'Split')}</button>)}
        </div>
        {mode === 'split' && <label>{t('Cash part (₹)')}<input data-testid="split-cash" inputMode="decimal" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></label>}
        {mode !== 'upi' && (
          <label>{t('Cash received (₹)')}
            <input data-testid="cash-in" inputMode="decimal" value={cashIn} onChange={(e) => setCashIn(e.target.value)} placeholder={mode === 'cash' ? rs(due) : ''} />
          </label>
        )}
        {mode !== 'cash' && <label>{t('UPI reference (optional)')}<input data-testid="upi-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
        {mode === 'cash' && (
          <div className="quick" data-testid="quick-cash">
            <button data-testid="cash-exact" className={cashIn === '' ? 'active' : ''} onClick={() => setCashIn('')}>{t('Exact')}</button>
            {QUICK_CASH_RUPEES.filter((v) => v * 100 >= due).map((v) => <button key={v} data-testid={`cash-${v}`} onClick={() => setCashIn(String(v))}>₹{v}</button>)}
          </div>
        )}
        {mode !== 'upi' && <p data-testid="change" className="change">{t('Change to give: ₹{amt}', { amt: rs(change) })}</p>}
        {giving && <DiscountFields form={d} settings={settings} onEdit={() => setError('')} />}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          {/* One slot: Discount opens the fields, No discount closes and clears them. Plain, never the primary. */}
          {giving
            ? <button data-testid="discount-clear" onClick={clearDiscount} disabled={busy}>{t('No discount')}</button>
            : <button data-testid="discount-open" onClick={() => setGiving(true)} disabled={busy || !!offWhy} title={offWhy}>{t('Discount')}</button>}
          <span className="spacer" />
          <button onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
          <button data-testid="confirm-pay" className="primary" onClick={confirm} disabled={busy || !ready} title={!ready ? d.why : undefined}>{t('Confirm payment')}</button>
        </div>
      </div>
    </div>
  );
}
