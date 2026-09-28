// Theme controller: general.theme ('light' | 'dark' | 'system') → data-wb-theme on every
// registered .wb element (shadow-root wrappers, popup/options <body>). 'system' follows
// prefers-color-scheme live.

import * as settings from '../core/settings.js';
import { setDebug } from '../core/log.js';

const elements = new Set();
let preference = 'light';
let mql = null;

function systemDark() {
  if (!mql && typeof matchMedia === 'function') {
    mql = matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => { if (preference === 'system') applyAll(); });
  }
  return !!mql?.matches;
}

export function resolvedTheme() {
  if (preference === 'system') return systemDark() ? 'dark' : 'light';
  return preference === 'dark' ? 'dark' : 'light';
}

function applyAll() {
  const t = resolvedTheme();
  for (const el of elements) el.setAttribute('data-wb-theme', t);
}

/** Keep `el`'s data-wb-theme in sync. Returns an unregister function. */
export function themed(el) {
  elements.add(el);
  el.setAttribute('data-wb-theme', resolvedTheme());
  return () => elements.delete(el);
}

export function setThemePreference(pref) {
  preference = pref;
  applyAll();
}

let watching = null;
/**
 * Load settings once and follow general.theme / general.debug from then on.
 * Idempotent; every entry point calls it. Resolves with the initial resolved settings.
 */
export function watchGeneralSettings() {
  if (!watching) {
    watching = settings.load().then((s) => {
      setThemePreference(s.general.theme);
      setDebug(s.general.debug);
      settings.subscribe((next) => {
        setThemePreference(next.general.theme);
        setDebug(next.general.debug);
      });
      return s;
    });
  }
  return watching;
}
