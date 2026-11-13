// The manager menu editor's pure data code (apps/counter/src/manager/menuDraft.ts): the diff Save sends, the row checks,
// bulk edits, paste and undo. The route that receives the diff is tested against real Postgres in api/test/menu-apply.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCat, addRow, buildApply, catIssues, deleteRows, editCat, editRow, fromMenu, moveRows, pasteCells, problemKeys, record, redo, removeCat,
  rowIssues, setGst, shownRows, startHistory, undo, importCsv, menuToCsv, type MenuPayload,
} from '../src/manager/menuDraft.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const I1 = '00000000-0000-4000-8000-000000000001';
const I2 = '00000000-0000-4000-8000-000000000002';
const I3 = '00000000-0000-4000-8000-000000000003';
const T1 = '00000000-0000-4000-8000-0000000000f1';

const menu = (): MenuPayload => ({
  categories: [{ id: A, name: 'Snacks', code: '01', sortOrder: 0 }, { id: B, name: 'Drinks', code: '02', sortOrder: 10 }],
  items: [
    { id: I1, categoryId: A, name: 'Samosa', code: '01', hsnCode: '21069099', description: null, diet: 'veg', imageSha256: null, sortOrder: 0, tagIds: [] },
    { id: I2, categoryId: A, name: 'Vada Pav', code: '02', hsnCode: null, description: 'Mumbai', diet: null, imageSha256: 'abc', sortOrder: 10, tagIds: [T1] },
    { id: I3, categoryId: B, name: 'Tea', code: '01', hsnCode: null, description: null, diet: 'veg', imageSha256: null, sortOrder: 0, tagIds: [] },
  ],
  prices: [
    { itemId: I1, channel: 'counter', pricePaise: 1200, gstRateBp: 500 },
    { itemId: I1, channel: 'zomato', pricePaise: 1500, gstRateBp: 500 },
    { itemId: I2, channel: 'counter', pricePaise: 2550, gstRateBp: 1200 },
    { itemId: I3, channel: 'counter', pricePaise: 1000, gstRateBp: 500 },
    { itemId: I3, channel: 'swiggy', pricePaise: 1100, gstRateBp: 1800 }, // mixed rates on one item
  ],
  tags: [{ id: T1, name: 'Spicy', sortOrder: 0 }],
});
const load = () => { const m = menu(); return { m, base: fromMenu(m) }; };

test('an untouched draft has nothing to save, and shows the server prices as typed', () => {
  const { m, base } = load();
  assert.equal(buildApply(base, base, m.prices), null);
  const r = base.rows.find((x) => x.key === I2)!;
  assert.deepEqual([r.counter, r.zomato, r.gst, r.desc, r.sha], ['25.50', '', '12', 'Mumbai', 'abc']);
  assert.equal(base.rows.find((x) => x.key === I3)!.gst, '5', 'GST shown is the counter price rate');
});

test('changing one price sends one price and nothing else', () => {
  const { m, base } = load();
  const c = buildApply(base, editRow(base, I1, { counter: '13' }), m.prices)!;
  assert.deepEqual(c.body, { prices: { set: [{ itemId: I1, channel: 'counter', pricePaise: 1300, gstRateBp: 500 }] } });
  assert.equal(c.origin.get('prices.set:0'), I1);
  assert.equal(c.ops, 1);
});

test('an emptied price cell deletes that channel; a filled one adds it', () => {
  const { m, base } = load();
  const c = buildApply(base, editRow(base, I1, { zomato: '', swiggy: '16.5' }), m.prices)!;
  assert.deepEqual(c.body.prices?.delete, [{ itemId: I1, channel: 'zomato' }]);
  assert.deepEqual(c.body.prices?.set, [{ itemId: I1, channel: 'swiggy', pricePaise: 1650, gstRateBp: 500 }]);
});

test('GST left alone keeps other channels at their own rate; changed GST moves every price of the item', () => {
  const { m, base } = load();
  const only = buildApply(base, editRow(base, I3, { counter: '11' }), m.prices)!;
  assert.deepEqual(only.body.prices?.set?.map((p) => p.channel), ['counter'], 'swiggy keeps its 18%');
  const all = buildApply(base, setGst(base, [I3], '12'), m.prices)!;
  assert.deepEqual(all.body.prices?.set?.map((p) => [p.channel, p.gstRateBp]), [['counter', 1200], ['swiggy', 1200]]);
});

test('item fields: only what changed, empty text clears, tags compare as a set', () => {
  const { m, base } = load();
  const c = buildApply(base, editRow(editRow(base, I2, { desc: '', diet: 'egg' }), I1, { name: ' Samosa ', hsn: '' }), m.prices)!;
  assert.deepEqual(c.body.items?.update, [{ id: I1, hsnCode: null }, { id: I2, description: null, diet: 'egg' }]);
  assert.equal(buildApply(base, editRow(base, I2, { tagIds: [T1] }), m.prices), null);
  assert.deepEqual(buildApply(base, editRow(base, I2, { tagIds: [] }), m.prices)!.body.items?.update, [{ id: I2, tagIds: [] }]);
});

test('a new category with a new item and its prices refer to each other by ref', () => {
  const { m, base } = load();
  const { draft, key: cat } = addCat(base, 'Sweets');
  const d = addRow(draft, cat);
  const row = d.rows[d.rows.length - 1]!;
  const cur = editRow(d, row.key, { name: 'Jalebi', counter: '30', swiggy: '35', code: '' });
  const c = buildApply(base, cur, m.prices)!;
  assert.equal(c.body.categories?.create?.[0]?.ref, cat);
  assert.equal(c.body.items?.create?.[0]?.categoryId, cat);
  assert.equal(c.body.items?.create?.[0]?.ref, row.key);
  assert.ok(!('code' in c.body.items!.create![0]!), 'no code typed: the server picks one');
  assert.deepEqual(c.body.prices?.set?.map((p) => [p.itemId, p.channel]), [[row.key, 'counter'], [row.key, 'swiggy']]);
  assert.equal(c.origin.get('items.create:0'), row.key);
});

test('deleting an item sends only the delete; an emptied category can be deleted in the same change', () => {
  const { m, base } = load();
  assert.deepEqual(buildApply(base, deleteRows(base, [I1]), m.prices)!.body, { items: { delete: [I1] } });
  const emptied = removeCat(deleteRows(base, [I3]), B);
  assert.deepEqual(buildApply(base, emptied, m.prices)!.body, { items: { delete: [I3] }, categories: { delete: [B] } });
});

test('a category with items cannot be removed from the draft', () => {
  const { base } = load();
  assert.equal(removeCat(base, A), base);
});

test('moving an item sends its new category; renaming a category sends the name', () => {
  const { m, base } = load();
  const c = buildApply(editCat(base, B, {}), editCat(moveRows(base, [I1], B), A, { name: 'Bites' }), m.prices)!;
  assert.deepEqual(c.body.items?.update, [{ id: I1, categoryId: B, sortOrder: 10 }]);
  assert.deepEqual(c.body.categories?.update, [{ id: A, name: 'Bites' }]);
});

test('row checks match the API rules', () => {
  const { base } = load();
  const ok = base.rows[0]!;
  assert.deepEqual(rowIssues(ok, base), {});
  const bad = { ...ok, name: ' ', code: '1', hsn: '12', gst: '41', counter: '1.234', zomato: 'x' };
  assert.deepEqual(Object.keys(rowIssues(bad, base)).sort(), ['code', 'counter', 'gst', 'hsn', 'name', 'zomato']);
  assert.ok(rowIssues({ ...ok, code: '' }, base).code, 'an existing item keeps a code');
  const fresh = addRow(base, A);
  assert.equal(rowIssues(fresh.rows[fresh.rows.length - 1]!, fresh).code, undefined, 'a new item may leave the code empty');
  assert.equal(rowIssues({ ...ok, desc: 'x'.repeat(2000) }, base).desc !== undefined, true);
});

test('a code used twice in a category is a problem on both rows; the same code in another category is fine', () => {
  const { base } = load();
  const d = editRow(base, I2, { code: '01' });
  assert.deepEqual([...problemKeys(d)].sort(), [I1, I2].sort());
  assert.equal(problemKeys(editRow(base, I3, { code: '02' })).size, 0);
  assert.ok(catIssues({ ...base.cats[0]!, code: '02' }, base).code);
});

test('bulk edits touch only the chosen rows', () => {
  const { base } = load();
  const d = setGst(base, [I1, I2], '18');
  assert.deepEqual(d.rows.map((r) => r.gst), ['18', '18', '5']);
});

test('filter by category, search and problems', () => {
  const { base } = load();
  assert.deepEqual(shownRows(base, { categoryKey: A, search: '', onlyProblems: false }).map((r) => r.key), [I1, I2]);
  assert.deepEqual(shownRows(base, { categoryKey: null, search: 'tea', onlyProblems: false }).map((r) => r.key), [I3]);
  assert.deepEqual(shownRows(base, { categoryKey: null, search: '02', onlyProblems: false }).map((r) => r.key), [I2], 'a quick code finds its item');
  assert.deepEqual(shownRows(editRow(base, I1, { name: '' }), { categoryKey: null, search: '', onlyProblems: true }).map((r) => r.key), [I1]);
});

test('pasting a block fills cells across rows and adds rows past the end', () => {
  const { base } = load();
  const shown = [I1, I2];
  const d = pasteCells(base, shown, 1, 0, 'Pav Bhaji\t07\t80\nMisal\t08\t60\n', A);
  assert.deepEqual(d.rows.slice(0, 2).map((r) => [r.name, r.code, r.counter]), [['Samosa', '01', '12'], ['Pav Bhaji', '07', '80']]);
  const added = d.rows[d.rows.length - 1]!;
  assert.deepEqual([added.name, added.code, added.counter, added.categoryKey], ['Misal', '08', '60', A]);
  assert.equal(d.rows.length, base.rows.length + 1);
});

test('undo and redo walk the edits; a new edit drops the redo trail; an unchanged draft records nothing', () => {
  const { base } = load();
  let h = startHistory(base);
  h = record(h, editRow(base, I1, { counter: '13' }));
  h = record(h, editRow(h.present, I1, { counter: '14' }));
  assert.equal(record(h, h.present), h);
  assert.equal(undo(h).present.rows[0]!.counter, '13');
  assert.equal(undo(undo(h)).present, base);
  assert.equal(undo(undo(undo(h))).present, base, 'nothing before the start');
  assert.equal(redo(undo(h)).present.rows[0]!.counter, '14');
  const branched = record(undo(h), editRow(undo(h).present, I1, { counter: '99' }));
  assert.equal(branched.future.length, 0);
  assert.equal(redo(branched), branched);
});

// ---------- CSV export and import (step 7) ----------
const HEAD = 'id,category,name,code,diet,hsn,gst,price_counter,price_zomato,price_swiggy,tags,description';
const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

test('export: BOM, the agreed columns, category then item order, tags by name, and it imports back as unchanged', () => {
  const { base } = load();
  const text = menuToCsv(base);
  assert.ok(text.startsWith('\u{FEFF}' + HEAD + '\r\n'));
  const lines = text.slice(1).trim().split('\r\n');
  assert.deepEqual(lines.slice(1).map((l) => l.split(',')[2]), ['Samosa', 'Vada Pav', 'Tea']);
  assert.equal(lines[2], `${I2},Snacks,Vada Pav,02,,,12,25.50,,,Spicy,Mumbai`);
  const back = importCsv(base, text);
  assert.deepEqual([back.changed, back.added, back.unchanged, back.problems.length, back.absent.length], [0, 0, 3, 0, 0]);
  assert.equal(back.draft, base, 'nothing to load');
});

test('a name a spreadsheet would run as a formula survives the round trip', () => {
  const { base } = load();
  const d = editRow(base, I1, { name: '=Samosa' });
  const text = menuToCsv(d);
  assert.ok(text.includes(",'=Samosa,"));
  assert.equal(importCsv(d, text).changed, 0);
});

test('import by id: prices, an emptied channel, Excel-stripped zeros, a new tag; Save sends exactly that', () => {
  const { m, base } = load();
  const r = importCsv(base, csv(HEAD, `${I1},Snacks,Samosa,1,veg,902,5,13.00,,,Hot|spicy,`));
  assert.deepEqual([r.changed, r.added, r.unchanged, r.newTags, r.bad], [1, 0, 0, 1, 0]);
  const row = r.draft.rows.find((x) => x.key === I1)!;
  assert.deepEqual([row.code, row.hsn, row.counter, row.zomato], ['01', '0902', '13', '']);
  const hot = r.draft.tags.find((t) => t.name === 'Hot')!;
  assert.deepEqual(row.tagIds, [hot.key, T1], 'existing tag matched ignoring case');
  const c = buildApply(base, r.draft, m.prices)!;
  assert.deepEqual(c.body.tags?.create, [{ ref: hot.key, name: 'Hot', sortOrder: 10 }]);
  assert.deepEqual(c.body.items?.update, [{ id: I1, hsnCode: '0902', tagIds: [hot.key, T1] }]);
  assert.deepEqual(c.body.prices, { set: [{ itemId: I1, channel: 'counter', pricePaise: 1300, gstRateBp: 500 }], delete: [{ itemId: I1, channel: 'zomato' }] });
});

test('import by category and name, ignoring case; an unknown category and its item are created; nothing is deleted', () => {
  const { m, base } = load();
  const r = importCsv(base, csv('category,name,price_counter', 'snacks,SAMOSA,12', 'Sweets,Jalebi,30'));
  assert.deepEqual([r.changed, r.added, r.unchanged, r.newCats], [1, 1, 0, 1], 'SAMOSA matched Samosa and renamed it');
  const sweets = r.draft.cats.find((x) => x.name === 'Sweets')!;
  const jalebi = r.draft.rows.find((x) => x.name === 'Jalebi')!;
  assert.equal(jalebi.categoryKey, sweets.key);
  assert.equal(r.draft.rows.find((x) => x.key === I1)!.name, 'SAMOSA', 'the file spelling wins');
  const c = buildApply(base, r.draft, m.prices)!;
  assert.equal(c.body.items?.delete, undefined, 'items not in the file stay');
  assert.deepEqual(c.body.categories?.create?.map((x) => x.ref), [sweets.key]);
  assert.deepEqual(c.body.items?.create?.map((x) => x.categoryId), [sweets.key]);
});

test('a column the file lacks leaves that field alone; an empty cell clears it', () => {
  const { base } = load();
  const r = importCsv(base, csv('id,name,description', `${I2},Vada Pav,`));
  const row = r.draft.rows.find((x) => x.key === I2)!;
  assert.deepEqual([row.desc, row.counter, row.gst, row.tagIds], ['', '25.50', '12', [T1]]);
  assert.ok(r.absent.includes('price_counter') && r.absent.includes('tags') && !r.absent.includes('description'));
});

test('an id that is gone falls back to category and name; an item moved by the file goes to its new category', () => {
  const { base } = load();
  const gone = importCsv(base, csv(HEAD, `00000000-0000-4000-8000-0000000000ff,Drinks,Tea,01,veg,,5,10,,11,,`));
  assert.deepEqual([gone.added, gone.unchanged], [0, 1]);
  const moved = importCsv(base, csv('id,category,name', `${I1},Drinks,Samosa`));
  assert.equal(moved.draft.rows.find((x) => x.key === I1)!.categoryKey, B);
  assert.equal(moved.changed, 1);
});

test('problems stop the whole file: same item twice, bad diet, no category for a new item, no usable header', () => {
  const { base } = load();
  const twice = importCsv(base, csv(HEAD, `${I1},Snacks,Samosa,01,,,5,12,,,,`, `,Snacks,samosa,01,,,5,14,,,,`));
  assert.deepEqual(twice.problems, ['Row 3 (samosa): the same item as row 2. Keep one of the two rows.']);
  assert.equal(twice.draft, base);
  assert.match(importCsv(base, csv('category,name,diet', 'Snacks,Samosa,vegan')).problems[0]!, /^Row 2 \(Samosa\): diet/);
  assert.match(importCsv(base, csv('id,name', ',Kachori')).problems[0]!, /no category/);
  assert.match(importCsv(base, csv('item,price', 'Samosa,12')).problems[0]!, /first row must name the columns/);
  assert.match(importCsv(base, csv('category,name,tags', `Snacks,Samosa,${'x'.repeat(31)}`)).problems[0]!, /longer than 30/);
});

test('a value the grid can fix loads and is counted as a problem there', () => {
  const { base } = load();
  const r = importCsv(base, csv('category,name,price_counter,gst', 'Snacks,Samosa,abc,5', 'Snacks,Kachori,15,55'));
  assert.deepEqual([r.problems.length, r.changed, r.added, r.bad], [0, 1, 1, 2]);
  assert.equal(problemKeys(r.draft).size, 2);
});

test('a new tag no row uses any more is not created', () => {
  const { m, base } = load();
  const r = importCsv(base, csv('id,name,tags', `${I1},Samosa,Hot`));
  assert.equal(buildApply(base, editRow(r.draft, I1, { tagIds: [] }), m.prices), null);
});
