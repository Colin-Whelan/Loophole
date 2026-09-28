// Bulk data: import from the legacy "Iterable User Push" and "Iterable Catalog Push" userscripts'
// Tampermonkey storage. API keys (api_keys_by_project, legacy_api_key) are imported centrally by
// options/importer/legacy-keys.js, so they're deliberately not touched here.
//
// Both scripts stored their pacing under the same GM key, `settings` = { rateLimit, batchSize },
// but they mean different settings here (rateLimit/batchSize vs catalogRateLimit/
// catalogBatchSize). The importer calls map(storage, { name }) with the legacy @name
// (ARCHITECTURE §8.3), which decides; a bare string or { scriptName } is accepted too. Only when
// no name is given does the storage itself decide where it can (see whichScript), and anything
// still ambiguous imports as User Push.

import { asJson } from '../../options/importer/decode.js';
import { normalizeScriptName } from '../../options/importer/names.js';
import { clampRate, clampBatch, clampCatalogRate, clampCatalogBatch, MAX_RATE_LIMIT, CKPT_PREFIX } from './logic.js';
import { CATALOG_SCOPE_PREFIX } from './catalog-logic.js';

export const USER_PUSH = 'Iterable User Push';
export const CATALOG_PUSH = 'Iterable Catalog Push';

function nameFrom(context) {
  if (typeof context === 'string') return context;
  if (context && typeof context === 'object') return context.name || context.scriptName || '';
  return '';
}

/**
 * 'catalogs' | 'users' for one legacy store. By name when known; otherwise by what only one of
 * the scripts writes: Catalog Push checkpoints ('ckpt:catalog:…') vs User Push ones
 * ('ckpt:push…', 'ckpt:subscribe…'), User Push's legacy_api_key / pre-1.1 settings.apiKey, or a
 * rate above User Push's cap of 10.
 */
export function whichScript(storage, context) {
  const n = normalizeScriptName(nameFrom(context));
  if (n && n === normalizeScriptName(CATALOG_PUSH)) return 'catalogs';
  if (n && n === normalizeScriptName(USER_PUSH)) return 'users';
  const s = storage && typeof storage === 'object' ? storage : {};
  const ckpts = Object.keys(s).filter((k) => k.startsWith(CKPT_PREFIX)).map((k) => k.slice(CKPT_PREFIX.length));
  const catalogCk = ckpts.some((k) => k.startsWith(CATALOG_SCOPE_PREFIX));
  const userCk = ckpts.some((k) => k.startsWith('push') || k.startsWith('subscribe'));
  if (catalogCk && !userCk) return 'catalogs';
  if (userCk && !catalogCk) return 'users';
  const cfg = asJson(s.settings);
  if ('legacy_api_key' in s || (cfg && typeof cfg === 'object' && cfg.apiKey)) return 'users';
  if (cfg && typeof cfg === 'object' && Number(cfg.rateLimit) > MAX_RATE_LIMIT) return 'catalogs';
  return 'users';
}

export default {
  scripts: [USER_PUSH, CATALOG_PUSH],
  map(storage, context) {
    const s = storage && typeof storage === 'object' ? storage : {};
    const values = {};
    const notes = [];
    const catalogs = whichScript(s, context) === 'catalogs';

    // `settings` was stored as JSON.stringify({ rateLimit, batchSize }); it may arrive decoded
    // to an object or still as a JSON string.
    const cfg = asJson(s.settings);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const rate = Number(cfg.rateLimit);
      if (Number.isFinite(rate) && rate > 0) values[catalogs ? 'catalogRateLimit' : 'rateLimit'] = catalogs ? clampCatalogRate(rate) : clampRate(rate);
      const batch = Number(cfg.batchSize);
      if (Number.isFinite(batch) && batch > 0) values[catalogs ? 'catalogBatchSize' : 'batchSize'] = catalogs ? clampCatalogBatch(batch) : clampBatch(batch);
    }

    const ckpts = Object.keys(s).filter((k) => k.startsWith(CKPT_PREFIX));
    if (ckpts.length) {
      notes.push('Skipped ' + ckpts.length + ' unfinished ' + (catalogs ? 'upload' : 'run') + (ckpts.length === 1 ? '' : 's') +
        ". Unfinished runs can't be carried over; re-select the file to start again.");
    }
    return { values, notes };
  },
};
