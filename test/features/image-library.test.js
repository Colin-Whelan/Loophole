import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewOptions, perPageNumber, formatFileSize, formatDimensions, splitFileName, finalAssetName,
  folderEntries, filterEntries, paginate, pageWindow, countLabel, spatialMove, partitionUploadFiles,
  lastFolderStateName, legacyLastFolderStateNames, normaliseFolderId, uploadOutcome, uploadSummary, LEGACY_FOLDER_HINT,
  pinnedProjectError,
} from '../../src/features/image-library/logic.js';
import importer, { mapImageLibrary } from '../../src/features/image-library/import.js';
import meta from '../../src/features/image-library/meta.js';
import { mergeValues } from '../../src/core/settings.js';
import { isValidStateName, projectSlot } from '../../src/core/state.js';
import { RESTORE_NAME_RE } from '../../src/options/importer/backup.js';
import { normalizeAssetFolder } from '../../src/lib/iterable/assets.js';

test('meta: id, route, action and settings schema', () => {
  assert.equal(meta.id, 'image-library');
  assert.deepEqual(meta.legacy, ['Iterable Image Path Selector']);
  assert.ok(meta.routes.some((r) => r.test('/templates/editor?templateId=12')));
  assert.ok(!meta.routes.some((r) => r.test('/campaigns/5')));
  assert.deepEqual(meta.actions.map((a) => a.id), ['open']);
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), ['itemsPerPage', 'skipEditStep', 'sortBy', 'sortDirection']);
  assert.equal(byKey.itemsPerPage.default, '30');
  assert.deepEqual(byKey.itemsPerPage.options.map((o) => o.value), ['20', '30', '50', '100']);
  assert.equal(byKey.sortBy.default, 'UpdatedAt');
  assert.equal(byKey.sortDirection.default, 'Descending');
  assert.equal(byKey.skipEditStep.default, false);
  // Every option value is a string, as the options page's <select> reads them back.
  for (const f of meta.settings.filter((x) => x.type === 'select')) {
    assert.ok(f.options.every((o) => typeof o.value === 'string'));
  }
});

test('viewOptions / perPageNumber fall back to defaults', () => {
  assert.deepEqual(viewOptions({}), { sortBy: 'UpdatedAt', sortDirection: 'Descending', perPage: 30, skipEditStep: false });
  assert.deepEqual(viewOptions({ sortBy: 'Name', sortDirection: 'Ascending', itemsPerPage: '100', skipEditStep: true }),
    { sortBy: 'Name', sortDirection: 'Ascending', perPage: 100, skipEditStep: true });
  assert.deepEqual(viewOptions({ sortBy: 'Bogus', sortDirection: 'up', itemsPerPage: '7', skipEditStep: 'yes' }),
    { sortBy: 'UpdatedAt', sortDirection: 'Descending', perPage: 30, skipEditStep: false });
  assert.equal(perPageNumber(50), 50);
  assert.equal(perPageNumber('20'), 20);
  assert.equal(perPageNumber(undefined), 30);
  assert.equal(perPageNumber('abc'), 30);
  // Resolved through the settings schema, as ctx.settings would be.
  const resolved = mergeValues(meta, { itemsPerPage: '50' });
  assert.equal(viewOptions(resolved).perPage, 50);
});

test('formatFileSize / formatDimensions', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(812), '812 B');
  assert.equal(formatFileSize(1023), '1023 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatFileSize(null), '');
  assert.equal(formatFileSize(NaN), '');
  assert.equal(formatFileSize(-1), '');
  assert.equal(formatDimensions(600, 400), '600 × 400');
  assert.equal(formatDimensions(null, 400), '');
});

test('splitFileName / finalAssetName', () => {
  assert.deepEqual(splitFileName('hero.final.png'), { base: 'hero.final', ext: '.png' });
  assert.deepEqual(splitFileName('noext'), { base: 'noext', ext: '' });
  assert.deepEqual(splitFileName('.hidden'), { base: '.hidden', ext: '' });
  assert.equal(finalAssetName(' Spring hero ', '.jpg', 'IMG_1.jpg'), 'Spring hero.jpg');
  assert.equal(finalAssetName('   ', '.jpg', 'IMG_1.jpg'), 'IMG_1.jpg');
  assert.equal(finalAssetName('logo', '', 'logo'), 'logo');
});

const sample = normalizeAssetFolder({
  id: 7, name: 'Spring',
  ancestors: [{ id: 1, name: '__root__' }, { id: 3, name: 'Campaigns' }],
  info: { count: 4 },
  content: [
    { __typename: 'AssetSubfolder', id: 11, name: 'Heroes' },
    { __typename: 'ImageAsset', id: 21, assetName: 'banner.png', url: 'https://cdn.example/b.png', width: 600, height: 200, size: 2048 },
    { __typename: 'AssetSubfolder', id: 12, name: 'Icons' },
    { __typename: 'ImageAsset', id: 22, assetName: 'Logo.svg', url: 'https://cdn.example/l.svg' },
  ],
});

test('folderEntries puts folders first; filterEntries is a case-insensitive substring match', () => {
  const entries = folderEntries(sample);
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.name}`), ['folder:Heroes', 'folder:Icons', 'image:banner.png', 'image:Logo.svg']);
  assert.equal(entries[2].image.url, 'https://cdn.example/b.png');
  assert.deepEqual(filterEntries(entries, ' LO ').map((e) => e.name), ['Logo.svg']);
  assert.deepEqual(filterEntries(entries, 'n').map((e) => e.name), ['Icons', 'banner.png']);
  assert.equal(filterEntries(entries, '').length, 4);
  assert.deepEqual(folderEntries(null), []);
  assert.equal(countLabel(entries), '2 folders · 2 images');
  assert.equal(countLabel(entries.slice(3)), '1 image');
  assert.equal(countLabel([]), '');
});

test('paginate clamps the page', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(paginate(items, 1, 20).items, items.slice(0, 20));
  const last = paginate(items, 3, 20);
  assert.deepEqual([last.page, last.totalPages, last.items.length], [3, 3, 5]);
  assert.equal(paginate(items, 9, 20).page, 3);
  assert.equal(paginate(items, 0, 20).page, 1);
  assert.deepEqual(paginate([], 4, 20), { page: 1, totalPages: 0, items: [] });
});

test('pageWindow matches the script: 5 around the current page, first/last with gaps', () => {
  assert.deepEqual(pageWindow(1, 1), []);
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(1, 10), [1, 2, 3, 4, 5, 'gap', 10]);
  assert.deepEqual(pageWindow(6, 10), [1, 'gap', 4, 5, 6, 7, 8, 'gap', 10]);
  assert.deepEqual(pageWindow(10, 10), [1, 'gap', 6, 7, 8, 9, 10]);
  assert.deepEqual(pageWindow(4, 6), [1, 2, 3, 4, 5, 6]);
});

test('spatialMove across two grids of different widths', () => {
  // Folder row: 3 tiles at y=0 (width 100); image rows: 2 per row at y=60 and y=260 (width 150).
  const rects = [
    { x: 0, y: 0, w: 100, h: 40 }, { x: 110, y: 0, w: 100, h: 40 }, { x: 220, y: 0, w: 100, h: 40 },
    { x: 0, y: 60, w: 150, h: 190 }, { x: 160, y: 60, w: 150, h: 190 },
    { x: 0, y: 260, w: 150, h: 190 },
  ];
  assert.equal(spatialMove(rects, 0, 'ArrowRight'), 1);
  assert.equal(spatialMove(rects, 5, 'ArrowRight'), 5);
  assert.equal(spatialMove(rects, 0, 'ArrowLeft'), 0);
  assert.equal(spatialMove(rects, 2, 'ArrowDown'), 4); // centre 270 → nearest is x-centre 235
  assert.equal(spatialMove(rects, 0, 'ArrowDown'), 3);
  assert.equal(spatialMove(rects, 4, 'ArrowDown'), 5);
  assert.equal(spatialMove(rects, 5, 'ArrowDown'), 5);
  assert.equal(spatialMove(rects, 4, 'ArrowUp'), 2);
  assert.equal(spatialMove(rects, 1, 'ArrowUp'), 1);
  assert.equal(spatialMove(rects, 3, 'End'), 5);
  assert.equal(spatialMove(rects, 3, 'Home'), 0);
  assert.equal(spatialMove(rects, 3, 'Enter'), 3);
  assert.equal(spatialMove([], 0, 'ArrowDown'), -1);
});

test('partitionUploadFiles keeps only PNG/JPEG/GIF/WEBP/SVG', () => {
  const files = [
    { name: 'a.png', type: 'image/png' }, { name: 'b.JPG', type: 'image/jpeg' }, { name: 'c.svg', type: 'image/svg+xml' },
    { name: 'd.pdf', type: 'application/pdf' }, { name: 'e.bmp', type: 'image/bmp' }, { name: 'f', type: '' }, null,
  ];
  const { accepted, rejected } = partitionUploadFiles(files);
  assert.deepEqual(accepted.map((f) => f.name), ['a.png', 'b.JPG', 'c.svg']);
  assert.equal(rejected.length, 4);
  assert.deepEqual(partitionUploadFiles(undefined), { accepted: [], rejected: [] });
});

test('lastFolderStateName / normaliseFolderId', () => {
  assert.equal(lastFolderStateName('us:18244'), 'lastFolder:' + projectSlot('us:18244'));
  assert.equal(lastFolderStateName('eu:name:My Project'), 'lastFolder:' + projectSlot('eu:name:My Project'));
  assert.ok(isValidStateName(lastFolderStateName('eu:name:My Project')));
  assert.ok(RESTORE_NAME_RE.test(lastFolderStateName('us:18244')), 'survives a backup restore');
  assert.ok(RESTORE_NAME_RE.test(lastFolderStateName('eu:name:My Project')), 'spaces no longer break a restore');
  assert.deepEqual(legacyLastFolderStateNames('eu:name:My Project'), ['lastFolder:eu:name:My Project']);
  assert.deepEqual(legacyLastFolderStateNames(null), []);
  assert.ok(RESTORE_NAME_RE.test(LEGACY_FOLDER_HINT));
  assert.equal(lastFolderStateName(null), null);
  assert.equal(lastFolderStateName(''), null);
  assert.equal(normaliseFolderId(42), 42);
  assert.equal(normaliseFolderId(' 42 '), 42);
  assert.equal(normaliseFolderId('12345678901234567890'), null); // > 19 digits
  assert.equal(normaliseFolderId('1234567890123456789'), '1234567890123456789'); // beyond 2^53: kept as text
  assert.equal(normaliseFolderId(0), null);
  assert.equal(normaliseFolderId(-3), null);
  assert.equal(normaliseFolderId(1.5), null);
  assert.equal(normaliseFolderId(null), null);
  assert.equal(normaliseFolderId('abc'), null);
  assert.equal(normaliseFolderId({ id: 3 }), null);
});

test('uploadOutcome / uploadSummary', () => {
  assert.deepEqual(uploadOutcome(null), { status: 'done', text: 'Uploaded', unknown: false });
  const net = uploadOutcome({ code: 'NETWORK', message: 'Image upload failed: network error' });
  assert.equal(net.unknown, true);
  assert.equal(uploadOutcome({ name: 'AbortError' }).unknown, true);
  const http = uploadOutcome({ code: 'HTTP', status: 413, message: 'Image upload failed: HTTP 413' });
  assert.deepEqual(http, { status: 'failed', text: 'Image upload failed: HTTP 413', unknown: false });
  assert.deepEqual(uploadSummary({ done: 3 }), { tone: 'ok', text: '3 images uploaded.' });
  assert.deepEqual(uploadSummary({ done: 1 }), { tone: 'ok', text: '1 image uploaded.' });
  assert.deepEqual(uploadSummary({ done: 2, failed: 1 }), { tone: 'warn', text: '2 uploaded, 1 failed.' });
  assert.deepEqual(uploadSummary({ done: 0, failed: 1, skipped: 4 }), { tone: 'bad', text: '0 uploaded, 1 failed, 4 not started.' });
});

test('import: decoded GM values, JSON strings and junk', () => {
  assert.deepEqual(importer.scripts, ['Iterable Image Path Selector']);
  const r = mapImageLibrary({
    iterableImageSelector_sortBy: 'Name',
    iterableImageSelector_sortDirection: '"Ascending"',
    iterableImageSelector_itemsPerPage: 50,
    iterableImageSelector_lastFolderId: 987,
  });
  assert.deepEqual(r.values, { sortBy: 'Name', sortDirection: 'Ascending', itemsPerPage: '50' });
  assert.deepEqual(r.state, { [LEGACY_FOLDER_HINT]: 987 });
  assert.equal(r.notes.length, 1);

  const s = mapImageLibrary({ iterableImageSelector_itemsPerPage: '100', iterableImageSelector_lastFolderId: '"321"' });
  assert.deepEqual(s.values, { itemsPerPage: '100' });
  assert.deepEqual(s.state, { [LEGACY_FOLDER_HINT]: 321 });

  // Root (null) last folder: nothing to remember, no note.
  const root = mapImageLibrary({ iterableImageSelector_lastFolderId: null });
  assert.deepEqual(root, { values: {}, state: {}, notes: [] });

  const bad = mapImageLibrary({
    iterableImageSelector_sortBy: 'Colour',
    iterableImageSelector_sortDirection: 5,
    iterableImageSelector_itemsPerPage: 25,
    iterableImageSelector_lastFolderId: 'o{not json',
  });
  assert.deepEqual(bad.values, {});
  assert.deepEqual(bad.state, {});
  assert.equal(bad.notes.length, 4);

  for (const junk of [undefined, null, 'x', 5, [], { __proto__: { a: 1 } }]) {
    assert.doesNotThrow(() => mapImageLibrary(junk));
  }
  // Imported values survive the settings schema.
  const merged = mergeValues(meta, r.values);
  assert.equal(merged.itemsPerPage, '50');
  assert.equal(merged.sortBy, 'Name');
});

test('pinnedProjectError: writes need the same, freshly confirmed project', async () => {
  const fake = ({ key = 'us:1', name = 'Sandbox', error = null, fail = false } = {}) => {
    const calls = [];
    return {
      calls,
      async refresh(o) { calls.push(o); if (fail) throw new Error('offline'); },
      current: () => (key ? { key, name } : null),
      error: () => error,
    };
  };
  const same = fake();
  assert.equal(await pinnedProjectError(same, 'us:1', 'uploaded'), null);
  assert.deepEqual(same.calls, [{ force: true }]);              // forced re-check, every time
  assert.match(await pinnedProjectError(fake({ key: 'us:2', name: 'Prod' }), 'us:1', 'uploaded'),
    /changed to "Prod".*nothing was uploaded/);
  for (const p of [fake({ error: new Error('x') }), fake({ key: null }), fake({ fail: true }), null, {}]) {
    assert.match(await pinnedProjectError(p, 'us:1', 'created'), /Couldn't confirm.*nothing was created/);
  }
  // Never pinned (project unknown when the library opened and no folder loaded yet) → refused.
  assert.match(await pinnedProjectError(fake(), null, 'uploaded'), /Couldn't confirm/);
});
