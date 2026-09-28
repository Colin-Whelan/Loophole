// Legacy mapper for "Iterable Image Path Selector" (ARCHITECTURE §8.3). GM values (decoded; any of
// them may still be a JSON string):
//   iterableImageSelector_sortBy         'UpdatedAt' | 'CreatedAt' | 'Name' | 'Size'  → values.sortBy
//   iterableImageSelector_sortDirection  'Descending' | 'Ascending'                   → values.sortDirection
//   iterableImageSelector_itemsPerPage   20 | 30 | 50 | 100 (number or string)        → values.itemsPerPage ('30')
//   iterableImageSelector_lastFolderId   folder id or null                            → state hint (below)
// The script kept one last folder for every project, so we can't tell which project it belongs
// to. It is stored as the state hint `legacyLastFolderId`: the library tries it once in a project
// that has no remembered folder of its own and drops it after it opens, falling back to the root
// if that project has no such folder. The skip-edit checkbox was never saved. Never throws; no DOM.

import { asJson } from '../../options/importer/decode.js';
import { SORT_BY, SORT_DIRECTIONS } from '../../lib/iterable/assets.js';
import { ITEMS_PER_PAGE_OPTIONS, LEGACY_FOLDER_HINT, normaliseFolderId } from './logic.js';

const K = {
  sortBy: 'iterableImageSelector_sortBy',
  sortDirection: 'iterableImageSelector_sortDirection',
  itemsPerPage: 'iterableImageSelector_itemsPerPage',
  lastFolder: 'iterableImageSelector_lastFolderId',
};

export function mapImageLibrary(storage) {
  const s = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const values = {};
  const state = {};
  const notes = [];
  const unreadable = (what) => notes.push(`The saved ${what} could not be read, so the default applies.`);

  if (has(K.sortBy)) {
    const v = asJson(s[K.sortBy]);
    if (SORT_BY.includes(v)) values.sortBy = v;
    else unreadable('sort order');
  }
  if (has(K.sortDirection)) {
    const v = asJson(s[K.sortDirection]);
    if (SORT_DIRECTIONS.includes(v)) values.sortDirection = v;
    else unreadable('sort direction');
  }
  if (has(K.itemsPerPage)) {
    const v = asJson(s[K.itemsPerPage]);
    const str = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (ITEMS_PER_PAGE_OPTIONS.includes(str)) values.itemsPerPage = str;
    else unreadable('items-per-page value');
  }
  if (has(K.lastFolder)) {
    const raw = asJson(s[K.lastFolder]);
    const id = normaliseFolderId(raw);
    if (id !== null) {
      state[LEGACY_FOLDER_HINT] = id;
      notes.push('Your last opened folder is tried once in the first project where you open the library; if that project has no such folder, the library opens at the top.');
    } else if (raw !== null && raw !== undefined && raw !== '') {
      notes.push('The saved last folder could not be read, so the library opens at the top.');
    }
  }
  return { values, state, notes };
}

export default {
  scripts: ['Iterable Image Path Selector'],
  map: mapImageLibrary,
};
