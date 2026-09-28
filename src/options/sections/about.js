import { h } from '../../core/dom.js';
import { kv } from '../../ui/components.js';
import { heading } from './common.js';

export function render(main) {
  const m = chrome.runtime.getManifest();
  main.append(
    ...heading('About Workbench',
      'Workbench for Iterable is a community project. It is not made, endorsed or supported by Iterable.'),
    h('div', { class: 'card form-card' },
      kv([
        ['Version', m.version],
        ['Browser', navigator.userAgent.includes('Firefox/') ? 'Firefox' : 'Chrome'],
        ['Source', 'Link coming soon'],
        ['Problems', 'Link coming soon'],
      ]),
      h('p', { class: 'wb-help', style: 'margin:0' },
        'Your API keys and settings are stored only in this browser profile. Workbench talks to Iterable and nothing else.')),
  );
}
