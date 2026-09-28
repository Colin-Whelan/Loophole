// Image library: port of "Iterable Image Path Selector" v2.0.0. A "Creative Library" button in the
// template editor opens an asset browser (folders, search, sort, paging, new folder, upload) and
// clicking an image copies its URL. The browser itself (browser.js) is editor-agnostic so a later
// BEE image picker can reuse it in 'pick' mode.
export default {
  id: 'image-library',
  name: 'Image library',
  description: 'Browse, upload and copy image paths from the template editor.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates\//],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'open', label: 'Open image library' }],
  settings: [
    {
      key: 'sortBy', type: 'select', label: 'Sort by',
      options: [
        { value: 'UpdatedAt', label: 'Date updated' },
        { value: 'CreatedAt', label: 'Date created' },
        { value: 'Name', label: 'Name' },
        { value: 'Size', label: 'Size' },
      ],
      default: 'UpdatedAt',
      help: 'Also changes when you pick a sort in the library window.',
    },
    {
      key: 'sortDirection', type: 'select', label: 'Sort direction',
      options: [{ value: 'Descending', label: 'Descending' }, { value: 'Ascending', label: 'Ascending' }],
      default: 'Descending',
    },
    {
      key: 'itemsPerPage', type: 'select', label: 'Items per page',
      options: ['20', '30', '50', '100'].map((v) => ({ value: v, label: v })),
      default: '30',
    },
    {
      key: 'skipEditStep', type: 'boolean', label: 'Skip the edit step when uploading',
      help: 'Upload files straight away with their original names and no alt text.',
      default: false,
    },
  ],
  customSettings: false,
  legacy: ['Iterable Image Path Selector'],
};
