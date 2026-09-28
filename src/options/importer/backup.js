// Loophole's own backup file (ARCHITECTURE §8.4, §9): what a restore would write. Pure, so the
// rules are unit-tested; sections/import.js renders the confirm dialog and does the writes.
//
// A backup file is untrusted input (it may come from anyone). Nothing from it is written as-is:
//   - settings: only registered feature ids; `enabled` must be boolean; `values` are deep-copied
//     JSON with __proto__ / constructor / prototype keys dropped at every depth; general settings
//     only as far as they validate.
//   - state: only `wb:state:<registered feature id>:<name>` with a name matching RESTORE_NAME_RE;
//     bulk-data checkpoints (`ckpt:*`) are never restored (they point at files on the machine that
//     made the backup, and resuming one against different data would be wrong).
//   - keys: validated like the vault does, deduplicated per project, and only offered: the user
//     ticks each one (nothing is imported by default).
//   - legacy: Tampermonkey settings stashed for features a version didn't have yet
//     (wb:legacy:*, §8.4). Only entries whose key matches their script name; their storage is
//     key-scrubbed again (stripLegacyKeys) on export and on restore. Older backups have none.
// Objects keyed by imported names are Maps, never `{}` (a featureId of "__proto__" once polluted
// Object.prototype here).

import { parseStateKey } from '../../core/state.js';
import { THEMES, SETTINGS_VERSION } from '../../core/settings.js';
import {
  parseProjectKey, legacyProjectKey, validateApiKey, cleanName, maskKey,
} from '../../core/api-validation.js';
import { safeJsonCopy, isForbiddenKey } from './safe-json.js';
import { isBackupApp } from './sources.js';
import { LEGACY_PREFIX, legacyStashKey } from './plan.js';
import { stripLegacyKeys } from './legacy-keys.js';

export const BACKUP_FORMAT = 1;
/** Same as features/bulk-data/logic.js CKPT_PREFIX (a test keeps them in step). */
export const CHECKPOINT_PREFIX = 'ckpt:';
/** State names a restore accepts: what features actually use ('ui', 'recents', 'collapsed', …). */
export const RESTORE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,127}$/;
const MAX_STATE_ENTRIES = 5000;
const MAX_KEYS = 1000;
const MAX_LEGACY_ENTRIES = 200;
const MAX_SCRIPT_NAME = 200;
const LEGACY_STATUSES = new Set(['pending', 'imported', 'empty']);
const FEATURE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function isLoopholeBackupFile(backup) {
  return isObject(backup) && isBackupApp(backup.app) && backup.format === BACKUP_FORMAT;
}

/** Sanitised raw settings (the wb:settings shape) from a backup's `settings`. */
export function sanitizeBackupSettings(raw, metas) {
  const ids = new Set(metas.map((m) => m.id));
  const out = { version: SETTINGS_VERSION, general: {}, features: {} };
  if (!isObject(raw)) return out;
  const g = isObject(raw.general) ? raw.general : {};
  if (THEMES.includes(g.theme)) out.general.theme = g.theme;
  if (typeof g.debug === 'boolean') out.general.debug = g.debug;
  const features = isObject(raw.features) ? raw.features : {};
  for (const id of Object.keys(features)) {
    if (!ids.has(id) || isForbiddenKey(id)) continue;
    const entry = features[id];
    if (!isObject(entry)) continue;
    const f = {};
    if (typeof entry.enabled === 'boolean') f.enabled = entry.enabled;
    if (isObject(entry.values)) {
      const values = safeJsonCopy(entry.values);
      if (isObject(values) && Object.keys(values).length) f.values = values;
    }
    if (Object.keys(f).length) out.features[id] = f;
  }
  return out;
}

/**
 * One wb:legacy stash entry, cleaned for a backup file or a restore → entry | null.
 * The storage is copied (JSON only, no prototype names) and key-scrubbed again; `secrets` are raw
 * keys that must not survive in any form (the vault's on export, the file's on restore).
 * `announced` (a background-only flag) is dropped: a restore announces what it imports itself.
 */
export function cleanLegacyEntry(storageKey, entry, { secrets = [] } = {}) {
  if (!isObject(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name || name.length > MAX_SCRIPT_NAME || isForbiddenKey(name)) return null;
  if (storageKey !== legacyStashKey(name) || storageKey === LEGACY_PREFIX) return null;
  const raw = isObject(entry.storage) ? safeJsonCopy(entry.storage) : {};
  const out = {
    name,
    storage: stripLegacyKeys(isObject(raw) ? raw : {}, { secrets }),
    savedAt: typeof entry.savedAt === 'string' && !Number.isNaN(Date.parse(entry.savedAt)) ? entry.savedAt : null,
    status: LEGACY_STATUSES.has(entry.status) ? entry.status : 'pending',
  };
  if (typeof entry.featureId === 'string' && FEATURE_ID_RE.test(entry.featureId) && !isForbiddenKey(entry.featureId)) out.featureId = entry.featureId;
  for (const k of ['importedAt', 'resolvedAt']) {
    if (typeof entry[k] === 'string' && !Number.isNaN(Date.parse(entry[k]))) out[k] = entry[k];
  }
  return out;
}

/**
 * The `legacy` part of a backup file from all of storage: every wb:legacy:* entry, cleaned
 * (cleanLegacyEntry). → { [storageKey]: entry }
 */
export function legacyForBackup(all, { secrets = [] } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(isObject(all) ? all : {})) {
    if (!k.startsWith(LEGACY_PREFIX)) continue;
    const e = cleanLegacyEntry(k, v, { secrets });
    if (e) out[k] = e;
  }
  return out;
}

/**
 * planBackupRestore(backup, { metas }) →
 *   { ok: false, error }
 * | { ok: true, exportedAt, settings, featureCount,
 *     state: Map<featureId, Map<name, value>>, stateCount,
 *     skipped: { checkpoints, unknownFeature, invalid },   // state entries left out
 *     keys: [{ projectKey, name, dataCenter, apiKey, masked }], invalidKeys,
 *     legacy: Map<storageKey, entry>, invalidLegacy }   // stashed Tampermonkey settings
 */
export function planBackupRestore(backup, { metas }) {
  if (!isLoopholeBackupFile(backup)) return { ok: false, error: 'That file isn’t a Loophole backup.' };
  const ids = new Set(metas.map((m) => m.id));

  const settings = sanitizeBackupSettings(backup.settings, metas);

  const state = new Map();
  const skipped = { checkpoints: 0, unknownFeature: 0, invalid: 0 };
  let stateCount = 0;
  const stateEntries = isObject(backup.state) ? Object.entries(backup.state) : [];
  for (const [i, [k, v]] of stateEntries.entries()) {
    if (i >= MAX_STATE_ENTRIES) { skipped.invalid += stateEntries.length - i; break; }
    const parsed = parseStateKey(k);
    if (!parsed) { skipped.invalid++; continue; }
    const { featureId, name } = parsed;
    if (!ids.has(featureId)) { skipped.unknownFeature++; continue; }
    if (name.startsWith(CHECKPOINT_PREFIX)) { skipped.checkpoints++; continue; }
    if (!RESTORE_NAME_RE.test(name) || isForbiddenKey(name)) { skipped.invalid++; continue; }
    const value = safeJsonCopy(v);
    if (value === undefined) { skipped.invalid++; continue; }
    if (!state.has(featureId)) state.set(featureId, new Map());
    const names = state.get(featureId);
    if (!names.has(name)) stateCount++;
    names.set(name, value);
  }

  const byProject = new Map();
  let invalidKeys = 0;
  const list = Array.isArray(backup.keys) ? backup.keys : [];
  for (const [i, item] of list.entries()) {
    if (i >= MAX_KEYS) { invalidKeys += list.length - i; break; }
    if (!isObject(item)) { invalidKeys++; continue; }
    const pk = parseProjectKey(item.projectKey) ? item.projectKey : legacyProjectKey(item.projectKey);
    const parsed = pk && parseProjectKey(pk);
    if (!parsed) { invalidKeys++; continue; }
    if (item.dataCenter != null && item.dataCenter !== parsed.dataCenter) { invalidKeys++; continue; }
    const k = validateApiKey(item.apiKey);
    if (!k.ok) { invalidKeys++; continue; }
    if (byProject.has(pk)) { invalidKeys++; continue; } // one key per project: the first wins
    const name = cleanName(item.name, { allowEmpty: true }) || '';
    byProject.set(pk, { projectKey: pk, name, dataCenter: parsed.dataCenter, apiKey: k.value, masked: maskKey(k.value) });
  }

  // Stashed Tampermonkey settings (backups from before v0.4.0 have none). Scrubbed again with
  // every key this file carries, valid or not.
  const legacy = new Map();
  let invalidLegacy = 0;
  const fileKeys = list.filter(isObject).map((item) => item.apiKey).filter((k) => typeof k === 'string');
  const legacyEntries = isObject(backup.legacy) ? Object.entries(backup.legacy) : [];
  for (const [i, [k, v]] of legacyEntries.entries()) {
    if (i >= MAX_LEGACY_ENTRIES) { invalidLegacy += legacyEntries.length - i; break; }
    const e = isForbiddenKey(k) ? null : cleanLegacyEntry(k, v, { secrets: fileKeys });
    if (!e || legacy.has(k)) { invalidLegacy++; continue; }
    legacy.set(k, e);
  }

  const exportedAt = typeof backup.exportedAt === 'string' && !Number.isNaN(Date.parse(backup.exportedAt))
    ? backup.exportedAt : null;

  return {
    ok: true,
    exportedAt,
    settings,
    featureCount: Object.keys(settings.features).length,
    state,
    stateCount,
    skipped,
    keys: [...byProject.values()],
    invalidKeys,
    legacy,
    invalidLegacy,
  };
}
