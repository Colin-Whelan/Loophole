import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSettings, mergeValues, defaultValues, isValidValue, resolveGeneral, DEFAULT_GENERAL,
} from '../src/core/settings.js';
import { FEATURES } from '../src/features/registry.js';

const META = {
  id: 'demo',
  defaultEnabled: false,
  settings: [
    { key: 'on', type: 'boolean', default: true },
    { key: 'rate', type: 'number', min: 0.1, max: 10, default: 5 },
    { key: 'name', type: 'string', default: 'x' },
    { key: 'body', type: 'text', default: '' },
    { key: 'mode', type: 'select', options: [{ value: 'a' }, { value: 'b' }], default: 'a' },
    { key: 'tags', type: 'stringList', default: ['one'] },
    { key: 'params', type: 'keyValueList', default: [{ key: 'utm_source', value: 'iterable' }] },
  ],
};

test('empty storage resolves to every default', () => {
  const s = resolveSettings(undefined, [META]);
  assert.deepEqual(s.general, DEFAULT_GENERAL);
  assert.equal(s.features.demo.enabled, false);
  assert.deepEqual(s.features.demo.values, defaultValues(META));
});

test('stored values override defaults; invalid ones fall back', () => {
  const values = mergeValues(META, { rate: 2, mode: 'b', tags: ['x', 'y'], on: 'yes', name: 7 });
  assert.equal(values.rate, 2);
  assert.equal(values.mode, 'b');
  assert.deepEqual(values.tags, ['x', 'y']);
  assert.equal(values.on, true);      // 'yes' is not a boolean → default
  assert.equal(values.name, 'x');     // 7 is not a string → default
  assert.deepEqual(values.params, [{ key: 'utm_source', value: 'iterable' }]);
});

test('numbers outside min/max and unknown select options fall back', () => {
  assert.equal(mergeValues(META, { rate: 50 }).rate, 5);
  assert.equal(mergeValues(META, { rate: 0 }).rate, 5);
  assert.equal(mergeValues(META, { rate: Number.NaN }).rate, 5);
  assert.equal(mergeValues(META, { mode: 'zzz' }).mode, 'a');
});

test('keys outside the schema are kept (custom settings editors)', () => {
  const values = mergeValues(META, { library: { terms: ['a'] } });
  assert.deepEqual(values.library, { terms: ['a'] });
});

test('defaults are copies, never shared with the meta', () => {
  const a = resolveSettings({}, [META]);
  a.features.demo.values.tags.push('mutated');
  a.features.demo.values.params[0].value = 'mutated';
  const b = resolveSettings({}, [META]);
  assert.deepEqual(b.features.demo.values.tags, ['one']);
  assert.equal(META.settings[6].default[0].value, 'iterable');
});

test('enabled: stored boolean wins, otherwise meta.defaultEnabled (missing means true)', () => {
  const metas = [META, { id: 'plain', settings: [] }];
  const s = resolveSettings({ features: { demo: { enabled: true }, plain: { enabled: 'nope' } } }, metas);
  assert.equal(s.features.demo.enabled, true);
  assert.equal(s.features.plain.enabled, true);
});

test('resolveSettings never mutates the stored object', () => {
  const raw = { version: 1, general: { theme: 'dark' }, features: { demo: { values: { rate: 3 } } } };
  const copy = JSON.parse(JSON.stringify(raw));
  resolveSettings(raw, [META]);
  assert.deepEqual(raw, copy);
});

test('general settings validate theme and debug', () => {
  assert.deepEqual(resolveGeneral({ theme: 'system', debug: true }), { theme: 'system', debug: true });
  assert.deepEqual(resolveGeneral({ theme: 'purple', debug: 1 }), DEFAULT_GENERAL);
  assert.deepEqual(resolveGeneral(null), DEFAULT_GENERAL);
});

test('isValidValue covers every field type', () => {
  assert.equal(isValidValue({ type: 'keyValueList' }, [{ key: 'a', value: 'b' }]), true);
  assert.equal(isValidValue({ type: 'keyValueList' }, [{ key: 'a' }]), false);
  assert.equal(isValidValue({ type: 'stringList' }, ['a', 1]), false);
  assert.equal(isValidValue({ type: 'text' }, 'x'), true);
});

test('the real feature metas resolve with their documented defaults', () => {
  const s = resolveSettings({});
  for (const meta of FEATURES) {
    assert.ok(s.features[meta.id], meta.id);
    for (const f of meta.settings) assert.ok(isValidValue(f, f.default), `${meta.id}.${f.key} default is valid`);
  }
  assert.equal(s.features['bulk-data'].values.rateLimit, 5);
  assert.equal(s.features['bulk-data'].values.batchSize, 500);
  assert.equal(s.features['delete-user'].values.defaultIdentifier, 'auto');
  assert.equal(s.features['quick-search'].values.sortOrder, 'custom');
});
