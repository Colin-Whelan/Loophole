export default {
  id: 'creative-previews',
  name: 'Creative library previews',
  description: 'Bigger thumbnails, hover previews and click-to-copy in the Creative Library.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/creativeLibrary/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'thumbSize', type: 'number', label: 'Thumbnail size (px)',
      help: 'Width and height of each grid preview.', default: 120, min: 60, max: 400, step: 10,
    },
    {
      key: 'rowHeight', type: 'number', label: 'Row height (px)',
      help: 'Minimum height of each grid row.', default: 140, min: 60, max: 420, step: 10,
    },
    {
      key: 'hoverPreview', type: 'boolean', label: 'Show a full-size preview on hover', default: true,
    },
    {
      key: 'hoverSize', type: 'number', label: 'Hover preview max size (px)',
      default: 600, min: 200, max: 1200, step: 20,
    },
    {
      key: 'hoverDelay', type: 'number', label: 'Hover delay (ms)',
      default: 150, min: 0, max: 2000, step: 50,
    },
  ],
  customSettings: false,
  legacy: ['Iterable Creative Library - Bigger Previews'],
};
