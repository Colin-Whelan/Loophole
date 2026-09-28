// Pure logic for Field value explorer: combobox items and client-side value search.
// No DOM, no fetch — kept testable and easy to reason about.

/** getUserFields() result → combobox source items ([{ value, label, hint }]). */
export function fieldComboItems(fields) {
  return (fields || []).map((f) => ({ value: f.name, label: f.name, hint: f.type || undefined }));
}

/**
 * Case-insensitive substring search over `values`, capped at `max` for rendering.
 * → { shown: string[], matchCount, truncated } where `truncated` means more matches exist than
 * were returned in `shown` (independent of whether the API's own result was truncated).
 */
export function searchValues(values, query, max = 2000) {
  const list = values || [];
  const q = (query || '').trim().toLowerCase();
  const matches = q ? list.filter((v) => v.toLowerCase().includes(q)) : list;
  const cap = Number.isInteger(max) && max > 0 ? max : list.length;
  return { shown: matches.slice(0, cap), matchCount: matches.length, truncated: matches.length > cap };
}

/** Status line under the field picker once values are loaded. */
export function summaryText(matchCount, total, { apiTruncated = false } = {}) {
  const totalText = total.toLocaleString();
  if (matchCount === total) {
    return `${totalText} value${total === 1 ? '' : 's'}${apiTruncated ? ' (API returned the maximum — there may be more)' : ''}`;
  }
  return `${matchCount.toLocaleString()} / ${totalText} shown`;
}
