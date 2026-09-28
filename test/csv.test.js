import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CsvStreamParser, parseCsvAll, isBlankRow, rowToObject, csvEscape, toCsv, streamRows, readHeader, countDataRows,
} from '../src/core/csv.js';

test('parses simple rows with LF, CRLF and CR line endings', () => {
  assert.deepEqual(parseCsvAll('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsvAll('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsvAll('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsvAll('a,b\r\n1,2\n3,4\r5,6'), [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
});

test('handles quoted fields, escaped quotes and embedded newlines/commas', () => {
  const rows = parseCsvAll('name,note\n"Doe, Jane","said ""hi""\nthen left"\n');
  assert.deepEqual(rows, [['name', 'note'], ['Doe, Jane', 'said "hi"\nthen left']]);
});

test('strips a UTF-8 BOM only at the very start', () => {
  assert.deepEqual(parseCsvAll('﻿email\nx@y.z'), [['email'], ['x@y.z']]);
  assert.deepEqual(parseCsvAll('a\n﻿b'), [['a'], ['﻿b']]);
});

test('final row without trailing newline is flushed by end()', () => {
  const p = new CsvStreamParser();
  assert.deepEqual(p.push('a,b\n1,2'), [['a', 'b']]);
  assert.deepEqual(p.end(), [['1', '2']]);
  assert.deepEqual(p.end(), []);
});

test('rows split across arbitrary chunk boundaries parse identically', () => {
  const text = 'id,val\r\n1,"x\r\ny"\r\n2,"he said ""ok"""\r\n3,plain';
  const whole = parseCsvAll(text);
  for (let size = 1; size <= 7; size++) {
    const p = new CsvStreamParser();
    let rows = [];
    for (let i = 0; i < text.length; i += size) rows = rows.concat(p.push(text.slice(i, i + size)));
    rows = rows.concat(p.end()).filter((r) => !isBlankRow(r));
    assert.deepEqual(rows, whole, `chunk size ${size}`);
  }
});

test('blank lines are dropped by parseCsvAll', () => {
  assert.deepEqual(parseCsvAll('a\n\n\nb\n'), [['a'], ['b']]);
  assert.equal(isBlankRow(['']), true);
  assert.equal(isBlankRow([]), true);
  assert.equal(isBlankRow(['', '']), false);
});

test('rowToObject pads missing fields with empty strings', () => {
  assert.deepEqual(rowToObject(['a', 'b', 'c'], ['1']), { a: '1', b: '', c: '' });
});

test('csvEscape / toCsv round-trip through the parser', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(null), '');
  const rows = [['k', 'v'], ['1', 'a,b'], ['2', 'line\nbreak'], ['3', '"q"']];
  assert.deepEqual(parseCsvAll(toCsv(rows)), rows);
});

test('streamRows / readHeader / countDataRows work on a Blob', async () => {
  const blob = new Blob(['email,first\nx@y.z,Ann\n\na@b.c,"Bo, Jr"\n']);
  assert.deepEqual(await readHeader(blob), ['email', 'first']);
  const seen = [];
  const res = await streamRows(blob, (fields, n) => { seen.push([n, fields]); });
  assert.deepEqual(res.header, ['email', 'first']);
  assert.equal(res.rows, 2);
  assert.deepEqual(seen, [[1, ['x@y.z', 'Ann']], [2, ['a@b.c', 'Bo, Jr']]]);
  assert.equal(await countDataRows(new Blob(['h\n1\n2\n3'])), 3);
});

test('streamRows stops early when onRow returns "stop"', async () => {
  const blob = new Blob(['h\n1\n2\n3\n']);
  let calls = 0;
  const res = await streamRows(blob, () => { calls++; return calls === 2 ? 'stop' : undefined; });
  assert.equal(calls, 2);
  assert.equal(res.rows, 2);
});
