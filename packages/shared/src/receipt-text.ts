// The printed receipt as plain text, for a 58 mm thermal printer (about 32 characters a line).
// Pure and deterministic: the same sale prints the same bytes on the tablet, in a test and on a
// reprint. Rupee amounts are plain numbers ("125.50"): the rupee sign is not in a thermal
// printer's default code page.
import { formatRupees, paise } from './money.ts';

export const RECEIPT_WIDTH = 32;

export interface ReceiptView {
  outletName: string;
  address: string | null;
  gstEnabled: boolean;
  gstin: string | null;
  fssaiNo: string | null;
  receiptNo: string;
  at: string; // ISO instant the sale was rung up
  timezone: string; // the outlet's, e.g. Asia/Kolkata
  staffName: string;
  reprint: boolean;
  lines: { name: string; qty: number; unitPaise: number; netPaise: number; gstRateBp: number; taxPaise: number }[];
  subtotalPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  payments: { method: 'cash' | 'upi'; amountPaise: number; changePaise: number }[];
}

const rs = (n: number) => formatRupees(paise(n));

// --- GST split ---------------------------------------------------------------------------------
export interface GstSplit { rateBp: number; cgstPaise: number; sgstPaise: number }

/**
 * Intra-state GST is shown as CGST + SGST, each half the rate. Tax is summed per rate, then split;
 * an odd paisa goes to CGST so the two always add up to exactly the tax charged.
 */
export function gstSplit(lines: readonly { gstRateBp: number; taxPaise: number }[]): GstSplit[] {
  const byRate = new Map<number, number>();
  for (const l of lines) if (l.gstRateBp > 0) byRate.set(l.gstRateBp, (byRate.get(l.gstRateBp) ?? 0) + l.taxPaise);
  return [...byRate.entries()]
    .filter(([, tax]) => tax > 0)
    .sort(([a], [b]) => a - b)
    .map(([rateBp, tax]) => ({ rateBp, sgstPaise: Math.floor(tax / 2), cgstPaise: tax - Math.floor(tax / 2) }));
}

// --- amount in words (Indian grouping) -----------------------------------------------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)]!, 'Hundred'); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10; }
  if (n > 0) parts.push(ONES[n]!);
  return parts.join(' ');
}

function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  for (const [unit, name] of [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']] as const) {
    if (n >= unit) {
      const q = Math.floor(n / unit);
      parts.push(name === 'Crore' ? wholeInWords(q) : below1000(q), name);
      n %= unit;
    }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(' ');
}

/** 1388000 -> "Thirteen Thousand Eight Hundred Eighty Only"; 10546 -> "One Hundred Five and Forty Six Paise Only". */
export function amountInWords(totalPaise: number): string {
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) throw new RangeError(`bad amount: ${totalPaise}`);
  const rupees = Math.floor(totalPaise / 100);
  const ps = totalPaise % 100;
  const r = wholeInWords(rupees);
  if (ps === 0) return `${r} Only`;
  return rupees === 0 ? `${below1000(ps)} Paise Only` : `${r} and ${below1000(ps)} Paise Only`;
}

// --- layout --------------------------------------------------------------------------------------
function wrap(text: string, width: number, hang = 0): string[] {
  const out: string[] = [];
  const indent = () => (out.length ? ' '.repeat(hang) : ''); // only continuation lines hang
  let line = '';
  for (const w of text.trim().split(/\s+/)) {
    let word = w;
    if (!word) continue;
    const sep = line.trim() === '' ? '' : ' ';
    if (line.length + sep.length + word.length <= width) { line += sep + word; continue; }
    if (line.trim() !== '') { out.push(line); line = indent(); }
    while (line.length + word.length > width) { // a word longer than a line is broken, never dropped
      const room = width - line.length;
      out.push(line + word.slice(0, room));
      word = word.slice(room);
      line = indent();
    }
    line += word;
  }
  if (line.trim() !== '') out.push(line);
  return out;
}

const center = (s: string, w: number) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
const row = (left: string, right: string, w: number) => {
  const room = w - right.length - 1;
  return (left.length > room ? left.slice(0, room) : left).padEnd(room) + ' ' + right;
};

function stamp(iso: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
}

const rateLabel = (bp: number) => `${bp / 200}%`;

export function renderReceipt(v: ReceiptView, width = RECEIPT_WIDTH): string[] {
  const dash = '-'.repeat(width);
  const out: string[] = [];
  const centered = (s: string) => wrap(s, width).forEach((l) => out.push(center(l, width)));

  centered(v.outletName.toUpperCase());
  if (v.address) centered(v.address);
  if (v.gstEnabled && v.gstin) centered(`GSTIN: ${v.gstin}`);
  centered(v.gstEnabled ? 'Tax Invoice' : 'Bill of Supply');
  if (v.reprint) centered('*** RE-PRINT ***');
  out.push(dash);
  out.push(`Bill# ${v.receiptNo}`);
  out.push(stamp(v.at, v.timezone));
  out.push(`User: ${v.staffName}`.slice(0, width));
  out.push(dash);

  v.lines.forEach((l, i) => {
    out.push(...wrap(`${i + 1}. ${l.name}`, width, 3));
    out.push(row(`   ${l.qty} x ${rs(l.unitPaise)}`, rs(l.netPaise), width));
  });
  out.push(dash);

  out.push(row('Sub Total', rs(v.subtotalPaise), width));
  for (const g of gstSplit(v.lines)) {
    out.push(row(`CGST @${rateLabel(g.rateBp)}`, rs(g.cgstPaise), width));
    out.push(row(`SGST @${rateLabel(g.rateBp)}`, rs(g.sgstPaise), width));
  }
  if (v.roundOffPaise !== 0) out.push(row('Round Off', `${v.roundOffPaise < 0 ? '-' : '+'}${rs(Math.abs(v.roundOffPaise))}`, width));
  out.push(dash);
  out.push(row('TOTAL', rs(v.totalPaise), width));
  out.push(dash);
  out.push(`Total Qty: ${v.lines.reduce((a, l) => a + l.qty, 0)}`);
  out.push(...wrap(`Rupees ${amountInWords(v.totalPaise)}`, width));
  for (const p of v.payments) {
    out.push(row(p.method === 'upi' ? 'UPI' : 'Cash', rs(p.amountPaise), width));
    if (p.changePaise > 0) out.push(row('Change', rs(p.changePaise), width));
  }
  out.push(dash);
  if (v.fssaiNo) out.push(center(`FSSAI: ${v.fssaiNo}`, width));
  out.push(center('Thank you. Visit again.', width));
  return out;
}
