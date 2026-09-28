export default {
  id: 'export-select',
  name: 'Export field picker',
  description: 'Select all, deselect all or invert the fields in segmentation’s Export to CSV dialog.',
  group: 'data',
  frame: 'top',
  // The dialog is segmentation's ([data-test="modal-segmentation-export-to-csv"]).
  routes: [/^\/segmentation(?:[/?#]|$)/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [],
  customSettings: false,
  legacy: ['Iterable Export CSV - Bulk Select'],
};
