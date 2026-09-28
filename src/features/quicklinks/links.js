// Pure helpers for the quicklinks feature (ARCHITECTURE §8.1 objectList `links`). No DOM: unit
// tested directly, and shared by meta.js's validator and index.js's render.

/**
 * true when `url` is safe to put in an href: a relative path (not protocol-relative "//host…",
 * which is effectively an external URL) or an https:// URL. Rejects javascript:, data:, and any
 * other scheme.
 */
export function isSafeQuickLinkUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return false;
  if (s.startsWith('/')) return !s.startsWith('//');
  try {
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
