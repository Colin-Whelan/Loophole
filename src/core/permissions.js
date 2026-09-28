// Host-permission checks for extension pages (popup, options).
// Firefox MV3 treats host_permissions as opt-in, so the user has to grant them once.
// Optional hosts (manifest optional_host_permissions, e.g. auth.iterable.com) are requested per
// feature when the user switches that feature on (ARCHITECTURE §4, §9).

import { featureOrigins, unneededOrigins } from './feature-frames.js';

export const REQUIRED_ORIGINS = Object.freeze([
  'https://app.iterable.com/*',
  'https://app.eu.iterable.com/*',
  'https://api.iterable.com/*',
  'https://api.eu.iterable.com/*',
  'https://app.getbee.io/*',
]);

export async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: [...REQUIRED_ORIGINS] });
  } catch {
    return false;
  }
}

/**
 * Must be called synchronously from a click handler (no await before it), or the browser
 * rejects the request as not user-initiated.
 */
export function requestHostAccess() {
  return chrome.permissions.request({ origins: [...REQUIRED_ORIGINS] });
}

/** Iterable app URL? (the pages Loophole runs on) */
export function isIterableAppUrl(url) {
  return /^https:\/\/app(\.eu)?\.iterable\.com(\/|$)/.test(String(url || ''));
}

// ── Optional hosts, per feature ──────────────────────────────────────────

/** Are all of the feature's optional origins granted? (true for features that declare none) */
export async function hasFeatureAccess(meta) {
  const origins = featureOrigins(meta);
  if (!origins.length) return true;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Switch a feature on or off from a click / change handler. For a feature with optional origins,
 * switching on calls chrome.permissions.request FIRST and synchronously (it needs the user
 * gesture), then records the choice. `setEnabled(id, on)` → Promise (core/settings.js).
 *
 * The enabled flag is written at once, in parallel with the prompt: Firefox may close the popup
 * while the prompt is up, and then nothing after the prompt runs. The background registers the
 * content script only for enabled ∩ granted (it listens to permissions.onAdded), so an enabled
 * feature without the grant just stays inactive and the UI shows "needs access".
 *
 * Resolves { enabled, denied?, removable? }:
 *   denied     on: the user refused (the flag was put back to off)
 *   removable  off: granted optional origins no enabled feature needs any more (offer removal)
 */
export function setFeatureEnabledFromClick(meta, on, { setEnabled, metas }) {
  const origins = featureOrigins(meta);
  if (!origins.length) return Promise.resolve(setEnabled(meta.id, on)).then(() => ({ enabled: !!on }));
  if (on) {
    let req;
    try {
      req = chrome.permissions.request({ origins });
    } catch (e) {
      req = Promise.reject(e);
    }
    const write = Promise.resolve(setEnabled(meta.id, true));
    return Promise.allSettled([req, write]).then(async ([r]) => {
      if (r.status === 'fulfilled' && r.value === true) return { enabled: true };
      await setEnabled(meta.id, false);
      return { enabled: false, denied: true, error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : '' };
    });
  }
  return Promise.resolve(setEnabled(meta.id, false)).then(async (settings) => ({
    enabled: false,
    removable: await removableOrigins({ metas, settings, candidates: origins }),
  }));
}

/** Of `candidates`, the granted optional origins no enabled feature (per `settings`) needs. */
export async function removableOrigins({ metas, settings, candidates }) {
  const out = [];
  for (const o of unneededOrigins({ metas, settings, candidates })) {
    try { if (await chrome.permissions.contains({ origins: [o] })) out.push(o); } catch { /* ignore */ }
  }
  return out;
}

/** Give back optional origins (the user clicked "Remove access"). Resolves true when removed. */
export function removeOrigins(origins) {
  if (!origins?.length) return Promise.resolve(true);
  return chrome.permissions.remove({ origins: [...origins] }).catch(() => false);
}

/** 'https://auth.iterable.com/*' → 'auth.iterable.com' for display. */
export function originLabel(pattern) {
  return String(pattern).replace(/^https:\/\//, '').replace(/\/\*$/, '');
}

/** cb() when optional permissions change (granted or removed anywhere). Returns unsubscribe. */
export function onPermissionsChanged(cb) {
  const fn = () => cb();
  try {
    chrome.permissions.onAdded.addListener(fn);
    chrome.permissions.onRemoved.addListener(fn);
  } catch { return () => {}; }
  return () => {
    try { chrome.permissions.onAdded.removeListener(fn); chrome.permissions.onRemoved.removeListener(fn); } catch { /* ignore */ }
  };
}
