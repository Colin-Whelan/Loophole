export default {
  id: 'quick-search',
  name: 'Quick search tags',
  description: 'One-click saved searches above the template list.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  // Both values are edited by settings-ui.js (hidden: the generated form must not render them,
  // or its Save would write back a stale copy of the tag list).
  settings: [
    {
      key: 'tags', type: 'tagList', label: 'Tags', hidden: true,
      help: '[{ id, label, colorGradient: { start, end }, timestamp }]',
      default: [],
    },
    {
      key: 'sortOrder', type: 'select', label: 'Tag order', hidden: true,
      options: [
        { value: 'custom', label: 'Custom (drag to reorder)' },
        { value: 'alpha', label: 'Alphabetical' },
        { value: 'recent', label: 'Newest first' },
      ],
      default: 'custom',
    },
  ],
  customSettings: true,
  legacy: ['Iterable Template Quick Search'],
};
