// Legacy mapper for "Iterable Template Quick Search" (ARCHITECTURE §8.3).
//   iterableQuickSearchTags       JSON string (or parsed array) of tags; old ones use `color`
//   iterableQuickSearchSettings   JSON string (or object) { sortOrder }; may be absent
//   iterableQuickSearchCollapsed  boolean (possibly still a string) → state 'collapsed'

import { asJson } from '../../options/importer/decode.js';
import {
  normaliseGradient, normaliseTag, normaliseTags, parseBool, SORT_ORDERS, MAX_TAG_LABEL,
} from './tags.js';

export function mapQuickSearch(storage) {
  const s = storage && typeof storage === 'object' ? storage : {};
  const values = {};
  const state = {};
  const notes = [];

  if (s.iterableQuickSearchTags !== undefined) {
    const raw = asJson(s.iterableQuickSearchTags);
    if (Array.isArray(raw)) {
      const tags = normaliseTags(raw);
      values.tags = tags;
      const converted = raw.filter((t) => normaliseTag(t) && !normaliseGradient(t.colorGradient)).length;
      const skipped = raw.length - tags.length;
      const shortened = raw.filter((t) => normaliseTag(t) && typeof t.label === 'string' && t.label.trim().length > MAX_TAG_LABEL).length;
      if (shortened > 0) {
        notes.push(`Shortened ${shortened} tag label${shortened === 1 ? '' : 's'} to ${MAX_TAG_LABEL} characters.`);
      }
      if (converted > 0) {
        notes.push(`Converted ${converted} tag${converted === 1 ? '' : 's'} from the old single-colour format to a gradient.`);
      }
      if (skipped > 0) notes.push(`Skipped ${skipped} tag${skipped === 1 ? '' : 's'} without a label.`);
    } else {
      notes.push('The saved tag list could not be read, so no tags were imported.');
    }
  }

  const settings = asJson(s.iterableQuickSearchSettings);
  if (settings && typeof settings === 'object' && SORT_ORDERS.includes(settings.sortOrder)) {
    values.sortOrder = settings.sortOrder;
  }

  if (s.iterableQuickSearchCollapsed !== undefined) {
    state.collapsed = parseBool(s.iterableQuickSearchCollapsed, false);
  }

  return { values, state, notes };
}

export default {
  scripts: ['Iterable Template Quick Search'],
  map: mapQuickSearch,
};
