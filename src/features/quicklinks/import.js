// Legacy mapper for "Custom Quicklinks" (ARCHITECTURE §8.3).
//   iterableQuicklinks  JSON.stringify([{ urlName, url }, …])
// After Tampermonkey decoding this is usually still a JSON string; a parsed array is accepted too.
// `openInNewTab` didn't exist in the script (links always opened in place), so it isn't set here —
// the feature default (false) applies.

import { asJson } from '../../options/importer/decode.js';

export function mapQuicklinks(storage) {
  const raw = storage && typeof storage === 'object' ? storage.iterableQuicklinks : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { values: {}, notes: ['No saved settings (the script was using its defaults).'] };
  }
  const parsed = asJson(raw);
  if (!Array.isArray(parsed)) {
    return { values: {}, notes: ['The saved quicklinks could not be read, so nothing was imported.'] };
  }
  const links = [];
  let dropped = 0;
  for (const entry of parsed) {
    const name = entry && typeof entry === 'object' && typeof entry.urlName === 'string' ? entry.urlName.trim() : '';
    const url = entry && typeof entry === 'object' && typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!name || !url) { dropped++; continue; }
    links.push({ name, url });
  }
  const notes = [];
  if (links.length) notes.push(`${links.length} quicklink${links.length === 1 ? '' : 's'} (${links.map((l) => l.name).join(', ')}).`);
  if (dropped) notes.push(`Skipped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} missing a name or URL.`);
  if (!links.length) notes.push('No usable quicklinks found, so the default links apply.');
  return { values: links.length ? { links } : {}, notes };
}

export default {
  scripts: ['Custom Quicklinks'],
  map: mapQuicklinks,
};
