import { EDITOR_COMMANDS, FONT_FAMILIES, FONT_SIZE_MIN, FONT_SIZE_MAX } from './commands.js';

const FONT_LABELS = { '': 'Editor default' };

export default {
  id: 'live-preview',
  name: 'Live preview editor',
  description: 'Live preview beside the template code editor, with JSON test data, saved payloads, a user\'s profile as test data, a field pusher, snippets and editor shortcuts.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates\/editor\?(?:.*&)?templateId=/],
  defaultEnabled: true,
  // Only "Push new value" (POST /api/users/update) uses the project's key; the preview, test data
  // and profile loading use your Iterable session.
  usesApiKey: true,
  actions: [],
  settings: [
    {
      key: 'previewWidth', type: 'number', label: 'Preview width (%)', min: 25, max: 75, step: 1, default: 50,
      section: 'Preview',
      help: 'Share of the editor area the live preview takes. Dragging the divider saves it here.',
    },
    {
      key: 'refreshShortcut', type: 'shortcut', label: 'Save and refresh the preview', default: 'Mod+S',
      section: 'Preview',
      help: 'Works everywhere on the template editor page, including inside the code editor. The default (Ctrl+S, ⌘S on a Mac) replaces the browser\'s "Save page" shortcut there while the live preview is on.',
    },
    {
      key: 'fontFamily', type: 'select', label: 'Code editor font', default: '',
      section: 'Code editor',
      options: FONT_FAMILIES.map((f) => ({ value: f, label: FONT_LABELS[f] ?? f })),
      help: 'Must be installed on your computer (nothing is downloaded); otherwise the next font in the list is used.',
    },
    {
      key: 'fontSize', type: 'number', label: 'Code editor font size (px)', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1, default: 13,
      section: 'Code editor',
      help: 'Applies together with a font chosen above.',
    },
    {
      key: 'keybindings', type: 'objectList', label: 'Keybindings', section: 'Code editor',
      help: 'Extra shortcuts inside the code editor. They win over the editor\'s own shortcuts for the same keys.',
      itemLabel: 'Keybinding', titleField: 'command', maxItems: 40,
      fields: [
        { key: 'command', type: 'select', label: 'Command', options: EDITOR_COMMANDS },
        { key: 'keys', type: 'shortcut', label: 'Keys', required: true },
      ],
      default: [
        { command: 'selectNextOccurrence', keys: 'Mod+D' },
        { command: 'deleteLine', keys: 'Mod+Shift+K' },
        { command: 'duplicateLine', keys: 'Mod+Shift+D' },
        { command: 'moveLineUp', keys: 'Alt+ArrowUp' },
        { command: 'moveLineDown', keys: 'Alt+ArrowDown' },
      ],
    },
    {
      key: 'snippets', type: 'objectList', label: 'Quick inserts', section: 'Quick inserts',
      help: 'Buttons above the code editor. In the text, ${1:placeholder} is selected after inserting and $0 is where Tab takes the cursor next.',
      itemLabel: 'Insert', titleField: 'name', layout: 'cards', maxItems: 40,
      fields: [
        { key: 'name', type: 'string', label: 'Button label', required: true, placeholder: '{{#if}}' },
        { key: 'body', type: 'text', label: 'Text to insert', mono: true, rows: 3, required: true },
        { key: 'shortcut', type: 'shortcut', label: 'Shortcut (optional)', help: 'Inside the code editor only.' },
      ],
      default: [
        { name: '{{#assign}}', body: '{{#assign "${1:varName}" }}VALUE{{/assign}}$0', shortcut: '' },
        { name: '{{#if}}', body: '{{#if ${1:condition}}}\nOUTPUT\n{{/if}}$0', shortcut: '' },
        { name: '{{#each}}', body: '{{#each ${1:array}}}\nOUTPUT\n{{/each}}$0', shortcut: '' },
        { name: '{{#unless}}', body: '{{#unless ${1:condition}}}\nOUTPUT\n{{/unless}}$0', shortcut: '' },
        { name: '{{{snippet}}}', body: '{{{ snippet "${1:name}" }}}$0', shortcut: '' },
      ],
    },
  ],
  customSettings: false,
  legacy: ['Iterable - Live Preview Editor'],
};
