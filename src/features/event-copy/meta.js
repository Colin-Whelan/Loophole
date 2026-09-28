export default {
  id: 'event-copy',
  name: 'Copy event data',
  description: 'Adds a Copy dataFields button to custom events in a user’s event history.',
  group: 'users',
  frame: 'top',
  // The Event History tab (…/event/history) is checked inside the feature, as the userscript did.
  routes: [/^\/users\/profiles\//],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'allEvents', type: 'boolean', label: 'Show on all events',
      help: 'Also add the button to system events (email sends, opens, clicks…), not only custom events.',
      default: false,
    },
  ],
  customSettings: false,
  legacy: ['Iterable Event History - Copy dataFields'],
};
