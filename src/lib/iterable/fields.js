// User field schema and field values, from the app's own (cookie-authenticated) endpoints:
//   GET  /mappings?dataType=user&fetchLatest=true&filterOutHiddenFields=false   (Profile Editor)
//   GET  /mappings/userMappings                                                 (Field Value Explorer)
//   POST /lists/v2/fieldFacets                                                  (Field Value Explorer)
// No API key needed.

import { IterableError, isAbortError, wrapFetchError } from './errors.js';

export const MAPPINGS_PATH = '/mappings?dataType=user&fetchLatest=true&filterOutHiddenFields=false';
export const USER_MAPPINGS_PATH = '/mappings/userMappings';
export const FIELD_FACETS_PATH = '/lists/v2/fieldFacets';

export const FIELDS_TTL_MS = 10 * 60 * 1000;
/** The explorer's facet size: the API's maximum. A result this long may be truncated. */
export const MAX_FACET_SIZE = 65535;

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Any of the mapping payload shapes → [{ name, type }]. Known shape (both endpoints): an array of
 * { fieldName, fieldType, … }. Also tolerated: { mappings | fields | results: [...] } and a
 * { [fieldName]: fieldType } map (as /api/users/getFields returns under `fields`).
 */
export function parseMappings(data) {
  let list = data;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = list.mappings ?? list.fields ?? list.results ?? list;
  }
  const out = [];
  if (Array.isArray(list)) {
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const name = m.fieldName ?? m.name;
      if (typeof name !== 'string' || !name) continue;
      const type = m.fieldType ?? m.type;
      out.push({ name, type: typeof type === 'string' ? type : '' });
    }
  } else if (list && typeof list === 'object') {
    for (const [name, type] of Object.entries(list)) {
      if (name) out.push({ name, type: typeof type === 'string' ? type : (type && typeof type.type === 'string' ? type.type : '') });
    }
  }
  return out;
}

/**
 * Is `data` one of the shapes parseMappings reads? An array; an object holding a `mappings` /
 * `fields` / `results` array or a `fields` map; or a bare { [fieldName]: type } map whose values
 * are all type strings (or { type }). Anything else (an HTML page, an error object) is not a
 * field list, even an empty one.
 */
export function isMappingsShape(data) {
  if (Array.isArray(data)) return true;
  if (!data || typeof data !== 'object') return false;
  for (const k of ['mappings', 'fields', 'results']) {
    if (Array.isArray(data[k])) return true;
  }
  if (data.fields && typeof data.fields === 'object') return true;
  const vals = Object.values(data);
  return vals.length > 0 && vals.every((v) => typeof v === 'string' || (v && typeof v === 'object' && typeof v.type === 'string'));
}

/**
 * Merge per-source field lists. sources: [{ source, fields: [{ name, type }] }] in precedence
 * order: the first source that knows a field (with a non-empty type) sets its type.
 * → [{ name, type, sources: [source…] }] sorted by name (case-insensitive).
 */
export function mergeFieldLists(sources) {
  const byName = new Map();
  for (const { source, fields } of sources) {
    for (const f of fields || []) {
      const cur = byName.get(f.name);
      if (!cur) { byName.set(f.name, { name: f.name, type: f.type || '', sources: [source] }); continue; }
      if (!cur.sources.includes(source)) cur.sources.push(source);
      if (!cur.type && f.type) cur.type = f.type;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1));
}

// ── Schema, cached per project ─────────────────────────────────────────────

const cache = new Map();   // projectKey → { at, fields } | { promise }

/** Test hook / project switch: forget one project's fields, or every project's. */
export function clearUserFieldsCache(projectKey) {
  if (projectKey === undefined) cache.clear(); else cache.delete(projectKey);
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function loadFields(http) {
  const sources = [
    { source: 'mappings', path: MAPPINGS_PATH },
    { source: 'userMappings', path: USER_MAPPINGS_PATH },
  ];
  const settled = await Promise.allSettled(sources.map((s) => http.appFetch(s.path)));
  const ok = [];
  let firstError = null;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && isMappingsShape(r.value)) ok.push({ source: sources[i].source, fields: parseMappings(r.value) });
    else if (r.status === 'fulfilled') {
      firstError ||= new IterableError(`Loading user fields: unexpected response from ${sources[i].path.split('?')[0]}.`, { code: 'BAD_RESPONSE' });
    } else firstError ||= r.reason;
  });
  if (!ok.length) throw firstError instanceof IterableError ? firstError : wrapFetchError(firstError, 'Loading user fields');
  return Object.freeze(mergeFieldLists(ok).map((f) => Object.freeze({ ...f, sources: Object.freeze(f.sources) })));
}

/**
 * getUserFields({ http, project?, projectKey? }, { force, ttlMs, signal, now })
 * → frozen [{ name, type, sources: ['mappings' | 'userMappings', …] }], sorted by name.
 *
 * type is Iterable's field type string as the mappings report it (e.g. 'string', 'long',
 * 'double', 'boolean', 'date', 'object', 'nested'); '' when unknown. Both endpoints are asked in
 * parallel; either may fail as long as one answers (both failing throws the first IterableError).
 * A response in no recognised shape counts as that endpoint failing (never cached as an empty
 * list). Cached in memory per project key (projectKey, else project.current().key) for ttlMs
 * (10 min); with no project key nothing is cached (it can't be told apart from another
 * project's). Concurrent calls share one request; `force` refetches. `signal` only abandons this
 * caller's wait.
 */
export async function getUserFields({ http, project, projectKey } = {}, { force = false, ttlMs = FIELDS_TTL_MS, signal, now = Date.now } = {}) {
  const key = projectKey || project?.current?.()?.key || '';
  if (!key) return raceAbort(loadFields(http), signal);
  const hit = cache.get(key);
  if (!force && hit) {
    if (hit.promise) return raceAbort(hit.promise, signal);
    if (now() - hit.at < ttlMs) return hit.fields;
  }
  const entry = { promise: null };
  entry.promise = loadFields(http).then(
    (fields) => { if (cache.get(key) === entry) cache.set(key, { at: now(), fields }); return fields; },
    (err) => { if (cache.get(key) === entry) cache.delete(key); throw err; },
  );
  cache.set(key, entry);
  return raceAbort(entry.promise, signal);
}

/** Case-sensitive lookup in a getUserFields result → the field or null. */
export function findField(fields, name) {
  return (fields || []).find((f) => f.name === name) || null;
}

// ── Field values ───────────────────────────────────────────────────────────

/** A facet term → string (the explorer's terms are strings; objects are tolerated). */
function termValue(t) {
  if (t == null) return null;
  if (typeof t === 'object') {
    const v = t.term ?? t.value ?? t.key;
    return v == null ? null : String(v);
  }
  return String(t);
}

/** The fieldFacets POST body (the explorer's). */
export function fieldFacetsBody({ field, search = '', limit = MAX_FACET_SIZE } = {}) {
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_FACET_SIZE) : MAX_FACET_SIZE;
  return { dataType: 'user', field, searchPrefix: search || '', size };
}

/**
 * fieldFacets({ http }, { field, search, limit, signal }) → { values: string[], truncated }
 * Distinct values of one user field. `search` is a prefix (searchPrefix). `truncated` is true when
 * the API returned `limit` values (default and max 65535), so there may be more.
 */
export async function fieldFacets({ http }, { field, search = '', limit = MAX_FACET_SIZE, signal } = {}) {
  if (!field || typeof field !== 'string') throw new IterableError('A field name is required.', { code: 'INVALID' });
  const body = fieldFacetsBody({ field, search, limit });
  let data;
  try {
    data = await http.appFetch(FIELD_FACETS_PATH, { method: 'POST', body, headers: { Accept: 'application/json, text/plain, */*' }, signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw wrapFetchError(err, 'Loading field values');
  }
  if (!data || typeof data !== 'object' || (data.terms != null && !Array.isArray(data.terms))) {
    throw new IterableError('Loading field values: unexpected response.', { code: 'BAD_RESPONSE', status: 200 });
  }
  const values = (data.terms || []).map(termValue).filter((v) => v != null);
  return { values, truncated: values.length >= body.size };
}
