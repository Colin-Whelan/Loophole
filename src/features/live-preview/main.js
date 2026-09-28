// Live preview editor, PAGE-WORLD half (ARCHITECTURE §6.3). Bundled into main-world.js; the
// isolated half (index.js) reaches these methods through ctx.page.
//
// Only the parts that need the page's Ace editor live here: watching the template editor for
// changes, adding the keybinding / snippet commands and the editor font, inserting snippets, and
// the JSON test-data editors (Ace instances inside elements index.js created).
//
// Rules (review like security code): any page script can call every method below with any
// arguments, so each one only does what page script could already do to its own editor; no
// network (Ace modes/themes are only used when already loaded, the JSON worker is off), no
// navigation, no eval / Function / innerHTML; arguments are type-checked; results are plain JSON
// and never carry secrets (nothing secret ever reaches this side).

import { COMMAND_NAMES, BIND_KEY_RE, fontStack, FONT_SIZE_MIN, FONT_SIZE_MAX } from './commands.js';
import { parseSnippetBody, offsetToPos } from './snippet.js';

const MAX_TEXT = 4 * 1024 * 1024;
const MAX_SNIPPET = 64 * 1024;
const MAX_COMMANDS = 60;
const CMD_PREFIX = 'wbLivePreview_';
const TAB_EXIT = CMD_PREFIX + 'snippetTabExit';
const JSON_ID_RE = /^[a-z0-9-]{1,40}$/;
const CHANGE_MS = 250;
const JSON_CHANGE_MS = 400;

let active = null; // { page, editor, offChange, saved, config, commands: [], json: Map, timer }

function aceLib() {
  const ace = window.ace;
  return ace && typeof ace.edit === 'function' ? ace : null;
}

function aceModule(name) {
  const ace = aceLib();
  if (!ace || typeof ace.require !== 'function') return null;
  try { return ace.require(name) || null; } catch { return null; }
}

/** The Ace editor on `el`, only if the page already made one (never creates one on its own). */
function editorOf(el) {
  if (!el) return null;
  const ed = el.env && el.env.editor;
  if (ed && typeof ed.getValue === 'function') return ed;
  const ace = aceLib();
  if (!ace || !el.classList || !el.classList.contains('ace_editor')) return null;
  try { return ace.edit(el); } catch { return null; }
}

/** Iterable's template editor: #content-editor-ace, else the first page .ace_editor in the
 *  side-by-side container that isn't one of ours (the script's lookup). */
function templateEditor() {
  const byId = editorOf(document.getElementById('content-editor-ace'));
  if (byId) return byId;
  const box = document.getElementById('content-editor-side-by-side');
  if (!box) return null;
  for (const el of box.querySelectorAll('.ace_editor')) {
    if (!el.closest('[data-wb-lp-ace]')) return editorOf(el);
  }
  return null;
}

const isKey = (s) => typeof s === 'string' && s.length <= 40 && BIND_KEY_RE.test(s);

// ── Commands (the script's ACE_COMMAND_BANK; refreshPreview is the isolated side's) ──────────

const BANK = {
  selectNextOccurrence(ed) {
    if (!ed.getSelectedText()) { ed.selection.selectWord(); return; }
    const mod = aceModule('ace/search');
    if (!mod || !mod.Search) return;
    const s = new mod.Search();
    s.setOptions({ needle: ed.getSelectedText(), wrap: true, caseSensitive: true });
    s.$options.start = ed.selection.getRange().end;
    const r = s.find(ed.session);
    if (r) ed.selection.addRange(r);
  },
  deleteLine: (ed) => ed.removeLines(),
  duplicateLine: (ed) => ed.duplicateSelection(),
  moveLineUp: (ed) => ed.moveLinesUp(),
  moveLineDown: (ed) => ed.moveLinesDown(),
  selectAll: (ed) => ed.selectAll(),
  toggleComment: (ed) => ed.toggleCommentLines(),
  toUpperCase: (ed) => ed.toUpperCase(),
  toLowerCase: (ed) => ed.toLowerCase(),
  blockIndent: (ed) => ed.blockIndent(),
  blockOutdent: (ed) => ed.blockOutdent(),
  joinLines(ed) {
    const r = ed.selection.getRange();
    ed.session.replace(r, ed.session.getTextRange(r).replace(/\n\s*/g, ' '));
  },
  sortLinesAsc: (ed) => ed.sortLines(),
  foldAll: (ed) => ed.session.foldAll(),
  unfoldAll: (ed) => ed.session.unfold(),
  find: (ed) => ed.execCommand('find'),
  replace: (ed) => ed.execCommand('replace'),
};

function insertSnippet(ed, body) {
  const { text, stops, final } = parseSnippetBody(body);
  const session = ed.session;
  const range = ed.getSelectionRange();
  const hasSelection = !range.isEmpty();
  const at = hasSelection ? { row: range.start.row, column: range.start.column } : ed.getCursorPosition();
  if (hasSelection) session.replace(range, text); else session.insert(at, text);
  const endPos = offsetToPos(text, final !== null ? final : text.length, at);
  if (stops.length) {
    const RangeCtor = aceModule('ace/range')?.Range;
    const toRange = (s) => {
      const a = offsetToPos(text, s.start, at);
      const b = offsetToPos(text, s.end, at);
      return RangeCtor ? new RangeCtor(a.row, a.column, b.row, b.column) : { start: a, end: b };
    };
    ed.selection.clearSelection();
    ed.selection.setSelectionRange(toRange(stops[0]));
    if (RangeCtor && typeof ed.selection.addRange === 'function') {
      for (let i = 1; i < stops.length; i++) ed.selection.addRange(toRange(stops[i]));
    }
    // Tab (once) jumps to the final position, as in the script.
    ed.commands.addCommand({
      name: TAB_EXIT, bindKey: { win: 'Tab', mac: 'Tab' }, readOnly: false,
      exec: (e) => { e.moveCursorToPosition(endPos); e.clearSelection(); e.commands.removeCommand(TAB_EXIT); },
    });
  } else {
    ed.moveCursorToPosition(endPos);
    ed.clearSelection();
  }
  ed.focus();
}

function removeCommands(ed) {
  if (!ed || !active) return;
  for (const name of active.commands) { try { ed.commands.removeCommand(name); } catch { /* gone */ } }
  try { ed.commands.removeCommand(TAB_EXIT); } catch { /* gone */ }
  active.commands = [];
}

function applyConfig() {
  const ed = active?.editor;
  const cfg = active?.config;
  if (!ed || !cfg) return 0;
  removeCommands(ed);
  let n = 0;
  cfg.bindings.forEach((b) => {
    const name = `${CMD_PREFIX}${b.command}_${n++}`;
    ed.commands.addCommand({ name, bindKey: { win: b.win, mac: b.mac }, exec: (e) => BANK[b.command](e), readOnly: false });
    active.commands.push(name);
  });
  cfg.snippets.forEach((s) => {
    const name = `${CMD_PREFIX}snippet_${n++}`;
    ed.commands.addCommand({ name, bindKey: { win: s.win, mac: s.mac }, exec: (e) => insertSnippet(e, s.body), readOnly: false });
    active.commands.push(name);
  });
  applyFont(ed, cfg.font);
  for (const j of active.json.values()) applyFont(j.ed, cfg.font, true);
  return n;
}

/**
 * Font family/size on the template editor (the page's own values come back when the family is
 * ''); only the family on our JSON editors (`ours`), which keep their own small size.
 */
function applyFont(ed, font, ours = false) {
  const stack = fontStack(font?.family);
  if (ours) { ed.setOption('fontFamily', stack); return; }
  const saved = active.saved;
  if (stack) {
    if (!('fontFamily' in saved)) {
      saved.fontFamily = ed.getOption('fontFamily');
      saved.fontSize = ed.getOption('fontSize');
    }
    ed.setOptions({ fontFamily: stack, fontSize: font.size });
  } else if ('fontFamily' in saved) {
    ed.setOptions({ fontFamily: saved.fontFamily, fontSize: saved.fontSize });
    delete saved.fontFamily;
    delete saved.fontSize;
  }
}

function hookEditor(ed) {
  active.editor = ed;
  active.saved = { scrollPastEnd: ed.getOption('scrollPastEnd') };
  ed.setOption('scrollPastEnd', 0.8);
  const onChange = () => {
    clearTimeout(active?.timer);
    if (!active) return;
    active.timer = setTimeout(() => active?.page.emit('change', {}), CHANGE_MS);
  };
  ed.on('change', onChange);
  active.offChange = () => ed.off('change', onChange);
  applyConfig();
}

function unhookEditor() {
  const ed = active?.editor;
  if (!ed) return;
  clearTimeout(active.timer);
  try { active.offChange?.(); } catch { /* destroyed */ }
  removeCommands(ed);
  try {
    const s = active.saved || {};
    if ('fontFamily' in s) ed.setOptions({ fontFamily: s.fontFamily, fontSize: s.fontSize });
    if ('scrollPastEnd' in s) ed.setOption('scrollPastEnd', s.scrollPastEnd);
  } catch { /* destroyed */ }
  active.editor = null;
  active.offChange = null;
  active.saved = null;
}

// ── JSON test-data editors ─────────────────────────────────────────────────────────────────

function jsonEntry(args) {
  const id = args && args.id;
  return typeof id === 'string' && JSON_ID_RE.test(id) ? active?.json.get(id) || null : null;
}

function destroyJson(id) {
  const j = active?.json.get(id);
  if (!j) return;
  active.json.delete(id);
  clearTimeout(j.timer);
  try { j.ed.destroy(); } catch { /* already gone */ }
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; }
}

const num = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt);

export const methods = {
  /** Find (or re-find) the template editor and hook it. → { ace, editor } */
  attach() {
    if (!active) return { ace: false, editor: false };
    const ed = templateEditor();
    if (ed && ed !== active.editor) { unhookEditor(); hookEditor(ed); }
    if (!ed && active.editor && !active.editor.container?.isConnected) unhookEditor();
    return { ace: !!aceLib(), editor: !!active.editor };
  },

  /**
   * args { bindings: [{ command, win, mac }], snippets: [{ body, win, mac }], font: { family, size } }
   * Replaces every command this feature added. → { ok, commands }
   */
  configure(args) {
    if (!active || !args || typeof args !== 'object') return { ok: false, commands: 0 };
    const bindings = (Array.isArray(args.bindings) ? args.bindings : []).slice(0, MAX_COMMANDS)
      .filter((b) => b && typeof b.command === 'string' && COMMAND_NAMES.includes(b.command) &&
        Object.hasOwn(BANK, b.command) && isKey(b.win) && isKey(b.mac))
      .map((b) => ({ command: b.command, win: b.win, mac: b.mac }));
    const snippets = (Array.isArray(args.snippets) ? args.snippets : []).slice(0, MAX_COMMANDS)
      .filter((s) => s && typeof s.body === 'string' && s.body.length <= MAX_SNIPPET && isKey(s.win) && isKey(s.mac))
      .map((s) => ({ body: s.body, win: s.win, mac: s.mac }));
    const f = args.font && typeof args.font === 'object' ? args.font : {};
    const font = { family: fontStack(f.family) ? f.family : '', size: num(f.size, FONT_SIZE_MIN, FONT_SIZE_MAX, 13) };
    active.config = { bindings, snippets, font };
    return { ok: !!active.editor, commands: applyConfig() };
  },

  /** args { body } → { ok } (inserted at the cursor of the template editor, stop 1 selected). */
  insertSnippet(args) {
    const body = args && args.body;
    if (!active?.editor || typeof body !== 'string' || body.length > MAX_SNIPPET) return { ok: false };
    insertSnippet(active.editor, body);
    return { ok: true };
  },

  /** Re-measure the editors after a layout change. → { ok } */
  resize() {
    try { active?.editor?.resize(true); } catch { /* destroyed */ }
    for (const j of active?.json.values() || []) { try { j.ed.resize(true); } catch { /* gone */ } }
    return { ok: true };
  },

  /**
   * An Ace JSON editor inside the element [data-wb-lp-ace="<id>"] that the isolated side created.
   * args { id, value, popout } → { ok, ace } (ace false: no Ace on this page, use a textarea).
   */
  createJsonEditor(args) {
    if (!active || !args || typeof args.id !== 'string' || !JSON_ID_RE.test(args.id)) return { ok: false, ace: false };
    const value = typeof args.value === 'string' && args.value.length <= MAX_TEXT ? args.value : '';
    const ace = aceLib();
    if (!ace) return { ok: false, ace: false };
    const el = document.querySelector(`[data-wb-lp-ace="${args.id}"]`);
    if (!el) return { ok: false, ace: true };
    destroyJson(args.id);
    let ed;
    try { ed = ace.edit(el); } catch { return { ok: false, ace: true }; }
    const popout = args.popout === true;
    ed.setOptions({
      showPrintMargin: false, showGutter: popout, highlightActiveLine: popout, wrap: true,
      tabSize: 2, useSoftTabs: true, scrollPastEnd: 0, fontSize: popout ? 13 : 12,
      ...(popout ? {} : { minLines: 3, maxLines: 12 }),
    });
    // Only modes/themes the page already loaded: nothing is fetched. No worker (it would load a script).
    try { ed.session.setUseWorker(false); } catch { /* old Ace */ }
    const JsonMode = aceModule('ace/mode/json')?.Mode;
    if (typeof JsonMode === 'function') { try { ed.session.setMode(new JsonMode()); } catch { /* keep text */ } }
    const theme = active.editor?.getTheme?.();
    if (typeof theme === 'string' && theme) { try { ed.setTheme(theme); } catch { /* keep default */ } }
    if (active.config) applyFont(ed, active.config.font, true);
    ed.commands.addCommand({
      name: CMD_PREFIX + 'formatJson', bindKey: { win: 'Ctrl-Shift-F', mac: 'Command-Shift-F' }, readOnly: false,
      exec: (e) => { const p = prettyJson(e.getValue()); if (p !== null) { e.setValue(p, -1); e.clearSelection(); } },
    });
    ed.setValue(value, -1);
    ed.clearSelection();
    const entry = { ed, timer: null };
    ed.on('change', () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => active?.page.emit('json-change', { id: args.id }), JSON_CHANGE_MS);
    });
    active.json.set(args.id, entry);
    if (args.focus === true) ed.focus();
    return { ok: true, ace: true };
  },

  /** args { id } → { ok, value } */
  getJsonValue(args) {
    const j = jsonEntry(args);
    if (!j) return { ok: false };
    const value = String(j.ed.getValue());
    return value.length > MAX_TEXT ? { ok: false } : { ok: true, value };
  },

  /** args { id, value } → { ok } */
  setJsonValue(args) {
    const j = jsonEntry(args);
    if (!j || typeof args.value !== 'string' || args.value.length > MAX_TEXT) return { ok: false };
    j.ed.setValue(args.value, -1);
    j.ed.clearSelection();
    return { ok: true };
  },

  /** args { id } → { ok } */
  destroyJsonEditor(args) {
    if (!jsonEntry(args)) return { ok: false };
    destroyJson(args.id);
    return { ok: true };
  },
};

export function activate(page) {
  active = { page, editor: null, offChange: null, saved: null, config: null, commands: [], json: new Map(), timer: null };
  const mine = active;
  return () => {
    if (active !== mine) return;
    for (const id of [...mine.json.keys()]) destroyJson(id);
    unhookEditor();
    active = null;
  };
}
