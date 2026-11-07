import test from 'node:test';
import assert from 'node:assert/strict';
import { blankDraft, groupRows, issues, parseCsv, pickCsv, resolvePictures, rowsFromCsv, toCsv, type BundleFile } from '../src/catalogIO.ts';

const pic = (path: string): BundleFile => ({ path, file: { name: path.split('/').pop()!, type: 'image/jpeg' } as File });
const csvFile = (path: string): BundleFile => ({ path, file: { name: path.split('/').pop()!, type: 'text/csv' } as File });

test('CSV: quotes, commas inside a field, doubled quotes, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,row');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['last', 'row']]);
});

test('rows are read by header name, in any column order, with the image column', () => {
  const rows = rowsFromCsv('Price,Item,Category,Image,GST,HSN\n12,Samosa,Snacks,images/samosa.jpg,5,21069099\n');
  assert.deepEqual(rows[0], { category: 'Snacks', name: 'Samosa', hsn: '21069099', gst: '5', price: '12', desc: '', image: 'images/samosa.jpg' });
});

test('a CSV with no header is read in the documented column order; missing category and GST get defaults', () => {
  const rows = rowsFromCsv('Snacks,Samosa,21069099,5,12,Crisp,samosa.jpg\n,Tea,,,10');
  assert.equal(rows[0]!.image, 'samosa.jpg');
  assert.equal(rows[1]!.category, 'Imported');
  assert.equal(rows[1]!.gst, '5');
});

test('the image column wins, by bare name or by path; a name that is not in the folder is reported', () => {
  const rows = rowsFromCsv('category,item,image\nSnacks,Samosa XL,samosa.jpg\nSnacks,Poha,images/poha.png\nSnacks,Pakora,pakora.jpg');
  const files = [pic('menu/images/samosa.jpg'), pic('menu/images/poha.png'), pic('menu/images/extra.jpg')];
  const r = resolvePictures(rows, files);
  assert.equal(r.byRow.get(0)!.path, 'menu/images/samosa.jpg', 'a bare name finds the file wherever it sits');
  assert.equal(r.byRow.get(1)!.path, 'menu/images/poha.png', 'a path matches its tail');
  assert.deepEqual(r.missing, [{ row: 2, ref: 'pakora.jpg' }]);
  assert.deepEqual(r.unused.map((f) => f.path), ['menu/images/extra.jpg']);
});

test('without an image column a picture is matched to the item name, ignoring case, dashes and extension; one picture serves one row', () => {
  const rows = rowsFromCsv('category,item\nSnacks,Veg Sandwich\nSnacks,Veg Sandwich');
  const r = resolvePictures(rows, [pic('veg-sandwich.JPG')]);
  assert.equal(r.byRow.size, 1);
  assert.equal(r.byRow.get(0)!.path, 'veg-sandwich.JPG');
});

test('a picture named by the CSV is not also handed to another row by name', () => {
  const rows = rowsFromCsv('category,item,image\nA,Tea,chai.jpg\nA,Chai,');
  const r = resolvePictures(rows, [pic('chai.jpg')]);
  assert.equal(r.byRow.get(0)!.path, 'chai.jpg');
  assert.equal(r.byRow.has(1), false);
});

test('non-picture files are ignored when matching', () => {
  const rows = rowsFromCsv('category,item\nA,Notes');
  const r = resolvePictures(rows, [{ path: 'notes.txt', file: { name: 'notes.txt', type: 'text/plain' } as File }]);
  assert.equal(r.byRow.size, 0);
  assert.equal(r.unused.length, 0);
});

test('catalog.csv is preferred; other CSVs are counted, not used', () => {
  const { csv, extra } = pickCsv([csvFile('a/other.csv'), csvFile('a/Catalog.csv'), pic('a/x.jpg')]);
  assert.equal(csv!.path, 'a/Catalog.csv');
  assert.equal(extra, 1);
});

test('row checks follow the API: name, HSN 4 to 8 digits, GST 0 to 40, price in rupees', () => {
  const ok = { ...blankDraft(), name: 'Samosa', hsn: '21069099', gst: '5', price: '12.50' };
  assert.deepEqual(issues(ok), {});
  assert.ok(issues({ ...ok, name: ' ' }).name);
  assert.ok(issues({ ...ok, hsn: '123' }).hsn);
  assert.deepEqual(Object.keys(issues({ ...ok, hsn: '' })), [], 'HSN is optional');
  assert.ok(issues({ ...ok, gst: '41' }).gst);
  assert.ok(issues({ ...ok, gst: '5.555' }).gst);
  assert.ok(issues({ ...ok, price: '12.505' }).price);
  assert.ok(issues({ ...ok, price: '' }).price);
});

test('grouping keeps categories in first-seen order (case-insensitive) and CSV round-trips', () => {
  const cats = groupRows(rowsFromCsv('category,item,hsn,gst,price,description\nSnacks,Samosa,,5,12,"crisp, hot"\nDrinks,Tea,,5,10,\nsnacks,Poha,,5,25,'));
  assert.deepEqual(cats.map((c) => [c.name, c.items.length]), [['Snacks', 2], ['Drinks', 1]]);
  const again = rowsFromCsv(toCsv(cats, (i) => (i.name === 'Samosa' ? 'samosa.jpg' : '')));
  assert.equal(again.length, 3);
  assert.equal(again[0]!.desc, 'crisp, hot');
  assert.equal(again[0]!.image, 'samosa.jpg');
});
