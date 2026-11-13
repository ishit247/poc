import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvFile, csvText, parseCsv, parseGstBp, parsePaise } from '../src/index.ts';

test('CSV: quotes, doubled quotes, commas and newlines inside quotes, CRLF, BOM, blank lines', () => {
  const rows = parseCsv('\u{FEFF}a,b\r\n"x,1","he said ""hi"""\r\n\r\n"two\nlines",z\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
});

test('a cell a spreadsheet would run as a formula is written as text, and read back as typed', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@sum'), "'@sum");
  assert.equal(csvCell('a, "b"'), '"a, ""b"""');
  assert.equal(csvText("'=1+1"), '=1+1');
  assert.equal(csvText("'twas"), "'twas");
  const back = parseCsv(csvFile([['name', 'note'], ['-Tea', 'say "hi", twice'], ['07', '']]));
  assert.deepEqual(back.map((r) => r.map(csvText)), [['name', 'note'], ['-Tea', 'say "hi", twice'], ['07', '']]);
});

test('a file starts with a BOM and ends lines with CRLF', () => {
  assert.equal(csvFile([['a', 'b']]), '\u{FEFF}a,b\r\n');
});

test('prices and GST rates are parsed from the text, with the API ceilings', () => {
  assert.equal(parsePaise('45'), 4500);
  assert.equal(parsePaise(' 45.5 '), 4550);
  assert.equal(parsePaise('0.07'), 7);
  assert.equal(parsePaise('1000000'), 100_000_000);
  for (const bad of ['', '-1', '45.505', '1e3', '10000001', 'abc']) assert.equal(parsePaise(bad), null, bad);
  assert.equal(parseGstBp('5'), 500);
  assert.equal(parseGstBp('2.5'), 250);
  assert.equal(parseGstBp('40'), 4000);
  for (const bad of ['', '40.01', '41', '5%', '-5']) assert.equal(parseGstBp(bad), null, bad);
});
