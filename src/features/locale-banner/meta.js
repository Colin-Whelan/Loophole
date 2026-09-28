export default {
  id: 'locale-banner',
  name: 'Locale banner',
  description: 'Flags the locale you are editing in the template editor header.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates\/editor/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'defaultLocale', type: 'string', label: 'Default locale', mono: true, placeholder: 'e.g. en-US',
      help: 'Shown in green. Every other locale is shown in amber. Leave empty to show every locale in the same neutral style.',
      default: '',
    },
    {
      key: 'pulseNonDefault', type: 'boolean', label: 'Pulse when not default',
      help: 'Animates the amber badge so it’s hard to miss. Never animates when your system asks for reduced motion.',
      default: true,
    },
    {
      key: 'hideWhenNoLocale', type: 'boolean', label: 'Hide when the URL has no locale',
      help: 'When off, pages without ?locale= show your default locale (or “Default”).',
      default: true,
    },
  ],
  customSettings: false,
  legacy: ['Iterable Locale Banner'],
};
