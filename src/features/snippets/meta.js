export default {
  id: 'snippets',
  name: 'Snippet viewer',
  description: 'Search, preview and copy snippets from anywhere in Iterable.',
  group: 'templates',
  frame: 'top',
  routes: [/.*/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'open', label: 'Open snippets' }],
  settings: [
    {
      key: 'showInNavbar', type: 'boolean', label: 'Show in the navbar',
      help: 'Adds a Snippets item to the Loophole strip in Iterable’s top navbar. The template editor toolbar always gets its own Snippets button.',
      default: true,
    },
    {
      key: 'cacheMinutes', type: 'number', label: 'Refresh the cached list after (minutes)',
      help: 'Snippets are cached per project. Opening the viewer after this long shows the cached list and refreshes it in the background. 0 = only refresh when you click Refresh.',
      min: 0, max: 10080, step: 1, default: 60,
    },
    {
      key: 'openShortcut', type: 'shortcut', label: 'Open the snippet viewer',
      help: 'Optional keyboard shortcut, anywhere in Iterable.',
      default: '',
    },
  ],
  customSettings: false,
  legacy: ['Iterable Snippet Viewer'],
};
