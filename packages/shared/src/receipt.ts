// Receipt numbers: <counter>-<yyyymmdd>-<n>, assigned at payment, per device per
// business day (DB invariant 5). The sequence restarts at 1 on a new business date.
export interface ReceiptCounter {
  date: string; // business date, YYYY-MM-DD
  seq: number; // last number issued on that date; 0 = none yet
}

export interface IssuedReceipt {
  receiptNo: string;
  receiptSeq: number;
  counter: ReceiptCounter;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function nextReceipt(counterCode: string, state: ReceiptCounter | null, businessDate: string): IssuedReceipt {
  if (!DATE.test(businessDate)) throw new RangeError(`bad business date: ${businessDate}`);
  if (!/^[A-Za-z0-9]{1,8}$/.test(counterCode)) throw new RangeError(`bad counter code: ${counterCode}`);
  // A date that moves backwards (clock set wrong) must not reuse numbers: keep counting on the later date.
  const date = state && state.date > businessDate ? state.date : businessDate;
  const seq = (state && state.date === date ? state.seq : 0) + 1;
  return {
    receiptNo: `${counterCode}-${date.replaceAll('-', '')}-${seq}`,
    receiptSeq: seq,
    counter: { date, seq },
  };
}
