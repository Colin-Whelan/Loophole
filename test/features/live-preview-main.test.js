// Live preview's page-world half (src/features/live-preview/main.js) against a fake `window.ace`
// and a stand-in document. Covers: never creating the page's editor, hooking + debounced change
// events, configure() validation (forged args are dropped), snippet insertion, JSON editors, and a
// cleanup that removes every command and puts the page's options back.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function fakeEditor(el) {
  const opts = { scrollPastEnd: 0, fontFamily: 'Monaco', fontSize: 12 };
  const listeners = new Set();
  const commands = new Map();
  let value = '';
  let cursor = { row: 0, column: 0 };
  const ranges = [];
  const ed = {
    container: el, destroyed: false, focused: false, theme: 'ace/theme/iterable',
    getValue: () => value,
    setValue(v) { value = v; for (const fn of listeners) fn(); },
    getOption: (k) => opts[k],
    setOption(k, v) { opts[k] = v; },
    setOptions(o) { Object.assign(opts, o); },
    opts,
    on(ev, fn) { if (ev === 'change') listeners.add(fn); },
    off(ev, fn) { listeners.delete(fn); },
    listeners,
    commands: {
      addCommand(c) { commands.set(c.name, c); },
      removeCommand(n) { commands.delete(n); },
      map: commands,
    },
    getSelectionRange: () => ({ isEmpty: () => true, start: cursor, end: cursor }),
    getCursorPosition: () => cursor,
    session: {
      insert(at, text) { value += text; ed.inserted = { at, text }; },
      replace() {},
      setUseWorker(v) { ed.worker = v; },
      setMode(m) { ed.mode = m; },
    },
    selection: {
      clearSelection() { ranges.length = 0; },
      setSelectionRange(r) { ranges.length = 0; ranges.push(r); },
      addRange(r) { ranges.push(r); },
    },
    ranges,
    moveCursorToPosition(p) { cursor = p; },
    clearSelection() {},
    focus() { ed.focused = true; },
    resize() { ed.resized = (ed.resized || 0) + 1; },
    getTheme() { return ed.theme; },
    setTheme(t) { ed.theme = t; },
    destroy() { ed.destroyed = true; },
    execCommand() {},
  };
  return ed;
}

function el(id, classes = []) {
  const e = { id, classList: { contains: (c) => classes.includes(c) }, closest: (s) => (s === '[data-wb-lp-ace]' && e.lpAce ? e : null), isConnected: true };
  return e;
}

let aceEl, jsonEl, created, fakeAce;
function setup({ pageEditor = true } = {}) {
  aceEl = el('content-editor-ace', pageEditor ? ['ace_editor'] : []);
  if (pageEditor) aceEl.env = { editor: fakeEditor(aceEl) };
  jsonEl = el('json');
  jsonEl.lpAce = true;
  created = [];
  class Range { constructor(a, b, c, d) { Object.assign(this, { start: { row: a, column: b }, end: { row: c, column: d } }); } }
  class Mode {}
  const modules = { 'ace/range': { Range }, 'ace/mode/json': { Mode } };
  fakeAce = {
    edit(e) {
      if (e.env?.editor) return e.env.editor;
      const ed = fakeEditor(e);
      e.env = { editor: ed };
      created.push(ed);
      return ed;
    },
    require: (n) => modules[n],
  };
  globalThis.window = { ace: fakeAce };
  globalThis.document = {
    getElementById: (id) => (id === 'content-editor-ace' ? aceEl : null),
    querySelector: (s) => (s === '[data-wb-lp-ace="lp-1"]' ? jsonEl : null),
  };
}

const main = await import('../../src/features/live-preview/main.js');
let events, cleanup;
const page = { featureId: 'live-preview', emit: (e, p) => { events.push([e, p]); return true; } };

beforeEach(() => {
  cleanup?.();
  events = [];
  setup();
  cleanup = main.activate(page);
});

test('attach hooks the page\'s editor; never creates one on a plain element', () => {
  setup({ pageEditor: false });
  cleanup(); cleanup = main.activate(page);
  assert.deepEqual(main.methods.attach(), { ace: true, editor: false });
  assert.equal(created.length, 0, 'no editor created on #content-editor-ace');
  setup();
  cleanup(); cleanup = main.activate(page);
  const ed = aceEl.env.editor;
  assert.deepEqual(main.methods.attach(), { ace: true, editor: true });
  assert.equal(ed.opts.scrollPastEnd, 0.8);
  assert.equal(ed.listeners.size, 1);
  main.methods.attach();
  assert.equal(ed.listeners.size, 1, 'idempotent');
});

test('no Ace at all → degrade', () => {
  window.ace = undefined;
  aceEl.env = undefined;
  assert.deepEqual(main.methods.attach(), { ace: false, editor: false });
  assert.deepEqual(main.methods.createJsonEditor({ id: 'lp-1', value: '{}' }), { ok: false, ace: false });
  assert.deepEqual(main.methods.insertSnippet({ body: 'x' }), { ok: false });
});

test('editor changes emit a debounced, content-free change event', async () => {
  main.methods.attach();
  const ed = aceEl.env.editor;
  ed.setValue('a'); ed.setValue('ab'); ed.setValue('abc');
  await new Promise((r) => setTimeout(r, 320));
  assert.deepEqual(events, [['change', {}]]);
});

test('configure: valid bindings/snippets become commands; forged ones are dropped', () => {
  main.methods.attach();
  const ed = aceEl.env.editor;
  const r = main.methods.configure({
    bindings: [
      { command: 'deleteLine', win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' },
      { command: 'refreshPreview', win: 'Ctrl-S', mac: 'Command-S' },     // isolated side's job
      { command: 'constructor', win: 'Ctrl-J', mac: 'Command-J' },
      { command: 'deleteLine', win: 'Ctrl-J;evil()', mac: 'Command-J' },
      { command: 'toString', win: 'Ctrl-J', mac: 'Command-J' },
      null, 'x',
    ],
    snippets: [{ body: '{{x}}', win: 'Ctrl-Alt-1', mac: 'Command-Option-1' }, { body: 7, win: 'Ctrl-1', mac: 'Ctrl-1' }, { body: 'x'.repeat(70000), win: 'Ctrl-2', mac: 'Ctrl-2' }],
    font: { family: 'Fira Code', size: 16 },
  });
  assert.deepEqual(r, { ok: true, commands: 2 });
  const names = [...ed.commands.map.keys()];
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => n.startsWith('wbLivePreview_')));
  assert.deepEqual(ed.commands.map.get(names[0]).bindKey, { win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' });
  assert.match(ed.opts.fontFamily, /^'Fira Code'/);
  assert.equal(ed.opts.fontSize, 16);
  // Reconfigure replaces, and font '' restores the page's own font.
  main.methods.configure({ bindings: [], snippets: [], font: { family: '', size: 13 } });
  assert.equal(ed.commands.map.size, 0);
  assert.equal(ed.opts.fontFamily, 'Monaco');
  assert.equal(ed.opts.fontSize, 12);
  // Font family outside the allow-list is ignored.
  main.methods.configure({ font: { family: "x'} *{display:none", size: 99 } });
  assert.equal(ed.opts.fontFamily, 'Monaco');
  assert.deepEqual(main.methods.configure(null), { ok: false, commands: 0 });
});

test('bank command runs on the editor it was invoked with', () => {
  main.methods.attach();
  const ed = aceEl.env.editor;
  let removed = 0;
  ed.removeLines = () => { removed++; };
  main.methods.configure({ bindings: [{ command: 'deleteLine', win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' }], snippets: [] });
  [...ed.commands.map.values()][0].exec(ed);
  assert.equal(removed, 1);
});

test('insertSnippet: text inserted, stop 1 selected, one-shot Tab exit', () => {
  main.methods.attach();
  const ed = aceEl.env.editor;
  assert.deepEqual(main.methods.insertSnippet({ body: '{{#if ${1:cond}}}\nX\n{{/if}}$0' }), { ok: true });
  assert.equal(ed.inserted.text, '{{#if cond}}\nX\n{{/if}}');
  assert.deepEqual(ed.ranges.map((r) => [r.start, r.end]), [[{ row: 0, column: 6 }, { row: 0, column: 10 }]]);
  const tab = ed.commands.map.get('wbLivePreview_snippetTabExit');
  assert.ok(tab && ed.focused);
  tab.exec(ed);
  assert.equal(ed.commands.map.has('wbLivePreview_snippetTabExit'), false);
  assert.deepEqual(main.methods.insertSnippet({ body: 5 }), { ok: false });
  assert.deepEqual(main.methods.insertSnippet(null), { ok: false });
});

test('JSON editors: only in our marked element, no worker, JSON mode and page theme; get/set/destroy', async () => {
  main.methods.attach();
  assert.deepEqual(main.methods.createJsonEditor({ id: 'BAD ID"]', value: '{}' }), { ok: false, ace: false });
  assert.deepEqual(main.methods.createJsonEditor({ id: 'lp-2', value: '{}' }), { ok: false, ace: true }, 'no such element');
  assert.deepEqual(main.methods.createJsonEditor({ id: 'lp-1', value: '{"a":1}' }), { ok: true, ace: true });
  const ed = jsonEl.env.editor;
  assert.equal(ed.worker, false);
  assert.ok(ed.mode, 'json mode used because it is already loaded');
  assert.equal(ed.theme, 'ace/theme/iterable');
  assert.deepEqual(main.methods.getJsonValue({ id: 'lp-1' }), { ok: true, value: '{"a":1}' });
  assert.deepEqual(main.methods.setJsonValue({ id: 'lp-1', value: '{"b":2}' }), { ok: true });
  assert.deepEqual(main.methods.setJsonValue({ id: 'lp-1', value: 5 }), { ok: false });
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(events.filter(([e]) => e === 'json-change'), [['json-change', { id: 'lp-1' }]]);
  // Format command (Ctrl-Shift-F) is added and pretty-prints its own value.
  ed.commands.map.get('wbLivePreview_formatJson').exec(ed);
  assert.equal(ed.getValue(), '{\n  "b": 2\n}');
  assert.deepEqual(main.methods.getJsonValue({ id: 'nope' }), { ok: false });
  assert.deepEqual(main.methods.destroyJsonEditor({ id: 'lp-1' }), { ok: true });
  assert.equal(ed.destroyed, true);
  assert.deepEqual(main.methods.getJsonValue({ id: 'lp-1' }), { ok: false });
});

test('deactivate removes our commands, listeners and JSON editors and restores the page options', () => {
  main.methods.attach();
  const ed = aceEl.env.editor;
  main.methods.configure({ bindings: [{ command: 'moveLineUp', win: 'Alt-Up', mac: 'Option-Up' }], snippets: [], font: { family: 'Consolas', size: 20 } });
  main.methods.createJsonEditor({ id: 'lp-1', value: '{}' });
  const json = jsonEl.env.editor;
  cleanup();
  cleanup = null;
  assert.equal(ed.commands.map.size, 0);
  assert.equal(ed.listeners.size, 0);
  assert.deepEqual([ed.opts.scrollPastEnd, ed.opts.fontFamily, ed.opts.fontSize], [0, 'Monaco', 12]);
  assert.equal(json.destroyed, true);
  // Methods called after deactivation do nothing.
  assert.deepEqual(main.methods.attach(), { ace: false, editor: false });
});

test('methods are own properties only', () => {
  assert.equal(Object.hasOwn(main.methods, 'constructor'), false);
  assert.deepEqual(Object.keys(main.methods).sort(),
    ['attach', 'configure', 'createJsonEditor', 'destroyJsonEditor', 'getJsonValue', 'insertSnippet', 'resize', 'setJsonValue']);
});
