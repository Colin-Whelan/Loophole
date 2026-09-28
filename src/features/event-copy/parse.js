// Lossless parser for the JSON tree Iterable renders in a user's Event History, plus the row
// helpers around it. Ported unchanged from "Iterable Event History - Copy dataFields" v1.0.0.
// Uses only standard Element methods on the elements passed in (no globals), so it runs against
// the real page and against the minimal DOM in test/features/event-copy.test.js.

export const HISTORY_PATH = '/event/history';

export const SELECTORS = Object.freeze({
  nameCell: '[data-test="event-history-name-cell"]',
  customIcon: 'svg[data-test="icon-custom"]', // marks Journey/custom events
  jsonRoot: '[data-test="json-root-raw"]', // the rendered JSON tree for a row
});

/** The userscript's view check: the Event History tab of a user profile. */
export function isHistoryPath(pathname) {
  return pathname.endsWith(HISTORY_PATH) || pathname.includes(HISTORY_PATH);
}

/** Only custom/Journey events carry the icon-custom svg in their name cell. */
export function isCustomEvent(nameCell) {
  return !!nameCell.querySelector(SELECTORS.customIcon);
}

// ── JSON DOM parsing ────────────────────────────────────
// Iterable renders the event JSON as nested divs. Types are encoded in class names on the value
// span: json-property-string / -number / -boolean / -null / -object / -array. We walk the tree
// and rebuild native JS so the copied value is type-accurate (numbers stay numbers, etc).
//
// Every row has a key span (.json-property-key) and a value span (.json-property-value with a
// type class). Rows are [data-test="json-leaf-raw"] (scalars) or [data-test="json-branch-raw"]
// (object/array heads); a branch holds its child rows in a [data-test="json-branch-value"] block.

function getKey(rowEl) {
  const keySpan = rowEl.querySelector(':scope > .json-leaf .json-property-key, :scope > .json-property-key');
  if (!keySpan) return null;
  // The key text is the inner highlighted span when there is one.
  const inner = keySpan.querySelector('span[data-test$="-unmatched"], span.sc-jWPcaf');
  const raw = (inner ? inner.textContent : keySpan.textContent) || '';
  return raw.trim();
}

function parseScalar(valueSpan) {
  const inner = valueSpan.querySelector('span[data-test$="-unmatched"], span.sc-jWPcaf');
  const text = inner ? inner.textContent : valueSpan.textContent;
  if (valueSpan.classList.contains('json-property-string')) return text;
  if (valueSpan.classList.contains('json-property-number')) return Number(text);
  if (valueSpan.classList.contains('json-property-boolean')) return text === 'true';
  if (valueSpan.classList.contains('json-property-null')) return null;
  return text; // fallback
}

// The direct child rows of a container (a branch's rows list, or the root).
function childRows(containerEl) {
  return Array.from(containerEl.children).filter(
    (el) => el.matches('[data-test="json-leaf-raw"], [data-test="json-branch-raw"]'),
  );
}

// Given a branch row (object/array opener), return the element holding its child rows.
// structure: <div json-branch-raw>
//              <div.json-leaf>(head: key + opener)</div>
//              <div json-branch-value><div><div> ...rows </div></div></div>
//              <div.json-property>}</div>
//            </div>
function branchValueList(branchRowEl) {
  const valueBlock = branchRowEl.querySelector(':scope > [data-test="json-branch-value"]');
  if (!valueBlock) return null;
  // descend through the two wrapper divs to the rows list
  const inner = valueBlock.querySelector(':scope > div > div');
  return inner || valueBlock;
}

// Recursively parse a container's rows into a JS object or array.
function parseContainer(containerEl, asArray) {
  const rows = childRows(containerEl);
  const out = asArray ? [] : {};

  for (const row of rows) {
    const isBranch = row.matches('[data-test="json-branch-raw"]');
    const head = row.querySelector(':scope > .json-leaf') || row;

    if (isBranch) {
      const valSpan = head.querySelector(':scope > .json-property-value');
      const childArray = valSpan && valSpan.classList.contains('json-property-array');
      const list = branchValueList(row);
      const value = list ? parseContainer(list, !!childArray) : (childArray ? [] : {});
      if (asArray) out.push(value);
      else {
        const key = getKey(row);
        if (key !== null) out[key] = value;
      }
    } else {
      const valSpan = head.querySelector(':scope > .json-property-value');
      if (!valSpan) continue;
      const value = parseScalar(valSpan);
      if (asArray) out.push(value);
      else {
        const key = getKey(row);
        if (key !== null) out[key] = value;
      }
    }
  }
  return out;
}

/** Parse a full [data-test="json-root-raw"] tree into a JS object (the root is the rows list). */
export function parseJsonRoot(rootEl) {
  return parseContainer(rootEl, false);
}

// ── Locate the JSON tree belonging to a given name cell ─
// Each event renders as name cell, details cell, …, then a collapsible block containing
// [data-test="json-root-raw"]. Walk forward siblings to the next json root, stopping at the next
// name cell.
export function findJsonRootForRow(nameCell) {
  let el = nameCell.nextElementSibling;
  while (el) {
    if (el.matches(SELECTORS.nameCell)) return null; // hit next row, none found
    const root = el.matches(SELECTORS.jsonRoot) ? el : el.querySelector(SELECTORS.jsonRoot);
    if (root) return root;
    el = el.nextElementSibling;
  }
  return null;
}

/**
 * What a click on a row's button should copy.
 * → { status: 'ok', text } (prettified dataFields) | { status: 'no-json' } | { status: 'no-datafields' }
 */
export function dataFieldsForRow(nameCell) {
  const root = findJsonRootForRow(nameCell);
  if (!root) return { status: 'no-json' };
  const parsed = parseJsonRoot(root);
  const dataFields = parsed?.dataFields;
  if (dataFields === undefined) return { status: 'no-datafields' };
  return { status: 'ok', text: JSON.stringify(dataFields, null, 2) };
}
