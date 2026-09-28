// Stub registered by the orchestrator; the porting agent replaces this.
export default {
  id: 'live-preview',
  name: 'Live preview editor',
  description: 'Live preview beside the code editor, with test data, profile data and editor shortcuts.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates\/editor\?(?:.*&)?templateId=/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [],
  customSettings: false,
  legacy: ['Iterable - Live Preview Editor'],
};
