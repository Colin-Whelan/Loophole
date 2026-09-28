export default {
  id: 'profile-editor',
  name: 'Profile editor',
  description: 'Edit buttons beside each field in the profile data view, plus "Add field". Values are type-checked against the project\'s field list and saved through the API.',
  group: 'users',
  frame: 'top',
  routes: [/^\/users\/profiles\//],
  defaultEnabled: true,
  usesApiKey: true,
  actions: [],
  settings: [
    {
      key: 'mergeNested', type: 'boolean', label: 'Merge nested objects by default', default: true,
      help: 'Initial state of the toggle in the editor. On, saving an object field keeps the keys you didn\'t send; off, it replaces the whole object.',
    },
    {
      key: 'showNotifications', type: 'boolean', label: 'Show success notifications', default: true,
      help: 'Toasts after a field is saved, cleared or restored. Errors are always shown.',
    },
  ],
  customSettings: false,
  legacy: ['Iterable Profile Editor'],
};
