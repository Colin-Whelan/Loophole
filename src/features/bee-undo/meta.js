// Stub registered by the orchestrator; the porting agent replaces this.
export default {
  id: 'bee-undo',
  name: 'Delete confirm + undo',
  description: 'Skips the drag-and-drop editor’s delete prompt and keeps an undo history.',
  group: 'templates',
  frame: 'top',
  routes: [/^\/templates\/editor/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [],
  customSettings: false,
  legacy: ['Iterable - Auto Confirm Delete + Undo'],
};
