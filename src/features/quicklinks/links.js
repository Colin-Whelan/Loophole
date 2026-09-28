// Pure helpers for the quicklinks feature (ARCHITECTURE §8.1 objectList `links`). No DOM: unit
// tested directly, and shared by meta.js's validator and index.js's render.

// Any of these anywhere makes a URL unsafe: browsers treat "\" like "/" and drop tabs/newlines
// while parsing, so "/\evil.example" or "/<TAB>/evil.example" would resolve off-site.
const UNSAFE_CHARS = /[\\\s\u0000-\u001f\u007f-\u009f]/;
const BASE = 'https://app.iterable.com';

/**
 * true when `url` is safe to put in an href. Decided by parsing, not by prefix:
 * - no backslashes, whitespace or control characters anywhere (after trimming the ends);
 * - a relative path ("/lists") must start with "/" and resolve to the same origin as the page
 *   (so "//host", "/\host" and friends are refused);
 * - anything else must be an absolute https: URL (never javascript:, data:, http:, …).
 */
export function isSafeQuickLinkUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s || UNSAFE_CHARS.test(s)) return false;
  try {
    if (s.startsWith('/')) return new URL(s, BASE).origin === BASE;
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Settings-form validator for the `url` sub-field. `required` already covers the empty case. */
export function validateQuickLinkUrl(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  return isSafeQuickLinkUrl(s) ? null : 'Use a relative path (e.g. /lists) or an https:// URL.';
}

/**
 * A stored/edited link item → { name, url } (both trimmed), or null when it isn't safe to render
 * (missing name, or a url that fails isSafeQuickLinkUrl — e.g. corrupted storage or a restored
 * backup that predates this check).
 */
export function normalizeQuickLink(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const url = typeof item.url === 'string' ? item.url.trim() : '';
  if (!name || !isSafeQuickLinkUrl(url)) return null;
  return { name, url };
}

/** A stable slug for a data-test attribute, e.g. "User lookup" → "user-lookup". */
export function quickLinkSlug(name) {
  const slug = String(name ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return slug || 'link';
}
