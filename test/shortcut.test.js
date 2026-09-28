import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShortcut, normalizeShortcut, shortcutError, isValidShortcut, formatShortcut, shortcutParts,
  shortcutFromEvent, matchesShortcut, eventKey,
} from '../src/core/shortcut.js';
import { onShortcut, isEditableTarget } from '../src/core/dom.js';

const ev = (key, mods = {}, code) => ({
  key, code: code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : ''),
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
});

test('normalizeShortcut: canonical modifier order, case and aliases', () => {
  assert.equal(normalizeShortcut('shift+ctrl+l'), 'Ctrl+Shift+L');
  assert.equal(normalizeShortcut(' Mod + Shift + k '), 'Mod+Shift+K');
  assert.equal(normalizeShortcut('CmdOrCtrl+/'), 'Mod+/');
  assert.equal(normalizeShortcut('Cmd+Option+Enter'), 'Alt+Meta+Enter');
  assert.equal(normalizeShortcut('control+alt+del'), 'Ctrl+Alt+Delete');
  assert.equal(normalizeShortcut('alt+up'), 'Alt+ArrowUp');
  assert.equal(normalizeShortcut('f5'), 'F5');
  assert.equal(normalizeShortcut('Ctrl+Esc'), 'Ctrl+Escape');
  assert.equal(normalizeShortcut(''), '');
  assert.equal(normalizeShortcut('   '), '');
});

test('parseShortcut rejects malformed strings', () => {
  for (const bad of ['Ctrl+', '+L', 'Ctrl++L', 'Ctrl+Ctrl+L', 'L+Ctrl', 'Ctrl+Shift', 'Ctrl+Hyper',
    'Ctrl+AB', 'Ctrl+F25', 'Ctrl+é', null, 42, {}]) {
    assert.equal(parseShortcut(bad), null, String(bad));
    assert.equal(normalizeShortcut(bad), bad === '' ? '' : null, String(bad));
  }
  // A bare modifier name as the only part is a key name we don't know.
  assert.equal(parseShortcut('Shift'), null);
});

test('shortcutError: bare keys and Shift+key are refused, F-keys may stand alone', () => {
  assert.equal(shortcutError(''), null);
  assert.equal(shortcutError('Mod+Shift+L'), null);
  assert.equal(shortcutError('Alt+1'), null);
  assert.equal(shortcutError('Ctrl+/'), null);
  assert.equal(shortcutError('F2'), null);
  assert.equal(shortcutError('Shift+F2'), null);
  assert.match(shortcutError('L', { mac: false }), /Ctrl or Alt/);
  assert.match(shortcutError('Shift+L', { mac: false }), /Shift plus a key/);
  assert.match(shortcutError('Enter', { mac: true }), /⌘/);
  assert.match(shortcutError('Space'), /on its own/);
  assert.equal(shortcutError('Ctrl+'), 'Not a valid shortcut.');
  assert.equal(isValidShortcut('Mod+K'), true);
  assert.equal(isValidShortcut('K'), false);
  assert.equal(isValidShortcut(''), true);
  assert.equal(isValidShortcut(undefined), false);
});

test('formatShortcut: Windows/Linux names vs Mac glyphs', () => {
  assert.equal(formatShortcut('Mod+Shift+L', { mac: false }), 'Ctrl+Shift+L');
  assert.equal(formatShortcut('Mod+Shift+L', { mac: true }), '⇧⌘L');
  assert.equal(formatShortcut('Ctrl+Alt+ArrowUp', { mac: true }), '⌃⌥↑');
  assert.equal(formatShortcut('Meta+K', { mac: false }), 'Win+K');
  assert.equal(formatShortcut('Mod+Ctrl+K', { mac: false }), 'Ctrl+K'); // same key on Windows
  assert.deepEqual(shortcutParts('Alt+Escape', { mac: false }), ['Alt', 'Esc']);
  assert.equal(formatShortcut('', { mac: false }), '');
  assert.equal(formatShortcut('nope+', { mac: true }), '');
});

test('eventKey: layout-aware letters, code-based punctuation, lone modifiers ignored', () => {
  assert.equal(eventKey(ev('l')), 'L');
  assert.equal(eventKey(ev('¬', { altKey: true }, 'KeyL')), 'L'); // Option+L on a Mac
  assert.equal(eventKey(ev('?', { shiftKey: true }, 'Slash')), '/');
  assert.equal(eventKey(ev('!', { shiftKey: true }, 'Digit1')), '1');
  assert.equal(eventKey(ev('ArrowDown', {}, 'ArrowDown')), 'ArrowDown');
  assert.equal(eventKey(ev(' ', {}, 'Space')), 'Space');
  assert.equal(eventKey(ev('Shift', { shiftKey: true }, 'ShiftLeft')), null);
  assert.equal(eventKey(ev('Dead', {}, 'IntlRo')), null);
});

test('shortcutFromEvent records the primary modifier as Mod', () => {
  assert.equal(shortcutFromEvent(ev('l', { ctrlKey: true, shiftKey: true }), { mac: false }), 'Mod+Shift+L');
  assert.equal(shortcutFromEvent(ev('l', { metaKey: true, shiftKey: true }), { mac: true }), 'Mod+Shift+L');
  assert.equal(shortcutFromEvent(ev('l', { ctrlKey: true }), { mac: true }), 'Ctrl+L');
  assert.equal(shortcutFromEvent(ev('l', { metaKey: true }), { mac: false }), 'Meta+L');
  assert.equal(shortcutFromEvent(ev('Control', { ctrlKey: true }, 'ControlLeft'), { mac: false }), null);
});

test('matchesShortcut: exact modifiers, Mod per platform', () => {
  const e = ev('l', { ctrlKey: true, shiftKey: true });
  assert.equal(matchesShortcut('Mod+Shift+L', e, { mac: false }), true);
  assert.equal(matchesShortcut('Ctrl+Shift+L', e, { mac: false }), true);
  assert.equal(matchesShortcut('Mod+Shift+L', e, { mac: true }), false); // needs ⌘ on Mac
  assert.equal(matchesShortcut('Ctrl+Shift+L', e, { mac: true }), true);
  assert.equal(matchesShortcut('Mod+L', e, { mac: false }), false); // extra Shift
  assert.equal(matchesShortcut('Mod+Shift+L', ev('l', { metaKey: true, shiftKey: true }), { mac: true }), true);
  assert.equal(matchesShortcut('Mod+Shift+K', e, { mac: false }), false);
  assert.equal(matchesShortcut('', e), false);
});

// ── onShortcut (core/dom.js) with a stand-in window ──

class FakeTarget extends EventTarget {}
function key(target, props, dispatchOn = target) {
  const e = new Event('keydown', { cancelable: true, bubbles: true });
  Object.assign(e, { key: 'k', code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...props });
  dispatchOn.dispatchEvent(e);
  return e;
}

test('onShortcut fires on the combo, prevents default, and stops on abort', () => {
  const win = new FakeTarget();
  const ac = new AbortController();
  let n = 0;
  onShortcut('Ctrl+Alt+K', () => { n++; }, { signal: ac.signal, target: win });
  const e = key(win, { ctrlKey: true, altKey: true });
  assert.equal(n, 1);
  assert.equal(e.defaultPrevented, true);
  key(win, { ctrlKey: true }); // missing Alt
  assert.equal(n, 1);
  key(win, { ctrlKey: true, altKey: true, repeat: true }); // auto-repeat ignored by default
  assert.equal(n, 1);
  ac.abort();
  key(win, { ctrlKey: true, altKey: true });
  assert.equal(n, 1);
});

test('onShortcut: handler returning false keeps the default; empty combo registers nothing', () => {
  const win = new FakeTarget();
  const stop = onShortcut('Ctrl+Alt+K', () => false, { target: win });
  assert.equal(key(win, { ctrlKey: true, altKey: true }).defaultPrevented, false);
  stop();
  let called = false;
  const noop = onShortcut('', () => { called = true; }, { target: win });
  key(win, { ctrlKey: true, altKey: true });
  assert.equal(called, false);
  noop();
});

test('onShortcut ignores keys typed into inputs unless allowInInputs', () => {
  class FakeInput extends EventTarget {
    constructor() { super(); this.nodeType = 1; this.tagName = 'INPUT'; this.type = 'text'; }
  }
  const field = new FakeInput();
  let n = 0;
  const s1 = onShortcut('Ctrl+Alt+K', () => { n++; }, { target: field });
  key(field, { ctrlKey: true, altKey: true });
  assert.equal(n, 0);
  s1();
  onShortcut('Ctrl+Alt+K', () => { n++; }, { target: field, allowInInputs: true });
  key(field, { ctrlKey: true, altKey: true });
  assert.equal(n, 1);
});

test('isEditableTarget', () => {
  assert.equal(isEditableTarget({ nodeType: 1, tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ nodeType: 1, tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableTarget({ nodeType: 1, tagName: 'INPUT', type: 'email' }), true);
  assert.equal(isEditableTarget({ nodeType: 1, tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ nodeType: 1, tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget(null), false);
});
