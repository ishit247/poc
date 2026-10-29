import test from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, gstSplit, renderReceipt, RECEIPT_WIDTH, type ReceiptView } from '../src/index.ts';

test('amount in words uses Indian grouping and handles paise', () => {
  assert.equal(amountInWords(0), 'Zero Only');
  assert.equal(amountInWords(1_388_000), 'Thirteen Thousand Eight Hundred Eighty Only');
  assert.equal(amountInWords(10_546), 'One Hundred Five and Forty Six Paise Only');
  assert.equal(amountInWords(5), 'Five Paise Only');
  assert.equal(amountInWords(100_000), 'One Thousand Only');
  assert.equal(amountInWords(1_234_567_800), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
  assert.equal(amountInWords(11_00_000_00), 'Eleven Lakh Only');
  assert.equal(amountInWords(1_000_00_00_000_00), 'One Thousand Crore Only');
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => amountInWords(bad), RangeError);
});

test('CGST and SGST always add up to exactly the tax charged, odd paisa to CGST', () => {
  assert.deepEqual(gstSplit([{ gstRateBp: 500, taxPaise: 315 }]), [{ rateBp: 500, cgstPaise: 158, sgstPaise: 157 }]);
  for (let tax = 1; tax < 500; tax++) {
    const [g] = gstSplit([{ gstRateBp: 1800, taxPaise: tax }]);
    assert.equal(g!.cgstPaise + g!.sgstPaise, tax);
    assert.ok(g!.cgstPaise - g!.sgstPaise <= 1);
  }
  // Summed per rate before halving, so two odd lines at one rate do not lose or invent a paisa.
  assert.deepEqual(gstSplit([{ gstRateBp: 500, taxPaise: 3 }, { gstRateBp: 500, taxPaise: 3 }, { gstRateBp: 1200, taxPaise: 10 }, { gstRateBp: 0, taxPaise: 0 }]),
    [{ rateBp: 500, cgstPaise: 3, sgstPaise: 3 }, { rateBp: 1200, cgstPaise: 5, sgstPaise: 5 }]);
  assert.deepEqual(gstSplit([{ gstRateBp: 500, taxPaise: 0 }]), [], 'nothing to show for a zero tax');
});

const base: ReceiptView = {
  outletName: 'Little Italy Bundgarden', address: '361/5, Bund Garden Rd, Opp. Pune Central Mall, Pune 411001', gstEnabled: true, gstin: '27AACFH0296B1ZR',
  fssaiNo: '11516034000797', receiptNo: 'C1-20251127-12', at: '2025-11-27T10:34:00Z', timezone: 'Asia/Kolkata', staffName: 'Abutalib', reprint: false,
  lines: [
    { name: 'Manali', qty: 1, unitPaise: 83000, netPaise: 83000, gstRateBp: 500, taxPaise: 4150 },
    { name: 'Cheese Garlic Bread with extra jalapenos', qty: 2, unitPaise: 25000, netPaise: 50000, gstRateBp: 500, taxPaise: 2501 },
    { name: 'Mineral Water', qty: 3, unitPaise: 9000, netPaise: 27000, gstRateBp: 1800, taxPaise: 4860 },
  ],
  subtotalPaise: 160000, taxPaise: 11511, roundOffPaise: -11, totalPaise: 171500,
  payments: [{ method: 'cash', amountPaise: 171500, changePaise: 8500 }],
};

test('a GST receipt carries the header, lines, CGST/SGST, round-off, words and footer', () => {
  const text = renderReceipt(base).join('\n');
  for (const must of ['LITTLE ITALY BUNDGARDEN', 'GSTIN: 27AACFH0296B1ZR', 'Tax Invoice', 'Bill# C1-20251127-12', '27-Nov-2025 04:04 PM', 'User: Abutalib',
    'CGST @2.5%', 'SGST @2.5%', 'CGST @9%', 'SGST @9%', 'Round Off', '-0.11', 'Total Qty: 6', 'FSSAI: 11516034000797', 'Thank you. Visit again.', 'Cash', 'Change']) {
    assert.ok(text.includes(must), `missing ${must}\n${text}`);
  }
  assert.ok(!text.includes('RE-PRINT'));
  // 5%: 4150 + 2501 = 6651 -> CGST 33.26, SGST 33.25 (odd paisa to CGST).
  assert.match(text, /CGST @2\.5% +33\.26/);
  assert.match(text, /SGST @2\.5% +33\.25/);
});

test('every line fits the 58 mm printer, including long names, long words and long addresses', () => {
  const awkward: ReceiptView = {
    ...base,
    outletName: 'A very long outlet name that surely needs wrapping onto lines',
    address: 'Averyveryveryverylongunbrokenaddressword12345678901234567890, Pune',
    staffName: 'Someone With A Rather Long Name Indeed',
    lines: [{ ...base.lines[0]!, name: 'Supercalifragilisticexpialidocious_extra_long_item_name', qty: 12 }, { ...base.lines[1]!, name: 'x'.repeat(100) }],
  };
  for (const v of [base, awkward, { ...base, reprint: true }, { ...base, gstEnabled: false, gstin: null, address: null, fssaiNo: null }]) {
    const lines = renderReceipt(v);
    for (const l of lines) assert.ok(l.length <= RECEIPT_WIDTH, `too wide (${l.length}): ${l}`);
  }
  // Nothing is silently dropped: every character of a long name is still on the paper.
  const joined = renderReceipt(awkward).join('').replaceAll(' ', '');
  assert.ok(joined.includes('x'.repeat(100)));
  assert.ok(joined.includes('Supercalifragilisticexpialidocious_extra_long_item_name'));
  assert.ok(joined.includes('Averyveryveryverylongunbrokenaddressword12345678901234567890'));
});

test('a reprint is marked; a non-GST outlet prints a bill of supply with no GSTIN or tax lines', () => {
  assert.ok(renderReceipt({ ...base, reprint: true }).some((l) => l.includes('*** RE-PRINT ***')));
  const nonGst = renderReceipt({ ...base, gstEnabled: false, lines: base.lines.map((l) => ({ ...l, gstRateBp: 0, taxPaise: 0 })), taxPaise: 0 }).join('\n');
  assert.ok(nonGst.includes('Bill of Supply'));
  assert.ok(!/Tax Invoice|GSTIN|CGST|SGST/.test(nonGst));
});

test('the layout is stable (golden)', () => {
  assert.deepEqual(renderReceipt(base), GOLDEN);
});

// Checked by hand: 1600.00 + (33.26 + 33.25 + 24.30 + 24.30) - 0.11 = 1715.00.
const GOLDEN: string[] = [
  '    LITTLE ITALY BUNDGARDEN',
  '361/5, Bund Garden Rd, Opp. Pune',
  '   Central Mall, Pune 411001',
  '     GSTIN: 27AACFH0296B1ZR',
  '          Tax Invoice',
  '--------------------------------',
  'Bill# C1-20251127-12',
  '27-Nov-2025 04:04 PM',
  'User: Abutalib',
  '--------------------------------',
  '1. Manali',
  '   1 x 830.00             830.00',
  '2. Cheese Garlic Bread with',
  '   extra jalapenos',
  '   2 x 250.00             500.00',
  '3. Mineral Water',
  '   3 x 90.00              270.00',
  '--------------------------------',
  'Sub Total                1600.00',
  'CGST @2.5%                 33.26',
  'SGST @2.5%                 33.25',
  'CGST @9%                   24.30',
  'SGST @9%                   24.30',
  'Round Off                  -0.11',
  '--------------------------------',
  'TOTAL                    1715.00',
  '--------------------------------',
  'Total Qty: 6',
  'Rupees One Thousand Seven',
  'Hundred Fifteen Only',
  'Cash                     1715.00',
  'Change                     85.00',
  '--------------------------------',
  '     FSSAI: 11516034000797',
  '    Thank you. Visit again.',
];
