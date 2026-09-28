import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLibrary, toDraft, defaultParamTypes } from '../../src/features/link-params/library.js';

test('buildLibrary keeps order, fills labels and cleans categories', () => {
  const r = buildLibrary([
    { key: 'utm_id', label: '', categories: [{ name: ' ', color: 'x', terms: ['a', 'a', ' b '] }] },
    { key: ' utm_term ', label: 'Term', categories: [] },
  ]);
  assert.deepEqual(r, {
    paramTypes: {
      utm_id: { label: 'utm_id', categories: [{ name: 'Untitled', color: '#8b9a98', terms: ['a', 'b'] }] },
      utm_term: { label: 'Term', categories: [] },
    },
  });
  assert.deepEqual(Object.keys(r.paramTypes), ['utm_id', 'utm_term']);
});

test('buildLibrary rejects empty, invalid and duplicate names and an empty library', () => {
  assert.equal(buildLibrary([{ key: '', categories: [] }]).errors.length, 1);
  assert.match(buildLibrary([{ key: 'a b', categories: [] }]).errors[0], /can't be used/);
  assert.match(buildLibrary([{ key: 'x', categories: [] }, { key: 'x', categories: [] }]).errors[0], /twice/);
  assert.match(buildLibrary([]).errors[0], /at least one/);
});

test('toDraft → buildLibrary round-trips the defaults', () => {
  const draft = toDraft(defaultParamTypes());
  assert.equal(draft[0].label, ''); // label equal to the name is left blank so renames carry it
  assert.deepEqual(buildLibrary(draft).paramTypes, defaultParamTypes());
});
