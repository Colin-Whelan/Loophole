// Small helpers shared by option sections.

import { h, clear } from '../../core/dom.js';
import * as settings from '../../core/settings.js';
import { FEATURES } from '../../features/registry.js';
import { featureOrigins } from '../../core/feature-frames.js';
import {
  hasHostAccess, requestHostAccess, hasFeatureAccess, setFeatureEnabledFromClick, removeOrigins, originLabel,
} from '../../core/permissions.js';
import { button, chip, toast } from '../../ui/components.js';

export function heading(title, lede, ...extra) {
  return [h('h2', null, title, ...extra), lede ? h('p', { class: 'lede' }, lede) : null].filter(Boolean);
}

/**
 * Firefox: host permissions are opt-in. Returns a notice with a grant button when they are
 * missing, or null. `onGranted` runs after the user allows access.
 */
export async function permissionNotice(onGranted) {
  if (await hasHostAccess()) return null;
  const el = h('div', { class: 'notice' },
    h('div', null,
      h('strong', null, 'Loophole needs your permission to run on Iterable. '),
      'Your browser asks before an extension can work on a site. Allow Iterable (US and EU), its API, and the drag-and-drop editor, then reload any open Iterable tabs.'),
    button('Allow Loophole on Iterable', {
      variant: 'primary',
      // Nothing may be awaited before request(): it has to run inside the click.
      onClick: () => requestHostAccess().then((ok) => { if (ok) { el.remove(); onGranted?.(); } }).catch(() => {}),
    }));
  return el;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ── Feature chips and optional host access (Features list and feature settings page) ──────

/** Display hosts of the feature's optional origins ([] when none). */
export const featureHosts = (meta) => featureOrigins(meta).map(originLabel);

/**
 * The "what this feature is" chips, the same on the Features list and the feature's own page.
 * `list: true` adds the list-only "off by default" chip.
 */
export function featureChips(meta, { list = false } = {}) {
  const hosts = featureHosts(meta);
  return [
    meta.usesApiKey ? chip('uses key', { tone: 'accent' }) : null,
    list && meta.defaultEnabled === false ? chip('off by default') : null,
    meta.frame === 'bee' ? chip('drag-and-drop editor') : null,
    meta.frame === 'auth' ? chip('sign-in page') : null,
    hosts.length ? chip(`Needs access to ${hosts.join(', ')}`, { tone: 'warn' }) : null,
  ].filter(Boolean);
}

/**
 * Switch a feature on/off from a click, asking for its optional hosts first when it has any
 * (core/permissions.js; the request must be the first thing the click handler does).
 * `access` (from featureAccess) is refreshed, or offers removal, afterwards.
 */
export function setEnabledFromClick(meta, on, access) {
  if (!featureOrigins(meta).length) return settings.setFeatureEnabled(meta.id, on);
  return setFeatureEnabledFromClick(meta, on, { setEnabled: settings.setFeatureEnabled, metas: FEATURES })
    .then((r) => {
      if (r.denied) toast(`${meta.name} stays off: access to ${featureHosts(meta).join(', ')} was not granted.`, { tone: 'warn' });
      if (r.removable?.length) access?.offerRemoval(r.removable);
      else access?.refresh();
    })
    .catch(() => {});
}

/**
 * Optional-host access line for a feature with meta.permissions.origins (null otherwise):
 * "Runs on … (access granted)", or, when enabled without the grant, a "not granted" chip and an
 * Allow button. → { el, refresh(), offerRemoval(origins) }.
 */
export function featureAccess(meta) {
  const origins = featureOrigins(meta);
  if (!origins.length) return null;
  const hosts = featureHosts(meta).join(', ');
  const el = h('div', { class: 'fd' });

  async function refresh() {
    const granted = await hasFeatureAccess(meta);
    const enabled = !!(await settings.load()).features[meta.id]?.enabled;
    clear(el);
    if (enabled && !granted) {
      el.append(
        chip('not granted', { tone: 'warn', dot: true }), ' ',
        `Allow Loophole on ${hosts} for this feature to run. `,
        button('Allow', {
          variant: 'primary', size: 'sm',
          // Nothing may be awaited before request(): it has to run inside the click.
          onClick: () => setEnabledFromClick(meta, true, api),
        }));
    } else {
      el.append(`Runs on ${hosts}${granted ? ' (access granted)' : '; your browser asks for access when you switch it on'}.`);
    }
  }

  function offerRemoval(removable) {
    if (!removable?.length) { refresh(); return; }
    const list = removable.map(originLabel).join(', ');
    clear(el).append(
      `Loophole can still read pages on ${list}, though nothing uses that now. `,
      button('Remove access', {
        size: 'sm',
        onClick: () => removeOrigins(removable).then((ok) => {
          toast(ok ? `Access to ${list} removed.` : `Couldn’t remove access to ${list}.`, { tone: ok ? undefined : 'warn' });
          refresh();
        }),
      }),
      ' ',
      button('Keep', { variant: 'ghost', size: 'sm', onClick: () => refresh() }));
  }

  const api = { el, refresh, offerRemoval };
  return api;
}
