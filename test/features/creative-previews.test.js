import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assetIdFromPreview, folderIdFromSearch, indexAssets, resolveAsset,
} from '../../src/features/creative-previews/match.js';
import { mapCreativePreviews } from '../../src/features/creative-previews/import.js';
import meta from '../../src/features/creative-previews/meta.js';

test('assetIdFromPreview strips only the leading "preview-"', () => {
  assert.equal(assetIdFromPreview('preview-1234'), '1234');
  assert.equal(assetIdFromPreview('preview-preview-1'), 'preview-1');
  assert.equal(assetIdFromPreview(''), '');
  assert.equal(assetIdFromPreview(null), '');
});

test('folderIdFromSearch: digits only, root is null', () => {
  assert.equal(folderIdFromSearch('?folderId=42'), 42);
  assert.equal(folderIdFromSearch('?tab=x&folderId=7&sort=name'), 7);
  assert.equal(folderIdFromSearch(''), null);
  assert.equal(folderIdFromSearch('?tab=x'), null);
  assert.equal(folderIdFromSearch('?folderId=abc'), null);
});

test('indexAssets indexes by id only (names are not unique)', () => {
  const images = [
    { id: 1, name: 'Logo.png' },
    { id: 2, name: 'Logo.png' },
    { id: '3', name: 'Banner' },
    { id: null, name: 'no id' },
    { id: 4, name: '' },
  ];
  const index = indexAssets(images);
  assert.deepEqual(Object.keys(index), ['byId']);
  assert.equal(index.byId.size, 4); // ids 1, 2, 3, 4 (null skipped)
  assert.equal(index.byId.get('1').name, 'Logo.png');
  assert.equal(index.byId.get('2').id, 2);
  assert.equal(index.byId.get('3').name, 'Banner');
});

test('resolveAsset: exact id only, never by name (no copying another asset URL)', () => {
  const index = indexAssets([
    { id: 10, name: 'Hero' },
    { id: 11, name: 'Footer' },
  ]);
  assert.equal(resolveAsset(index, { id: '10' }).id, 10);
  assert.equal(resolveAsset(index, { id: '10', rowName: 'Footer' }).id, 10);
  assert.equal(resolveAsset(index, { id: '999', rowName: 'Footer' }), null); // stale id: no name fallback
  assert.equal(resolveAsset(index, { id: '', rowName: 'Hero' }), null);
  assert.equal(resolveAsset(index, {}), null);
  assert.equal(resolveAsset(undefined, { id: '10' }), null);
});

test('mapCreativePreviews: JSON-string config, clamped to the settings schema range', () => {
  const { values, notes } = mapCreativePreviews({
    config: JSON.stringify({ thumbSize: 200, hoverSize: 5000, hoverDelay: -10, rowHeight: 999999 }),
  });
  assert.equal(values.thumbSize, 200);
  assert.equal(values.hoverSize, 1200); // clamped to max
  assert.equal(values.hoverDelay, 0); // clamped to min
  assert.equal(values.rowHeight, 420); // clamped to max
  assert.deepEqual(notes, []);
});

test('mapCreativePreviews: already-parsed object, partial config, non-numeric value skipped', () => {
  const { values, notes } = mapCreativePreviews({ config: { thumbSize: 'nope', hoverSize: 700 } });
  assert.equal(values.thumbSize, undefined);
  assert.equal(values.hoverSize, 700);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /thumbSize/);
});

test('mapCreativePreviews: never throws on garbage, and is a no-op when config is absent', () => {
  assert.deepEqual(mapCreativePreviews(null), { values: {}, notes: [] });
  assert.deepEqual(mapCreativePreviews({}), { values: {}, notes: [] });
  const { values, notes } = mapCreativePreviews({ config: '{not json' });
  assert.deepEqual(values, {});
  assert.equal(notes.length, 1);
});

test('meta: legacy name matches the userscript, defaults match its DEFAULT_CONFIG', () => {
  assert.deepEqual(meta.legacy, ['Iterable Creative Library - Bigger Previews']);
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f.default]));
  assert.equal(byKey.thumbSize, 120);
  assert.equal(byKey.hoverSize, 600);
  assert.equal(byKey.hoverDelay, 150);
  assert.equal(byKey.rowHeight, 140);
  assert.equal(byKey.hoverPreview, true);
});
