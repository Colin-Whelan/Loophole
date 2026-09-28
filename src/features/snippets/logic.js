// Pure helpers for the snippet viewer (no DOM, no storage): usage syntax, search, cache records.
// Lifted from "Iterable Snippet Viewer" v1.1.0 where the script had them.

import { projectSlot } from '../../core/state.js';

/** Where the editor toolbar button goes (the script's PLACEMENT_RULES[0]). */
export const EDITOR_ROUTE = /^\/templates\/editor\b/;
export const EDITOR_ANCHOR = '[data-test="basic-select-email-editor-view"]';

export const CACHE_VERSION = 1;

/**
 * The handlebars insert, exactly as the script built it:
 * {{{ snippet "name" param1 param2 }}}
 */
export function buildSnippetSyntax(snippet) {
  const params = (snippet.positionalParameters || []).join(' ');
  return `{{{ snippet "${snippet.name}"${params ? ' ' + params : ''} }}}`;
}

/** "just now", "5m ago", "3h ago", "2d ago" (the script's timeAgo). */
export function timeAgo(ts, now = Date.now()) {
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Case-insensitive match on name, description or any positional parameter (the script's rule). */
export function filterSnippets(snippets, term) {
  const t = String(term ?? '').trim();
  if (!t) return [...snippets];
  const lower = t.toLowerCase();
  return snippets.filter((s) => s.name.toLowerCase().includes(lower)
    || (s.description || '').toLowerCase().includes(lower)
    || (s.positionalParameters || []).some((p) => p.toLowerCase().includes(lower)));
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Iterable timestamps may be ISO strings or epoch numbers → ms, or null. */
export function toMillis(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return Number(v);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * One API (or cached) snippet → the fields the viewer uses, or null when it has no name.
 * { id, name, description, content, positionalParameters: string[], updatedAt: ms|null,
 *   createdAt: ms|null, updatedBy: string }
 */
export function normaliseSnippet(s) {
  if (!s || typeof s !== 'object') return null;
  const name = str(s.name);
  if (!name) return null;
  const params = Array.isArray(s.positionalParameters)
    ? s.positionalParameters.filter((p) => typeof p === 'string' && p) : [];
  const updatedBy = str(s.updatedByUser?.fullName) || str(s.updatedBy);
  return {
    id: s.id == null ? name : str(s.id),
    name,
    description: str(s.description),
    content: str(s.content),
    positionalParameters: params,
    updatedAt: toMillis(s.updatedAt),
    createdAt: toMillis(s.createdAt),
    updatedBy,
  };
}

export function normaliseSnippets(list) {
  return (Array.isArray(list) ? list : []).map(normaliseSnippet).filter(Boolean);
}

/**
 * State name for a project's cache: `cache:<projectSlot>` (core/state.js), so any project key
 * (spaces, slashes, non-ASCII) gives a short, backup-restorable name. '' for no project.
 */
export function cacheStateName(projectKey) {
  const slot = projectSlot(projectKey);
  return slot ? 'cache:' + slot : '';
}

/** Names the cache had before projectSlot (read once, then moved; see getMigrated). */
export function legacyCacheStateNames(projectKey) {
  if (typeof projectKey !== 'string' || !projectKey) return [];
  return [('cache:' + projectKey).replace(/[^A-Za-z0-9_.:|-]/g, '_').slice(0, 128)];
}

/** fetchSnippets() result → the cache record stored in ctx.state. */
export function makeCache({ snippets, total = null, complete = true }, now = Date.now()) {
  return {
    v: CACHE_VERSION,
    fetchedAt: now,
    complete: complete !== false,
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    snippets: normaliseSnippets(snippets),
  };
}

/** A stored cache record (untrusted shape) → a clean record, or null when unusable. */
export function readCache(value) {
  if (!value || typeof value !== 'object' || value.v !== CACHE_VERSION) return null;
  const fetchedAt = toMillis(value.fetchedAt);
  if (fetchedAt == null || !Array.isArray(value.snippets)) return null;
  return {
    v: CACHE_VERSION,
    fetchedAt,
    complete: value.complete !== false,
    total: typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : null,
    snippets: normaliseSnippets(value.snippets),
  };
}

/** Stale when older than `minutes`. 0 (or less / invalid) = never auto-refresh. */
export function isStale(cache, minutes, now = Date.now()) {
  if (!cache) return true;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return false;
  return now - cache.fetchedAt > m * 60000;
}

/** Warning text when the list may be missing snippets, else ''. */
export function incompleteText(cache) {
  if (!cache || cache.complete) return '';
  const n = cache.snippets.length;
  return cache.total != null && cache.total > n
    ? `Showing ${n.toLocaleString('en-US')} of ${cache.total.toLocaleString('en-US')} snippets: the list is incomplete.`
    : `Showing ${n.toLocaleString('en-US')} snippets: the list may be incomplete.`;
}

/**
 * The preview's Content-Security-Policy. Default: nothing leaves the browser (inline styles and
 * data: images only), so tracking pixels and remote CSS in a snippet don't fire just because it
 * was previewed. `remote: true` (the Preview tab's "Load remote images") adds https: images and
 * stylesheets. Scripts, plugins, forms, frames and <base> stay blocked either way.
 */
export function previewCsp({ remote = false } = {}) {
  return [
    "default-src 'none'",
    remote ? 'img-src https: data:' : 'img-src data:',
    remote ? "style-src 'unsafe-inline' https:" : "style-src 'unsafe-inline'",
    "script-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * The preview iframe's srcdoc. The iframe is sandbox="" (no scripts, opaque origin); the CSP meta
 * is a second lock on scripts, keeps forms / plugins / <base> tricks out and, unless
 * `remote` is set, blocks every network load (previewCsp).
 */
export function previewDoc(content, { remote = false } = {}) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${previewCsp({ remote })}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<style>body{font-family:sans-serif;padding:16px;margin:0;}</style></head><body>'
    + str(content) + '</body></html>';
}
