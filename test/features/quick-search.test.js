import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_GRADIENTS, darken, expandHex, gradientCss, makeTag, nextPresetIndex, normaliseSortOrder,
  normaliseTag, normaliseTags, parseBool, reorderTags, sortTags, hasLabel, mergeTagEdits, MAX_TAG_LABEL,
} from '../../src/features/quick-search/tags.js';
import importer, { mapQuickSearch } from '../../src/features/quick-search/import.js';
import meta from '../../src/features/quick-search/meta.js';
import { decodeStorage } from '../../src/options/importer/decode.js';
import { mergeValues } from '../../src/core/settings.js';

const g = (start, end) => ({ start, end });

test('nine presets from the userscript', () => {
  assert.equal(PRESET_GRADIENTS.length, 9);
  assert.deepEqual(PRESET_GRADIENTS[0], g('#10b981', '#047857'));
  assert.deepEqual(PRESET_GRADIENTS[8], g('#ef4444', '#b91c1c'));
});

test('darken / expandHex', () => {
  assert.equal(darken('#ffffff', 0.5), '#808080');
  assert.equal(darken('#000000', 0.3), '#000000');
  assert.equal(darken('#abc', 0), '#aabbcc');
  assert.equal(darken('#B4621A', 0.3), '#7e4512');
  assert.equal(darken('red'), null);
  assert.equal(darken('#12345'), null);
  assert.equal(expandHex(' #ABC '), '#aabbcc');
});

test('gradientCss only emits validated colours', () => {
  assert.equal(gradientCss(g('#111111', '#222222')), 'linear-gradient(135deg, #111111 0%, #222222 100%)');
  assert.match(gradientCss(g('red); background:url(x)', '#000')), /#10b981/);
});

test('normaliseTag: new, old single-colour, and junk shapes', () => {
  assert.deepEqual(
    normaliseTag({ id: 'a', label: ' News ', colorGradient: g('#0D8A7E', '#1aa592'), timestamp: 5, extra: 1 }),
    { id: 'a', label: 'News', colorGradient: g('#0d8a7e', '#1aa592'), timestamp: 5 });
  assert.deepEqual(
    normaliseTag({ id: 7, label: 'Promo', color: '#b4621a', timestamp: '9' }),
    { id: '7', label: 'Promo', colorGradient: g('#b4621a', '#7e4512'), timestamp: 9 });
  // A non-hex colour falls back to the preset for the tag's position.
  assert.deepEqual(normaliseTag({ id: 'x', label: 'X', color: 'tomato' }, 3).colorGradient, PRESET_GRADIENTS[3]);
  assert.deepEqual(normaliseTag({ id: 'x', label: 'X', colorGradient: { start: '#fff' } }, 1).colorGradient, PRESET_GRADIENTS[1]);
  assert.equal(normaliseTag({ id: 'x', label: '   ' }), null);
  assert.equal(normaliseTag(null), null);
  assert.equal(normaliseTag('Newsletter'), null);
  assert.equal(normaliseTag([1]), null);
  assert.equal(normaliseTag({ label: 'x' }).timestamp, 0);
});

test('normaliseTags: drops junk, fills and de-duplicates ids', () => {
  const out = normaliseTags([{ id: 'a', label: 'A' }, null, { label: 'B' }, { id: 'a', label: 'C' }, { id: 'a', label: '' }]);
  assert.deepEqual(out.map((t) => [t.id, t.label]), [['a', 'A'], ['tag-3', 'B'], ['a-2', 'C']]);
  assert.deepEqual(normaliseTags('nope'), []);
  assert.deepEqual(normaliseTags(undefined), []);
});

test('sortTags', () => {
  const tags = [
    { id: '1', label: 'beta', timestamp: 2 },
    { id: '2', label: 'Alpha', timestamp: 3 },
    { id: '3', label: 'gamma', timestamp: 1 },
  ];
  assert.deepEqual(sortTags(tags, 'custom').map((t) => t.id), ['1', '2', '3']);
  assert.deepEqual(sortTags(tags, 'alpha').map((t) => t.id), ['2', '1', '3']);
  assert.deepEqual(sortTags(tags, 'recent').map((t) => t.id), ['2', '1', '3']);
  assert.deepEqual(sortTags(tags, 'bogus').map((t) => t.id), ['1', '2', '3']);
  assert.deepEqual(tags.map((t) => t.id), ['1', '2', '3'], 'input untouched');
  assert.equal(normaliseSortOrder('alpha'), 'alpha');
  assert.equal(normaliseSortOrder('x'), 'custom');
});

test('reorderTags ignores unknown ids and keeps missing tags at the end', () => {
  const tags = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(reorderTags(tags, ['c', 'zz', 'a']).map((t) => t.id), ['c', 'a', 'b']);
});

test('makeTag / nextPresetIndex / hasLabel', () => {
  const existing = [{ id: 't' + (1000).toString(36) }];
  const t = makeTag('  Welcome ', null, existing, 1000);
  assert.equal(t.label, 'Welcome');
  assert.notEqual(t.id, existing[0].id);
  assert.equal(t.timestamp, 1000);
  assert.deepEqual(t.colorGradient, PRESET_GRADIENTS[1]);
  assert.equal(nextPresetIndex(new Array(10).fill({})), 1);
  assert.ok(hasLabel([{ label: 'Promo' }], ' promo '));
  assert.ok(!hasLabel([{ label: 'Promo' }], ''));
});

test('parseBool', () => {
  assert.equal(parseBool(true), true);
  assert.equal(parseBool('bfalse', true), false);
  assert.equal(parseBool('btrue'), true);
  assert.equal(parseBool('false', true), false);
  assert.equal(parseBool(0, true), false);
  assert.equal(parseBool({}, true), true);
});

test('import: mixed old/new tags from a decoded storage export', () => {
  const storage = decodeStorage({
    iterableQuickSearchCollapsed: 'btrue',
    iterableQuickSearchSettings: 's{"sortOrder":"alpha","other":1}',
    iterableQuickSearchTags: 's' + JSON.stringify([
      { id: 't1', label: 'Newsletter', colorGradient: g('#0d8a7e', '#1aa592'), timestamp: 2 },
      { id: 't2', label: 'Promo', color: '#b4621a', timestamp: 1, legacyField: true },
      { id: 't3', label: '' },
    ]),
  });
  const r = importer.map(storage);
  assert.deepEqual(r.values.tags, [
    { id: 't1', label: 'Newsletter', colorGradient: g('#0d8a7e', '#1aa592'), timestamp: 2 },
    { id: 't2', label: 'Promo', colorGradient: g('#b4621a', '#7e4512'), timestamp: 1 },
  ]);
  assert.equal(r.values.sortOrder, 'alpha');
  assert.deepEqual(r.state, { collapsed: true });
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[0], /Converted 1 tag /);
  assert.match(r.notes[1], /Skipped 1 tag /);
});

test('import: already-parsed values, absent settings, raw "bfalse" collapsed', () => {
  const r = mapQuickSearch({
    iterableQuickSearchTags: [{ id: 'x', label: 'Promo', color: '#abc', timestamp: 1 }],
    iterableQuickSearchCollapsed: 'bfalse',
  });
  assert.deepEqual(r.values.tags[0].colorGradient, g('#aabbcc', '#77838f'));
  assert.equal('sortOrder' in r.values, false);
  assert.deepEqual(r.state, { collapsed: false });
});

test('import: decoded boolean false, bad JSON, bad sort order, empty storage', () => {
  assert.deepEqual(mapQuickSearch({ iterableQuickSearchCollapsed: false }).state, { collapsed: false });
  const bad = mapQuickSearch({ iterableQuickSearchTags: '[{not json', iterableQuickSearchSettings: '{"sortOrder":"weird"}' });
  assert.equal('tags' in bad.values, false);
  assert.equal('sortOrder' in bad.values, false);
  assert.equal(bad.notes.length, 1);
  assert.deepEqual(mapQuickSearch({}), { values: {}, state: {}, notes: [] });
  assert.deepEqual(mapQuickSearch(undefined), { values: {}, state: {}, notes: [] });
  assert.deepEqual(mapQuickSearch({ iterableQuickSearchTags: '[]' }).values, { tags: [] });
});

test('import: the synthetic Tampermonkey fixture', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../fixtures/tm/Iterable Template Quick Search.storage.json', import.meta.url), 'utf8'));
  const r = importer.map(decodeStorage(raw.data));
  assert.deepEqual(r.values.tags.map((t) => t.label), ['Newsletter', 'Promo']);
  assert.equal(r.values.tags[1].colorGradient.start, '#b4621a');
  assert.deepEqual(r.state, { collapsed: false });
});

test('import script name matches meta.legacy', () => {
  assert.deepEqual(importer.scripts, meta.legacy);
});

test('meta: defaults resolve, hidden fields, imported values survive mergeValues', () => {
  assert.deepEqual(mergeValues(meta, undefined), { tags: [], sortOrder: 'custom' });
  assert.ok(meta.settings.every((f) => f.hidden));
  const r = mapQuickSearch({ iterableQuickSearchTags: '[{"id":"a","label":"A","color":"#000"}]', iterableQuickSearchSettings: '{"sortOrder":"recent"}' });
  const v = mergeValues(meta, r.values);
  assert.equal(v.sortOrder, 'recent');
  assert.equal(v.tags[0].label, 'A');
});

// ── Editor saves merge by id ────────────────────────────────────────────

const tg = (id, label) => ({ id, label, colorGradient: g('#000000', '#111111'), timestamp: 1 });

test('mergeTagEdits keeps a tag saved from the page while the editor was open', () => {
  const base = [tg('a', 'A'), tg('b', 'B')];
  const latest = [tg('a', 'A'), tg('b', 'B'), tg('p', 'From page')];
  // Editor renamed b and deleted a.
  const local = [tg('b', 'B2')];
  assert.deepEqual(mergeTagEdits(base, latest, local), [tg('b', 'B2'), tg('p', 'From page')]);
});

test('mergeTagEdits: editor adds and reorders win; untouched tags take the latest copy', () => {
  const base = [tg('a', 'A'), tg('b', 'B')];
  const latest = [tg('a', 'A (renamed elsewhere)'), tg('b', 'B')];
  const local = [tg('b', 'B'), tg('a', 'A'), tg('n', 'New')];
  assert.deepEqual(mergeTagEdits(base, latest, local), [tg('b', 'B'), tg('a', 'A (renamed elsewhere)'), tg('n', 'New')]);
  // Deleted elsewhere and untouched here: stays deleted.
  assert.deepEqual(mergeTagEdits(base, [tg('b', 'B')], [tg('a', 'A'), tg('b', 'B')]), [tg('b', 'B')]);
  // No concurrent change: the editor's list as is.
  assert.deepEqual(mergeTagEdits(base, base, local), local);
});

test('tag labels are capped', () => {
  const long = 'x'.repeat(MAX_TAG_LABEL + 10);
  assert.equal(normaliseTag({ id: 'a', label: long }).label.length, MAX_TAG_LABEL);
  assert.equal(makeTag(long, null, [], 1).label.length, MAX_TAG_LABEL);
  const r = mapQuickSearch({ iterableQuickSearchTags: JSON.stringify([{ id: 'a', label: long }]) });
  assert.equal(r.values.tags[0].label.length, MAX_TAG_LABEL);
  assert.ok(r.notes.some((n) => /Shortened 1 tag label/.test(n)));
});
