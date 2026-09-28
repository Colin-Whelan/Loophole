export default {
  id: 'field-explorer',
  name: 'Field value explorer',
  description: 'Lists every value of a user field, past the 1,200-value autocomplete limit.',
  group: 'data',
  frame: 'top',
  routes: [/^\/segmentation/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'open', label: 'Field values' }],
  settings: [
    { key: 'maxRendered', type: 'number', label: 'Max values rendered', min: 100, max: 20000, step: 100,
      help: 'Caps how many matching values are drawn in the list at once, for DOM performance. Search still filters the full set.',
      default: 2000 },
  ],
  customSettings: false,
  legacy: ['Iterable Field Value Explorer'],
};
