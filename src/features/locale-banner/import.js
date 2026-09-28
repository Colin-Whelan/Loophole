// Legacy mapper for "Iterable Locale Banner" (ARCHITECTURE §8.3).
// The userscript (v1.2.0) saved no GM values: its EN-CA / FR-CA styling was hard-coded, so a
// normal export has nothing to import and the defaults apply. This mapper exists so such a store
// reports "saved nothing Loophole uses" instead of being stashed for a future version, and so a
// locally modified copy that did save same-named values (defaultLocale, pulseNonDefault,
// hideWhenNoLocale; possibly still JSON-encoded strings) carries them over. Never throws.
// No DOM here: this runs in the service worker too.

import { asJson } from '../../options/importer/decode.js';

const MAX_LOCALE = 64;

function parseBool(v) {
  const x = asJson(v);
  if (typeof x === 'boolean') return x;
  if (x === 'true' || x === 1 || x === '1') return true;
  if (x === 'false' || x === 0 || x === '0') return false;
  return null;
}

export function mapLocaleBanner(storage) {
  const s = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const values = {};
  const notes = [];

  if (has('defaultLocale')) {
    const v = asJson(s.defaultLocale);
    if (typeof v === 'string' && v.trim().length <= MAX_LOCALE) values.defaultLocale = v.trim();
    else notes.push('The saved default locale could not be read, so it was not imported.');
  }
  for (const key of ['pulseNonDefault', 'hideWhenNoLocale']) {
    if (!has(key)) continue;
    const b = parseBool(s[key]);
    if (b === null) notes.push(`The saved ${key} value could not be read, so it was not imported.`);
    else values[key] = b;
  }

  if (!Object.keys(values).length && !notes.length) {
    notes.push('The script kept its locales in code, not in saved settings. Set your default locale on the Locale banner settings page.');
  }
  return { values, notes };
}

export default {
  scripts: ['Iterable Locale Banner'],
  map: mapLocaleBanner,
};
