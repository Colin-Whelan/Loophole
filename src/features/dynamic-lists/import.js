// Legacy mapper for "Iterable Dynamic Lists Checker" (ARCHITECTURE §8.3).
//   batchSize            number (1-20 in the script) → batchSize, clamped to 1-16
//   showProgressBar      boolean → showProgressBar
//   autoStart            boolean → autoStart (only stored once the user toggled it in the menu)
//   dynamicLists_<id>    per-user cached results (JSON strings) → skipped: keyed by raw profile
//                        id, and cheap to rebuild with Check now
// No DOM here: this runs in the service worker too.

import { clampInt } from './logic.js';

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return null;
}

export function mapDynamicLists(storage) {
  const s = storage && typeof storage === 'object' ? storage : {};
  const values = {};
  const notes = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  if (!Object.keys(s).length) return { values, notes };

  if (has('batchSize')) {
    const n = Number(s.batchSize);
    if (Number.isFinite(n) && n > 0) {
      values.batchSize = clampInt(n, 1, 16, 8);
      if (values.batchSize !== Math.round(n)) notes.push(`Concurrent queries lowered from ${Math.round(n)} to ${values.batchSize} (the new maximum).`);
    } else {
      notes.push('The saved batch size could not be read, so the default (8) applies.');
    }
  }

  if (has('showProgressBar')) {
    const b = parseBool(s.showProgressBar);
    if (b !== null) values.showProgressBar = b;
  }

  if (has('autoStart')) {
    const b = parseBool(s.autoStart);
    if (b !== null) values.autoStart = b;
  }
  if (values.autoStart !== true) {
    notes.push("Automatic checks are off (the script ran them by default). Use Check now on a profile's Lists tab, or turn on \"Check automatically\".");
  }

  const cached = Object.keys(s).filter((k) => k.startsWith('dynamicLists_') && s[k] != null && s[k] !== '').length;
  if (cached > 0) {
    notes.push(`Skipped ${cached} cached result${cached === 1 ? '' : 's'}; Check now rebuilds them.`);
  }

  return { values, notes };
}

export default {
  scripts: ['Iterable Dynamic Lists Checker'],
  map: mapDynamicLists,
};
