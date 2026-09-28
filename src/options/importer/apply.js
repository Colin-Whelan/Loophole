// Writing an import to storage, and the wb:legacy stash (ARCHITECTURE §8.4).
//
// No DOM here: the background runs runStashedMappers() on runtime.onInstalled reason 'update',
// and the options page runs it on every load. Keep this file (and everything it imports) free of
// document/window so the background bundle stays service-worker safe.

import * as storage from '../../core/storage.js';
import * as settings from '../../core/settings.js';
import { writeStateEntries } from '../../core/state.js';
import { importKeys } from '../../core/keys.js';
import { LEGACY_PREFIX, legacyStashKey, findImporter, featureForScript } from './plan.js';
import { FEATURES } from '../../features/registry.js';

/** Apply one mapper result's values and state. Returns its keys for the central key import. */
export async function applyMapperResult(featureId, result) {
  if (result?.values && Object.keys(result.values).length) {
    await settings.setFeatureValues(featureId, result.values);
  }
  if (result?.state && Object.keys(result.state).length) {
    await writeStateEntries({ [featureId]: result.state });
  }
  return Array.isArray(result?.keys) ? result.keys : [];
}

/**
 * Import API keys. keep: saved keys win on conflict; replace: the imported key wins.
 * Returns { added, replaced, kept, unchanged, invalid }.
 */
export async function importKeyLists({ keep = [], replace = [] }) {
  const totals = { added: 0, replaced: 0, kept: 0, unchanged: 0, invalid: 0 };
  for (const [list, onConflict] of [[keep, 'keep'], [replace, 'replace']]) {
    if (!list.length) continue;
    const res = await importKeys(list, { onConflict });
    totals.added += res.added || 0;
    totals.replaced += res.replaced || 0;
    totals.kept += res.kept || 0;
    totals.unchanged += res.unchanged || 0;
    totals.invalid += (res.invalid || []).length;
  }
  return totals;
}

/**
 * Apply the ticked plan items and the chosen keys.
 *   items  planned items (plan.js) the user ticked
 *   keys   { keep: [{ projectKey, name, apiKey }], replace: [...] }
 * → { scripts: [{ name, status }], keys: totals }
 */
export async function applyImport({ items, keys }) {
  const outcome = [];
  const mapperKeys = [];
  for (const item of items) {
    if (item.status === 'import') {
      mapperKeys.push(...await applyMapperResult(item.featureId, item.result));
      outcome.push({ name: item.script.name, status: 'import' });
    } else if (item.status === 'stash') {
      await storage.set(legacyStashKey(item.script.name), {
        name: item.script.name,
        storage: item.stash,
        savedAt: new Date().toISOString(),
        status: 'pending',
      });
      outcome.push({ name: item.script.name, status: 'stash' });
    } else {
      outcome.push({ name: item.script.name, status: 'empty' });
    }
  }
  const totals = await importKeyLists({ keep: [...(keys?.keep || []), ...mapperKeys], replace: keys?.replace || [] });
  return { scripts: outcome, keys: totals };
}

/** Every stash entry: [{ storageKey, name, status, featureId?, savedAt, importedAt? }]. */
export async function listStash() {
  const all = await storage.getAll();
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(LEGACY_PREFIX) && v && typeof v === 'object')
    .map(([k, v]) => ({ storageKey: k, ...v }));
}

/**
 * Run newly available mappers against pending stash entries (and 'empty' ones whose feature has
 * since gained a mapper) and mark them imported. A pending entry whose feature exists but ships no
 * mapper is marked status 'empty' ("Nothing to import") instead of staying pending forever.
 * importers: `{ [featureId]: import.js module }` (wb-virtual:importers). Returns
 * [{ name, featureId }] that were imported.
 * announced: false (the background, which can't show anything) leaves the entries for the options
 * page to announce later via takeUnannounced().
 */
export async function runStashedMappers(importers, { announced = true, metas = FEATURES } = {}) {
  const done = [];
  for (const entry of await listStash()) {
    // 'empty' entries stay kept (storage included): should their feature gain a mapper later,
    // it still runs.
    if (entry.status !== 'pending' && entry.status !== 'empty') continue;
    const found = findImporter(entry.name, importers);
    if (!found && entry.status === 'empty') continue;
    if (!found) {
      // The feature has shipped without a mapper (it keeps no settings from the script, e.g.
      // Export CSV bulk select): nothing will ever import this, so resolve it instead of leaving
      // it pending forever. Quietly: there's nothing to announce.
      const feature = featureForScript(entry.name, metas);
      if (feature) {
        try {
          await storage.set(entry.storageKey, {
            name: entry.name, storage: entry.storage, savedAt: entry.savedAt,
            status: 'empty', featureId: feature.id, resolvedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('[WB:import] could not resolve the stash entry for', entry.name, e?.message || e);
        }
      }
      continue;
    }
    try {
      const result = found.importer.map(entry.storage, { name: entry.name }) || {};
      const keys = await applyMapperResult(found.featureId, result);
      if (keys.length) await importKeyLists({ keep: keys });
      await storage.set(entry.storageKey, {
        name: entry.name, storage: entry.storage, savedAt: entry.savedAt,
        status: 'imported', featureId: found.featureId, importedAt: new Date().toISOString(),
        ...(announced ? {} : { announced: false }),
      });
      done.push({ name: entry.name, featureId: found.featureId });
    } catch (e) {
      console.warn('[WB:import] stashed settings for', entry.name, 'could not be imported yet:', e?.message || e);
    }
  }
  return done;
}

/**
 * Stash entries imported without telling the user (by the background on update): returns
 * [{ name, featureId }] and marks them announced.
 */
export async function takeUnannounced() {
  const out = [];
  for (const entry of await listStash()) {
    if (entry.status !== 'imported' || entry.announced !== false) continue;
    const { storageKey, announced: _a, ...rest } = entry;
    await storage.set(storageKey, rest);
    out.push({ name: entry.name, featureId: entry.featureId });
  }
  return out;
}
