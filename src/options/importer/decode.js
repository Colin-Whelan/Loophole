// Tampermonkey value decoding (ARCHITECTURE §8.4). Pure.
//
// Tampermonkey stores every GM value as a type-tagged string: the first character is the type,
// the rest is the payload.
//   "s…" string        "sHello"            → "Hello"
//   "b…" boolean       "bfalse"            → false
//   "n…" number        "n42"               → 42
//   "o…" JSON          "o{\"a\":1}"        → { a: 1 }
//   "u"  undefined     "u"                 → undefined
// Many scripts stored JSON.stringify(config), so a decoded "s" value is often JSON text itself:
// use asJson() on it.

import { isForbiddenKey } from './safe-json.js';

export const TAGS = new Set(['s', 'b', 'n', 'o', 'u']);

/** Decode one tagged value; anything that isn't a well-formed tag comes back unchanged. */
export function decodeTmValue(v) {
  const r = tryDecode(v);
  return r.ok ? r.value : v;
}

function tryDecode(v) {
  if (typeof v !== 'string' || !v.length || !TAGS.has(v[0])) return { ok: false };
  const body = v.slice(1);
  switch (v[0]) {
    case 's': return { ok: true, value: body };
    case 'b':
      if (body === 'true') return { ok: true, value: true };
      if (body === 'false') return { ok: true, value: false };
      return { ok: false };
    case 'n': {
      if (body.trim() === '') return { ok: false };
      const n = Number(body);
      return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
    }
    case 'o':
      try { return { ok: true, value: JSON.parse(body) }; } catch { return { ok: false }; }
    case 'u':
      return body === '' || body === 'ndefined' ? { ok: true, value: undefined } : { ok: false };
    default:
      return { ok: false };
  }
}

/**
 * Decode a whole `data` object from a .storage.json, one value at a time.
 *   tagged: true   the caller knows this is Tampermonkey storage (a `{ ts, data }` export): every
 *                  string must be a well-formed tag.
 *   tagged: omitted  guess: decode only when every string value starts with a tag character, so a
 *                  hand-made dump like { "note": "plain text" } isn't mangled.
 * In a tagged store a value that fails to decode (e.g. "o{not json") is left out and its GM key
 * listed in `failed`; it never falls back to the raw, still-tagged string, and one bad value never
 * affects the others. Keys named __proto__ / constructor / prototype are dropped.
 * → { values, failed: [gmKey], tagged }
 */
export function decodeStorageReport(data, { tagged } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { values: {}, failed: [], tagged: false };
  const entries = Object.entries(data).filter(([k]) => !isForbiddenKey(k));
  const strings = entries.filter(([, v]) => typeof v === 'string');
  const isTagged = tagged ?? (strings.length > 0 && strings.every(([, v]) => v.length > 0 && TAGS.has(v[0])));
  const values = {};
  const failed = [];
  for (const [k, v] of entries) {
    if (!isTagged || typeof v !== 'string') { values[k] = v; continue; }
    const r = tryDecode(v);
    if (!r.ok) { failed.push(k); continue; }
    if (r.value !== undefined) values[k] = r.value;
  }
  return { values, failed, tagged: isTagged };
}

/** decodeStorageReport(...).values: the decoded GM values. */
export function decodeStorage(data, opts) {
  return decodeStorageReport(data, opts).values;
}

/** Parse a string that looks like JSON (object, array or quoted string); otherwise return as-is. */
export function asJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || !/^[[{"]/.test(s)) return v;
  try { return JSON.parse(s); } catch { return v; }
}
