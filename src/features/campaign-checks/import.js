// Legacy mapper for "Campaign Preview Enhancements" (ARCHITECTURE §8.3).
//   campaignConfig  JSON.stringify({ seedListCheck, seedListKeyword, suppressListCheck,
//                   campaignRules: [{ keywords[], requiredSuppressionLists[], isGlobal }],
//                   customRateLimit, rateLimitsByMessageType, htmlScan: { enabled, … } });
//                   after Tampermonkey decoding usually still a JSON string, a parsed object is
//                   accepted too. Values inside may be strings ("true", "4000").
//   customRateLimit older script versions kept this as its own value; used when the config
//                   has none.
// Never throws: anything unreadable is skipped with a note.

import { asJson } from '../../options/importer/decode.js';
import { splitList, toWholeNumber } from './logic.js';
import { RATE_MIN, RATE_MAX } from './meta.js';

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function mapRules(raw, notes) {
  const list = asJson(raw);
  if (!Array.isArray(list)) {
    notes.push('The campaign rules could not be read, so none were imported.');
    return null;
  }
  const rules = [];
  let skipped = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { skipped++; continue; }
    const isGlobal = asBool(r.isGlobal) === true;
    const keywords = isGlobal ? [] : splitList(Array.isArray(r.keywords) || typeof r.keywords === 'string' ? r.keywords : []);
    const lists = splitList(
      Array.isArray(r.requiredSuppressionLists) || typeof r.requiredSuppressionLists === 'string'
        ? r.requiredSuppressionLists
        : (Array.isArray(r.requiredLists) || typeof r.requiredLists === 'string' ? r.requiredLists : []),
    );
    if (!lists.length || (!isGlobal && !keywords.length)) { skipped++; continue; }
    rules.push({ keywords: keywords.join(', '), requiredLists: lists.join(', '), isGlobal });
  }
  notes.push(`${rules.length} suppression rule${rules.length === 1 ? '' : 's'}.`);
  if (skipped) notes.push(`Skipped ${skipped} incomplete or unreadable rule${skipped === 1 ? '' : 's'}.`);
  return rules;
}

export function mapCampaignChecks(storage) {
  const store = storage && typeof storage === 'object' ? storage : {};
  const values = {};
  const notes = [];
  const rawCfg = store.campaignConfig;
  let cfg = null;
  if (rawCfg !== undefined && rawCfg !== null && rawCfg !== '') {
    cfg = asJson(rawCfg);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      notes.push('The saved settings could not be read, so nothing was imported from them.');
      cfg = null;
    }
  }

  if (cfg) {
    // The script's checks were off unless switched on; keep what the user had.
    for (const key of ['seedListCheck', 'suppressListCheck']) {
      if (!Object.hasOwn(cfg, key)) continue;
      const b = asBool(cfg[key]);
      if (b !== null) values[key] = b;
    }
    if (typeof cfg.seedListKeyword === 'string' && cfg.seedListKeyword.trim()) {
      values.seedListKeyword = cfg.seedListKeyword.trim();
    }
    if (Object.hasOwn(cfg, 'campaignRules')) {
      const rules = mapRules(cfg.campaignRules, notes);
      if (rules) values.campaignRules = rules;
    }
    if (cfg.rateLimitsByMessageType && typeof cfg.rateLimitsByMessageType === 'object'
      && Object.keys(cfg.rateLimitsByMessageType).length) {
      notes.push('The cached per-message-type rate limits were not imported (Loophole no longer reads them from the settings page).');
    }
    if (cfg.htmlScan !== undefined) {
      notes.push('The HTML scan setting was not imported: the Email HTML check feature does that job now (its own settings).');
    }
  }

  const rateRaw = cfg && Object.hasOwn(cfg, 'customRateLimit') ? cfg.customRateLimit : store.customRateLimit;
  if (rateRaw !== undefined && rateRaw !== null && rateRaw !== '') {
    const n = toWholeNumber(rateRaw);
    if (n !== null && n >= RATE_MIN && n <= RATE_MAX) {
      values.customRateLimit = n;
      notes.push(`Send rate ${n.toLocaleString('en-US')}/min.`);
    } else {
      notes.push('The saved send rate was out of range or unreadable, so the default applies.');
    }
  }

  if (!cfg && !Object.keys(values).length && !notes.length) {
    notes.push('No saved settings (the script was using its defaults).');
  }
  return { values, notes };
}

export default {
  scripts: ['Campaign Preview Enhancements'],
  map: mapCampaignChecks,
};
