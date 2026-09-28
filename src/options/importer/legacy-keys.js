// Central extraction of API keys from legacy userscript storage (ARCHITECTURE §8.4). Pure.
//
// Works on decoded GM values (see decode.js). Known formats, each either JSON text or parsed:
//   api_keys_by_project  { [id | 'name:<n>']: { name, apiKey } }   User Push, Catalog Push, Delete User
//   legacy_api_key       '<key>'                                    User Push (pre-1.1) → unassigned
//   settings.apiKey      '<key>'                                    User Push (before 1.1) → unassigned
//   iterable_spaces      [{ name, apiKey }]                         Profile Editor → matched by name
//   config.apiKeys       [{ id, label, key }] (+ old config.apiKey) Live Preview Editor → unassigned

import {
  legacyProjectKey, makeProjectKey, parseProjectKey, validateApiKey, API_KEY_MIN,
} from '../../core/api-validation.js';
import { asJson, TAGS } from './decode.js';
import { isForbiddenKey } from './safe-json.js';

const parseGmValue = asJson;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * A usable key, or null. Refuses a value that still carries a Tampermonkey type tag ("s" + a
 * 32-hex key): that is a decoding failure, and importing it would save a key that never works.
 */
function cleanKey(raw) {
  const k = validateApiKey(typeof raw === 'string' ? raw : '');
  if (!k.ok) return null;
  if (k.value.length === 33 && TAGS.has(k.value[0]) && HEX32_RE.test(k.value.slice(1))) return null;
  return k.value;
}

/**
 * extractLegacyKeys(scripts, { knownProjects }) → { assigned, unassigned, skipped }
 *   scripts        [{ name, storage }]  (storage = GM values)
 *   knownProjects  [{ projectKey, name }] already in the vault (for matching iterable_spaces names)
 *
 *   assigned    [{ projectKey, name, apiKey, sources: [scriptName] }]  one per projectKey
 *   unassigned  [{ id, label, apiKey, sources }]                       keys with no project yet
 *   skipped     number of values that didn't look like API keys
 *
 * The same key found in several scripts collapses to one entry (the first project it was
 * assigned to wins); a key that is assigned anywhere is not also listed as unassigned. If two
 * different keys claim one project, the first wins.
 */
export function extractLegacyKeys(scripts, { knownProjects = [] } = {}) {
  const assigned = new Map();   // projectKey → entry
  const unassigned = new Map(); // apiKey → entry
  const spaces = [];            // deferred: matched after every api_keys_by_project is known
  let skipped = 0;

  const assign = (projectKey, name, rawKey, source) => {
    const apiKey = cleanKey(rawKey);
    if (!projectKey || !apiKey) { skipped++; return; }
    // One key belongs to one project: the first assignment wins (explicit api_keys_by_project
    // entries are processed before name-matched Profile Editor spaces).
    const owner = [...assigned.values()].find((a) => a.apiKey === apiKey);
    if (owner && owner.projectKey !== projectKey) {
      if (!owner.sources.includes(source)) owner.sources.push(source);
      return;
    }
    const prev = assigned.get(projectKey);
    if (prev) {
      if (prev.apiKey === apiKey && !prev.sources.includes(source)) prev.sources.push(source);
      return;
    }
    assigned.set(projectKey, { projectKey, name: name || '', apiKey, sources: [source] });
  };

  const leave = (label, rawKey, source) => {
    const apiKey = cleanKey(rawKey);
    if (!apiKey) { skipped++; return; }
    const prev = unassigned.get(apiKey);
    if (prev) { if (!prev.sources.includes(source)) prev.sources.push(source); return; }
    unassigned.set(apiKey, { id: '', label: label || 'API key', apiKey, sources: [source] });
  };

  for (const script of scripts) {
    const storage = script.storage;
    if (!isObject(storage)) continue;
    const source = script.name;

    const byProject = parseGmValue(storage.api_keys_by_project);
    if (isObject(byProject)) {
      for (const [legacy, entry] of Object.entries(byProject)) {
        const e = parseGmValue(entry);
        assign(legacyProjectKey(legacy), isObject(e) && typeof e.name === 'string' ? e.name : '', isObject(e) ? e.apiKey : e, source);
      }
    }

    const single = parseGmValue(storage.legacy_api_key);
    if (typeof single === 'string' && single.trim()) leave(`${source}: older single key`, single, source);

    // User Push before 1.1 kept its one key inside `settings` (1.1 moved it to legacy_api_key).
    const settings = parseGmValue(storage.settings);
    if (isObject(settings) && typeof settings.apiKey === 'string' && settings.apiKey.trim()) {
      leave(`${source}: older single key`, settings.apiKey, source);
    }

    const sp = parseGmValue(storage.iterable_spaces);
    if (Array.isArray(sp)) {
      for (const space of sp) if (isObject(space)) spaces.push({ space, source });
    }

    const config = parseGmValue(storage.config);
    if (isObject(config)) {
      if (Array.isArray(config.apiKeys)) {
        for (const k of config.apiKeys) {
          if (isObject(k)) leave(k.label ? `${source}: ${k.label}` : `${source} key`, k.key, source);
        }
      }
      if (typeof config.apiKey === 'string' && config.apiKey.trim()) leave(`${source} key`, config.apiKey, source);
    }
  }

  // Profile Editor "spaces": match by project name against the vault and this import.
  const byName = new Map();
  for (const p of [...knownProjects, ...assigned.values()]) {
    const n = String(p.name || '').trim().toLowerCase();
    if (n && !byName.has(n)) byName.set(n, p.projectKey);
  }
  for (const { space, source } of spaces) {
    const name = typeof space.name === 'string' ? space.name.trim() : '';
    const pk = byName.get(name.toLowerCase()) || (name ? makeProjectKey({ dataCenter: 'us', name }) : null);
    if (pk) assign(pk, name, space.apiKey, source);
    else leave(name ? `${source}: ${name}` : `${source} key`, space.apiKey, source);
  }

  // A key that ended up assigned somewhere doesn't need a project picker.
  const assignedKeys = new Set([...assigned.values()].map((a) => a.apiKey));
  const loose = [...unassigned.values()].filter((u) => !assignedKeys.has(u.apiKey));
  loose.forEach((u, i) => { u.id = `u${i + 1}`; });

  return {
    assigned: [...assigned.values()].filter((a) => parseProjectKey(a.projectKey)),
    unassigned: loose,
    skipped,
  };
}

/**
 * A copy of a script's GM values with every API key removed (for the wb:legacy stash). Values keep
 * their original form: a JSON string stays a JSON string. Applied at every depth, top level
 * included (a GM value is just a named field). Conservative: losing a setting is better than
 * keeping a key.
 *   - fields with a secret-looking name (apiKey, api_key, token, secret, secretKey, password,
 *     bearer, credentials, authorization, privateKey, accessKey, …) are dropped whatever they hold;
 *   - any string shaped like an Iterable key (32 hex, trimmed, any case) is dropped wherever it is,
 *     whatever its field is called: in an object, in an array, or as JSON text;
 *   - any field whose name is 32 hex, or contains one of `secrets`, is dropped;
 *   - `key` / `keys` / `value` inside an `apiKeys` list is always dropped;
 *   - any string equal to, or containing, one of `secrets` (the keys extractLegacyKeys found;
 *     compared case-insensitively) is dropped wherever it is. JSON text holding an object or
 *     array (a whole script config) is parsed and scrubbed part by part first, so a key inside it
 *     costs only that part; if the re-serialised result still contains a secret it goes whole.
 *     JSON text holding JSON text (encoded twice or more) is unwrapped first, up to 4 times, and
 *     encoded back the same number of times; wrapped deeper than that it is dropped;
 *   - __proto__ / constructor / prototype fields are dropped.
 * opts.secrets: [apiKey] already extracted from this import.
 */
export function stripLegacyKeys(storage, { secrets = [] } = {}) {
  if (!isObject(storage)) return {};
  const ctx = {
    secrets: secrets.filter((s) => typeof s === 'string' && s.trim().length >= API_KEY_MIN).map((s) => s.trim().toLowerCase()),
  };
  const out = {};
  for (const [k, v] of Object.entries(storage)) {
    const c = scrubField(k, v, ctx, false);
    if (c !== DROP) out[k] = c;
  }
  return out;
}

const DROP = Symbol('drop');
const HEX32_RE = /^[0-9a-f]{32}$/i;
const API_KEYS_LIST_RE = /^api[_-]?keys$/i;
// Matched against the field name lower-cased with everything but a-z0-9 removed.
const SECRET_NAME_RE = /apikey|secret|passw(?:or)?d|token|bearer|credential|privatekey|accesskey|authorization/;

const normFieldName = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const looksLikeKey = (s) => HEX32_RE.test(s.trim());
/** A string that must not reach the stash: key-shaped, or carrying an extracted key. */
const isSecretString = (s, ctx) => looksLikeKey(s) || containsSecret(s, ctx);

function scrubField(name, v, ctx, inKeyList) {
  if (isForbiddenKey(name)) return DROP;
  // A key used as a field name (e.g. a map keyed by API key).
  if (isSecretString(String(name), ctx)) return DROP;
  const n = normFieldName(name);
  // An apiKeys list keeps its labels/ids (a future mapper may want them), minus the keys.
  if (API_KEYS_LIST_RE.test(name) && Array.isArray(asJson(v))) return scrubValue(v, ctx, true);
  if (SECRET_NAME_RE.test(n)) return DROP;
  if (inKeyList && (n === 'key' || n === 'keys' || n === 'value')) return DROP;
  return scrubValue(v, ctx, false);
}

// How many times JSON text holding JSON text is unwrapped; anything wrapped deeper is dropped.
const MAX_UNWRAP = 4;

function scrubValue(v, ctx, inKeyList, depth = 0) {
  if (typeof v === 'string') {
    if (looksLikeKey(v)) return DROP;
    // JSON text holding an object / array (a whole script config): scrub its parts, so one key
    // inside doesn't cost every other setting. Checked before the containment test below, which
    // would otherwise match the whole text and drop it all.
    const parsed = parseGmValue(v);
    if (parsed !== v && parsed && typeof parsed === 'object') {
      const s = scrub(parsed, ctx, inKeyList);
      if (s === DROP) return DROP;
      const text = JSON.stringify(s);
      // Belt and braces: whatever still carries a key after scrubbing goes whole.
      return containsSecret(text, ctx) ? DROP : text;
    }
    // JSON text holding a string ('"<key>"', or a config JSON-encoded twice): unwrap it first
    // (bounded), scrub what it holds, then encode it back as many times as it was. Nested deeper
    // than that it can't be judged, so it goes.
    if (typeof parsed === 'string' && parsed !== v) {
      if (depth >= MAX_UNWRAP) return DROP;
      const inner = scrubValue(parsed, ctx, inKeyList, depth + 1);
      if (inner === DROP) return DROP;
      const text = inner === parsed ? v : JSON.stringify(inner);
      return isSecretString(text, ctx) ? DROP : text;
    }
    return containsSecret(v, ctx) ? DROP : v;
  }
  return scrub(v, ctx, inKeyList);
}

function scrub(v, ctx, inKeyList) {
  if (typeof v === 'string') return isSecretString(v, ctx) ? DROP : v;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const c = scrubValue(x, ctx, inKeyList);
      if (c !== DROP) out.push(c);
    }
    return out;
  }
  if (!isObject(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const c = scrubField(k, val, ctx, inKeyList);
    if (c !== DROP) out[k] = c;
  }
  return out;
}

function containsSecret(s, ctx) {
  if (!ctx.secrets.length) return false;
  const lower = s.toLowerCase();
  return ctx.secrets.some((secret) => lower.includes(secret));
}
