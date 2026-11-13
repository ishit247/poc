// The catalog editor's data handling, kept free of React so it can be tested: CSV in and out, reading a dropped folder,
// working out which picture belongs to which row, and the per-row checks that mirror the API's.
import { ITEM_DESCRIPTION_MAX, csvFile, csvText, parseCsv, parseGstBp, parsePaise } from '@pos/shared';

export interface Draft {
  id: string; name: string; hsn: string; gst: string; price: string; desc: string;
  sha: string | null;      // a picture already stored (by hash)
  blob: Blob | null;       // a picture chosen in this session, uploaded when the template is saved
  preview: string | null;  // object URL of `blob`
}
export interface DraftCat { id: string; name: string; items: Draft[] }
export interface ParsedRow { category: string; name: string; hsn: string; gst: string; price: string; desc: string; image: string }
export interface BundleFile { file: File; path: string }

export const uid = () => Math.random().toString(36).slice(2, 9);
export const blankDraft = (): Draft => ({ id: uid(), name: '', hsn: '', gst: '5', price: '', desc: '', sha: null, blob: null, preview: null });
export const isBlank = (i: Draft) => !i.name.trim() && !i.hsn.trim() && !i.price.trim() && !i.desc.trim() && !i.sha && !i.blob;
/** Set by the list's Import button so the editor opens with the import dialog already showing. */
export const IMPORT_FLAG = 'console-catalog-import';

/** What is wrong with one row, by field. Same rules as the API: name, 4 to 8 digit HSN/SAC, GST 0 to 40%, price up to 10,00,000. */
export function issues(i: Draft): Partial<Record<'name' | 'hsn' | 'gst' | 'price' | 'desc', string>> {
  const e: Partial<Record<'name' | 'hsn' | 'gst' | 'price' | 'desc', string>> = {};
  if (!i.name.trim()) e.name = 'Name is required';
  else if (i.name.trim().length > 100) e.name = 'Name is at most 100 characters';
  if (i.hsn.trim() && !/^[0-9]{4,8}$/.test(i.hsn.trim())) e.hsn = 'HSN/SAC must be 4 to 8 digits';
  if (parseGstBp(i.gst) === null) e.gst = 'GST must be 0 to 40, up to 2 decimals';
  if (parsePaise(i.price) === null) e.price = 'Price in rupees, up to 2 decimals (e.g. 45 or 45.50)';
  if (i.desc.trim().length > ITEM_DESCRIPTION_MAX) e.desc = `Description is at most ${ITEM_DESCRIPTION_MAX} characters`;
  return e;
}
export const rowHasIssues = (i: Draft) => !isBlank(i) && Object.keys(issues(i)).length > 0;

// ---------- CSV ----------
/** Rows from a CSV with a header (category, item, hsn, gst, price, description, image) or, without one, in that column order. */
export function rowsFromCsv(text: string): ParsedRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const hasHead = head.some((h) => h === 'item' || h === 'name');
  const find = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const col = hasHead
    ? { category: find('category'), name: find('item', 'name'), hsn: find('hsn', 'hsn/sac', 'hsn_code', 'sac'), gst: find('gst', 'gst %', 'gst%', 'gst_percent'), price: find('price', 'price ₹', 'price (excl. gst)', 'price_excl_gst'), desc: find('description', 'desc'), image: find('image', 'picture', 'photo', 'image_file') }
    : { category: 0, name: 1, hsn: 2, gst: 3, price: 4, desc: 5, image: 6 };
  return rows.slice(hasHead ? 1 : 0).map((r) => {
    const g = (k: keyof typeof col) => csvText((col[k] >= 0 ? (r[col[k]] ?? '') : '').trim());
    return { category: g('category') || 'Imported', name: g('name'), hsn: g('hsn'), gst: g('gst') || '5', price: g('price'), desc: g('desc'), image: g('image') };
  });
}

/** The grid as CSV. `imageName` gives the file name to write in the image column for a row that has a picture. */
export function toCsv(cats: DraftCat[], imageName: (i: Draft, c: DraftCat) => string = () => ''): string {
  const lines = [['category', 'item', 'hsn', 'gst', 'price', 'description', 'image']];
  for (const c of cats) for (const i of c.items) if (!isBlank(i)) lines.push([c.name, i.name, i.hsn, i.gst, i.price, i.desc, imageName(i, c)]);
  return csvFile(lines);
}
export const CSV_TEMPLATE = 'category,item,hsn,gst,price,description,image\nSnacks,Samosa,21069099,5,12,Crisp pastry,samosa.jpg\nBeverages,Tea,09024090,5,10,,tea.jpg\n';

export function groupRows(rows: ParsedRow[], pictures: (Draft | null)[] = []): DraftCat[] {
  const map = new Map<string, DraftCat>();
  rows.forEach((r, n) => {
    const key = r.category.toLowerCase();
    const cat = map.get(key) ?? { id: uid(), name: r.category, items: [] };
    map.set(key, cat);
    const pic = pictures[n];
    cat.items.push({ ...blankDraft(), name: r.name, hsn: r.hsn, gst: r.gst, price: r.price, desc: r.desc, ...(pic ? { sha: pic.sha, blob: pic.blob, preview: pic.preview } : {}) });
  });
  return [...map.values()];
}

// ---------- pictures ----------
export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
export const isImageFile = (f: File) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name);
export const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;
/** "Veg-Sandwich_2.JPG" and "veg sandwich 2" compare equal. */
export const norm = (s: string) => baseName(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '');

export interface Resolution {
  byRow: Map<number, BundleFile>;           // row index -> the picture to use
  missing: { row: number; ref: string }[];  // the CSV names a file that is not in the folder
  unused: BundleFile[];                     // pictures no row uses
}
/**
 * Which picture goes with which row. A row's `image` column wins (a bare file name, or a path ending in it); otherwise the
 * row's name is compared with the picture file names. A picture serves one row.
 */
export function resolvePictures(rows: ParsedRow[], files: BundleFile[]): Resolution {
  const pics = files.filter((f) => isImageFile(f.file));
  const used = new Set<BundleFile>();
  const byRow = new Map<number, BundleFile>();
  const missing: Resolution['missing'] = [];
  const lowerPath = (f: BundleFile) => f.path.replace(/\\/g, '/').toLowerCase();
  const find = (ref: string) => {
    const r = ref.replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '');
    return pics.find((f) => lowerPath(f) === r || lowerPath(f).endsWith(`/${r}`)) ?? pics.find((f) => baseName(f.path).toLowerCase() === baseName(r));
  };
  rows.forEach((r, n) => {
    if (!r.image) return;
    const hit = find(r.image);
    if (hit) { byRow.set(n, hit); used.add(hit); } else missing.push({ row: n, ref: r.image });
  });
  rows.forEach((r, n) => {
    if (r.image || byRow.has(n) || !r.name.trim()) return;
    const key = norm(r.name);
    const hit = key ? pics.find((f) => !used.has(f) && norm(f.path) === key) : undefined;
    if (hit) { byRow.set(n, hit); used.add(hit); }
  });
  return { byRow, missing, unused: pics.filter((f) => !used.has(f)) };
}

// ---------- reading a dropped folder ----------
export const fromFileList = (list: FileList | File[]): BundleFile[] =>
  [...list].map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));

interface FsEntry { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: (ok: (f: File) => void, no: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, no: (e: unknown) => void) => void } }
async function walk(entry: FsEntry, out: BundleFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, no) => entry.file!(ok, no));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns a batch at a time (about 100): keep asking until it comes back empty.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}
/** Everything in what was dropped, folders included. Must be called synchronously from the drop event's handler. */
export async function readDropped(dt: DataTransfer): Promise<BundleFile[]> {
  const entries = [...dt.items].map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  const plain = [...dt.files];
  if (!entries.length || entries.every((e) => !e)) return fromFileList(plain);
  const out: BundleFile[] = [];
  for (const e of entries) if (e) await walk(e, out);
  return out;
}

/** The CSV in a bundle: catalog.csv if there is one, otherwise the first .csv. */
export function pickCsv(files: BundleFile[]): { csv: BundleFile | null; extra: number } {
  const csvs = files.filter((f) => /\.csv$/i.test(f.path));
  const csv = csvs.find((f) => baseName(f.path).toLowerCase() === 'catalog.csv') ?? csvs[0] ?? null;
  return { csv, extra: Math.max(0, csvs.length - (csv ? 1 : 0)) };
}
