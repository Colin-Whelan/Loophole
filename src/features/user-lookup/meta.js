export default {
  id: 'user-lookup',
  name: 'User lookup',
  description: 'Find a user by email or userId from the top bar and jump straight to their profile.',
  group: 'navigation',
  frame: 'top',
  routes: [/.*/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'focusShortcut', type: 'shortcut', label: 'Focus the lookup box',
      help: 'Jump to the user lookup input from anywhere in the app. Empty turns the shortcut off.',
      default: '',
    },
  ],
  customSettings: false,
  legacy: ['Enhanced User Lookup Bar'],
};
