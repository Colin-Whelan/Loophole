// Copying untrusted JSON-shaped data (Tampermonkey exports, Loophole backups) without prototype
// pollution. Pure; no DOM (the background bundles the importer via apply.js).
//
// JSON.parse happily creates an own "__proto__" property. That alone is harmless, but code that
// later does `target[k] = v` or `(obj[a] ||= {})[b] = v` with such a key walks into
// Object.prototype. Everything that builds objects from imported keys goes through these helpers
// (or uses a Map / checks isForbiddenKey itself).

export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN = new Set(FORBIDDEN_KEYS);

export function isForbiddenKey(k) {
  return FORBIDDEN.has(k);
}

const MAX_DEPTH = 64;

/**
 * Deep copy of JSON data: plain objects, arrays, strings, finite numbers, booleans and null.
 * Object keys named __proto__ / constructor / prototype are dropped at every depth, as are
 * functions, symbols, undefined, non-finite numbers, non-plain objects and anything nested deeper
 * than MAX_DEPTH. Returns undefined when `v` itself isn't JSON data.
 */
export function safeJsonCopy(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'object' || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) {
      const c = safeJsonCopy(item, depth + 1);
      out.push(c === undefined ? null : c); // JSON.stringify's rule for arrays
    }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  for (const [k, item] of Object.entries(v)) {
    if (FORBIDDEN.has(k)) continue;
    const c = safeJsonCopy(item, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
