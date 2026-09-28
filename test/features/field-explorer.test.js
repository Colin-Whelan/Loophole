import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldComboItems, searchValues, summaryText } from '../../src/features/field-explorer/values.js';
import meta from '../../src/features/field-explorer/meta.js';

test('fieldComboItems maps getUserFields() shape to combobox items', () => {
  const fields = [{ name: 'email', type: 'string', sources: ['mappings'] }, { name: 'age', type: 'long', sources: ['userMappings'] }];
  assert.deepEqual(fieldComboItems(fields), [
    { value: 'email', label: 'email', hint: 'string' },
    { value: 'age', label: 'age', hint: 'long' },
  ]);
});

test('fieldComboItems tolerates a missing type and empty/nullish input', () => {
  assert.deepEqual(fieldComboItems([{ name: 'x', type: '' }]), [{ value: 'x', label: 'x', hint: undefined }]);
  assert.deepEqual(fieldComboItems(null), []);
  assert.deepEqual(fieldComboItems(undefined), []);
});

test('searchValues: empty query returns everything up to the cap', () => {
  const values = ['a', 'b', 'c'];
  const r = searchValues(values, '', 2);
  assert.deepEqual(r.shown, ['a', 'b']);
  assert.equal(r.matchCount, 3);
  assert.equal(r.truncated, true);
});

test('searchValues: case-insensitive substring match', () => {
  const values = ['Alpha', 'beta', 'gamma', 'ALPHABET'];
  const r = searchValues(values, 'alpha', 10);
  assert.deepEqual(r.shown, ['Alpha', 'ALPHABET']);
  assert.equal(r.matchCount, 2);
  assert.equal(r.truncated, false);
});

test('searchValues: not truncated when matches fit exactly at the cap', () => {
  const r = searchValues(['a', 'b'], '', 2);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.shown, ['a', 'b']);
});

test('searchValues: cap <= 0 or non-integer falls back to no cap', () => {
  const values = ['a', 'b', 'c'];
  assert.deepEqual(searchValues(values, '', 0).shown, values);
  assert.deepEqual(searchValues(values, '', -5).shown, values);
  assert.deepEqual(searchValues(values, '', NaN).shown, values);
});

test('summaryText: all values shown, no truncation note', () => {
  assert.equal(summaryText(3, 3), '3 values');
  assert.equal(summaryText(1, 1), '1 value');
});

test('summaryText: filtered subset shown', () => {
  assert.equal(summaryText(2, 10), '2 / 10 shown');
});

test('summaryText: notes an API-truncated result only when everything is shown', () => {
  assert.equal(summaryText(3, 3, { apiTruncated: true }), '3 values (API returned the maximum — there may be more)');
  assert.equal(summaryText(2, 10, { apiTruncated: true }), '2 / 10 shown');
});

test('meta: id is stable and route matches /segmentation', () => {
  assert.equal(meta.id, 'field-explorer');
  assert.ok(meta.routes.some((r) => r.test('/segmentation')));
  assert.ok(meta.routes.some((r) => r.test('/segmentation/123')));
  assert.ok(!meta.routes.some((r) => r.test('/users/profiles/1')));
});

test('meta: maxRendered setting has a sane numeric default', () => {
  const s = meta.settings.find((x) => x.key === 'maxRendered');
  assert.ok(s);
  assert.equal(s.type, 'number');
  assert.equal(s.default, 2000);
});
