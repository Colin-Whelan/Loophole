// Shared by meta.js (settings options), index.js (isolated) and main.js (page world). Pure, no
// DOM at import time: main.js bundles this into the MAIN-world script, meta.js into everything.

import { parseShortcut } from '../../core/shortcut.js';

/**
 * Editor commands a keybinding can run: the Live Preview Editor script's ACE_COMMAND_BANK.
 * `refreshPreview` is handled by the isolated side (a window shortcut, like the script's own
 * refresh shortcut); the others are Ace commands added by main.js.
 */
export const EDITOR_COMMANDS = Object.freeze([
  { value: 'refreshPreview', label: 'Refresh preview' },
  { value: 'selectNextOccurrence', label: 'Select next occurrence' },
  { value: 'deleteLine', label: 'Delete line' },
  { value: 'duplicateLine', label: 'Duplicate line/selection' },
  { value: 'moveLineUp', label: 'Move line up' },
  { value: 'moveLineDown', label: 'Move line down' },
  { value: 'selectAll', label: 'Select all' },
  { value: 'toggleComment', label: 'Toggle comment' },
  { value: 'toUpperCase', label: 'Transform to uppercase' },
  { value: 'toLowerCase', label: 'Transform to lowercase' },
  { value: 'blockIndent', label: 'Indent selection' },
  { value: 'blockOutdent', label: 'Outdent selection' },
  { value: 'joinLines', label: 'Join lines' },
  { value: 'sortLinesAsc', label: 'Sort lines (A→Z)' },
  { value: 'foldAll', label: 'Fold all' },
  { value: 'unfoldAll', label: 'Unfold all' },
  { value: 'find', label: 'Find' },
  { value: 'replace', label: 'Find & replace' },
]);

export const COMMAND_NAMES = Object.freeze(EDITOR_COMMANDS.map((c) => c.value));

/**
 * Editor fonts. Only fonts installed on the computer are used (nothing is downloaded); each falls
 * back to the next one in its stack. '' = leave the editor's own font alone.
 */
export const FONT_FAMILIES = Object.freeze(['', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Consolas']);

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

/** CSS font-family stack for an allowed family, or '' (default / not allowed). */
export function fontStack(family) {
  if (typeof family !== 'string' || !family || !FONT_FAMILIES.includes(family)) return '';
  return `'${family}', 'Cascadia Code', Consolas, monospace`;
}

// Ace key names for our canonical key tokens (core/shortcut.js) where they differ.
const ACE_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Esc', Enter: 'Return', PageUp: 'PageUp', PageDown: 'PageDown',
};

/**
 * A canonical shortcut ('Mod+Shift+D') → Ace bindKey { win, mac } ('Ctrl-Shift-D' /
 * 'Command-Shift-D'), or null for '' / malformed. Mod is Ctrl on Windows/Linux and Command on a
 * Mac (the script bound Ctrl, and Cmd on Mac).
 */
export function aceBindKey(shortcut) {
  const p = parseShortcut(shortcut);
  if (!p) return null;
  const key = ACE_KEYS[p.key] || p.key;
  const win = [];
  const mac = [];
  if (p.mods.has('Mod')) { win.push('Ctrl'); mac.push('Command'); }
  if (p.mods.has('Ctrl')) { if (!win.includes('Ctrl')) win.push('Ctrl'); mac.push('Ctrl'); }
  if (p.mods.has('Alt')) { win.push('Alt'); mac.push('Option'); }
  if (p.mods.has('Shift')) { win.push('Shift'); mac.push('Shift'); }
  if (p.mods.has('Meta')) { win.push('Meta'); if (!mac.includes('Command')) mac.push('Command'); }
  return { win: [...win, key].join('-'), mac: [...mac, key].join('-') };
}

/** What main.js accepts as an Ace bindKey string (the page can send anything). */
export const BIND_KEY_RE = /^(?:(?:Ctrl|Alt|Shift|Meta|Command|Option)-){0,5}(?:[A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Up|Down|Left|Right|Esc|Return|PageUp|PageDown|Space|Tab|Backspace|Delete|Insert|Home|End|[/.,;'[\]\\=`-])$/;
