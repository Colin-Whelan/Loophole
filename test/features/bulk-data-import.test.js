import { test } from 'node:test';
import assert from 'node:assert/strict';
import importer, { whichScript } from '../../src/features/bulk-data/import.js';
import meta from '../../src/features/bulk-data/meta.js';
import { mergeValues } from '../../src/core/settings.js';

test('import maps settings given as a JSON string (decoded GM value)', () => {
  const r = importer.map({ settings: '{"rateLimit":4,"batchSize":250}', ui_collapsed: '0' });
  assert.deepEqual(r.values, { rateLimit: 4, batchSize: 250 });
  assert.deepEqual(r.notes, []);
  assert.equal(r.keys, undefined);   // keys are imported centrally
});

test('import accepts an already-parsed object and clamps out-of-range values', () => {
  const r = importer.map({ settings: { rateLimit: 50, batchSize: 5000 } }, { name: 'Iterable User Push' });
  assert.deepEqual(r.values, { rateLimit: 10, batchSize: 1000 });
  // The mapped values pass the schema as-is.
  assert.deepEqual(mergeValues(meta, r.values), { ...mergeValues(meta, {}), ...r.values });
});

test('import ignores API keys and skips checkpoints with a note', () => {
  const r = importer.map({
    api_keys_by_project: '{"1":{"name":"P","apiKey":"0000000000000000aaaaaaaaaaaaaaaa"}}',
    legacy_api_key: '1111111111111111bbbbbbbbbbbbbbbb',
    'ckpt:push:a.csv|1|2': '{"committedRows":5}',
    'ckpt:subscribe:a.csv|1|2': '{"committedRows":5}',
  });
  assert.deepEqual(r.values, {});
  assert.ok(!JSON.stringify(r).includes('aaaaaaaa'));
  assert.ok(!JSON.stringify(r).includes('bbbbbbbb'));
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /2 unfinished runs/);
  assert.match(r.notes[0], /re-select the file to start again/);
});

test('import tolerates junk', () => {
  assert.deepEqual(importer.map({ settings: 'not json' }).values, {});
  assert.deepEqual(importer.map({ settings: '{"rateLimit":"x","batchSize":0}' }).values, {});
  assert.deepEqual(importer.map(null).values, {});
});

// ── Catalog Push (same `settings` key, different settings here) ─────────────

test('Catalog Push settings map to the catalog values by script name', () => {
  const r = importer.map({ settings: '{"rateLimit":25,"batchSize":800}' }, { name: 'Iterable Catalog Push' });
  assert.deepEqual(r.values, { catalogRateLimit: 25, catalogBatchSize: 800 });
  assert.deepEqual(mergeValues(meta, r.values), { ...mergeValues(meta, {}), ...r.values });
  // A plain string name works too, and renamed copies match (normalised names).
  assert.deepEqual(importer.map({ settings: { rateLimit: 500, batchSize: 5000 } }, 'catalog push').values,
    { catalogRateLimit: 100, catalogBatchSize: 1000 });
});

test('User Push settings by name stay on the users values, even at Catalog-like numbers', () => {
  const r = importer.map({ settings: { rateLimit: 10, batchSize: 1000 } }, { scriptName: 'Iterable User Push' });
  assert.deepEqual(r.values, { rateLimit: 10, batchSize: 1000 });
});

test('without a name, the storage decides where it can', () => {
  assert.equal(whichScript({ 'ckpt:catalog:Shoes|merge|id:sku:a.csv|1|2': '{}' }), 'catalogs');
  assert.equal(whichScript({ 'ckpt:push:a.csv|1|2': '{}' }), 'users');
  assert.equal(whichScript({ legacy_api_key: 'x', settings: '{"rateLimit":50}' }), 'users');
  assert.equal(whichScript({ settings: '{"rateLimit":50,"batchSize":1000}' }), 'catalogs');   // User Push caps at 10
  assert.equal(whichScript({ settings: '{"rateLimit":5,"batchSize":500}' }), 'users');        // ambiguous: as before
  const r = importer.map({ settings: '{"rateLimit":40}', 'ckpt:catalog:Shoes|merge|id:sku:a.csv|1|2': '{"committedRows":3}' });
  assert.deepEqual(r.values, { catalogRateLimit: 40 });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /1 unfinished upload\./);
});

test('meta lists both legacy scripts and import.js claims both', () => {
  assert.deepEqual(meta.legacy, ['Iterable User Push', 'Iterable Catalog Push']);
  assert.deepEqual(importer.scripts, meta.legacy);
});
