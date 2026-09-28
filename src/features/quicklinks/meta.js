import { validateQuickLinkUrl } from './links.js';

export default {
  id: 'quicklinks',
  name: 'Quicklinks',
  description: 'Your own shortcuts in Iterable’s top bar.',
  group: 'navigation',
  frame: 'top',
  routes: [/.*/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'links',
      type: 'objectList',
      label: 'Quicklinks',
      help: 'Shown in the shared Loophole strip, next to the Iterable logo.',
      itemLabel: 'Link',
      titleField: 'name',
      fields: [
        { key: 'name', type: 'string', label: 'Name', required: true, placeholder: 'Lists' },
        {
          key: 'url', type: 'string', label: 'URL', mono: true, required: true, placeholder: '/lists',
          validate: validateQuickLinkUrl,
        },
      ],
      default: [
        { name: 'Lists', url: '/lists' },
        { name: 'User lookup', url: '/users/lookup' },
      ],
      reorderable: true,
    },
    { key: 'openInNewTab', type: 'boolean', label: 'Open links in a new tab', default: false },
  ],
  customSettings: false,
  legacy: ['Custom Quicklinks'],
};
