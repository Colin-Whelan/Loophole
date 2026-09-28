// Pure selection planning for the Export to CSV field picker. No DOM: index.js reads the rows into
// plain objects, asks this module what to change, and does the clicking.
//
// A field is { id, label, checked, visible }:
//   id       the part after "export-to-csv-field-" in the row's data-test
//   label    the row's label text (a field name, not user data)
//   checked  the row's checkbox has data-state="checked"
//   visible  the row is rendered (Iterable's own search hides rows it filters out)

/** Never unchecked by any bulk action (the userscript's LOCKED_FIELDS). */
export const LOCKED_FIELDS = Object.freeze(['userId', 'email']);

export const ROW_PREFIX = 'export-to-csv-field-';

export const isLocked = (id) => LOCKED_FIELDS.includes(id);

/** data-test="export-to-csv-field-<id>" → "<id>" ('' when absent). */
export function fieldIdFromTestAttr(attr) {
  return String(attr || '').replace(ROW_PREFIX, '');
}

/**
 * The rows a bulk action applies to: rendered rows whose label contains the search box's text
 * (trimmed, case-insensitive). The text match is the userscript's fallback in case Iterable
 * renders every row while a search is active.
 */
export function filterFields(fields, query = '') {
  const q = String(query || '').trim().toLowerCase();
  return fields.filter((f) => {
    if (!f.visible) return false;
    if (!q) return true;
    return String(f.label || '').toLowerCase().includes(q);
  });
}

/**
 * Which checkboxes to click for `op` over the filtered rows, in row order.
 * op: 'select'   check every filtered row
 *     'deselect' uncheck every filtered row except the locked fields
 *     'invert'   flip every filtered row, but never uncheck a locked field
 * Returns [{ id, checked }] (the target state) for the rows that change. Unknown ops → [].
 */
export function planSelection(fields, op, query = '') {
  const plan = [];
  for (const f of filterFields(fields, query)) {
    if (!f.id) continue;
    let target;
    if (op === 'select') target = true;
    else if (op === 'deselect') target = isLocked(f.id) ? f.checked : false;
    else if (op === 'invert') target = f.checked && isLocked(f.id) ? true : !f.checked;
    else return [];
    if (target !== !!f.checked) plan.push({ id: f.id, checked: target });
  }
  return plan;
}

/** Apply a plan to a field list (what the rows should look like once every click has landed). */
export function applyPlan(fields, plan) {
  const next = new Map(plan.map((p) => [p.id, p.checked]));
  return fields.map((f) => (next.has(f.id) ? { ...f, checked: next.get(f.id) } : f));
}

/** { selected, total } over the filtered rows: the same rows the buttons act on. */
export function countSelection(fields, query = '') {
  const rows = filterFields(fields, query);
  return { selected: rows.filter((f) => f.checked).length, total: rows.length };
}

export function formatCount({ selected, total }) {
  return `Selected ${selected} of ${total}`;
}
