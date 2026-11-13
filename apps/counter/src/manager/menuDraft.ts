// The manager menu editor's data handling, free of React so it can be tested (docs/manager-menu-editor-plan.md).
// The grid edits a local draft of the live menu; `buildApply` turns the difference from what the server last sent into
// the body of POST /menu/apply (one transaction, see apps/api/src/routes/menu.ts).
import { ITEM_DESCRIPTION_MAX, csvFile, csvText, parseCsv, parseGstBp, parsePaise } from '@pos/shared';

export type Channel = 'counter' | 'zomato' | 'swiggy';
export const CHANNELS: Channel[] = ['counter', 'zomato', 'swiggy'];
export type Diet = 'veg' | 'egg' | 'non_veg';
/** The apply route accepts this many ops in one change (APPLY_MAX_OPS in routes/menu.ts). */
export const MAX_OPS = 500;

/** The shape of GET /menu and of the apply response. */
export interface MenuPayload {
  categories: { id: string; name: string; code: string | null; sortOrder: number }[];
  items: { id: string; categoryId: string; name: string; code: string | null; hsnCode: string | null; description: string | null; diet: Diet | null; imageSha256: string | null; sortOrder: number; tagIds: string[] }[];
  prices: { itemId: string; channel: Channel; pricePaise: number; gstRateBp: number }[];
  tags: { id: string; name: string; sortOrder: number }[];
}

/** `key` is the row's id once it exists on the server, else a client ref ("tmp-…") the server maps to a real id. */
export interface DCat { key: string; name: string; code: string; sortOrder: number }
export interface DRow {
  key: string; categoryKey: string; name: string; code: string; hsn: string; desc: string; diet: Diet | ''; tagIds: string[]; sortOrder: number;
  gst: string;                              // one GST % for all of the item's prices
  counter: string; zomato: string; swiggy: string; // rupees as typed, excluding GST; empty = not sold on that channel
  sha: string | null;                       // picture, by hash (pictures are saved outside this draft)
}
export interface DTag { key: string; name: string; sortOrder: number }
/** Tags are in the draft so a tag made by a CSV import is undone and saved with the rows that use it. */
export interface Draft { cats: DCat[]; rows: DRow[]; tags: DTag[] }
export type Field = 'name' | 'code' | 'counter' | 'zomato' | 'swiggy' | 'gst' | 'hsn' | 'diet' | 'desc';

export const isNew = (key: string) => key.startsWith('tmp-');
let counter = 0;
export const newKey = () => `tmp-${Date.now().toString(36)}${(counter++).toString(36)}`;

export const rupeesText = (p: number) => (p % 100 === 0 ? String(p / 100) : `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`);
export const gstText = (bp: number) => String(bp / 100);

/** The server's menu as a draft. An item's GST % is its counter price's, else the first price it has. */
export function fromMenu(m: MenuPayload): Draft {
  const price = new Map(m.prices.map((p) => [`${p.itemId}/${p.channel}`, p]));
  return {
    cats: m.categories.map((c) => ({ key: c.id, name: c.name, code: c.code ?? '', sortOrder: c.sortOrder })),
    rows: m.items.map((i) => {
      const at = (ch: Channel) => price.get(`${i.id}/${ch}`);
      const first = at('counter') ?? at('zomato') ?? at('swiggy');
      const t = (ch: Channel) => { const p = at(ch); return p ? rupeesText(p.pricePaise) : ''; };
      return {
        key: i.id, categoryKey: i.categoryId, name: i.name, code: i.code ?? '', hsn: i.hsnCode ?? '', desc: i.description ?? '', diet: i.diet ?? '',
        tagIds: [...i.tagIds], sortOrder: i.sortOrder, gst: first ? gstText(first.gstRateBp) : '5',
        counter: t('counter'), zomato: t('zomato'), swiggy: t('swiggy'), sha: i.imageSha256,
      };
    }),
    tags: m.tags.map((t) => ({ key: t.id, name: t.name, sortOrder: t.sortOrder })),
  };
}

// ---------- checks (mirror the API: name 1-100, 2-digit code, HSN 4-8 digits, GST 0-40, price, description) ----------
export type RowIssues = Partial<Record<Field, string>>;

/** Existing rows always have a code; a new one may leave it empty and be given the next free one. */
export function rowIssues(r: DRow, d: Draft): RowIssues {
  const e: RowIssues = {};
  if (!r.name.trim()) e.name = 'Name is required';
  else if (r.name.trim().length > 100) e.name = 'Name is at most 100 characters';
  const code = r.code.trim();
  if (code ? !/^[0-9]{2}$/.test(code) : !isNew(r.key)) e.code = 'Code is two digits';
  else if (code && d.rows.some((o) => o !== r && o.categoryKey === r.categoryKey && o.code.trim() === code)) e.code = 'Code is used in this category';
  if (r.hsn.trim() && !/^[0-9]{4,8}$/.test(r.hsn.trim())) e.hsn = 'HSN/SAC must be 4 to 8 digits';
  if (parseGstBp(r.gst) === null) e.gst = 'GST must be 0 to 40, up to 2 decimals';
  for (const ch of CHANNELS) if (r[ch].trim() && parsePaise(r[ch]) === null) e[ch] = 'Price in rupees, up to 2 decimals';
  if (r.desc.trim().length > ITEM_DESCRIPTION_MAX) e.desc = `Description is at most ${ITEM_DESCRIPTION_MAX} characters`;
  return e;
}
export function catIssues(c: DCat, d: Draft): Partial<Record<'name' | 'code', string>> {
  const e: Partial<Record<'name' | 'code', string>> = {};
  if (!c.name.trim()) e.name = 'Name is required';
  else if (c.name.trim().length > 100) e.name = 'Name is at most 100 characters';
  const code = c.code.trim();
  if (code ? !/^[0-9]{2}$/.test(code) : !isNew(c.key)) e.code = 'Code is two digits';
  else if (code && d.cats.some((o) => o !== c && o.code.trim() === code)) e.code = 'Code is used by another category';
  return e;
}
const hasKeys = (o: object) => Object.keys(o).length > 0;
/** Keys of the rows and categories with something wrong. */
export function problemKeys(d: Draft): Set<string> {
  const out = new Set<string>();
  for (const r of d.rows) if (hasKeys(rowIssues(r, d))) out.add(r.key);
  for (const c of d.cats) if (hasKeys(catIssues(c, d))) out.add(c.key);
  return out;
}

// ---------- editing (every function returns a new draft; the screen keeps them in a History) ----------
const mapRows = (d: Draft, keys: Iterable<string>, f: (r: DRow) => DRow): Draft => {
  const set = new Set(keys);
  return { ...d, rows: d.rows.map((r) => (set.has(r.key) ? f(r) : r)) };
};
export const editRow = (d: Draft, key: string, patch: Partial<DRow>): Draft => mapRows(d, [key], (r) => ({ ...r, ...patch }));
export const editCat = (d: Draft, key: string, patch: Partial<DCat>): Draft => ({ ...d, cats: d.cats.map((c) => (c.key === key ? { ...c, ...patch } : c)) });

const nextSort = (xs: { sortOrder: number }[]) => (xs.length ? Math.max(...xs.map((x) => x.sortOrder)) + 10 : 0);
export function addRow(d: Draft, categoryKey: string, patch: Partial<DRow> = {}): Draft {
  const row: DRow = {
    key: newKey(), categoryKey, name: '', code: '', hsn: '', desc: '', diet: '', tagIds: [], gst: '5', counter: '', zomato: '', swiggy: '', sha: null,
    sortOrder: nextSort(d.rows.filter((r) => r.categoryKey === categoryKey)), ...patch,
  };
  return { ...d, rows: [...d.rows, row] };
}
export function addCat(d: Draft, name = ''): { draft: Draft; key: string } {
  const key = newKey();
  return { draft: { ...d, cats: [...d.cats, { key, name, code: '', sortOrder: nextSort(d.cats) }] }, key };
}
/** A category with items stays (the server refuses it too); move or delete its items first. */
export function removeCat(d: Draft, key: string): Draft {
  if (d.rows.some((r) => r.categoryKey === key)) return d;
  return { ...d, cats: d.cats.filter((c) => c.key !== key) };
}
export const deleteRows = (d: Draft, keys: Iterable<string>): Draft => {
  const set = new Set(keys);
  return { ...d, rows: d.rows.filter((r) => !set.has(r.key)) };
};
export const setGst = (d: Draft, keys: Iterable<string>, gst: string) => mapRows(d, keys, (r) => ({ ...r, gst }));
export const setHsn = (d: Draft, keys: Iterable<string>, hsn: string) => mapRows(d, keys, (r) => ({ ...r, hsn }));
/** A moved item keeps its code if it is free in the new category; the server picks the next free one otherwise. */
export const moveRows = (d: Draft, keys: Iterable<string>, categoryKey: string) =>
  mapRows(d, keys, (r) => (r.categoryKey === categoryKey ? r : { ...r, categoryKey, sortOrder: nextSort(d.rows.filter((o) => o.categoryKey === categoryKey)) }));

const GRID_COLS: Field[] = ['name', 'code', 'counter', 'zomato', 'swiggy', 'gst', 'hsn', 'diet', 'desc'];
/**
 * Pastes tab/newline text (from a spreadsheet) into the grid. `shown` are the keys on screen, top to bottom; the block
 * lands from `shown[at]` and column `col` of `cols`. Lines past the last row become new items in `categoryKey`.
 */
export function pasteCells(d: Draft, shown: string[], at: number, col: number, text: string, categoryKey: string, cols: Field[] = GRID_COLS): Draft {
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
  let out = d;
  lines.forEach((cells, n) => {
    let key = shown[at + n];
    if (!key) {
      out = addRow(out, categoryKey);
      key = out.rows[out.rows.length - 1]!.key;
    }
    const patch: Partial<DRow> = {};
    cells.forEach((cell, c) => {
      const f = cols[col + c];
      if (!f) return;
      const v = cell.trim();
      if (f === 'diet') patch.diet = v === 'veg' || v === 'egg' || v === 'non_veg' ? v : '';
      else patch[f] = v;
    });
    out = editRow(out, key, patch);
  });
  return out;
}

// ---------- filtering ----------
export function shownRows(d: Draft, o: { categoryKey: string | null; search: string; onlyProblems: boolean }): DRow[] {
  const q = o.search.trim().toLowerCase();
  const bad = o.onlyProblems ? problemKeys(d) : null;
  return d.rows.filter((r) =>
    (!o.categoryKey || r.categoryKey === o.categoryKey) &&
    (!q || r.name.toLowerCase().includes(q) || r.code === q) &&
    (!bad || bad.has(r.key)));
}

// ---------- history (undo and redo) ----------
export interface History { past: Draft[]; present: Draft; future: Draft[] }
const HISTORY_MAX = 100;
export const startHistory = (present: Draft): History => ({ past: [], present, future: [] });
export const record = (h: History, next: Draft): History =>
  next === h.present ? h : { past: [...h.past, h.present].slice(-HISTORY_MAX), present: next, future: [] };
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] } : h);
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h);

// ---------- the diff (what Save sends) ----------
export interface ApplyBody {
  tags?: { create?: { ref: string; name: string; sortOrder: number }[] };
  categories?: { create?: { ref: string; name: string; code?: string; sortOrder: number }[]; update?: ({ id: string } & Record<string, unknown>)[]; delete?: string[] };
  items?: { create?: Record<string, unknown>[]; update?: ({ id: string } & Record<string, unknown>)[]; delete?: string[] };
  prices?: { set?: { itemId: string; channel: Channel; pricePaise: number; gstRateBp: number }[]; delete?: { itemId: string; channel: Channel }[] };
}
export interface Change {
  body: ApplyBody;
  /** `${list}:${index}` (as the server reports a failed op) -> the key of the row or category it came from. */
  origin: Map<string, string>;
  ops: number;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The difference between `base` (what the server last sent, as a draft) and `cur`, or null when nothing changed.
 * The draft must have no problems: text that does not parse is left out of the body, never guessed at.
 * `basePrices` are the server's prices, so a price is sent only if its amount, or its item's GST %, changed.
 */
export function buildApply(base: Draft, cur: Draft, basePrices: MenuPayload['prices']): Change | null {
  const origin = new Map<string, string>();
  const body: ApplyBody = {};
  const put = <L extends 'tags' | 'categories' | 'items' | 'prices', K extends string>(group: L, list: K, v: unknown, from: string) => {
    const g = ((body as Record<string, Record<string, unknown[]>>)[group] ??= {});
    const arr = (g[list] ??= []);
    origin.set(`${group}.${list}:${arr.length}`, from);
    arr.push(v);
  };
  const baseCat = new Map(base.cats.map((c) => [c.key, c]));
  const baseRow = new Map(base.rows.map((r) => [r.key, r]));
  const have = new Map(basePrices.map((p) => [`${p.itemId}/${p.channel}`, p]));
  const curCat = new Set(cur.cats.map((c) => c.key));
  const curRow = new Set(cur.rows.map((r) => r.key));

  // A new tag is created only while some row uses it (so undoing its last use drops it). Tags are not edited here.
  const used = new Set(cur.rows.flatMap((r) => r.tagIds));
  for (const t of cur.tags) if (isNew(t.key) && used.has(t.key)) put('tags', 'create', { ref: t.key, name: t.name, sortOrder: t.sortOrder }, t.key);

  for (const c of cur.cats) {
    const b = baseCat.get(c.key);
    if (!b) { put('categories', 'create', { ref: c.key, name: c.name.trim(), ...(c.code.trim() ? { code: c.code.trim() } : {}), sortOrder: c.sortOrder }, c.key); continue; }
    const patch: Record<string, unknown> = {};
    if (c.name.trim() !== b.name) patch.name = c.name.trim();
    if (c.code.trim() !== b.code) patch.code = c.code.trim();
    if (c.sortOrder !== b.sortOrder) patch.sortOrder = c.sortOrder;
    if (hasKeys(patch)) put('categories', 'update', { id: c.key, ...patch }, c.key);
  }
  for (const r of base.rows) if (!curRow.has(r.key)) put('items', 'delete', r.key, r.key);

  for (const r of cur.rows) {
    const b = baseRow.get(r.key);
    const fields = {
      name: r.name.trim(), hsnCode: r.hsn.trim() || null, description: r.desc.trim() || null, diet: r.diet || null, sortOrder: r.sortOrder,
    };
    if (!b) {
      put('items', 'create', {
        ref: r.key, categoryId: r.categoryKey, ...fields, ...(r.code.trim() ? { code: r.code.trim() } : {}), ...(r.tagIds.length ? { tagIds: r.tagIds } : {}),
      }, r.key);
    } else {
      const patch: Record<string, unknown> = {};
      if (r.categoryKey !== b.categoryKey) patch.categoryId = r.categoryKey;
      if (fields.name !== b.name) patch.name = fields.name;
      if (r.code.trim() !== b.code) patch.code = r.code.trim();
      if (fields.hsnCode !== (b.hsn.trim() || null)) patch.hsnCode = fields.hsnCode;
      if (fields.description !== (b.desc.trim() || null)) patch.description = fields.description;
      if (fields.diet !== (b.diet || null)) patch.diet = fields.diet;
      if (r.sortOrder !== b.sortOrder) patch.sortOrder = r.sortOrder;
      if (!sameSet(r.tagIds, b.tagIds)) patch.tagIds = r.tagIds;
      if (hasKeys(patch)) put('items', 'update', { id: r.key, ...patch }, r.key);
    }
    const bp = parseGstBp(r.gst);
    const gstChanged = !b || r.gst.trim() !== b.gst.trim();
    for (const ch of CHANNELS) {
      const text = r[ch].trim();
      const was = b ? have.get(`${r.key}/${ch}`) : undefined;
      if (!text) { if (was) put('prices', 'delete', { itemId: r.key, channel: ch }, r.key); continue; }
      const p = parsePaise(text);
      if (p === null || bp === null) continue;
      if (!was || was.pricePaise !== p || (gstChanged && was.gstRateBp !== bp)) put('prices', 'set', { itemId: r.key, channel: ch, pricePaise: p, gstRateBp: bp }, r.key);
    }
  }
  for (const c of base.cats) if (!curCat.has(c.key)) put('categories', 'delete', c.key, c.key);

  const ops = [...origin.keys()].length;
  return ops ? { body, origin, ops } : null;
}

// ---------- CSV export and import (docs/manager-menu-editor-plan.md, step 7) ----------
// Import never saves: it merges the file into the draft, so the grid's checks, undo and Save are the ones used.
export const CSV_COLS = ['id', 'category', 'name', 'code', 'diet', 'hsn', 'gst', 'price_counter', 'price_zomato', 'price_swiggy', 'tags', 'description'] as const;
export type CsvCol = (typeof CSV_COLS)[number];
const PRICE_COL: Record<Channel, CsvCol> = { counter: 'price_counter', zomato: 'price_zomato', swiggy: 'price_swiggy' };
const TAG_SEP = '|';
const TAG_NAME_MAX = 30; // mirrors tagName in apps/api/src/routes/menu.ts

const bySort = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** The draft as a CSV file, category by category. Prices are rupees excluding GST; tags are names joined by "|".
 *  A row not saved yet has no id. */
export function menuToCsv(d: Draft): string {
  const tag = new Map(d.tags.map((t) => [t.key, t.name]));
  const lines: string[][] = [[...CSV_COLS]];
  for (const c of [...d.cats].sort(bySort)) {
    for (const r of d.rows.filter((x) => x.categoryKey === c.key).sort(bySort)) {
      lines.push([isNew(r.key) ? '' : r.key, c.name, r.name, r.code, r.diet, r.hsn, r.gst, r.counter, r.zomato, r.swiggy,
        r.tagIds.map((k) => tag.get(k)).filter((n): n is string => !!n).join(TAG_SEP), r.desc]);
    }
  }
  return csvFile(lines);
}

export interface CsvImport {
  /** The current draft with the file merged in; the current draft itself when there are problems or nothing changed. */
  draft: Draft;
  changed: number; added: number; unchanged: number;
  /** Rows from the file that the grid will mark, fixable there. */
  bad: number;
  newCats: number; newTags: number;
  /** What stops the file loading at all, one line each. */
  problems: string[];
  /** Columns not in the file: those fields keep their values. */
  absent: CsvCol[];
  /** Column names in the file that mean nothing here. */
  ignored: string[];
}

const DIET_IN: Record<string, Diet | ''> = { '': '', veg: 'veg', egg: 'egg', non_veg: 'non_veg', 'non-veg': 'non_veg', nonveg: 'non_veg' };
// Excel opens "07" as the number 7: put back the leading zero a two-digit code, or a 4/6/8-digit HSN, has lost.
const padCode = (s: string) => (/^[0-9]$/.test(s) ? `0${s}` : s);
const padHsn = (s: string) => (/^([0-9]{3}|[0-9]{5}|[0-9]{7})$/.test(s) ? `0${s}` : s);
const normPrice = (s: string) => { const p = parsePaise(s); return p === null ? s : rupeesText(p); };
const normGst = (s: string) => { const b = parseGstBp(s); return b === null ? s : gstText(b); };
const SAME: (keyof DRow)[] = ['categoryKey', 'name', 'code', 'hsn', 'desc', 'diet', 'gst', 'counter', 'zomato', 'swiggy'];
const sameRow = (a: DRow, b: DRow) => SAME.every((k) => a[k] === b[k]) && sameSet(a.tagIds, b.tagIds);

/**
 * Merges a CSV file into the draft. A row matches an item by `id` when that item is in the draft, else by category and
 * name (ignoring case), else it is a new item. Unknown categories and tags are created. Items not in the file are left
 * alone (import never deletes). An empty cell sets the field empty (an empty price stops that channel); a column the
 * file does not have leaves the field as it is.
 */
export function importCsv(cur: Draft, text: string): CsvImport {
  const table = parseCsv(text);
  const at = new Map<CsvCol, number>();
  const ignored: string[] = [];
  (table[0] ?? []).forEach((h, i) => {
    const name = csvText(h.trim()).toLowerCase();
    if ((CSV_COLS as readonly string[]).includes(name) && !at.has(name as CsvCol)) at.set(name as CsvCol, i);
    else if (name) ignored.push(name);
  });
  const absent = CSV_COLS.filter((c) => !at.has(c));
  const out: CsvImport = { draft: cur, changed: 0, added: 0, unchanged: 0, bad: 0, newCats: 0, newTags: 0, problems: [], absent, ignored };
  if (!at.has('name') || !(at.has('id') || at.has('category'))) {
    out.problems.push('The first row must name the columns: at least name, and category or id. Export the menu to see the layout.');
    return out;
  }
  if (table.length < 2) { out.problems.push('The file has no items.'); return out; }

  let d = cur;
  const live = new Map(cur.rows.map((r) => [r.key, r]));
  const catBy = new Map(cur.cats.map((c) => [c.name.trim().toLowerCase(), c.key]));
  const tagBy = new Map(cur.tags.map((t) => [t.name.trim().toLowerCase(), t.key]));
  const rowBy = new Map(cur.rows.map((r) => [`${r.categoryKey}/${r.name.trim().toLowerCase()}`, r.key]));
  const claimed = new Map<string, number>(); // what a file row matched -> its row number
  const touched: string[] = [];

  table.slice(1).forEach((cells, n) => {
    const line = n + 2; // as a spreadsheet numbers it, the header being row 1
    const get = (c: CsvCol) => { const i = at.get(c); return i === undefined ? undefined : csvText((cells[i] ?? '').trim()); };
    const name = get('name') ?? '';
    const catName = get('category') ?? '';
    const id = get('id') ?? '';
    const say = (why: string) => out.problems.push(`Row ${line}${name ? ` (${name})` : ''}: ${why}`);
    if (!name) return say('no name.');
    const catKey = catName ? catBy.get(catName.toLowerCase()) : undefined;
    const target = id && live.has(id) ? id : catKey ? rowBy.get(`${catKey}/${name.toLowerCase()}`) : undefined;
    if (!target && !catName) return say('no category. A new item needs one.');
    const claim = target ?? `new/${catName.toLowerCase()}/${name.toLowerCase()}`;
    const twin = claimed.get(claim);
    if (twin) return say(`the same item as row ${twin}. Keep one of the two rows.`);
    claimed.set(claim, line);

    const patch: Partial<DRow> = { name };
    const diet = get('diet');
    if (diet !== undefined) {
      const v = DIET_IN[diet.toLowerCase()];
      if (v === undefined) return say('diet must be veg, egg, non_veg or empty.');
      patch.diet = v;
    }
    const tagNames = get('tags')?.split(TAG_SEP).map((t) => t.trim()).filter(Boolean);
    const longTag = tagNames?.find((t) => t.length > TAG_NAME_MAX);
    if (longTag) return say(`the tag "${longTag}" is longer than ${TAG_NAME_MAX} characters.`);
    if (out.problems.length) return; // no point building a draft that will not be used

    const code = get('code'); if (code !== undefined) patch.code = padCode(code);
    const hsn = get('hsn'); if (hsn !== undefined) patch.hsn = padHsn(hsn);
    const gst = get('gst'); if (gst !== undefined) patch.gst = normGst(gst);
    const desc = get('description'); if (desc !== undefined) patch.desc = desc;
    for (const ch of CHANNELS) { const p = get(PRICE_COL[ch]); if (p !== undefined) patch[ch] = normPrice(p); }
    if (tagNames) {
      patch.tagIds = [...new Set(tagNames.map((t) => {
        const k = tagBy.get(t.toLowerCase());
        if (k) return k;
        const key = newKey();
        d = { ...d, tags: [...d.tags, { key, name: t, sortOrder: nextSort(d.tags) }] };
        tagBy.set(t.toLowerCase(), key); out.newTags++;
        return key;
      }))];
    }
    let toCat = catKey;
    if (catName && !toCat) {
      const made = addCat(d, catName);
      d = made.draft; toCat = made.key;
      catBy.set(catName.toLowerCase(), toCat); out.newCats++;
    }

    if (target) {
      const before = d.rows.find((r) => r.key === target)!;
      if (toCat) d = moveRows(d, [target], toCat);
      d = editRow(d, target, patch);
      if (sameRow(before, d.rows.find((r) => r.key === target)!)) out.unchanged++; else out.changed++;
      touched.push(target);
    } else {
      d = addRow(d, toCat!, patch);
      touched.push(d.rows[d.rows.length - 1]!.key);
      out.added++;
    }
  });

  if (out.problems.length || !(out.changed || out.added)) return { ...out, newCats: 0, newTags: 0 };
  out.draft = d;
  out.bad = touched.filter((k) => hasKeys(rowIssues(d.rows.find((r) => r.key === k)!, d))).length;
  return out;
}
