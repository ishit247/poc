import { parseRupees } from '@pos/shared';

// A platform's payout statement as CSV. Pure functions: no database, so the rules can be tested alone.
// Amounts in the file are rupees; they become integer paise through parseRupees, never a float.

export interface ParsedLine { row: number; externalOrderId: string; grossPaise: number; payoutPaise: number }
export type ParseResult = { ok: true; lines: ParsedLine[] } | { ok: false; errors: { row: number; message: string }[] };

/** RFC 4180 subset: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Header names the platforms use, lower-cased with punctuation removed. The first match wins.
const HEADERS = {
  id: ['orderid', 'externalorderid', 'order', 'orderno', 'ordernumber', 'orderref'],
  gross: ['gross', 'grossamount', 'orderamount', 'ordervalue', 'ordertotal', 'billamount', 'itemtotal'],
  payout: ['payout', 'payoutamount', 'netamount', 'netpayout', 'settlementamount', 'netsettlement'],
} as const;
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "1,050.50", "₹ 1050", "Rs. 99" and "-12.5" to paise. Throws RangeError when it is not an amount. */
export function amountToPaise(raw: string): number {
  const s = raw.trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/,/g, '');
  const neg = s.startsWith('-') || /^\(.*\)$/.test(s);
  const body = s.replace(/^-/, '').replace(/^\((.*)\)$/, '$1').trim();
  const p = parseRupees(body) as number;
  return neg ? -p : p;
}

export const MAX_LINES = 5000;

export function parseSettlement(text: string): ParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { ok: false, errors: [{ row: 0, message: 'The file is empty.' }] };
  const head = rows[0]!.map(norm);
  const col = (names: readonly string[]) => head.findIndex((h) => names.includes(h));
  const idCol = col(HEADERS.id), grossCol = col(HEADERS.gross), payoutCol = col(HEADERS.payout);
  const missing = [idCol < 0 && 'order id', grossCol < 0 && 'gross amount', payoutCol < 0 && 'payout'].filter(Boolean);
  if (missing.length) return { ok: false, errors: [{ row: 1, message: `The header row has no column for: ${missing.join(', ')}.` }] };
  if (rows.length - 1 > MAX_LINES) return { ok: false, errors: [{ row: 0, message: `More than ${MAX_LINES} lines. Split the file.` }] };

  const errors: { row: number; message: string }[] = [];
  const lines: ParsedLine[] = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    const id = (r[idCol] ?? '').trim();
    if (!id) return void errors.push({ row, message: 'No order id.' });
    if (id.length > 64) return void errors.push({ row, message: 'Order id is longer than 64 characters.' });
    const first = seen.get(id);
    if (first) return void errors.push({ row, message: `Order ${id} is also on row ${first}.` });
    seen.set(id, row);
    try {
      const gross = amountToPaise(r[grossCol] ?? '');
      const payout = amountToPaise(r[payoutCol] ?? '');
      if (false) return void errors.push({ row, message: 'Gross amount is negative.' });
      lines.push({ row, externalOrderId: id, grossPaise: gross, payoutPaise: payout });
    } catch { errors.push({ row, message: 'Gross or payout is not an amount.' }); }
  });
  if (errors.length) return { ok: false, errors };
  if (lines.length === 0) return { ok: false, errors: [{ row: 0, message: 'The file has a header but no lines.' }] };
  return { ok: true, lines };
}
