// Pure helpers for the link-params feature: the default library, library normalisation, and the
// URL param add/replace logic. No DOM, no chrome.* — unit-tested in test/features/link-params*.

/**
 * Library shape (stored as values.paramTypes; null/missing → DEFAULT_PARAM_TYPES):
 *   { [paramName]: { label, categories: [{ name, color: '#rrggbb', terms: [string] }] } }
 * Object key order is the tab order.
 */
export const DEFAULT_PARAM_TYPES = Object.freeze({
  utm_term: {
    label: 'utm_term',
    categories: [
      { name: 'Placement', color: '#0d8a7e', terms: ['hero', 'header', 'footer', 'body_cta'] },
      { name: 'Offer', color: '#c77d1a', terms: ['free_shipping', 'percent_off', 'bogo'] },
    ],
  },
  utm_content: {
    label: 'utm_content',
    categories: [
      { name: 'Link type', color: '#3a7bd5', terms: ['button', 'text_link', 'image'] },
      { name: 'Variant', color: '#b0487a', terms: ['version_a', 'version_b'] },
    ],
  },
  utm_id: {
    label: 'utm_id',
    categories: [
      { name: 'Program', color: '#6b6fd6', terms: ['welcome', 'winback', 'abandoned_cart'] },
      { name: 'Dynamic', color: '#5a6a68', terms: ['{{campaignId}}', '{{now format="yyyyMMdd"}}'] },
    ],
  },
});

export const MAX_RECENTS = 10;
export const MAX_TERM_LENGTH = 200;
export const FALLBACK_COLOR = '#8b9a98';
export const NEW_CATEGORY_COLOR = '#6b7280';

/** Deep copy of the defaults (callers may mutate it). */
export function defaultParamTypes() {
  return JSON.parse(JSON.stringify(DEFAULT_PARAM_TYPES));
}

// ── Validation / normalisation ───────────────────────────────────────────

/** A query-parameter name we can safely write: non-empty, no whitespace or URL delimiters. */
export function isValidParamName(name) {
  return typeof name === 'string' && /^[^\s&=#?/{}]+$/.test(name) && name.length <= 100;
}

/** '#abc' / '#AABBCC' / 'aabbcc' → '#aabbcc'; anything else → fallback. */
export function normalizeColor(value, fallback = FALLBACK_COLOR) {
  if (typeof value !== 'string') return fallback;
  let s = value.trim().toLowerCase();
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  return /^#[0-9a-f]{6}$/.test(s) ? s : fallback;
}

/**
 * Terms as array (or a comma-separated string) → trimmed, de-duplicated strings. Terms longer
 * than MAX_TERM_LENGTH are dropped (cutting one short could break a Handlebars expression).
 */
export function normalizeTerms(value) {
  return termsWithDropped(value).terms;
}

/** normalizeTerms plus how many terms were dropped for being too long. */
function termsWithDropped(value) {
  const list = Array.isArray(value) ? value
    : typeof value === 'string' ? splitTerms(value)
      : [];
  const terms = [];
  let tooLong = 0;
  for (const t of list) {
    if (typeof t !== 'string' && typeof t !== 'number') continue;
    const s = String(t).trim();
    if (s.length > MAX_TERM_LENGTH) { tooLong++; continue; }
    if (s && !terms.includes(s)) terms.push(s);
  }
  return { terms, tooLong };
}

/**
 * Split a comma-separated term list, ignoring commas inside Handlebars ({{…}}) so a term like
 * {{#if a}}x,y{{/if}} stays whole.
 */
export function splitTerms(text) {
  const out = [];
  let cur = '';
  let depth = 0; // inside {{ … }}
  let blocks = 0; // inside {{#block}} … {{/block}}
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{') {
      const tag = text.slice(i + 2).replace(/^[{~\s]+/, '')[0];
      if (tag === '#') blocks++;
      else if (tag === '/' && blocks > 0) blocks--;
      depth++; cur += two; i++; continue;
    }
    if (two === '}}' && depth > 0) { depth--; cur += two; i++; continue; }
    if (text[i] === ',' && depth === 0 && blocks === 0) { out.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseMaybeJson(input) {
  if (typeof input !== 'string') return input;
  const s = input.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Normalise anything that might be a library (object, JSON string, a { paramTypes } wrapper such
 * as our own export) into the canonical shape. Never throws; unknown fields are dropped.
 * Returns { paramTypes, notes } where paramTypes is null when nothing usable was found.
 */
export function normalizeParamTypes(input) {
  const notes = [];
  let data = parseMaybeJson(input);
  // Tolerate one extra level of string encoding (JSON of a JSON string).
  if (typeof data === 'string') data = parseMaybeJson(data);
  if (data && typeof data === 'object' && !Array.isArray(data)
    && data.paramTypes !== undefined && !looksLikeParamType(data.paramTypes)) {
    data = parseMaybeJson(data.paramTypes);
    if (typeof data === 'string') data = parseMaybeJson(data);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { paramTypes: null, notes: ['No link parameter library found.'] };
  }

  const out = {};
  for (const [rawKey, rawType] of Object.entries(data)) {
    const key = String(rawKey).trim();
    if (!isValidParamName(key)) {
      notes.push(`Skipped "${rawKey}": not a usable parameter name.`);
      continue;
    }
    if (out[key]) {
      notes.push(`Skipped duplicate parameter "${key}".`);
      continue;
    }
    if (!rawType || typeof rawType !== 'object') {
      notes.push(`Skipped "${key}": no categories.`);
      continue;
    }
    // Some hand-edited configs are just an array of categories.
    const cats = Array.isArray(rawType) ? rawType : rawType.categories;
    const label = !Array.isArray(rawType) && typeof rawType.label === 'string' && rawType.label.trim()
      ? rawType.label.trim() : key;
    const categories = [];
    for (const c of Array.isArray(cats) ? cats : []) {
      if (!c || typeof c !== 'object') continue;
      const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim()
        : typeof c.name === 'number' ? String(c.name) : 'Untitled';
      const { terms, tooLong } = termsWithDropped(c.terms);
      if (tooLong) notes.push(`Skipped ${tooLong} term${tooLong === 1 ? '' : 's'} longer than ${MAX_TERM_LENGTH} characters in ${key} › ${name}.`);
      categories.push({ name, color: normalizeColor(c.color), terms });
    }
    out[key] = { label, categories };
  }
  if (!Object.keys(out).length) {
    return { paramTypes: null, notes: notes.length ? notes : ['The library has no parameters.'] };
  }
  return { paramTypes: out, notes };
}

function looksLikeParamType(v) {
  // { paramTypes: { utm_term: {...} } } is a wrapper; a param literally named "paramTypes" whose
  // value has `categories` is not.
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.categories);
}

/** The library the feature should use for these settings values (defaults when unset/invalid). */
export function resolveParamTypes(values) {
  const stored = values?.paramTypes;
  if (stored == null) return defaultParamTypes();
  return normalizeParamTypes(stored).paramTypes || defaultParamTypes();
}

// ── Options-page draft (settings-ui.js) ──────────────────────────────────

/** Library object → editable draft (array keeps order; label '' means "same as the name"). */
export function toDraft(paramTypes) {
  return Object.entries(paramTypes).map(([key, t]) => ({
    key,
    label: t.label && t.label !== key ? t.label : '',
    categories: t.categories.map((c) => ({ name: c.name, color: c.color, terms: [...c.terms] })),
  }));
}

/** Draft → { paramTypes } or { errors }. */
export function buildLibrary(draft) {
  const errors = [];
  const out = {};
  draft.forEach((t, i) => {
    const key = (t.key || '').trim();
    if (!key) { errors.push(`Parameter ${i + 1} needs a name.`); return; }
    if (!isValidParamName(key)) { errors.push(`"${key}" can't be used as a parameter name (no spaces or & = # ? / { }).`); return; }
    if (out[key]) { errors.push(`"${key}" is listed twice.`); return; }
    for (const c of t.categories) {
      if (termsWithDropped(c.terms).tooLong) {
        errors.push(`A term in ${key} › ${(c.name || '').trim() || 'Untitled'} is longer than ${MAX_TERM_LENGTH} characters.`);
      }
    }
    out[key] = {
      label: (t.label || '').trim() || key,
      categories: t.categories.map((c) => ({
        name: (c.name || '').trim() || 'Untitled',
        color: normalizeColor(c.color),
        terms: normalizeTerms(c.terms),
      })),
    };
  });
  if (!draft.length) errors.push('Keep at least one parameter.');
  return errors.length ? { errors } : { paramTypes: out };
}

/** Push `term` to the front of a recents list: de-duplicated, capped at `max`. */
export function addRecent(list, term, max = MAX_RECENTS) {
  const prev = Array.isArray(list) ? list.filter((t) => typeof t === 'string' && t !== term) : [];
  return [term, ...prev].slice(0, max);
}

/** Recents store { [paramName]: string[] } → sanitised copy. */
export function normalizeRecents(value, max = MAX_RECENTS) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const terms = normalizeTerms(list).slice(0, max);
    if (terms.length) out[k] = terms;
  }
  return out;
}

// ── URL editing ──────────────────────────────────────────────────────────

const HANDLEBARS = /\{\{\{?[\s\S]*?\}?\}\}/g;

/**
 * Replace every Handlebars expression with an inert token so URL delimiters inside them
 * ({{#if}}, {{a?b}}, spaces, quotes) are never parsed or encoded. restore() puts them back.
 */
function maskHandlebars(text, saved = []) {
  const masked = text.replace(HANDLEBARS, (m) => {
    saved.push(m);
    return `__wbhb${saved.length - 1}__`;
  });
  return { masked, saved };
}

function restoreHandlebars(text, saved) {
  return text.replace(/__wbhb(\d+)__/g, (m, i) => (saved[+i] !== undefined ? saved[+i] : m));
}

/** Percent-encode a query component, leaving masked Handlebars tokens as they are. */
function encodeComponent(s) {
  return s.split(/(__wbhb\d+__)/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join('');
}

function decodeComponent(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/** Split a (masked) URL into base / query (without '?') / hash (with '#'). */
function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = beforeHash.indexOf('?');
  return {
    base: qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash,
    query: qAt >= 0 ? beforeHash.slice(qAt + 1) : null,
    hash,
  };
}

function hasScheme(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(mailto|tel|sms):/i.test(url);
}

/** True when the WHATWG URL parser accepts the (masked) link, adding https:// when it has no scheme. */
function parsesAsUrl(masked) {
  try {
    const u = new URL(hasScheme(masked) ? masked : `https://${masked}`);
    return !!u;
  } catch {
    return false;
  }
}

/**
 * Set `name=value` on `url`: replaces the first existing `name` param in place (dropping any
 * duplicates) or appends it before the fragment. Everything else in the link — other params,
 * their encoding, the fragment, Handlebars anywhere — is preserved byte for byte.
 *
 * Like the userscript: the URL API decides whether this is a parseable link (with https:// assumed
 * when there's no scheme); if it isn't, a regex fallback edits the string directly.
 * Handlebars in `value` are written raw; everything else in it is percent-encoded.
 */
/**
 * Links a query parameter makes no sense on (or would break): mailto:, tel:, sms: and in-page
 * #anchors. → 'mailto' | 'tel' | 'sms' | 'anchor', or null when params can be added.
 */
export function paramUnsupportedReason(url) {
  const s = String(url ?? '').trim();
  if (s.startsWith('#')) return 'anchor';
  const m = /^(mailto|tel|sms):/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export function addOrReplaceParam(url, name, value) {
  if (typeof url !== 'string' || !url || !name) return url;
  if (paramUnsupportedReason(url)) return url;
  const saved = [];
  const { masked } = maskHandlebars(url.trim(), saved);
  const { masked: maskedValue } = maskHandlebars(String(value ?? ''), saved);
  const encName = encodeComponent(name);
  const encValue = encodeComponent(maskedValue);

  const result = parsesAsUrl(masked)
    ? spliceQuery(masked, name, `${encName}=${encValue}`)
    : regexFallback(masked, encName, encValue);
  return restoreHandlebars(result, saved);
}

function spliceQuery(masked, name, pair) {
  const { base, query, hash } = splitUrl(masked);
  if (query === null || query === '') return `${base}?${pair}${hash}`;
  const parts = query.split('&');
  let replaced = false;
  const out = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    const key = decodeComponent(eq >= 0 ? p.slice(0, eq) : p);
    if (key === name) {
      if (!replaced) { out.push(pair); replaced = true; }
      continue; // drop duplicates, like URLSearchParams.set
    }
    out.push(p);
  }
  if (!replaced) {
    // Keep a trailing '&' tidy: "?a=1&" + pair → "?a=1&pair".
    if (out.length && out[out.length - 1] === '') out.pop();
    out.push(pair);
  }
  return `${base}?${out.join('&')}${hash}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexFallback(masked, encName, encValue) {
  const { base, query, hash } = splitUrl(masked);
  const beforeHash = query === null ? base : `${base}?${query}`;
  const re = new RegExp(`([?&])${escapeRegex(encName)}=[^&]*`);
  if (re.test(beforeHash)) {
    return beforeHash.replace(re, (m, sep) => `${sep}${encName}=${encValue}`) + hash;
  }
  const sep = query === null ? '?' : (query === '' || query.endsWith('&') ? '' : '&');
  return `${beforeHash}${sep}${encName}=${encValue}${hash}`;
}

/** Current (decoded) value of `name` in `url`, or null. Handlebars come back verbatim. */
export function getParam(url, name) {
  if (typeof url !== 'string' || !url || !name) return null;
  const saved = [];
  const { masked } = maskHandlebars(url, saved);
  const { query } = splitUrl(masked);
  if (!query) return null;
  for (const p of query.split('&')) {
    const eq = p.indexOf('=');
    if (decodeComponent(eq >= 0 ? p.slice(0, eq) : p) !== name) continue;
    return restoreHandlebars(decodeComponent(eq >= 0 ? p.slice(eq + 1) : ''), saved);
  }
  return null;
}
