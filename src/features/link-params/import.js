// Legacy importer for "Iterable - Link Param Helper" (ARCHITECTURE §8.3).
// The script stored one GM value: paramTypes = JSON.stringify(library). Tampermonkey tags it as a
// string, so after decoding it usually arrives as a JSON string; an object is accepted too.
// Session recents were never persisted, so there is no state to bring over.

import { normalizeParamTypes } from './library.js';

export default {
  scripts: ['Iterable - Link Param Helper'],
  map(storage) {
    const raw = storage && typeof storage === 'object' ? storage.paramTypes : undefined;
    if (raw === undefined || raw === null || raw === '') {
      return { values: {}, notes: ['No saved link parameter library (the script was using its defaults).'] };
    }
    const { paramTypes, notes } = normalizeParamTypes(raw);
    if (!paramTypes) return { values: {}, notes };
    const types = Object.values(paramTypes);
    const cats = types.reduce((n, t) => n + t.categories.length, 0);
    const terms = types.reduce((n, t) => n + t.categories.reduce((m, c) => m + c.terms.length, 0), 0);
    return {
      values: { paramTypes },
      notes: [
        `Library: ${types.length} parameter${types.length === 1 ? '' : 's'} (${Object.keys(paramTypes).join(', ')}), `
          + `${cats} categor${cats === 1 ? 'y' : 'ies'}, ${terms} term${terms === 1 ? '' : 's'}.`,
        ...notes,
      ],
    };
  },
};
