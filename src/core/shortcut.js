// Keyboard shortcut strings: parse, normalise, validate, format, match (ARCHITECTURE §8.1).
// Pure (no DOM at import time), so settings.js can validate in the service worker.
//
// Canonical form: modifiers in the order Mod, Ctrl, Alt, Shift, Meta, then one key, joined by
// "+": "Mod+Shift+L". `Mod` is the platform's primary modifier (Ctrl on Windows/Linux, ⌘ on
// Mac), so one stored value works everywhere; the shortcut field records Ctrl on Windows and ⌘ on
// Mac as `Mod`. `Ctrl` is the literal Control key (⌃ on Mac); `Meta` is ⌘ / the Windows key.
// The empty string means "no shortcut".

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];

const MOD_ALIASES = {
  mod: 'Mod', cmdorctrl: 'Mod', commandorcontrol: 'Mod', primary: 'Mod',
  ctrl: 'Ctrl', control: 'Ctrl', ctl: 'Ctrl', '⌃': 'Ctrl',
  alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
  shift: 'Shift', '⇧': 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', os: 'Meta', '⌘': 'Meta',
};

// Named keys (canonical spelling). Aliases map to these.
const NAMED = ['Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const NAMED_ALIASES = {
  esc: 'Escape', return: 'Enter', ' ': 'Space', spacebar: 'Space', del: 'Delete', ins: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown',
};
const NAMED_LOWER = Object.fromEntries(NAMED.map((k) => [k.toLowerCase(), k]));
const PUNCT = new Set(['/', '.', ',', ';', "'", '[', ']', '\\', '-', '=', '`']);

// KeyboardEvent.code → key token, for keys whose `key` changes with Shift/Alt/layout.
const CODE_KEYS = {
  Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space',
};

/** Canonical key token for one key name, or null when it isn't a key we support. */
function keyToken(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length === 1) {
    if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
    if (PUNCT.has(raw)) return raw;
    if (raw === ' ') return 'Space';
    return null;
  }
  const lower = raw.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return 'F' + lower.slice(1);
  if (NAMED_LOWER[lower]) return NAMED_LOWER[lower];
  if (NAMED_ALIASES[lower]) return NAMED_ALIASES[lower];
  return null;
}

/**
 * Parse a shortcut string ("Ctrl+Shift+L", "mod + k", "Cmd+Alt+/"). Parts are separated by "+",
 * case-insensitive, modifier aliases accepted; "+" itself can't be the key (use "=").
 * → { mods: Set<'Mod'|'Ctrl'|'Alt'|'Shift'|'Meta'>, key } or null when malformed.
 */
export function parseShortcut(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  const parts = s.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const mods = new Set();
  let key = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const mod = MOD_ALIASES[p.toLowerCase()];
    if (mod && i < parts.length - 1) {
      if (mods.has(mod)) return null;
      mods.add(mod);
      continue;
    }
    if (i !== parts.length - 1) return null; // a non-modifier before the end
    key = keyToken(p);
    if (!key) return null;
  }
  if (!key) return null;
  return { mods, key };
}

function stringify({ mods, key }) {
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Canonical string for `str`, '' for empty input, or null when malformed. */
export function normalizeShortcut(str) {
  if (typeof str === 'string' && str.trim() === '') return '';
  const p = parseShortcut(str);
  return p ? stringify(p) : null;
}

const isFunctionKey = (key) => /^F\d{1,2}$/.test(key);

/**
 * Why `str` can't be used as a shortcut, or null when it's fine. '' (no shortcut) is fine.
 * Rules: must parse; a letter, digit, punctuation or named key needs Mod, Ctrl, Alt or Meta
 * (Shift alone still types); only F1–F24 may stand alone.
 */
export function shortcutError(str, { mac = isMac() } = {}) {
  if (typeof str === 'string' && str.trim() === '') return null;
  const p = parseShortcut(str);
  if (!p) return 'Not a valid shortcut.';
  if (isFunctionKey(p.key)) return null;
  const hasCommandMod = ['Mod', 'Ctrl', 'Alt', 'Meta'].some((m) => p.mods.has(m));
  if (!hasCommandMod) {
    return `Add ${mac ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'}: ${p.mods.has('Shift') ? 'Shift plus a key' : 'a key on its own'} would fire while you type.`;
  }
  return null;
}

/** True for '' and for any shortcut shortcutError accepts. Platform-independent. */
export function isValidShortcut(str) {
  return typeof str === 'string' && shortcutError(str, { mac: false }) === null;
}

/** True on macOS / iOS (primary modifier is ⌘). */
export function isMac() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

const MAC_GLYPHS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']; // Apple's ⌃⌥⇧⌘ order
const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn',
};

/**
 * Display parts for a shortcut: ['Ctrl', 'Shift', 'L'] on Windows/Linux, ['⌘', '⇧', 'L'] on Mac.
 * [] for '' or malformed input.
 */
export function shortcutParts(str, { mac = isMac() } = {}) {
  const p = parseShortcut(str);
  if (!p) return [];
  const key = KEY_LABELS[p.key] || p.key;
  if (mac) {
    const seen = new Set();
    const glyphs = [];
    for (const m of MAC_ORDER) {
      if (!p.mods.has(m)) continue;
      const g = MAC_GLYPHS[m];
      if (!seen.has(g)) { seen.add(g); glyphs.push(g); }
    }
    return [...glyphs, key];
  }
  const names = [];
  for (const m of MOD_ORDER) {
    if (!p.mods.has(m)) continue;
    const n = m === 'Mod' ? 'Ctrl' : m === 'Meta' ? 'Win' : m;
    if (!names.includes(n)) names.push(n);
  }
  return [...names, key];
}

/** "Ctrl+Shift+L" (Windows/Linux) or "⌘⇧L" (Mac); '' for ''/malformed. */
export function formatShortcut(str, { mac = isMac() } = {}) {
  const parts = shortcutParts(str, { mac });
  return mac ? parts.join('') : parts.join('+');
}

/**
 * Key token for a KeyboardEvent-like object, or null for a lone modifier / unsupported key.
 * Letters and digits prefer `key` (layout-aware), falling back to `code` when a modifier changed
 * the character (Alt+L on a Mac gives "¬"); punctuation uses `code` so Shift doesn't turn "/" into "?".
 */
export function eventKey(e) {
  if (!e || ['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn'].includes(e.key)) return null;
  if (typeof e.key === 'string' && /^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  const code = e.code || '';
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  return keyToken(e.key);
}

/**
 * Canonical shortcut for a keydown event, as the shortcut field records it: the platform's
 * primary modifier becomes `Mod`. null for a lone modifier / unsupported key.
 */
export function shortcutFromEvent(e, { mac = isMac() } = {}) {
  const key = eventKey(e);
  if (!key) return null;
  const mods = new Set();
  if (mac) {
    if (e.metaKey) mods.add('Mod');
    if (e.ctrlKey) mods.add('Ctrl');
  } else {
    if (e.ctrlKey) mods.add('Mod');
    if (e.metaKey) mods.add('Meta');
  }
  if (e.altKey) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  return stringify({ mods, key });
}

/**
 * Does keydown `e` trigger shortcut `str` (string or parsed)? Modifier state must match exactly.
 * `Mod` is ⌘ on Mac and Ctrl elsewhere; on Mac `Meta` is ⌘ too, elsewhere `Ctrl` is Ctrl too.
 */
export function matchesShortcut(str, e, { mac = isMac() } = {}) {
  const p = typeof str === 'string' ? parseShortcut(str) : str;
  if (!p || !e) return false;
  const wantCtrl = p.mods.has('Ctrl') || (!mac && p.mods.has('Mod'));
  const wantMeta = p.mods.has('Meta') || (mac && p.mods.has('Mod'));
  if (!!e.ctrlKey !== wantCtrl || !!e.metaKey !== wantMeta) return false;
  if (!!e.altKey !== p.mods.has('Alt') || !!e.shiftKey !== p.mods.has('Shift')) return false;
  return eventKey(e) === p.key;
}
