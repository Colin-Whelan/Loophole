// Pure helpers for the delete-user feature. No DOM, no chrome.*: unit-tested in Node
// (test/features/delete-user*.test.js). Selectors and parsing lifted from the
// "Iterable Delete User" userscript.

import { isOutcomeUnknown } from '../../core/retry.js';
import { USER_IDENTITY_FIELDS as FIELDS } from '../../lib/iterable/users.js';

// Profile-page readers and user lookups live in the shared data layer (ARCHITECTURE §5.5);
// re-exported so this feature's callers and tests keep one import site.
export {
  profileIdFromPath, extractUserId, pickEmail, emailFromContactRows,
} from '../../lib/iterable/profile-page.js';
export {
  publicLookupRequest, appLookupPath, interpretPublicLookup, interpretAppLookup,
} from '../../lib/iterable/users.js';

/**
 * Which identifier to preselect. 'auto' (the default, as in the userscript): userId when the
 * profile shows one (byUserId works on every project type; the email endpoint fails on
 * userId-based projects), else email. 'email' / 'userId': that one when the profile shows it,
 * else the other one. null when the profile shows neither.
 */
export function pickKind(preferred, ref) {
  const order = preferred === 'email' ? ['email', 'userId'] : ['userId', 'email'];
  return order.find((k) => ref && ref[k]) || null;
}

/** The public API host for a data center. */
export function apiHost(dataCenter) {
  return dataCenter === 'eu' ? 'api.eu.iterable.com' : 'api.iterable.com';
}

/**
 * DELETE endpoint for one identifier. encodeURIComponent turns a "/" in the identifier into %2F
 * rather than an extra path segment.
 */
export function deletePath(kind, value) {
  return kind === 'email'
    ? '/api/users/' + encodeURIComponent(value)
    : '/api/users/byUserId/' + encodeURIComponent(value);
}

// ── Comparing ──────────────────────────────────────────────────────────────

// Iterable's own date format: "2021-03-04 12:34:56 +00:00" (optionally with fractional seconds).
const ITERABLE_DATE_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})$/;
// ISO with an explicit zone. Strings without a zone are ambiguous (local time) and skipped.
const ISO_ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A date as epoch ms, or null when it isn't in a format we can read unambiguously. */
export function parseDateMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{9,13}$/.test(s)) return parseDateMs(Number(s));
  let m = ITERABLE_DATE_RE.exec(s);
  if (m) {
    let zone = m[3];
    if (zone !== 'Z' && !zone.includes(':')) zone = zone.slice(0, 3) + ':' + zone.slice(3);
    const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
    return Number.isNaN(t) ? null : t;
  }
  if (ISO_ZONED_RE.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const COMPARATORS = {
  email: (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(),
  userId: (a, b) => String(a).trim() === String(b).trim(),
  itblUserId: (a, b) => String(a).trim() === String(b).trim(),
  // One side may truncate to whole seconds.
  signupDate: (a, b) => Math.abs(a - b) < 1000,
};

function comparable(field, v) {
  if (field === 'signupDate') return parseDateMs(v);
  return typeof v === 'string' || typeof v === 'number' ? v : null;
}

/**
 * Compare what the saved key's project returns with what the app session returns.
 *   api, app:    results of interpretPublicLookup / interpretAppLookup.
 *   lookedUpBy:  'email' | 'userId', the identifier both lookups used. Both sides agree on it by
 *                construction, so it never counts as evidence on its own.
 *   profileId:   the profile URL segment (plausibly the itblUserId). When the key's record has an
 *                itblUserId equal to it (and the app's, if it has one, agrees too), that counts as
 *                an independent agreeing field, 'profileId'. A difference is ignored: what the
 *                segment is hasn't been confirmed yet.
 * → { outcome, compared: [field], mismatched: [field], independent: [field], message? }
 *   outcome 'match'     both found, every shared field agrees, and at least one field other than
 *                       lookedUpBy agrees (`independent`)
 *           'mismatch'  both found, at least one shared field disagrees
 *           'not-found' the app sees the user, the key's project doesn't
 *           'unknown'   either lookup failed, the app couldn't find the user, or nothing
 *                       independent to compare
 */
export function compareLookups(api, app, { lookedUpBy, profileId } = {}) {
  const none = { compared: [], mismatched: [], independent: [] };
  if (!app || app.status === 'error') {
    return { outcome: 'unknown', ...none, message: `The app lookup failed${app?.message ? ` (${app.message})` : ''}.` };
  }
  if (!api || api.status === 'error') {
    return { outcome: 'unknown', ...none, message: `The API lookup failed${api?.message ? ` (${api.message})` : ''}.` };
  }
  if (app.status === 'not-found') {
    return { outcome: 'unknown', ...none, message: "The app's own lookup didn't find this user." };
  }
  if (api.status === 'not-found') return { outcome: 'not-found', ...none };

  const compared = [], mismatched = [];
  for (const field of FIELDS) {
    const a = comparable(field, api.user[field]);
    const b = comparable(field, app.user[field]);
    if (a == null || b == null) continue;
    compared.push(field);
    if (!COMPARATORS[field](a, b)) mismatched.push(field);
  }
  if (!compared.length) {
    return { outcome: 'unknown', compared, mismatched, independent: [], message: 'The two lookups share no fields to compare.' };
  }
  if (mismatched.length) return { outcome: 'mismatch', compared, mismatched, independent: [] };

  const independent = compared.filter((f) => f !== lookedUpBy);
  const pid = typeof profileId === 'string' ? profileId.trim() : '';
  const apiItbl = comparable('itblUserId', api.user.itblUserId);
  const appItbl = comparable('itblUserId', app.user.itblUserId);
  if (pid && apiItbl != null && COMPARATORS.itblUserId(apiItbl, pid) &&
      (appItbl == null || COMPARATORS.itblUserId(appItbl, pid))) {
    independent.push('profileId');
  }
  if (!independent.length) {
    return {
      outcome: 'unknown', compared, mismatched, independent,
      message: `Both lookups found the ${lookedUpBy || 'identifier'}, but returned no other field to confirm it's the same user.`,
    };
  }
  return { outcome: 'match', compared, mismatched, independent };
}

// ── Delete outcome ─────────────────────────────────────────────────────────

/** Whether a single wb:api response counts as a successful delete. */
export function isDeleteSuccess(r) {
  if (!r || !r.ok) return false;
  const d = r.data;
  if (d && typeof d === 'object' && typeof d.code === 'string') return d.code === 'Success';
  return true;
}

/**
 * Was this response one where the request may or may not have reached Iterable (NETWORK /
 * TIMEOUT)? Retries use core/retry.js's default policy, which retries exactly these plus 429/5xx.
 */
export function isUncertain(r) {
  return !!r && isOutcomeUnknown(r);
}

/**
 * Final verdict after sendWithRetry.
 *   result          sendWithRetry's resolution
 *   sawUncertain    an earlier attempt ended in NETWORK/TIMEOUT
 * → { kind: 'deleted' | 'unknown' | 'failed', message }
 */
export function classifyDelete(result, { sawUncertain = false } = {}) {
  if (result?.ok) return { kind: 'deleted', message: '' };
  const resp = result?.response;
  if (isUncertain(resp) || sawUncertain) {
    return { kind: 'unknown', message: "Couldn't confirm the delete. Reload the profile to check." };
  }
  const d = resp?.data;
  if (resp?.ok && d && typeof d === 'object' && typeof d.code === 'string') {
    return { kind: 'failed', message: d.code + (typeof d.msg === 'string' && d.msg ? ': ' + d.msg : '') };
  }
  return { kind: 'failed', message: result?.error?.message || `HTTP ${result?.status || 0}` };
}

/** Long identifiers get elided in the middle: both ends carry meaning. */
export function ellipsize(s, max = 64) {
  s = String(s == null ? '' : s);
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head));
}
