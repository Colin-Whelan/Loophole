// Legacy mapper for "Iterable Email HTML Scanner" (ARCHITECTURE §8.3).
//   emailScannerSettings  JSON.stringify({ [ruleId]: boolean }); after Tampermonkey decoding
//                         usually still a JSON string, a parsed object is accepted too.
// Rule ids are this feature's setting keys. Unknown ids and non-boolean values are skipped.
// A few ids from earlier script versions map to their current rule.

import { asJson } from '../../options/importer/decode.js';
import { RULE_IDS } from './rules.js';

const ALIASES = Object.freeze({
  checkMissingAlt: 'checkMissingAltText',
  checkUnclosedHandlebars: 'checkBrokenHandlebars',
  checkUnsubscribe: 'checkMissingUnsubscribe',
});

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export function mapEmailScanner(storage) {
  const raw = storage && typeof storage === 'object' ? storage.emailScannerSettings : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { values: {}, notes: ['No saved settings (the script was using its defaults).'] };
  }
  const cfg = asJson(raw);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { values: {}, notes: ['The saved rule settings could not be read, so nothing was imported.'] };
  }
  const values = {};
  let unknown = 0;
  for (const [key, v] of Object.entries(cfg)) {
    const id = Object.hasOwn(ALIASES, key) ? ALIASES[key] : key;
    const on = asBool(v);
    if (!RULE_IDS.includes(id) || on === null) { unknown++; continue; }
    // A current id wins over an old alias for the same rule.
    if (id !== key && Object.hasOwn(cfg, id)) continue;
    values[id] = on;
  }
  const notes = [];
  const n = Object.keys(values).length;
  const off = Object.values(values).filter((v) => !v).length;
  if (n) notes.push(`${n} rule setting${n === 1 ? '' : 's'} (${off} switched off).`);
  else notes.push('No recognised rule settings in the saved data.');
  if (unknown) notes.push(`Skipped ${unknown} unknown or unreadable rule setting${unknown === 1 ? '' : 's'}.`);
  return { values, notes };
}

export default {
  scripts: ['Iterable Email HTML Scanner'],
  map: mapEmailScanner,
};
