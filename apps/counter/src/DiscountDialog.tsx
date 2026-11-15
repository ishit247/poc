import { useState } from 'react';
import { formatRupees, paise, type BillDiscount, type TradingSettings } from '@pos/shared';
import { DiscountFields, useDiscountForm } from './DiscountFields.tsx';
import type { BillLine } from './sale.ts';

const rs = (n: number) => formatRupees(paise(n));

/**
 * The Sell screen's Discount dialog (docs/discounts-plan.md, step 5): puts a bill discount on the draft cart or on an
 * open order, to be paid later. The same fields as the Pay dialog; Pay opens with what is saved here. `onApply(null)`
 * removes it. Nothing is offered that the store (`discountProblem`) would refuse.
 */
export function DiscountDialog({ lines, settings, current, onApply, onCancel }: {
  lines: readonly BillLine[]; settings: TradingSettings; current: BillDiscount | null;
  onApply: (d: BillDiscount | null) => Promise<void>; onCancel: () => void;
}) {
  const form = useDiscountForm(lines, settings, current, true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (d: BillDiscount | null) => {
    setError(''); setBusy(true);
    try { await onApply(d); } catch (e) { setError(e instanceof Error ? e.message : 'Not allowed.'); setBusy(false); }
  };
  const ready = form.why === undefined && form.bill !== null;
  return (
    <div className="overlay" role="dialog" aria-label="Discount">
      <div className="dialog pay">
        <h2>Discount</h2>
        <p className="muted discount-summary" data-testid="discount-summary">
          {form.bill ? `Discount −₹${rs(form.bill.discountPaise)} before GST, GST ₹${rs(form.bill.taxPaise)}, total ₹${rs(form.bill.totalPaise)}` : 'Taken off the bill before GST, and fixed when it is paid.'}
        </p>
        <DiscountFields form={form} settings={settings} onEdit={() => setError('')} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button data-testid="discount-remove" onClick={() => void run(null)} disabled={busy || !current} title={!current ? 'No discount on this bill.' : undefined}>Remove discount</button>
          <span className="spacer" />
          <button data-testid="discount-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button data-testid="discount-apply" className="primary" onClick={() => void run(form.bill!.discount)} disabled={busy || !ready} title={!ready ? form.why : undefined}>Apply</button>
        </div>
      </div>
    </div>
  );
}
