// Pure helpers for the Profile editor. No DOM globals, no chrome.*: unit-tested in Node
// (test/features/profile-editor.test.js). The JSON-view selectors and the key/value reading rules
// come from the "Iterable Profile Editor" userscript (v1.1); the row structure is the one Event
// copy documents (src/features/event-copy/parse.js).

// ── Iterable's JSON view (read-only use) ───────────────────────────────────

export const KEY_SELECTOR = '.json-property-key';
export const LEAF_SELECTOR = '.json-leaf';
export const VALUE_SELECTOR = '.json-property-value';
export const BRANCH_SELECTOR = '.json-branch, [data-test="json-branch-raw"]';

/** Event History renders event JSON with the same classes: those keys are not profile fields. */
export function isEditableView(pathname) {
  const p = String(pathname || '');
  return p.includes('/users/profiles/') && !p.includes('/event/history');
}

/**
 * Top-level keys that identify the user. /api/users/update can't change them through dataFields
 * (Iterable has its own flows for that), so they get no Edit button.
 */
export const IDENTITY_FIELDS = Object.freeze(['email', 'userId', 'itblUserId']);

/**
 * A key span's text → the field name. The script stripped every `"` and `:`; this strips only the
 * wrapping quotes and the trailing colon, so a key containing ":" survives.
 */
export function cleanKeyText(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/\s*:\s*$/, '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.trim();
}

/** The value span's type class → 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'unknown'. */
export function valueKind(classNames) {
  const set = new Set(Array.isArray(classNames) ? classNames : String(classNames || '').split(/\s+/));
  for (const k of ['string', 'number', 'boolean', 'null', 'object', 'array']) {
    if (set.has('json-property-' + k)) return k;
  }
  return 'unknown';
}

/**
 * A scalar read off the page → { ok: true, value } or { ok: false } when the page text can't be
 * trusted as the value (objects/arrays, unknown types, integers beyond ±2^53−1 that Number()
 * would round). Strings lose their wrapping quotes, as in the script.
 */
export function scalarFromPage(kind, text) {
  const t = String(text ?? '').trim();
  switch (kind) {
    case 'string':
      return { ok: true, value: t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t };
    case 'number': {
      if (/^-?\d+$/.test(t)) {
        const n = BigInt(t);
        if ((n < 0n ? -n : n) > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false };
      }
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean':
      if (t === 'true') return { ok: true, value: true };
      if (t === 'false') return { ok: true, value: false };
      return { ok: false };
    case 'null':
      return { ok: true, value: null };
    default:
      return { ok: false };
  }
}

/**
 * Resolve a key into an editable field.
 *   segments  [{ key, kind }] from the outermost branch down to this key; `kind` is that row's
 *             value kind (valueKind). The last segment is the key itself.
 * → { editable: true, path } | { editable: false, reason, path? }
 * Rules: the path is the dot-joined keys (the script's setNestedProperty shape). A key inside an
 * array has no field path the update API can address (the script built "arr.id" paths that would
 * turn the array into an object), so only the array field itself is editable. A leading
 * "dataFields" segment is dropped, in case the view shows the raw user record. Identity fields
 * are skipped.
 */
export function resolveField(segments) {
  const segs = (segments || []).filter((s) => s && typeof s.key === 'string');
  if (!segs.length) return { editable: false, reason: 'no-key' };
  const keys = segs.map((s) => s.key);
  if (keys.some((k) => !k)) return { editable: false, reason: 'no-key' };
  if (segs.slice(0, -1).some((s) => s.kind === 'array')) return { editable: false, reason: 'in-array' };
  let path = keys;
  if (path[0] === 'dataFields') {
    path = path.slice(1);
    if (!path.length) return { editable: false, reason: 'container' };
  }
  if (path.length === 1 && IDENTITY_FIELDS.includes(path[0])) return { editable: false, reason: 'identity', path: path[0] };
  return { editable: true, path: path.join('.') };
}

/** Object and array fields: the page only shows a collapsible tree, so read the value from the API. */
export function needsApiValue(kind) {
  return kind === 'object' || kind === 'array' || kind === 'unknown';
}

// ── Session history (the script's RollbackManager) ─────────────────────────

/**
 * Per-page-session record of each field's value before its first write from this editor, so it
 * can be restored. Keyed by project, profile and field path. In memory only: values are PII and
 * never persisted or logged.
 */
export function createHistory() {
  const original = new Map();   // key → value before the first write
  const written = new Set();    // keys written in this session (the page may still show old values)
  const k = (projectKey, profileId, path) => `${projectKey}\u0000${profileId}\u0000${path}`;
  return {
    /** Remember `value` as the original, unless one is already remembered (first write wins). */
    recordWrite(projectKey, profileId, path, value) {
      const key = k(projectKey, profileId, path);
      if (value !== undefined && !original.has(key)) original.set(key, cloneJson(value));
      written.add(key);
    },
    /** A field written without a known original (added through "Add field"). */
    markWritten(projectKey, profileId, path) { written.add(k(projectKey, profileId, path)); },
    wasWritten(projectKey, profileId, path) { return written.has(k(projectKey, profileId, path)); },
    hasOriginal(projectKey, profileId, path) { return original.has(k(projectKey, profileId, path)); },
    getOriginal(projectKey, profileId, path) { return cloneJson(original.get(k(projectKey, profileId, path))); },
    /** After a restore, as in the script: the original is forgotten. */
    forget(projectKey, profileId, path) { original.delete(k(projectKey, profileId, path)); },
    clear() { original.clear(); written.clear(); },
  };
}

function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Short one-line preview of a value for button titles and confirm text. */
export function previewValue(value, max = 80) {
  const s = (value === undefined ? '(not set)' : JSON.stringify(value)).replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
