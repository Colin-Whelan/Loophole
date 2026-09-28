import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeQuickLinkUrl, validateQuickLinkUrl, normalizeQuickLink, quickLinkSlug,
} from '../../src/features/quicklinks/links.js';
import { mapQuicklinks } from '../../src/features/quicklinks/import.js';
import meta from '../../src/features/quicklinks/meta.js';

// ── isSafeQuickLinkUrl / validateQuickLinkUrl ──────────────────────────────

test('isSafeQuickLinkUrl accepts relative paths and https URLs', () => {
  assert.equal(isSafeQuickLinkUrl('/lists'), true);
  assert.equal(isSafeQuickLinkUrl('/users/lookup'), true);
  assert.equal(isSafeQuickLinkUrl('https://example.com/help'), true);
});

test('isSafeQuickLinkUrl rejects dangerous or protocol-relative schemes', () => {
  assert.equal(isSafeQuickLinkUrl('javascript:alert(1)'), false);
  assert.equal(isSafeQuickLinkUrl('JavaScript:alert(1)'), false);
  assert.equal(isSafeQuickLinkUrl('data:text/html,<script>1</script>'), false);
  assert.equal(isSafeQuickLinkUrl('//evil.example.com/'), false);
  assert.equal(isSafeQuickLinkUrl('http://example.com'), false); // http, not https
  assert.equal(isSafeQuickLinkUrl('ftp://example.com'), false);
  assert.equal(isSafeQuickLinkUrl(''), false);
  assert.equal(isSafeQuickLinkUrl('lists'), false); // no leading slash, no scheme
  assert.equal(isSafeQuickLinkUrl(undefined), false);
});

test('validateQuickLinkUrl: null for empty (required handles it) and for safe urls, a message otherwise', () => {
  assert.equal(validateQuickLinkUrl(''), null);
  assert.equal(validateQuickLinkUrl('/lists'), null);
  assert.equal(validateQuickLinkUrl('https://example.com'), null);
  assert.match(validateQuickLinkUrl('javascript:alert(1)'), /relative path/);
});

// ── normalizeQuickLink ──────────────────────────────────────────────────────

test('normalizeQuickLink trims and passes through a valid item', () => {
  assert.deepEqual(normalizeQuickLink({ name: ' Lists ', url: ' /lists ' }), { name: 'Lists', url: '/lists' });
});

test('normalizeQuickLink drops items with no name or an unsafe url', () => {
  assert.equal(normalizeQuickLink({ name: '', url: '/lists' }), null);
  assert.equal(normalizeQuickLink({ name: 'Bad', url: 'javascript:alert(1)' }), null);
  assert.equal(normalizeQuickLink(null), null);
  assert.equal(normalizeQuickLink('not an object'), null);
});

// ── quickLinkSlug ────────────────────────────────────────────────────────────

test('quickLinkSlug', () => {
  assert.equal(quickLinkSlug('User Lookup'), 'user-lookup');
  assert.equal(quickLinkSlug('  Lists  '), 'lists');
  assert.equal(quickLinkSlug('Ünïcode!'), 'ncode');
  assert.equal(quickLinkSlug(''), 'link');
});

// ── import.js (legacy "Custom Quicklinks" mapper) ───────────────────────────

test('mapQuicklinks: no storage → notes only, no values', () => {
  const r = mapQuicklinks({});
  assert.deepEqual(r.values, {});
  assert.match(r.notes[0], /No saved settings/);
});

test('mapQuicklinks: JSON-string storage (Tampermonkey shape) is parsed', () => {
  const storage = { iterableQuicklinks: JSON.stringify([{ urlName: 'Lists', url: '/lists' }, { urlName: 'Users', url: '/users/lookup' }]) };
  const r = mapQuicklinks(storage);
  assert.deepEqual(r.values.links, [{ name: 'Lists', url: '/lists' }, { name: 'Users', url: '/users/lookup' }]);
});

test('mapQuicklinks: already-decoded array storage works too', () => {
  const storage = { iterableQuicklinks: [{ urlName: 'Lists', url: '/lists' }] };
  const r = mapQuicklinks(storage);
  assert.deepEqual(r.values.links, [{ name: 'Lists', url: '/lists' }]);
});

test('mapQuicklinks: entries missing a name or url are dropped and noted', () => {
  const storage = { iterableQuicklinks: [{ urlName: '', url: '/x' }, { urlName: 'Y' }, { urlName: 'Lists', url: '/lists' }] };
  const r = mapQuicklinks(storage);
  assert.deepEqual(r.values.links, [{ name: 'Lists', url: '/lists' }]);
  assert.ok(r.notes.some((n) => /Skipped 2/.test(n)));
});

test('mapQuicklinks: unreadable storage is reported, not thrown', () => {
  const r = mapQuicklinks({ iterableQuicklinks: 'not json but not an array either' });
  assert.deepEqual(r.values, {});
  assert.match(r.notes[0], /could not be read/);
});

test('mapQuicklinks never throws on garbage input', () => {
  assert.doesNotThrow(() => mapQuicklinks(null));
  assert.doesNotThrow(() => mapQuicklinks({ iterableQuicklinks: 42 }));
  assert.doesNotThrow(() => mapQuicklinks({ iterableQuicklinks: [null, 1, 'x', {}] }));
});

// ── meta.js shape ────────────────────────────────────────────────────────────

test('meta: ids and defaults', () => {
  assert.equal(meta.id, 'quicklinks');
  assert.equal(meta.frame, 'top');
  const links = meta.settings.find((s) => s.key === 'links');
  assert.equal(links.type, 'objectList');
  assert.deepEqual(links.default, [{ name: 'Lists', url: '/lists' }, { name: 'User lookup', url: '/users/lookup' }]);
  const openInNewTab = meta.settings.find((s) => s.key === 'openInNewTab');
  assert.equal(openInNewTab.default, false);
});
