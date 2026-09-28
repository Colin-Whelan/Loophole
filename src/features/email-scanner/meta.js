import { ruleSettings } from './scan.js';

export default {
  id: 'email-scanner',
  name: 'Email HTML check',
  description: 'Checks campaign email HTML for accessibility, deliverability and rendering problems, in a banner on the campaign page.',
  group: 'campaigns',
  frame: 'top',
  routes: [/^\/campaigns\//],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'rescan', label: 'Rescan email HTML' }],
  // One switch per rule, grouped by category (each section gets Turn all on / Turn all off).
  settings: ruleSettings(),
  customSettings: false,
  legacy: ['Iterable Email HTML Scanner'],
};
