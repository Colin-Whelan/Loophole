// Settings page (mockup: "Settings page"). Hash routing:
//   #welcome  #keys  #features  #general  #feature/<id> (or #feature?id=<id>)  #import  #about
// A section module exports render(main, route) → optional cleanup.

import { STORAGE } from '../core/messages.js';
import { h, clear, append } from '../core/dom.js';
import * as storage from '../core/storage.js';
import { listProjects } from '../core/keys.js';
import { FEATURES, hasSettings, getMeta } from '../features/registry.js';
import { themed, watchGeneralSettings } from '../ui/theme.js';
import { mark, chip, toast } from '../ui/components.js';
import { importers } from '../features/optional.js';
import { runStashedMappers, takeUnannounced } from './importer/apply.js';

import * as welcome from './sections/welcome.js';
import * as keys from './sections/keys.js';
import * as features from './sections/features.js';
import * as general from './sections/general.js';
import * as feature from './sections/feature.js';
import * as importSection from './sections/import.js';
import * as about from './sections/about.js';

const SECTIONS = { welcome, keys, features, general, feature, import: importSection, about };

const nav = document.getElementById('nav');
const main = document.getElementById('main');
let cleanup = null;

themed(document.body);
watchGeneralSettings();

export function parseHash(hash) {
  const bare = String(hash || '').replace(/^#/, '');
  // A malformed escape (a hand-typed "#feature%") must not throw: that would leave a blank page.
  let decoded;
  try { decoded = decodeURIComponent(bare); } catch { decoded = bare; }
  const raw = decoded || 'welcome';
  const [pathPart, query = ''] = raw.split('?');
  const [section, ...rest] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { section, arg: rest.join('/') || params.id || '', params };
}

async function renderNav(route) {
  const projects = await listProjects().catch(() => []);
  const link = (hash, label, extra) => {
    const current = hash === route.section || (route.section === 'feature' && hash === `feature/${route.arg}`);
    return h('a', { href: '#' + hash, 'aria-current': current ? 'page' : null }, h('span', null, label), extra);
  };
  const withSettings = FEATURES.filter(hasSettings);
  append(clear(nav),
    h('div', { class: 'opts-brand' }, mark({ large: true }), 'Loophole for Iterable'),
    link('welcome', 'Welcome'),
    link('keys', 'Projects & keys', chip(String(projects.length))),
    link('features', 'Features', chip(String(FEATURES.length))),
    link('general', 'General'),
    withSettings.length ? h('div', { class: 'grp' }, 'Feature settings') : null,
    withSettings.map((m) => link(`feature/${m.id}`, m.name)),
    h('div', { class: 'grp' }, 'Data'),
    link('import', 'Import & export'),
    link('about', 'About'),
    h('div', { class: 'opts-nav-footer' },
      h('a', { href: 'https://ko-fi.com/cocodev', target: '_blank', rel: 'noopener noreferrer' }, 'Support Loophole')),
  );
}

async function render() {
  const route = parseHash(location.hash);
  const mod = SECTIONS[route.section] || welcome;
  if (route.section === 'feature' && !getMeta(route.arg)) route.section = 'features';
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.error('[Loophole:options] cleanup threw', e); }
  }
  cleanup = null;
  renderNav(route);
  clear(main);
  window.scrollTo({ top: 0 });
  try {
    cleanup = await (SECTIONS[route.section] || mod).render(main, route);
  } catch (e) {
    console.error('[Loophole:options]', e);
    main.append(h('h2', null, 'Something went wrong'), h('p', { class: 'lede' }, String(e?.message || e)));
  }
}

window.addEventListener('hashchange', render);
// Keep the nav's key count current when keys change here, in the popup, or in another tab.
storage.subscribe(STORAGE.KEYS, () => renderNav(parseHash(location.hash)));
render();

// Settings saved from Tampermonkey for features that weren't ported yet: if this version can now
// import them, do it once and say so (ARCHITECTURE §8.4, "Everything else is stashed").
// The background may already have done so on update; announce those too.
takeUnannounced().then(async (earlier) => {
  const done = [...earlier, ...await runStashedMappers(importers)];
  if (!done.length) return;
  const names = done.map((d) => getMeta(d.featureId)?.name || d.featureId);
  toast(`Imported your saved Tampermonkey settings for ${names.join(', ')}.`, { tone: 'ok', source: 'Import', timeoutMs: 8000 });
}).catch((e) => console.warn('[Loophole:options] stash import failed', e));
