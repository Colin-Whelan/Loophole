// Decide what happens to each detected script (ARCHITECTURE §8.4). Pure.
//
// Per script, one of:
//   'import'  a feature's import.js mapper handles it          → "Imported"
//   'stash'   no mapper yet; raw values (minus keys) are kept  → "Saved for a future version"
//   'empty'   nothing left once API keys are taken out        → "Nothing to import"
//   'error'   the mapper threw

import { normalizeScriptName } from './names.js';
import { stripLegacyKeys } from './legacy-keys.js';

export const STATUS_LABEL = Object.freeze({
  import: 'Imported',
  stash: 'Saved for a future version',
  empty: 'Nothing to import',
  error: 'Could not be read',
});

export const LEGACY_PREFIX = 'wb:legacy:';

export function legacyStashKey(scriptName) {
  return LEGACY_PREFIX + normalizeScriptName(scriptName);
}

/**
 * importers: { [featureId]: module with default { scripts, map } } (features/optional.js)
 * → { featureId, importer } | null, matching normalised names.
 */
export function findImporter(scriptName, importers) {
  const n = normalizeScriptName(scriptName);
  for (const [featureId, mod] of Object.entries(importers || {})) {
    const imp = mod?.default ?? mod;
    if (imp && typeof imp.map === 'function' && Array.isArray(imp.scripts) &&
        imp.scripts.some((s) => normalizeScriptName(s) === n)) {
      return { featureId, importer: imp };
    }
  }
  return null;
}

/** Feature whose meta.legacy lists this script (normalised), or null. */
export function featureForScript(scriptName, metas) {
  const n = normalizeScriptName(scriptName);
  return metas.find((m) => (m.legacy || []).some((l) => normalizeScriptName(l) === n)) || null;
}

/** Count what a mapper result carries, for the preview line. */
export function summarize(result) {
  const values = Object.keys(result?.values || {}).length;
  const state = Object.keys(result?.state || {}).length;
  const parts = [];
  if (values) parts.push(`${values} setting${values === 1 ? '' : 's'}`);
  if (state) parts.push(`${state} saved item${state === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * planScripts(scripts, { importers, metas, keySources, secrets })
 *   scripts     from readInputs(); only those with storage are planned
 *   keySources  Set of script names that contributed API keys (for the messages)
 *   secrets     every API key extractLegacyKeys found in this import: no string containing one
 *               survives into the wb:legacy stash
 * → [{ script, normName, feature, featureId, status, result, stash, message, notes }]
 * `notes` starts with the script's own reading notes (values that couldn't be decoded, duplicate
 * files) followed by the mapper's.
 */
export function planScripts(scripts, { importers, metas, keySources = new Set(), secrets = [] }) {
  return scripts.filter((s) => s.storage).map((script) => {
    const found = findImporter(script.name, importers);
    const feature = found ? metas.find((m) => m.id === found.featureId) || null : featureForScript(script.name, metas);
    const hadKeys = keySources.has(script.name);
    const stash = stripLegacyKeys(script.storage, { secrets });
    const readNotes = Array.isArray(script.notes) ? script.notes.map(String) : [];
    const item = {
      script, normName: script.normName, feature, featureId: feature?.id || found?.featureId || null,
      status: 'empty', result: null, stash, message: '', notes: [...readNotes],
    };

    if (found) {
      try {
        item.result = found.importer.map(script.storage, { name: script.name }) || {};
        item.notes = [...readNotes, ...(Array.isArray(item.result.notes) ? item.result.notes.map(String) : [])];
        const what = summarize(item.result);
        if (what || (item.result.keys || []).length) {
          item.status = 'import';
          item.message = what ? `Will import ${what}.` : 'Only API keys; they are listed below.';
        } else {
          item.message = hadKeys ? 'Only API keys; they are listed below.' : 'This script saved nothing Loophole uses.';
        }
      } catch (e) {
        item.status = 'error';
        item.message = `Couldn’t read this script’s settings: ${e?.message || e}`;
      }
      return item;
    }

    if (Object.keys(stash).length) {
      item.status = 'stash';
      item.message = feature
        ? `${feature.name} can’t import these settings yet. They’re kept and applied automatically when it can.`
        : 'Not in this version of Loophole. The settings are kept and applied automatically when a future version adds it.';
    } else {
      item.message = hadKeys ? 'Only API keys; they are listed below.' : 'This script has no saved settings.';
    }
    return item;
  });
}
