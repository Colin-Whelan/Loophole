// Legacy mapper for "Iterable - Auto Confirm Delete + Undo" (ARCHITECTURE §8.3).
// The script stored one GM value: autoConfirmDelete (boolean). Its undo history was in memory
// only, so there is no state to bring over. Never throws. No DOM: runs in the service worker too.

import { asJson } from '../../options/importer/decode.js';

function parseBool(v) {
  const x = asJson(v);
  if (typeof x === 'boolean') return x;
  if (x === 'true' || x === 1 || x === '1') return true;
  if (x === 'false' || x === 0 || x === '0') return false;
  return null;
}

export function mapBeeUndo(storage) {
  const s = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  if (!Object.prototype.hasOwnProperty.call(s, 'autoConfirmDelete')) {
    return { values: {}, notes: ['No saved auto-confirm setting (the script was using its default: off).'] };
  }
  const b = parseBool(s.autoConfirmDelete);
  if (b === null) {
    return { values: {}, notes: ['The saved auto-confirm setting could not be read, so it was not imported.'] };
  }
  return {
    values: { autoConfirmDelete: b },
    notes: [`Auto-confirm delete: ${b ? 'on' : 'off'}. The undo history was never saved, so there is none to import.`],
  };
}

export default {
  scripts: ['Iterable - Auto Confirm Delete + Undo'],
  map: mapBeeUndo,
};
