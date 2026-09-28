import { HISTORY_LIMIT, SNAPSHOT_MAX_CHARS, BASELINE_MAX_WIRE_CHARS } from './history.js';

export default {
  id: 'bee-undo',
  name: 'Delete confirm + undo',
  description: 'Skips the drag-and-drop editor’s delete prompt and keeps an undo history, with redo.',
  group: 'templates',
  frame: 'top',
  // The editor-frame half (bee.js) auto-confirms the delete prompt and reports each template
  // load; the top half keeps the snapshots and posts BEE's own `load` to restore one.
  companionFrames: ['bee'],
  frameMessages: {
    // bee → top: the template BEE was just given by Iterable (the undo baseline).
    // loadedAt = Date.now() in the editor frame when the load arrived.
    baseline: {
      fields: {
        json: { type: 'string', maxLength: SNAPSHOT_MAX_CHARS },
        loadedAt: { type: 'number', min: 0 },
      },
      maxChars: BASELINE_MAX_WIRE_CHARS,
    },
    // bee → top: a load too large to keep; the history can't reach back past it.
    baselineTooBig: {
      fields: { chars: { type: 'integer', min: 0 }, loadedAt: { type: 'number', min: 0 } },
      maxChars: 256,
    },
    // bee → top: answer to the top half's claim challenge (a nonce it posted to the editor
    // frame's window only), binding this peer as the editor frame.
    claim: { fields: { nonce: { type: 'string', maxLength: 64 } }, maxChars: 128 },
    // bee → top: the undo / redo shortcut was pressed while the editor frame had focus.
    undo: { fields: {}, maxChars: 16 },
    redo: { fields: {}, maxChars: 16 },
  },
  routes: [/^\/templates\/editor/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'autoConfirmDelete', type: 'boolean', label: 'Auto-confirm delete', default: false,
      help: 'Clicks the editor’s “Delete” confirmation for you as soon as it opens, so one click on '
        + 'a row or content block’s delete icon removes it. Off by default because it skips a '
        + 'safety prompt; Undo can bring a deletion back while you stay on the template. The same '
        + 'switch sits next to the editor’s action bar.',
    },
    {
      key: 'historyLimit', type: 'number', label: 'Undo steps to keep',
      min: HISTORY_LIMIT.min, max: HISTORY_LIMIT.max, step: 1, default: HISTORY_LIMIT.default,
      help: 'Undo and redo steps together. The history lives in this tab’s memory only: it is '
        + 'never saved, and it starts over when you open another template, reload the page or the '
        + 'editor reloads. Very large templates may keep fewer steps.',
    },
    {
      key: 'undoShortcut', type: 'shortcut', label: 'Undo shortcut', default: '',
      help: 'Works in the editor and on the page around it, but not while you are typing in a '
        + 'text field. Mod+Z (Ctrl/⌘+Z) is what the old userscript used. Empty: button only.',
    },
    {
      key: 'redoShortcut', type: 'shortcut', label: 'Redo shortcut', default: '',
      help: 'Same rules as the undo shortcut; for example Mod+Shift+Z. The Redo button appears '
        + 'after an undo and goes away as soon as you make a new change. Empty: button only.',
    },
  ],
  customSettings: false,
  legacy: ['Iterable - Auto Confirm Delete + Undo'],
};
