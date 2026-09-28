import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEditableView, cleanKeyText, valueKind, scalarFromPage, resolveField, needsApiValue, createHistory, previewValue,
} from '../../src/features/profile-editor/logic.js';
import importer, { mapProfileEditor } from '../../src/features/profile-editor/import.js';
import meta from '../../src/features/profile-editor/meta.js';
import { mergeValues } from '../../src/core/settings.js';

// All data synthetic.

test('isEditableView: profile pages except Event History', () => {
  assert.equal(isEditableView('/users/profiles/abc123'), true);
  assert.equal(isEditableView('/users/profiles/abc123/fields'), true);
  assert.equal(isEditableView('/users/profiles/abc123/event/history'), false);
  assert.equal(isEditableView('/campaigns/1'), false);
  assert.equal(isEditableView(undefined), false);
});

test('cleanKeyText strips wrapping quotes and the trailing colon only', () => {
  assert.equal(cleanKeyText('"firstName":'), 'firstName');
  assert.equal(cleanKeyText('  loyaltyTier : '), 'loyaltyTier');
  assert.equal(cleanKeyText('"a:b":'), 'a:b');
  assert.equal(cleanKeyText(''), '');
  assert.equal(cleanKeyText(null), '');
});

test('valueKind reads the type class', () => {
  assert.equal(valueKind(['json-property-value', 'json-property-string']), 'string');
  assert.equal(valueKind('json-property-value json-property-array'), 'array');
  assert.equal(valueKind('json-property-value json-property-null'), 'null');
  assert.equal(valueKind('json-property-value'), 'unknown');
});

test('scalarFromPage: the script’s parsing, plus null and big-int safety', () => {
  assert.deepEqual(scalarFromPage('string', '"silver"'), { ok: true, value: 'silver' });
  assert.deepEqual(scalarFromPage('string', 'plain'), { ok: true, value: 'plain' });
  assert.deepEqual(scalarFromPage('number', '1142'), { ok: true, value: 1142 });
  assert.deepEqual(scalarFromPage('number', '-3.5'), { ok: true, value: -3.5 });
  assert.deepEqual(scalarFromPage('number', '9007199254740993'), { ok: false });
  assert.deepEqual(scalarFromPage('number', ''), { ok: false });
  assert.deepEqual(scalarFromPage('boolean', 'true'), { ok: true, value: true });
  assert.deepEqual(scalarFromPage('boolean', 'false'), { ok: true, value: false });
  assert.deepEqual(scalarFromPage('boolean', 'yes'), { ok: false });
  assert.deepEqual(scalarFromPage('null', 'null'), { ok: true, value: null });
  assert.deepEqual(scalarFromPage('object', '{'), { ok: false });
  assert.deepEqual(scalarFromPage('array', '['), { ok: false });
  assert.deepEqual(scalarFromPage('unknown', 'x'), { ok: false });
});

test('needsApiValue: objects, arrays and unknown kinds come from the API', () => {
  assert.equal(needsApiValue('object'), true);
  assert.equal(needsApiValue('array'), true);
  assert.equal(needsApiValue('unknown'), true);
  assert.equal(needsApiValue('string'), false);
  assert.equal(needsApiValue('null'), false);
});

test('resolveField: dotted paths through objects', () => {
  assert.deepEqual(resolveField([{ key: 'firstName', kind: 'string' }]), { editable: true, path: 'firstName' });
  assert.deepEqual(resolveField([{ key: 'profile', kind: 'object' }, { key: 'city', kind: 'string' }]), { editable: true, path: 'profile.city' });
  assert.deepEqual(resolveField([{ key: 'profile', kind: 'object' }]), { editable: true, path: 'profile' });
  assert.deepEqual(resolveField([{ key: 'tags', kind: 'array' }]), { editable: true, path: 'tags' });
});

test('resolveField: keys inside arrays, empty keys and identity fields are not editable', () => {
  assert.equal(resolveField([{ key: 'orders', kind: 'array' }, { key: '', kind: 'object' }, { key: 'id', kind: 'number' }]).editable, false);
  assert.equal(resolveField([{ key: 'orders', kind: 'array' }, { key: '0', kind: 'object' }, { key: 'id', kind: 'number' }]).reason, 'in-array');
  assert.equal(resolveField([{ key: '', kind: 'string' }]).reason, 'no-key');
  assert.equal(resolveField([]).reason, 'no-key');
  assert.equal(resolveField([{ key: 'email', kind: 'string' }]).reason, 'identity');
  assert.equal(resolveField([{ key: 'userId', kind: 'string' }]).reason, 'identity');
  // Nested keys called email are ordinary fields.
  assert.deepEqual(resolveField([{ key: 'contact', kind: 'object' }, { key: 'email', kind: 'string' }]), { editable: true, path: 'contact.email' });
});

test('resolveField: a leading dataFields segment is dropped', () => {
  assert.deepEqual(resolveField([{ key: 'dataFields', kind: 'object' }, { key: 'tier', kind: 'string' }]), { editable: true, path: 'tier' });
  assert.equal(resolveField([{ key: 'dataFields', kind: 'object' }]).editable, false);
  assert.equal(resolveField([{ key: 'dataFields', kind: 'object' }, { key: 'email', kind: 'string' }]).reason, 'identity');
});

test('history: first write keeps the original; forget after restore; scoped by project and profile', () => {
  const h = createHistory();
  assert.equal(h.hasOriginal('us:1', 'p1', 'tier'), false);
  h.recordWrite('us:1', 'p1', 'tier', 'silver');
  h.recordWrite('us:1', 'p1', 'tier', 'gold');   // second write: original stays
  assert.equal(h.getOriginal('us:1', 'p1', 'tier'), 'silver');
  assert.equal(h.wasWritten('us:1', 'p1', 'tier'), true);
  assert.equal(h.hasOriginal('us:2', 'p1', 'tier'), false);
  assert.equal(h.hasOriginal('us:1', 'p2', 'tier'), false);
  h.forget('us:1', 'p1', 'tier');
  assert.equal(h.hasOriginal('us:1', 'p1', 'tier'), false);
  assert.equal(h.wasWritten('us:1', 'p1', 'tier'), true);
  h.clear();
  assert.equal(h.wasWritten('us:1', 'p1', 'tier'), false);
});

test('history: originals are copies; undefined is not recorded; markWritten has no original', () => {
  const h = createHistory();
  const obj = { a: 1 };
  h.recordWrite('us:1', 'p', 'o', obj);
  obj.a = 2;
  const got = h.getOriginal('us:1', 'p', 'o');
  assert.deepEqual(got, { a: 1 });
  got.a = 3;
  assert.deepEqual(h.getOriginal('us:1', 'p', 'o'), { a: 1 });
  h.recordWrite('us:1', 'p', 'u', undefined);
  assert.equal(h.hasOriginal('us:1', 'p', 'u'), false);
  assert.equal(h.wasWritten('us:1', 'p', 'u'), true);
  h.markWritten('us:1', 'p', 'n');
  assert.equal(h.hasOriginal('us:1', 'p', 'n'), false);
  assert.equal(h.wasWritten('us:1', 'p', 'n'), true);
  // null is a real original (the field was cleared before).
  h.recordWrite('us:1', 'p', 'z', null);
  assert.equal(h.hasOriginal('us:1', 'p', 'z'), true);
  assert.equal(h.getOriginal('us:1', 'p', 'z'), null);
});

test('previewValue', () => {
  assert.equal(previewValue('gold'), '"gold"');
  assert.equal(previewValue(null), 'null');
  assert.equal(previewValue(undefined), '(not set)');
  assert.equal(previewValue({ a: [1, 2] }), '{"a":[1,2]}');
  assert.equal(previewValue('x'.repeat(200), 20).length, 20);
});

test('meta: settings and key usage', () => {
  assert.equal(meta.id, 'profile-editor');
  assert.equal(meta.usesApiKey, true);
  assert.deepEqual(mergeValues(meta, {}), { mergeNested: true, showNotifications: true });
  assert.ok(meta.legacy.includes('Iterable Profile Editor'));
});

test('import maps the two booleans (tag-decoded or string forms) and ignores keys', () => {
  const r = importer.map({
    iterable_merge_nested: false,
    iterable_show_notifications: 'false',
    iterable_spaces: '[{"name":"Prod","apiKey":"0000000000000000aaaaaaaaaaaaaaaa"}]',
  });
  assert.deepEqual(r.values, { mergeNested: false, showNotifications: false });
  assert.deepEqual(r.notes, []);
  assert.equal(r.keys, undefined);
  assert.ok(!JSON.stringify(r).includes('aaaaaaaa'));
  assert.deepEqual(mergeValues(meta, r.values), r.values);
  assert.deepEqual(importer.scripts, ['Iterable Profile Editor']);
});

test('import tolerates junk and empty stores', () => {
  assert.deepEqual(mapProfileEditor(null), { values: {}, notes: [] });
  assert.deepEqual(mapProfileEditor([]), { values: {}, notes: [] });
  const r = mapProfileEditor({ iterable_merge_nested: 'maybe', iterable_show_notifications: true });
  assert.deepEqual(r.values, { showNotifications: true });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /merge-nested-objects/);
});
