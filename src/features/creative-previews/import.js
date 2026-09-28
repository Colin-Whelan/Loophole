// Legacy mapper for "Iterable Creative Library - Bigger Previews" (ARCHITECTURE §8.3).
//   config   JSON string (or already-parsed object) { thumbSize, hoverSize, hoverDelay, rowHeight }
// Storage values arrive decoded (Tampermonkey's type tag already stripped) but a script that did
// `GM_setValue('config', JSON.stringify(cfg))` leaves `config` as a JSON string, so it's run
// through `asJson` first. Never throws: unreadable or out-of-range numbers fall back to the
// current default rather than being imported.

import { asJson } from '../../options/importer/decode.js';
import meta from './meta.js';

const DEFAULTS = Object.fromEntries(meta.settings.map((f) => [f.key, f]));

function clampedNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  return Math.min(max, Math.max(min, n));
}

export function mapCreativePreviews(storage) {
  const s = storage && typeof storage === 'object' ? storage : {};
  const values = {};
  const notes = [];

  if (s.config !== undefined) {
    const cfg = asJson(s.config);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      for (const key of ['thumbSize', 'hoverSize', 'hoverDelay', 'rowHeight']) {
        if (cfg[key] === undefined) continue;
        const n = clampedNumber(cfg[key], DEFAULTS[key]);
        if (n === undefined) {
          notes.push(`Skipped "${key}": not a number.`);
        } else {
          values[key] = n;
        }
      }
    } else {
      notes.push('The saved preview settings could not be read, so defaults were used.');
    }
  }

  return { values, notes };
}

export default {
  scripts: ['Iterable Creative Library - Bigger Previews'],
  map: mapCreativePreviews,
};
