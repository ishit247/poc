// Payment validation: cash, UPI, or a split of both. Mirrors the DB checks on
// `payment` (amount > 0; change only on cash; tendered = amount + change).
import { add, paise, type Paise } from './money.ts';

export type Tender =
  | { method: 'cash'; amountPaise: Paise; tenderedPaise: Paise }
  | { method: 'upi'; amountPaise: Paise; upiRef?: string };

export interface PaymentRecord {
  method: 'cash' | 'upi';
  amountPaise: Paise;
  tenderedPaise: Paise | null;
  changePaise: Paise;
  upiRef: string | null;
}

export type PaymentProblem = 'empty' | 'amount' | 'tendered' | 'mismatch';

export class PaymentError extends Error {
  constructor(readonly problem: PaymentProblem, message: string) {
    super(message);
  }
}

/**
 * The amounts must add up to the sale total exactly. Change is given only on cash,
 * and only for what the customer handed over beyond that tender's own amount.
 */
export function validatePayments(total: Paise, tenders: readonly Tender[]): PaymentRecord[] {
  if (tenders.length === 0) throw new PaymentError('empty', 'no payment');
  const records = tenders.map((t): PaymentRecord => {
    if (!Number.isSafeInteger(t.amountPaise) || t.amountPaise <= 0) throw new PaymentError('amount', 'amount must be positive');
    if (t.method === 'cash') {
      if (!Number.isSafeInteger(t.tenderedPaise) || t.tenderedPaise < t.amountPaise)
        throw new PaymentError('tendered', 'cash handed over is less than the amount');
      return { method: 'cash', amountPaise: t.amountPaise, tenderedPaise: t.tenderedPaise, changePaise: paise(t.tenderedPaise - t.amountPaise), upiRef: null };
    }
    return { method: 'upi', amountPaise: t.amountPaise, tenderedPaise: null, changePaise: paise(0), upiRef: t.upiRef?.trim() || null };
  });
  if (add(...records.map((r) => r.amountPaise)) !== total) throw new PaymentError('mismatch', 'payments do not add up to the total');
  return records;
}
