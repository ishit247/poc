// CSV in and out, shared by the admin catalog, the manager's menu export, reports and settlement imports.

/** RFC 4180 subset: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, a leading BOM.
 *  Rows with no text in any cell are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\u{FEFF}/u, '');
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

const FORMULA = /^[=+\-@\t\r]/;
/** One text cell. A cell a spreadsheet would read as a formula is prefixed with ' so it is shown, not run
 *  (names and reasons are typed by people); `csvText` undoes that on the way back in. */
export const csvCell = (s: string) => {
  const safe = FORMULA.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
/** A parsed cell with the formula guard of `csvCell` removed. */
export const csvText = (s: string) => (s.startsWith("'") && FORMULA.test(s.slice(1)) ? s.slice(1) : s);
/** A whole file of text cells (so not for negative numbers): BOM first so Excel reads UTF-8, CRLF line ends. */
export const csvFile = (lines: string[][]) => '\u{FEFF}' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
