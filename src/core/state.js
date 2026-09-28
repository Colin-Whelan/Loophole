// Feature-owned state under wb:state:<featureId>:<name> (ctx.state, and the `state` handed to a
// feature's settings-ui.js on the options page).
//
// list() reads a per-feature index (wb:state-index:<featureId> = [names]) instead of scanning all
// of storage: a full scan from a content script would pull the raw wb:keys vault into page-process
// memory.

import { STORAGE } from './messages.js';
import * as storage from './storage.js';
import { stableHash64 } from './hash.js';

export const STATE_INDEX_PREFIX = 'wb:state-index:';

// Feature ids are kebab-case (ARCHITECTURE §8.1). State names are free-form (bulk-data checkpoint
// names embed a file name), but never an Object.prototype property name, never empty, never
// control characters, and bounded in length. Imported data (backup restore, legacy mappers) goes
// through writeStateEntries / parseStateKey, which enforce this.
const FEATURE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
export const STATE_NAME_MAX = 512;

export function isValidFeatureId(id) {
  return typeof id === 'string' && id.length <= 64 && FEATURE_ID_RE.test(id) && !FORBIDDEN_NAMES.has(id);
}

export function isValidStateName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= STATE_NAME_MAX &&
    // eslint-disable-next-line no-control-regex
    !FORBIDDEN_NAMES.has(name) && !/[\u0000-\u001F\u007F]/.test(name);
}

export function statePrefix(featureId) {
  return `${STORAGE.STATE_PREFIX}${featureId}:`;
}

function indexKey(featureId) {
  return STATE_INDEX_PREFIX + featureId;
}

async function readIndex(featureId) {
  const list = await storage.get(indexKey(featureId), []);
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
}

// Index updates are read-modify-write; serialise them per context so rapid set() calls in one
// feature can't drop each other's names.
let indexChain = Promise.resolve();
function updateIndex(featureId, mutate) {
  const run = async () => {
    const before = await readIndex(featureId);
    const after = mutate(new Set(before));
    if (after.size !== before.length || before.some((n) => !after.has(n))) {
      await storage.set(indexKey(featureId), [...after].sort());
    }
  };
  indexChain = indexChain.then(run, run);
  return indexChain;
}

export function createState(featureId) {
  const prefix = statePrefix(featureId);
  return Object.freeze({
    get: (name, fallback = undefined) => storage.get(prefix + name, fallback),
    async set(name, value) {
      await storage.set(prefix + name, value);
      await updateIndex(featureId, (s) => s.add(String(name)));
    },
    async remove(name) {
      await storage.remove(prefix + name);
      await updateIndex(featureId, (s) => { s.delete(String(name)); return s; });
    },
    /** Names (without the prefix) of every state entry this feature has stored. */
    list: () => readIndex(featureId),
  });
}

/**
 * Write many state entries at once (importers, backup restore), keeping the index in step.
 * entries: { [featureId]: { [name]: value } } or a Map of Maps (either level may be a Map).
 * Entries whose featureId or name fails isValidFeatureId / isValidStateName are skipped: this is
 * the sink for imported (untrusted) data, so it must never write e.g. `wb:state:__proto__:x`.
 * Resolves { written, skipped }.
 */
export async function writeStateEntries(entries) {
  let written = 0;
  let skipped = 0;
  for (const [featureId, values] of ownEntries(entries)) {
    const pairs = ownEntries(values);
    if (!isValidFeatureId(featureId)) { skipped += pairs.length; continue; }
    const ok = pairs.filter(([n]) => isValidStateName(n));
    skipped += pairs.length - ok.length;
    if (!ok.length) continue;
    const prefix = statePrefix(featureId);
    await storage.setMany(Object.fromEntries(ok.map(([n, v]) => [prefix + n, v])));
    await updateIndex(featureId, (s) => { ok.forEach(([n]) => s.add(n)); return s; });
    written += ok.length;
  }
  return { written, skipped };
}

/** [key, value] pairs of a Map or of an object's own enumerable string keys; [] for anything else. */
function ownEntries(v) {
  if (v instanceof Map) return [...v.entries()].filter(([k]) => typeof k === 'string');
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v);
  return [];
}

/**
 * Split a full storage key `wb:state:<featureId>:<name>` → { featureId, name } | null.
 * Returns null unless the feature id is kebab-case and the name passes isValidStateName, so a
 * crafted key can never produce `__proto__` / `constructor` / `prototype` for either part.
 */
export function parseStateKey(key) {
  if (typeof key !== 'string' || !key.startsWith(STORAGE.STATE_PREFIX)) return null;
  const rest = key.slice(STORAGE.STATE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const featureId = rest.slice(0, i);
  const name = rest.slice(i + 1);
  if (!isValidFeatureId(featureId) || !isValidStateName(name)) return null;
  return { featureId, name };
}

// ── Per-project state names ────────────────────────────────────────────────

/**
 * A short, stable token for a projectKey, for per-project state names
 * (`'cache:' + projectSlot(pk)`). Project keys can hold any character (`us:name:My Project`),
 * and a backup restore only accepts state names matching RESTORE_NAME_RE
 * (options/importer/backup.js), so raw keys must never go into a name. The token is `p` + the
 * 16-hex-digit 64-bit FNV-1a hash of the key's UTF-8 (core/hash.js): the same in every browser
 * and version, only [a-z0-9], collisions negligible for the handful of projects one person uses.
 * '' for an empty / non-string key (callers then skip the state).
 */
export function projectSlot(projectKey) {
  if (typeof projectKey !== 'string' || !projectKey) return '';
  return 'p' + stableHash64(projectKey);
}

const MISSING = Symbol('missing');

/**
 * state.get(name) with a read fallback to the older names the same entry used to live under
 * (e.g. `cache:<raw projectKey>` before projectSlot). The first old name that holds a value is
 * moved: written under `name`, then every old name found is removed. Failures while moving are
 * ignored (the value is still returned; the next read tries again). → value | fallback
 * `state` is ctx.state (or the settings-ui `state`).
 */
export async function getMigrated(state, name, oldNames = [], fallback = undefined) {
  const cur = await state.get(name, MISSING);
  if (cur !== MISSING) return cur;
  const olds = [...new Set(oldNames)].filter((n) => n && n !== name && isValidStateName(n));
  let found = MISSING;
  const seen = [];
  for (const old of olds) {
    const v = await state.get(old, MISSING);
    if (v === MISSING) continue;
    seen.push(old);
    if (found === MISSING) found = v;
  }
  if (found === MISSING) return fallback;
  try {
    await state.set(name, found);
    for (const old of seen) await state.remove(old);
  } catch { /* keep the old entries; try again next time */ }
  return found;
}
