import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeObjectList, isValidObjectList, validateObjectList, itemFieldError, newItem, groupSections,
} from '../src/core/schema.js';
import { mergeValues, isValidValue, defaultValues } from '../src/core/settings.js';

const LINKS = {
  key: 'links', type: 'objectList', label: 'Quicklinks', itemLabel: 'Link', titleField: 'name',
  fields: [
    { key: 'name', type: 'string', label: 'Name', required: true },
    { key: 'url', type: 'string', label: 'URL', mono: true, required: true,
      validate: (v) => (v.startsWith('/') ? null : 'Use a path that starts with /.') },
  ],
  default: [{ name: 'Lists', url: '/lists' }],
  maxItems: 3,
};

const KEYS = {
  key: 'bindings', type: 'objectList', label: 'Keybindings', itemLabel: 'Binding',
  fields: [
    { key: 'command', type: 'select', label: 'Command', options: [{ value: 'save' }, { value: 'find' }] },
    { key: 'keys', type: 'shortcut', label: 'Keys' },
    { key: 'on', type: 'boolean', label: 'On', default: true },
    { key: 'n', type: 'number', label: 'N', min: 1, max: 5 },
  ],
  default: [],
};

test('newItem fills sub-field defaults', () => {
  assert.deepEqual(newItem(KEYS), { command: 'save', keys: '', on: true, n: 1 });
  assert.deepEqual(newItem(LINKS), { name: '', url: '' });
});

test('normalizeObjectList repairs items, keeps extra keys, drops non-objects', () => {
  const out = normalizeObjectList(KEYS, [
    { command: 'find', keys: 'shift+mod+f', id: 'x1' },
    'junk', null, [1],
    { command: 'bogus', keys: 'F', on: 'yes', n: 9 },
  ]);
  assert.deepEqual(out, [
    { command: 'find', keys: 'Mod+Shift+F', on: true, n: 1, id: 'x1' },
    { command: 'save', keys: '', on: true, n: 1 },
  ]);
  assert.equal(normalizeObjectList(KEYS, 'nope'), null);
  assert.equal(normalizeObjectList(LINKS, new Array(4).fill({ name: 'a', url: '/a' })), null); // > maxItems
});

test('isValidObjectList is strict (normal form + bounds)', () => {
  assert.equal(isValidObjectList(LINKS, [{ name: 'a', url: '/a' }]), true);
  assert.equal(isValidObjectList(LINKS, [{ name: 'a' }]), false);
  assert.equal(isValidObjectList(KEYS, [{ command: 'save', keys: 'shift+ctrl+k', on: true, n: 2 }]), false); // not canonical
  assert.equal(isValidObjectList(KEYS, [{ command: 'save', keys: 'Ctrl+Shift+K', on: true, n: 2 }]), true);
  assert.equal(isValidObjectList({ ...LINKS, minItems: 1 }, []), false);
});

test('settings: stored objectList is repaired rather than thrown away', () => {
  const meta = { id: 'x', settings: [LINKS, KEYS, { key: 'hot', type: 'shortcut', default: 'Mod+K' }] };
  const v = mergeValues(meta, {
    links: [{ name: 'Home', url: '/home' }, 'garbage'],
    bindings: [{ command: 'find', keys: 'ctrl+f' }],
    hot: 'shift+alt+p',
  });
  assert.deepEqual(v.links, [{ name: 'Home', url: '/home' }]);
  assert.deepEqual(v.bindings, [{ command: 'find', keys: 'Ctrl+F', on: true, n: 1 }]);
  assert.equal(v.hot, 'Alt+Shift+P');
  // Invalid → defaults.
  const d = mergeValues(meta, { links: 'x', hot: 'P', bindings: [{ keys: 'Q' }] });
  assert.deepEqual(d.links, [{ name: 'Lists', url: '/lists' }]);
  assert.equal(d.hot, 'Mod+K');
  assert.deepEqual(d.bindings, [{ command: 'save', keys: '', on: true, n: 1 }]); // bad shortcut → ''
  assert.equal(isValidValue({ type: 'shortcut' }, ''), true);
  assert.equal(isValidValue({ type: 'shortcut' }, 'L'), false);
  assert.deepEqual(defaultValues({ settings: [{ ...KEYS, default: [{ command: 'find' }] }] }).bindings,
    [{ command: 'find', keys: '', on: true, n: 1 }]);
});

test('validateObjectList: per-field errors, custom validate, duplicate shortcuts, bounds', () => {
  const r = validateObjectList(LINKS, [
    { name: 'Ok', url: '/ok' },
    { name: '  ', url: 'http://x' },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.itemErrors, [
    { index: 1, key: 'name', message: 'Name is required.' },
    { index: 1, key: 'url', message: 'Use a path that starts with /.' },
  ]);
  const b = validateObjectList(KEYS, [
    { command: 'save', keys: 'ctrl+s', on: true, n: 1 },
    { command: 'find', keys: 'Ctrl+S', on: true, n: 1 },
    { command: 'find', keys: 'S', on: true, n: 7 },
  ], { mac: false });
  assert.deepEqual(b.itemErrors.map((e) => [e.index, e.key]), [[1, 'keys'], [2, 'keys'], [2, 'n']]);
  assert.match(b.itemErrors[0].message, /Already used by Binding 1/);
  assert.equal(b.value[0].keys, 'Ctrl+S');
  const many = validateObjectList(LINKS, new Array(4).fill({ name: 'a', url: '/a' }));
  assert.equal(many.listError, 'At most 3 links.');
  const few = validateObjectList({ ...LINKS, minItems: 1 }, []);
  assert.equal(few.listError, 'Add at least 1 link.');
  assert.equal(validateObjectList(LINKS, [{ name: 'a', url: '/a' }]).ok, true);
});

test('itemFieldError: numbers, selects, throwing validators', () => {
  assert.equal(itemFieldError({ type: 'number' }, NaN), 'Enter a number.');
  assert.equal(itemFieldError({ type: 'number', min: 2 }, 1), 'Must be at least 2.');
  assert.equal(itemFieldError({ type: 'select', options: [{ value: 'a' }] }, 'b'), 'Pick one of the options.');
  assert.equal(itemFieldError({ type: 'string', validate: () => { throw new Error('x'); } }, 'v'), 'Invalid value.');
  assert.equal(itemFieldError({ type: 'text' }, 'free text'), null);
});

test('groupSections keeps first-seen order; unsectioned fields share one group', () => {
  const g = groupSections([
    { key: 'a' }, { key: 'b', section: 'Links' }, { key: 'c' }, { key: 'd', section: 'Accessibility' },
    { key: 'e', section: 'Links' },
  ]);
  assert.deepEqual(g.map((x) => [x.title, x.fields.map((f) => f.key)]), [
    [null, ['a', 'c']], ['Links', ['b', 'e']], ['Accessibility', ['d']],
  ]);
});

test('stored objectList items and values lose __proto__ / constructor / prototype keys', async () => {
  const { cloneJsonSafe, normalizeObjectList } = await import('../src/core/schema.js');
  const { mergeValues } = await import('../src/core/settings.js');
  const crafted = JSON.parse('{"name":"x","url":"/a","__proto__":{"polluted":1},"constructor":{"prototype":{"y":1}},"nested":{"__proto__":{"z":1},"ok":2}}');
  const c = cloneJsonSafe(crafted);
  assert.equal(Object.hasOwn(c, '__proto__'), false);
  assert.equal(Object.hasOwn(c, 'constructor'), false);
  assert.equal(Object.hasOwn(c.nested, '__proto__'), false);
  assert.equal(c.nested.ok, 2);
  const field = { key: 'links', type: 'objectList', fields: [{ key: 'name', type: 'string' }, { key: 'url', type: 'string' }], default: [] };
  const [item] = normalizeObjectList(field, [crafted]);
  assert.equal(Object.hasOwn(item, '__proto__'), false);
  assert.equal(Object.hasOwn(item, 'constructor'), false);
  assert.equal(item.name, 'x');
  const meta = { settings: [field, { key: 'n', type: 'number', default: 1 }] };
  const merged = mergeValues(meta, JSON.parse('{"links":[{"name":"a","url":"/","__proto__":{"p":1}}],"__proto__":{"q":1},"extra":{"constructor":1}}'));
  assert.equal(Object.hasOwn(merged, '__proto__'), false);
  assert.equal(Object.hasOwn(merged.links[0], '__proto__'), false);
  assert.deepEqual(merged.extra, {});
  assert.equal({}.polluted, undefined);
});
