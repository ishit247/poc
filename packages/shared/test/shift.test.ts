import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedCash, renderShiftSlip, RECEIPT_WIDTH, type ShiftSlipView } from '../src/index.ts';

test('expected cash is the float plus the cash part only; UPI and change are not in the drawer', () => {
  assert.equal(expectedCash(50_000, []), 50_000);
  // A 1,050 bill paid 1,000 cash (tendered 1,500, so 500 change was handed back) + 50 UPI: the drawer gained 1,000.
  assert.equal(expectedCash(50_000, [{ method: 'cash', amountPaise: 1000 }, { method: 'upi', amountPaise: 50 }]), 51_000);
});

const view: ShiftSlipView = {
  outletName: 'School 1 Canteen with a very long name indeed', counterCode: 'C1', cashier: 'Asha Kulkarni-Deshpande the Second',
  openedAt: '2026-03-01T03:30:00Z', closedAt: '2026-03-01T10:30:00Z', timeZone: 'Asia/Kolkata',
  openingCashPaise: 50_000, cashSalesPaise: 123_450, upiSalesPaise: 10_000, salesCount: 42, countedCashPaise: 173_000, variancePaise: -450, unsyncedCount: 0,
};

test('the shift slip fits 32 columns, shows the variance, and says when records are still unsent', () => {
  const lines = renderShiftSlip(view);
  assert.ok(lines.every((l) => l.length <= RECEIPT_WIDTH), lines.join('\n'));
  assert.ok(lines.some((l) => /^SHORT\s+4\.50$/.test(l)));
  assert.ok(lines.some((l) => /^Opened\s+01\/03\/2026 09:00$/.test(l)), 'times are in the outlet timezone');
  assert.ok(!lines.some((l) => /not yet sent/.test(l)));
  assert.ok(renderShiftSlip({ ...view, unsyncedCount: 3 }).some((l) => /3 records not yet sent/.test(l)));
  assert.ok(renderShiftSlip({ ...view, variancePaise: 0 }).some((l) => l.startsWith('Cash matches')));
  assert.ok(renderShiftSlip({ ...view, variancePaise: 100 }).some((l) => /^OVER\s+1\.00$/.test(l)));
});
