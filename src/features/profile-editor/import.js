// Legacy mapper for "Iterable Profile Editor" (ARCHITECTURE §8.3). The script's per-space API keys
// (`iterable_spaces`) are imported centrally by options/importer/legacy-keys.js and deliberately
// not touched here. Never throws. No DOM: this runs in the service worker too.

import { asJson } from '../../options/importer/decode.js';

function parseBool(v) {
  const x = asJson(v);
  if (typeof x === 'boolean') return x;
  if (x === 'true' || x === 1 || x === '1') return true;
  if (x === 'false' || x === 0 || x === '0') return false;
  return null;
}

const MAP = [
  ['iterable_merge_nested', 'mergeNested', 'merge-nested-objects'],
  ['iterable_show_notifications', 'showNotifications', 'show-notifications'],
];

export function mapProfileEditor(storage) {
  const s = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const values = {};
  const notes = [];
  for (const [gm, key, label] of MAP) {
    if (!Object.prototype.hasOwnProperty.call(s, gm)) continue;
    const b = parseBool(s[gm]);
    if (b === null) notes.push(`The saved ${label} setting could not be read, so it was not imported.`);
    else values[key] = b;
  }
  return { values, notes };
}

export default {
  scripts: ['Iterable Profile Editor'],
  map: mapProfileEditor,
};
