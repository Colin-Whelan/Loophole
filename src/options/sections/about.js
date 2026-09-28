import { h } from '../../core/dom.js';
import { kv } from '../../ui/components.js';
import { heading } from './common.js';

const REPO_URL = 'https://github.com/Colin-Whelan/loophole';
const ISSUES_URL = REPO_URL + '/issues';

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

export function render(main) {
  const m = chrome.runtime.getManifest();
  main.append(
    ...heading('About Loophole for Iterable',
      'Loophole for Iterable is a community project. It is not made, endorsed or supported by Iterable.'),
    h('div', { class: 'card form-card' },
      kv([
        ['Version', m.version],
        ['Browser', navigator.userAgent.includes('Firefox/') ? 'Firefox' : 'Chrome'],
        ['Source', link(REPO_URL, 'github.com/Colin-Whelan/loophole')],
        ['Problems', link(ISSUES_URL, 'Report a problem')],
      ]),
      h('p', { class: 'wb-help' },
        'When reporting a problem, include the feature name, the page path, what you expected, and any [Loophole:…] console lines. Never paste API keys or customer data.'),
      h('p', { class: 'wb-help', style: 'margin:0' },
        'Your API keys and settings are stored only in this browser profile. Loophole talks to Iterable and nothing else.')),
  );
}
