import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnippetSyntax, timeAgo, filterSnippets, normaliseSnippet, normaliseSnippets, toMillis,
  cacheStateName, legacyCacheStateNames, makeCache, readCache, isStale, incompleteText, previewDoc, EDITOR_ROUTE, EDITOR_ANCHOR,
} from '../../src/features/snippets/logic.js';
import meta from '../../src/features/snippets/meta.js';
import { RESTORE_NAME_RE } from '../../src/options/importer/backup.js';
import { projectSlot } from '../../src/core/state.js';

const MIN = 60000;

test('meta: id, legacy name, action and settings', () => {
  assert.equal(meta.id, 'snippets');
  assert.equal(meta.frame, 'top');
  assert.deepEqual(meta.legacy, ['Iterable Snippet Viewer']);
  assert.deepEqual(meta.actions.map((a) => a.id), ['open']);
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f]));
  assert.equal(byKey.showInNavbar.type, 'boolean');
  assert.equal(byKey.showInNavbar.default, true);
  assert.equal(byKey.cacheMinutes.type, 'number');
  assert.equal(byKey.cacheMinutes.default, 60);
  assert.equal(byKey.openShortcut.type, 'shortcut');
  assert.equal(byKey.openShortcut.default, '');
  assert.ok(meta.routes.some((r) => r.test('/templates/editor?templateId=1')));
  assert.ok(meta.routes.some((r) => r.test('/lists')));
});

test('buildSnippetSyntax: exactly the script\'s triple-brace form', () => {
  assert.equal(buildSnippetSyntax({ name: 'footer' }), '{{{ snippet "footer" }}}');
  assert.equal(buildSnippetSyntax({ name: 'footer', positionalParameters: [] }), '{{{ snippet "footer" }}}');
  assert.equal(buildSnippetSyntax({ name: 'cta', positionalParameters: ['url', 'label'] }), '{{{ snippet "cta" url label }}}');
});

test('timeAgo', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 30_000, now), 'just now');
  assert.equal(timeAgo(now - 5 * MIN, now), '5m ago');
  assert.equal(timeAgo(now - 3 * 60 * MIN, now), '3h ago');
  assert.equal(timeAgo(now - 50 * 60 * MIN, now), '2d ago');
});

test('filterSnippets: name, description, parameters; case-insensitive', () => {
  const list = normaliseSnippets([
    { id: 1, name: 'Header', description: 'Top banner', positionalParameters: ['logoUrl'] },
    { id: 2, name: 'footer', description: '', positionalParameters: [] },
    { id: 3, name: 'cta', description: 'Big BUTTON', positionalParameters: ['href'] },
  ]);
  assert.deepEqual(filterSnippets(list, '').map((s) => s.id), ['1', '2', '3']);
  assert.deepEqual(filterSnippets(list, '  ').map((s) => s.id), ['1', '2', '3']);
  assert.deepEqual(filterSnippets(list, 'FOOT').map((s) => s.id), ['2']);
  assert.deepEqual(filterSnippets(list, 'button').map((s) => s.id), ['3']);
  assert.deepEqual(filterSnippets(list, 'logo').map((s) => s.id), ['1']);
  assert.deepEqual(filterSnippets(list, 'zzz'), []);
  assert.notEqual(filterSnippets(list, ''), list, 'returns a copy');
});

test('normaliseSnippet: keeps what the viewer needs, drops the rest', () => {
  const s = normaliseSnippet({
    id: 42, name: 'hero', content: '<p>Hi</p>', description: null,
    positionalParameters: ['a', 7, '', 'b'], updatedAt: '2026-01-02T03:04:05Z', createdAt: 1700000000000,
    updatedBy: 'someone@example.com', updatedByUser: { fullName: 'Sam Example', avatarUrl: 'x' },
    creatorUser: { fullName: 'C' }, projectId: 9,
  });
  assert.deepEqual(s, {
    id: '42', name: 'hero', description: '', content: '<p>Hi</p>', positionalParameters: ['a', 'b'],
    updatedAt: Date.parse('2026-01-02T03:04:05Z'), createdAt: 1700000000000, updatedBy: 'Sam Example',
  });
  assert.equal(normaliseSnippet({ name: 'x', updatedBy: 'u1' }).updatedBy, 'u1');
  assert.equal(normaliseSnippet({ name: 'x' }).id, 'x');
  assert.equal(normaliseSnippet({ id: 1 }), null);
  assert.equal(normaliseSnippet(null), null);
  assert.deepEqual(normaliseSnippets('nope'), []);
});

test('toMillis', () => {
  assert.equal(toMillis(5), 5);
  assert.equal(toMillis('1700000000000'), 1700000000000);
  assert.equal(toMillis('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(toMillis('garbage'), null);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(NaN), null);
});

test('cacheStateName: per project (projectSlot), backup-safe; legacy name for migration', () => {
  assert.equal(cacheStateName('us:18244'), 'cache:' + projectSlot('us:18244'));
  assert.notEqual(cacheStateName('us:1'), cacheStateName('eu:1'));
  const odd = cacheStateName('us:name:My Project/ü');
  assert.match(odd, RESTORE_NAME_RE);
  assert.notEqual(odd, cacheStateName('us:name:My_Project__'));
  assert.ok(cacheStateName('us:name:' + 'x'.repeat(300)).length <= 128);
  assert.equal(cacheStateName(''), '');
  assert.deepEqual(legacyCacheStateNames('us:18244'), ['cache:us:18244']);
  assert.deepEqual(legacyCacheStateNames('us:name:My Project/ü'), ['cache:us:name:My_Project__']);
});

test('makeCache / readCache round trip, and bad stored values', () => {
  const now = 1_700_000_000_000;
  const c = makeCache({ snippets: [{ id: 1, name: 'a', content: 'x' }, { nope: true }], total: 5, complete: false }, now);
  assert.equal(c.v, 1);
  assert.equal(c.fetchedAt, now);
  assert.equal(c.complete, false);
  assert.equal(c.total, 5);
  assert.equal(c.snippets.length, 1);
  assert.deepEqual(readCache(JSON.parse(JSON.stringify(c))), c);
  assert.equal(makeCache({ snippets: [], total: null }).complete, true);
  assert.equal(makeCache({ snippets: [], total: 'x' }).total, null);

  assert.equal(readCache(null), null);
  assert.equal(readCache('x'), null);
  assert.equal(readCache({ v: 2, fetchedAt: now, snippets: [] }), null);
  assert.equal(readCache({ v: 1, snippets: [] }), null);
  assert.equal(readCache({ v: 1, fetchedAt: now, snippets: {} }), null);
  // The script's localStorage shape isn't ours: ignored rather than misread.
  assert.equal(readCache({ fetchedAt: now, snippets: [] }), null);
});

test('isStale: older than cacheMinutes; 0 never auto-refreshes', () => {
  const now = 1_700_000_000_000;
  const cache = { fetchedAt: now - 61 * MIN };
  assert.equal(isStale(cache, 60, now), true);
  assert.equal(isStale({ fetchedAt: now - 59 * MIN }, 60, now), false);
  assert.equal(isStale(cache, 0, now), false);
  assert.equal(isStale(cache, 'x', now), false);
  assert.equal(isStale(null, 60, now), true);
});

test('incompleteText', () => {
  assert.equal(incompleteText(null), '');
  assert.equal(incompleteText({ complete: true, snippets: [], total: null }), '');
  assert.equal(incompleteText({ complete: false, snippets: [1, 2], total: 1500 }),
    'Showing 2 of 1,500 snippets: the list is incomplete.');
  assert.equal(incompleteText({ complete: false, snippets: [1, 2], total: null }),
    'Showing 2 snippets: the list may be incomplete.');
});

test('previewDoc: wraps content with a script-blocking CSP', () => {
  const doc = previewDoc('<b>Hi</b><script>alert(1)</script>');
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.match(doc, /Content-Security-Policy" content="script-src 'none'/);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<b>Hi</b>'));
  assert.ok(doc.includes('<b>Hi</b><script>alert(1)</script></body>'));
  assert.ok(previewDoc(null).includes('<body></body>'));
});

test('editor placement rule: the script\'s route and anchor', () => {
  assert.ok(EDITOR_ROUTE.test('/templates/editor?templateId=12'));
  assert.ok(EDITOR_ROUTE.test('/templates/editor/'));
  assert.ok(!EDITOR_ROUTE.test('/templates/editorial'));
  assert.ok(!EDITOR_ROUTE.test('/templates'));
  assert.equal(EDITOR_ANCHOR, '[data-test="basic-select-email-editor-view"]');
});
