// wb:settings: read, resolve against feature metas, write, subscribe. See ARCHITECTURE §5.1.
//
// Stored settings are sparse: only what the user actually changed. Defaults come from the metas
// at read time and are never written back unprompted, so a changed default reaches every user.

import { STORAGE } from './messages.js';
import * as storage from './storage.js';
import { FEATURES } from '../features/registry.js';
import { isValidObjectList, normalizeObjectList, cloneJsonSafe } from './schema.js';
import { isValidShortcut, normalizeShortcut } from './shortcut.js';

export const SETTINGS_VERSION = 1;
export const THEMES = ['light', 'dark', 'system'];
export const DEFAULT_GENERAL = Object.freeze({ theme: 'light', debug: false });

export function emptyRaw() {
  return { version: SETTINGS_VERSION, general: {}, features: {} };
}

/** Schema defaults for one feature meta. */
export function defaultValues(meta) {
  const out = {};
  for (const field of meta?.settings || []) out[field.key] = repair(field, clone(field.default));
  return out;
}

/** True when `value` is acceptable for a schema field. Invalid stored values fall back to the default. */
export function isValidValue(field, value) {
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (field.min != null && value < field.min) return false;
      if (field.max != null && value > field.max) return false;
      return true;
    case 'string':
    case 'text': return typeof value === 'string';
    case 'select': return (field.options || []).some((o) => o.value === value);
    case 'stringList': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'keyValueList':
      return Array.isArray(value) && value.every((v) => v && typeof v.key === 'string' && typeof v.value === 'string');
    case 'shortcut': return isValidShortcut(value);
    case 'objectList': return isValidObjectList(field, value);
    default: return true;
  }
}

/**
 * Merge stored values over schema defaults. Keys outside the schema are kept as-is: features with
 * a custom settings editor store their own shapes there.
 */
export function mergeValues(meta, stored) {
  const out = { ...(stored && typeof stored === 'object' ? clone(stored) : {}) };
  for (const field of meta?.settings || []) {
    const has = Object.prototype.hasOwnProperty.call(out, field.key);
    const v = has ? repair(field, out[field.key]) : undefined;
    out[field.key] = has && isValidValue(field, v) ? v : repair(field, clone(field.default));
  }
  return out;
}

/**
 * Bring a stored value into normal form where that is safe: objectList items get defaults for
 * missing/invalid sub-fields (so a sub-field added later keeps the user's list), shortcuts are
 * canonicalised. Anything else is returned unchanged.
 */
function repair(field, value) {
  if (field.type === 'objectList') return normalizeObjectList(field, value) ?? value;
  if (field.type === 'shortcut' && typeof value === 'string') return normalizeShortcut(value) ?? value;
  return value;
}

export function resolveGeneral(rawGeneral) {
  const g = rawGeneral && typeof rawGeneral === 'object' ? rawGeneral : {};
  return {
    theme: THEMES.includes(g.theme) ? g.theme : DEFAULT_GENERAL.theme,
    debug: typeof g.debug === 'boolean' ? g.debug : DEFAULT_GENERAL.debug,
  };
}

/** Full resolved settings: `{ version, general, features: { [id]: { enabled, values } } }`. */
export function resolveSettings(raw, metas = FEATURES) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const storedFeatures = r.features && typeof r.features === 'object' ? r.features : {};
  const features = {};
  for (const meta of metas) {
    const s = storedFeatures[meta.id] || {};
    features[meta.id] = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : meta.defaultEnabled !== false,
      values: mergeValues(meta, s.values),
    };
  }
  return { version: SETTINGS_VERSION, general: resolveGeneral(r.general), features };
}

// ── Storage-backed API ───────────────────────────────────────────────────

export async function readRaw() {
  const raw = await storage.get(STORAGE.SETTINGS, null);
  if (!raw || typeof raw !== 'object') return emptyRaw();
  return {
    version: raw.version || SETTINGS_VERSION,
    general: raw.general && typeof raw.general === 'object' ? raw.general : {},
    features: raw.features && typeof raw.features === 'object' ? raw.features : {},
  };
}

export async function load() {
  return resolveSettings(await readRaw());
}

/**
 * Read-modify-write of the raw (sparse) settings object. `mutate` may return false to skip the
 * write (nothing changed).
 */
async function update(mutate) {
  const raw = await readRaw();
  if (mutate(raw) === false) return resolveSettings(raw);
  raw.version = SETTINGS_VERSION;
  await storage.set(STORAGE.SETTINGS, raw);
  return resolveSettings(raw);
}

export function setGeneral(patch) {
  return update((raw) => { raw.general = { ...raw.general, ...patch }; });
}

export function setFeatureEnabled(featureId, enabled) {
  return update((raw) => {
    raw.features[featureId] = { ...(raw.features[featureId] || {}), enabled: !!enabled };
  });
}

/**
 * Merge `patch` into stored values. A key whose patch value is `undefined` is deleted, so it falls
 * back to the current schema default (JSON storage can't hold undefined, so this is the only way
 * to express "unset").
 */
function applyPatch(raw, featureId, patch) {
  const f = raw.features[featureId] || {};
  const values = { ...(f.values && typeof f.values === 'object' ? f.values : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete values[k];
    else values[k] = clone(v);
  }
  raw.features[featureId] = { ...f, values };
}

/** Merge `patch` into the feature's stored values (`undefined` values delete keys, see above). */
export function setFeatureValues(featureId, patch) {
  return update((raw) => applyPatch(raw, featureId, patch));
}

/**
 * Like setFeatureValues, but `patchOrFn` may be a function `(latestValues) => patch | null`
 * that receives this feature's resolved values as read inside the same read-modify-write (so a
 * patch computed from them, e.g. "append a tag", starts from the latest stored copy). Returning
 * null/undefined skips the write. Resolves the full resolved settings.
 */
export function updateFeatureValues(featureId, patchOrFn) {
  return update((raw) => {
    let patch = patchOrFn;
    if (typeof patchOrFn === 'function') {
      const meta = FEATURES.find((m) => m.id === featureId);
      patch = patchOrFn(mergeValues(meta, raw.features[featureId]?.values));
      if (patch == null) return false;
    }
    applyPatch(raw, featureId, patch);
    return undefined;
  });
}

/**
 * Drop stored values so the current schema defaults apply again (enabled state is kept).
 * `keys` (optional array) limits the reset to those value keys.
 */
export function resetFeatureValues(featureId, keys) {
  return update((raw) => {
    const f = raw.features[featureId];
    if (!f || !f.values) return false;
    if (Array.isArray(keys)) {
      f.values = { ...f.values };
      for (const k of keys) delete f.values[k];
    } else {
      delete f.values;
    }
    return undefined;
  });
}

/** Replace the whole raw object (Loophole settings import). */
export async function replaceRaw(raw) {
  const next = { ...emptyRaw(), ...(raw && typeof raw === 'object' ? raw : {}) };
  await storage.set(STORAGE.SETTINGS, next);
  return resolveSettings(next);
}

/** cb(resolved, previousResolved) on every change. Returns unsubscribe. */
export function subscribe(cb) {
  return storage.subscribe(STORAGE.SETTINGS, (newRaw, oldRaw) => {
    cb(resolveSettings(newRaw), resolveSettings(oldRaw));
  });
}

// Stored values are copied without __proto__ / constructor / prototype keys (core/schema.js).
const clone = cloneJsonSafe;
