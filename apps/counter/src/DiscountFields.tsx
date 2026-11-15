import { useMemo, useState } from 'react';
import { DISCOUNT_REASON_MAX, parsePaise, parsePercentBp, type BillDiscount, type TradingSettings } from '@pos/shared';
import { priced, type BillLine } from './sale.ts';

type Kind = BillDiscount['kind'];

/** A saved discount as the fields show it: a percentage in percent, a flat amount in rupees. */
const asValue = (d: BillDiscount | null): string => (!d ? '' : d.kind === 'percent' ? String(d.value / 100) : (d.value / 100).toFixed(2));

/**
 * The state of the discount fields, shared by the Pay dialog and the Sell screen's Discount dialog (docs/discounts-
 * plan.md). `bill` is the bill priced by the same function the store uses (`priced`); `why` is what stops the discount
 * being given yet, or undefined when it can be (then `bill.discount` is the discount to store).
 */
export function useDiscountForm(lines: readonly BillLine[], settings: TradingSettings | null, initial: BillDiscount | null, active: boolean) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'percent');
  const [value, setValue] = useState(asValue(initial));
  const [reason, setReason] = useState(initial?.reason ?? '');
  const d = useMemo(() => {
    if (!active || !settings) return { why: undefined, bill: null };
    const v = kind === 'percent' ? parsePercentBp(value) : parsePaise(value);
    if (!value.trim() || v === null) return { why: kind === 'percent' ? 'Type the discount, like 10 or 12.5 (%).' : 'Type the discount in rupees, like 50 or 50.50.', bill: null };
    const rule: BillDiscount = { kind, value: v, reason: reason.trim() || '-' };
    let bill;
    try { bill = priced(lines, settings, rule); } catch (e) { return { why: e instanceof Error ? e.message : 'Not allowed.', bill: null }; }
    if (!reason.trim()) return { why: 'Pick or type a reason for the discount.', bill };
    return { why: undefined, bill: { ...bill, discount: { ...rule, reason: reason.trim() } } };
  }, [active, settings, kind, value, reason, lines]);
  const reset = () => { setValue(''); setReason(''); };
  return { kind, setKind, value, setValue, reason, setReason, why: d.why, bill: d.bill, reset };
}
export type DiscountForm = ReturnType<typeof useDiscountForm>;

/** The % / ₹ switch, the value, and the reason (typed or picked from the manager's list). */
export function DiscountFields({ form, settings, onEdit }: { form: DiscountForm; settings: TradingSettings | null; onEdit?: () => void }) {
  const cap = settings?.discountMaxBp ?? 0;
  const edit = onEdit ?? (() => {});
  return (
    <div className="discount-panel" data-testid="discount-panel">
      <div className="row">
        <div className="modes">
          {(['percent', 'amount'] as const).map((k) => (
            <button key={k} data-testid={`discount-${k}`} className={form.kind === k ? 'active' : ''} onClick={() => { form.setKind(k); form.setValue(''); edit(); }}>
              {k === 'percent' ? '% off' : '₹ off'}
            </button>
          ))}
        </div>
        <input data-testid="discount-value" aria-label={form.kind === 'percent' ? 'Discount, percent' : 'Discount, rupees'} inputMode="decimal" value={form.value}
          placeholder={form.kind === 'percent' ? `up to ${cap / 100}` : '0.00'} onChange={(e) => { form.setValue(e.target.value); edit(); }} />
      </div>
      <input data-testid="discount-reason" aria-label="Discount reason" name="discount-reason" list="discount-reasons" value={form.reason} maxLength={DISCOUNT_REASON_MAX}
        autoComplete="off" placeholder="Reason (required): pick one or type" onChange={(e) => { form.setReason(e.target.value); edit(); }} />
      <datalist id="discount-reasons">{settings?.discountReasons.map((r) => <option key={r} value={r} />)}</datalist>
      {!!settings?.discountReasons.length && (
        <div className="reason-picks">
          {settings.discountReasons.map((r) => (
            <button key={r} type="button" data-testid="discount-reason-pick" className={form.reason === r ? 'active' : ''} onClick={() => { form.setReason(r); edit(); }}>{r}</button>
          ))}
        </div>
      )}
      {form.why && form.value.trim() && <p className="muted" data-testid="discount-why" style={{ margin: 0 }}>{form.why}</p>}
    </div>
  );
}
