import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aceBindKey, BIND_KEY_RE, fontStack, COMMAND_NAMES, FONT_FAMILIES } from '../../src/features/live-preview/commands.js';
import { parseSnippetBody, offsetToPos } from '../../src/features/live-preview/snippet.js';
import * as L from '../../src/features/live-preview/logic.js';
import importer, { mapLivePreview, legacyShortcut } from '../../src/features/live-preview/import.js';
import meta from '../../src/features/live-preview/meta.js';
import { mergeValues, defaultValues } from '../../src/core/settings.js';
import { validateObjectList } from '../../src/core/schema.js';

// All data synthetic.

test('aceBindKey: Mod → Ctrl / Command, arrows and named keys in Ace spelling', () => {
  assert.deepEqual(aceBindKey('Mod+D'), { win: 'Ctrl-D', mac: 'Command-D' });
  assert.deepEqual(aceBindKey('Mod+Shift+K'), { win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' });
  assert.deepEqual(aceBindKey('Alt+ArrowUp'), { win: 'Alt-Up', mac: 'Option-Up' });
  assert.deepEqual(aceBindKey('Ctrl+Alt+Enter'), { win: 'Ctrl-Alt-Return', mac: 'Ctrl-Option-Return' });
  assert.deepEqual(aceBindKey('Mod+/'), { win: 'Ctrl-/', mac: 'Command-/' });
  assert.deepEqual(aceBindKey('Mod+-'), { win: 'Ctrl--', mac: 'Command--' });
  assert.equal(aceBindKey(''), null);
  assert.equal(aceBindKey('nonsense+++'), null);
});

test('BIND_KEY_RE accepts every aceBindKey output and refuses junk', () => {
  for (const s of ['Mod+D', 'Mod+Shift+K', 'Alt+ArrowDown', 'Ctrl+Alt+Shift+Meta+F12', 'Mod+Escape', 'Mod+`', 'Mod+\\', 'Mod+Space', 'F5']) {
    const k = aceBindKey(s);
    assert.ok(BIND_KEY_RE.test(k.win) && BIND_KEY_RE.test(k.mac), s);
  }
  for (const bad of ['', 'Ctrl-', 'ctrl-d', 'Ctrl-D;alert(1)', 'Ctrl-<img>', 'Hyper-D', 'Ctrl-Ctrl-Ctrl-Ctrl-Ctrl-Ctrl-D']) {
    assert.equal(BIND_KEY_RE.test(bad), false, bad);
  }
});

test('fontStack: only the offered fonts, with local fallbacks; no web fonts', () => {
  assert.equal(fontStack(''), '');
  assert.equal(fontStack('Comic Sans'), '');
  assert.equal(fontStack("x'; } body{"), '');
  assert.match(fontStack('Fira Code'), /^'Fira Code', 'Cascadia Code', Consolas, monospace$/);
  for (const f of FONT_FAMILIES.filter(Boolean)) assert.ok(fontStack(f));
});

test('parseSnippetBody: ${1:…} selected (multi), $1 empty stop, $0 final, others stripped', () => {
  assert.deepEqual(parseSnippetBody('{{#if ${1:cond}}}\nX\n{{/if}}$0'),
    { text: '{{#if cond}}\nX\n{{/if}}', stops: [{ start: 6, end: 10 }], final: 22 });
  assert.deepEqual(parseSnippetBody('${1:a} and ${1:b}'), { text: 'a and b', stops: [{ start: 0, end: 1 }, { start: 6, end: 7 }], final: null });
  assert.deepEqual(parseSnippetBody('x$1y${2:two}$3'), { text: 'xytwo', stops: [{ start: 1, end: 1 }], final: null });
  assert.deepEqual(parseSnippetBody('cost $ 5 and $$'), { text: 'cost $ 5 and $$', stops: [], final: null });
  assert.deepEqual(parseSnippetBody(null), { text: '', stops: [], final: null });
});

test('offsetToPos: same line adds to the column, later lines restart', () => {
  assert.deepEqual(offsetToPos('ab\ncd', 1, { row: 4, column: 10 }), { row: 4, column: 11 });
  assert.deepEqual(offsetToPos('ab\ncd', 4, { row: 4, column: 10 }), { row: 5, column: 1 });
});

test('templateIdFrom / localeFrom / previewPath', () => {
  assert.equal(L.templateIdFrom('?templateId=123&locale=fr-CA'), '123');
  assert.equal(L.templateIdFrom('?templateId=12a'), null);
  assert.equal(L.templateIdFrom(''), null);
  assert.equal(L.localeFrom('?templateId=1&locale=fr-CA'), 'fr-CA');
  assert.equal(L.localeFrom('?templateId=1'), '');
  assert.equal(L.previewPath('123', 'fr-CA', 99), '/templates/showHtml?templateId=123&_t=99&locale=fr-CA');
  assert.equal(L.previewPath('123', '', 99), '/templates/showHtml?templateId=123&_t=99');
});

test('testDataBody keeps the script\'s exact request shape', () => {
  assert.deepEqual(L.testDataBody('42', { a: 1 }), {
    jsonTestData: { dataFeedJson: {}, userJson: { a: 1 } }, payload: {}, templateId: 42, subject: '', webBody: '', webTitle: '',
  });
});

test('parseTestData: objects only; empty text is {}', () => {
  assert.deepEqual(L.parseTestData('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(L.parseTestData('  '), { ok: true, value: {} });
  assert.equal(L.parseTestData('[1]').ok, false);
  assert.deepEqual(L.parseTestData('{bad').value, {});
  assert.match(L.parseTestData('{bad').error, /valid JSON/);
});

test('applyOverrides: copies, sets dotted paths nested, skips reserved names', () => {
  const src = { a: 1, prefs: { color: 'red', size: 2 }, flat: 5 };
  const out = L.applyOverrides(src, new Map([['a', 9], ['prefs.color', 'blue'], ['flat.x', true], ['__proto__.polluted', 1], ['new.deep.key', [1]]]));
  assert.deepEqual(out, { a: 9, prefs: { color: 'blue', size: 2 }, flat: { x: true }, new: { deep: { key: [1] } } });
  assert.deepEqual(src, { a: 1, prefs: { color: 'red', size: 2 }, flat: 5 });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(L.applyOverrides(null, [['x', 1]]), { x: 1 });
});

test('overridesLabel', () => {
  assert.equal(L.overridesLabel(['a']), 'a');
  assert.equal(L.overridesLabel(['a', 'b', 'c']), 'a, b, c');
  assert.equal(L.overridesLabel(['a', 'b', 'c', 'd']), 'a, b +2');
});

test('payloads: normalise, upsert by name, cap', () => {
  const list = L.normalizePayloads([{ name: ' A ', data: '{}' }, { name: 'A', data: '{"x":1}' }, { name: '', data: '{}' }, 5, { name: 'B', data: { x: 1 } }, { name: 'C' }]);
  assert.deepEqual(list, [{ name: 'A', data: '{}' }, { name: 'B', data: '{"x":1}' }]);
  assert.deepEqual(L.upsertPayload(list, 'A', '{"y":2}'), [{ name: 'A', data: '{"y":2}' }, { name: 'B', data: '{"x":1}' }]);
  assert.equal(L.upsertPayload(list, 'C', '{}').length, 3);
  assert.equal(L.upsertPayload(list, '  ', '{}'), list);
  assert.deepEqual(L.normalizePayloads('nope'), []);
});

test('pushRecent / clampWidth', () => {
  assert.deepEqual(L.pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.equal(L.pushRecent(Array.from({ length: 20 }, (_, i) => `f${i}`), 'x').length, 10);
  assert.equal(L.clampWidth(10), 25);
  assert.equal(L.clampWidth(90), 75);
  assert.equal(L.clampWidth(40.4), 40);
  assert.equal(L.clampWidth('x'), 50);
});

test('editorPlan: refresh keybindings go to the isolated side, the rest to Ace; snippets need a shortcut', () => {
  const p = L.editorPlan({
    refreshShortcut: 'Mod+S', fontFamily: 'Consolas', fontSize: 40,
    keybindings: [{ command: 'deleteLine', keys: 'Mod+Shift+K' }, { command: 'refreshPreview', keys: 'Mod+Enter' }, { command: 'refreshPreview', keys: 'Mod+S' }, { command: 'x', keys: '' }],
    snippets: [{ name: 'a', body: 'A', shortcut: 'Mod+Alt+1' }, { name: 'b', body: 'B', shortcut: '' }],
  });
  assert.deepEqual(p.refreshKeys, ['Mod+S', 'Mod+Enter']);
  assert.deepEqual(p.bindings, [{ command: 'deleteLine', win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' }]);
  assert.deepEqual(p.snippets, [{ body: 'A', win: 'Ctrl-Alt-1', mac: 'Command-Option-1' }]);
  assert.deepEqual(p.font, { family: 'Consolas', size: 24 });
  assert.deepEqual(L.editorPlan({ fontFamily: 'Papyrus' }).font, { family: '', size: 13 });
});

test('meta: defaults are valid and resolve unchanged; commands offered are the script\'s bank', () => {
  const defaults = defaultValues(meta);
  assert.deepEqual(mergeValues(meta, {}), defaults);
  assert.equal(defaults.refreshShortcut, 'Mod+S');
  assert.equal(defaults.previewWidth, 50);
  assert.equal(defaults.fontFamily, '');
  for (const key of ['keybindings', 'snippets']) {
    const field = meta.settings.find((f) => f.key === key);
    assert.equal(validateObjectList(field, field.default, { mac: false }).ok, true, key);
  }
  assert.equal(COMMAND_NAMES.length, 18);
  assert.ok(!JSON.stringify(meta).includes('googleapis'));
  assert.equal(meta.usesApiKey, true);
});

test('legacyShortcut: Ctrl meant Cmd on a Mac → Mod; bad ones refused', () => {
  assert.equal(legacyShortcut('Ctrl+S'), 'Mod+S');
  assert.equal(legacyShortcut('Ctrl+Shift+K'), 'Mod+Shift+K');
  assert.equal(legacyShortcut('Alt+Up'), 'Alt+ArrowUp');
  assert.equal(legacyShortcut('Meta+K'), 'Meta+K');
  assert.equal(legacyShortcut('Shift+A'), null);
  assert.equal(legacyShortcut('K'), null);
  assert.equal(legacyShortcut(''), null);
  assert.equal(legacyShortcut(7), null);
});

const LEGACY = {
  previewWidth: 60, shortcut: 'Ctrl+Enter', fontFamily: 'JetBrains Mono', fontSize: 15,
  userDataEmail: 'test.user@example.com', customTestData: '{"firstName":"Test"}',
  savedPayloads: [{ name: 'VIP', data: '{"tier":"gold"}' }, { name: 'bad' }],
  apiKeys: [{ id: '1', label: 'Prod', key: '0123456789abcdef0123456789abcdef' }], activeApiKeyId: '1',
  keybindings: [{ name: 'deleteLine', keys: 'Ctrl+Shift+K' }, { name: 'refreshPreview', keys: 'Ctrl+R' }, { name: 'nope', keys: 'Ctrl+J' }, { name: 'moveLineUp', keys: 'Up' }],
  snippets: [{ name: 'IF', body: '{{#if ${1:x}}}{{/if}}', shortcutKey: 'Ctrl+Alt+I' }, { name: '', body: 'x' }, { name: 'Bad key', body: 'y', shortcutKey: 'Q' }],
  recentFields: ['b', 'a', 'b'], maxRecent: 10, useUserData: true,
};

test('import: settings, user data to state, never the API keys; accepts the JSON string form', () => {
  assert.deepEqual(importer.scripts, ['Iterable - Live Preview Editor']);
  for (const storage of [{ config: JSON.stringify(LEGACY) }, { config: LEGACY }]) {
    const r = mapLivePreview(storage);
    assert.deepEqual(r.values, {
      previewWidth: 60, refreshShortcut: 'Mod+Enter', fontFamily: 'JetBrains Mono', fontSize: 15,
      keybindings: [{ command: 'deleteLine', keys: 'Mod+Shift+K' }, { command: 'refreshPreview', keys: 'Mod+R' }],
      snippets: [{ name: 'IF', body: '{{#if ${1:x}}}{{/if}}', shortcut: 'Mod+Alt+I' }, { name: 'Bad key', body: 'y', shortcut: '' }],
    });
    assert.deepEqual(r.state, {
      testData: '{"firstName":"Test"}', payloads: [{ name: 'VIP', data: '{"tier":"gold"}' }],
      recentFields: ['b', 'a'], lastEmail: 'test.user@example.com',
    });
    const all = JSON.stringify(r);
    assert.ok(!all.includes('0123456789abcdef'), 'no key material');
    assert.ok(r.notes.some((n) => /2 keybinding/.test(n)));
    assert.ok(r.notes.some((n) => /install it/.test(n)));
    // What it maps is accepted by the settings schema as is.
    assert.deepEqual(mergeValues(meta, r.values), { ...defaultValues(meta), ...r.values });
  }
});

test('import: clamps numbers, ignores unknown fonts, never throws', () => {
  const r = mapLivePreview({ config: '{"previewWidth":"90","fontSize":3,"fontFamily":"Papyrus","shortcut":"K"}' });
  assert.deepEqual(r.values, { previewWidth: 75, fontSize: 10 });
  assert.equal(r.notes.length, 2);
  for (const junk of [undefined, null, 5, 'x', [], { config: '{not json' }, { config: 7 }, { config: { keybindings: 'x', snippets: [null, 1], savedPayloads: {}, recentFields: [1, null] } }]) {
    assert.doesNotThrow(() => mapLivePreview(junk));
  }
  assert.deepEqual(mapLivePreview({}).values, {});
  assert.match(mapLivePreview({ config: '{not json' }).notes[0], /could not be read/);
});

test('refreshPlan: switching templates or locales, or the preview appearing, only reloads (GET)', () => {
  const base = { editorPresent: true, sidebarShown: true, templateId: '123', testDataFor: '123', unsaved: true };
  for (const trigger of ['url', 'show']) {
    assert.deepEqual(L.refreshPlan({ ...base, trigger }), { reload: true, save: false, post: false }, trigger);
    assert.deepEqual(L.refreshPlan({ ...base, trigger, sidebarShown: false }), { reload: false, save: false, post: false }, trigger);
  }
});

test('refreshPlan: Iterable\'s Save only on an explicit refresh with the sidebar showing', () => {
  const base = { editorPresent: true, templateId: '123', testDataFor: '123' };
  assert.deepEqual(L.refreshPlan({ ...base, trigger: 'explicit', sidebarShown: true, unsaved: true }), { reload: true, save: true, post: true });
  assert.equal(L.refreshPlan({ ...base, trigger: 'explicit', sidebarShown: true, unsaved: false }).save, false);
  assert.equal(L.refreshPlan({ ...base, trigger: 'explicit', sidebarShown: false, unsaved: true }).save, false, 'Static / hidden: never clicks Save');
  assert.equal(L.refreshPlan({ ...base, trigger: 'testData', sidebarShown: true, unsaved: true }).save, false);
  assert.equal(L.refreshPlan({ ...base, trigger: 'url', sidebarShown: true, unsaved: true }).save, false);
  assert.equal(L.refreshPlan({ ...base, trigger: 'bogus', sidebarShown: true, unsaved: true }).save, false);
  assert.equal(L.refreshPlan({ ...base, sidebarShown: true, unsaved: true }).save, false, 'no trigger → nothing');
});

test('refreshPlan: test data is posted only to the template it belongs to', () => {
  const base = { editorPresent: true, sidebarShown: true, templateId: '456', unsaved: false };
  for (const trigger of ['explicit', 'testData']) {
    assert.equal(L.refreshPlan({ ...base, trigger, testDataFor: '456' }).post, true, trigger);
    assert.equal(L.refreshPlan({ ...base, trigger, testDataFor: '123' }).post, false, `${trigger}: another template's data`);
    assert.equal(L.refreshPlan({ ...base, trigger, testDataFor: null }).post, false, `${trigger}: only the starting text`);
  }
  assert.equal(L.refreshPlan({ ...base, trigger: 'url', testDataFor: '456' }).post, false);
  assert.equal(L.refreshPlan({ ...base, trigger: 'show', testDataFor: '456' }).post, false);
});

test('refreshPlan: nothing at all without the code editor (drag-and-drop templates) or a template id', () => {
  const none = { reload: false, save: false, post: false };
  for (const trigger of ['explicit', 'testData', 'show', 'url']) {
    assert.deepEqual(L.refreshPlan({ trigger, editorPresent: false, sidebarShown: true, templateId: '7', testDataFor: '7', unsaved: true }), none, trigger);
    assert.deepEqual(L.refreshPlan({ trigger, editorPresent: true, sidebarShown: true, templateId: null, testDataFor: null, unsaved: true }), none, trigger);
  }
  assert.ok(L.TRIGGER_RANK.explicit > L.TRIGGER_RANK.testData && L.TRIGGER_RANK.testData > L.TRIGGER_RANK.url);
});

test('testDataName: per template, per project, restorable', () => {
  assert.equal(L.testDataName('p0123456789abcdef', '123'), 'testData:p0123456789abcdef:t123');
  assert.equal(L.testDataName('', '123'), 'testData:t123');
  assert.notEqual(L.testDataName('p1', '1'), L.testDataName('p1', '12'));
  assert.match(L.testDataName('p0123456789abcdef', '123456789012345'), /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,127}$/);
});

test('actionCurrent: an action applies only on the template, load and project it started on', () => {
  const scope = { tid: '123', gen: 4, slot: 'p1' };
  const now = { tid: '123', urlTid: '123', gen: 4, slot: 'p1', aborted: false };
  assert.equal(L.actionCurrent(scope, now), true);
  // The URL moved on (the switch hasn't loaded yet), the switch loaded, or A → B → A.
  assert.equal(L.actionCurrent(scope, { ...now, urlTid: '124' }), false);
  assert.equal(L.actionCurrent(scope, { ...now, tid: '124', urlTid: '124', gen: 5 }), false);
  assert.equal(L.actionCurrent(scope, { ...now, gen: 6 }), false);
  // Another project, or the feature unmounted.
  assert.equal(L.actionCurrent(scope, { ...now, slot: 'p2' }), false);
  assert.equal(L.actionCurrent(scope, { ...now, aborted: true }), false);
  // No scope → never.
  assert.equal(L.actionCurrent(null, now), false);
  assert.equal(L.actionCurrent(scope, null), false);
  // A page without a template id stays consistent with itself (nothing is posted there anyway).
  assert.equal(L.actionCurrent({ tid: null, gen: 1, slot: '' }, { tid: null, urlTid: null, gen: 1, slot: '', aborted: false }), true);
  assert.equal(L.SWITCHED_TEXT, 'Switched templates — nothing was applied.');
});
