// Bulk data: pure logic for the Catalogs tab (no DOM, no storage, no network). Lifted from the
// "Iterable Catalog Push" userscript's tested Section 1; type inference is shared with the Users
// tab (logic.js inferValue, the same function in both scripts). Unit-tested by
// test/features/bulk-data-catalogs.test.js.

import { csvEscape } from '../../core/csv.js';
import { inferValue, normalizeCol, nf } from './logic.js';
// Endpoint shapes live in the shared data layer (ARCHITECTURE §5.5); re-exported for callers/tests.
export {
  CATALOG_LIST_PAGE_SIZE, parseCatalogList, unwrapListResponse, catalogItemsPath,
} from '../../lib/iterable/catalogs.js';
import { catalogItemsPath } from '../../lib/iterable/catalogs.js';

// Iterable: "Each of a catalog's items must have a unique ID that contains only alphanumeric
// characters and dashes and has a maximum length of 255."
export const ITEM_ID_RE = /^[A-Za-z0-9-]+$/;
export const ITEM_ID_MAX = 255;
export const MAX_DOC_BYTES = 30 * 1024;   // "max size of each json value is 30kb"

/**
 * Largest JSON body one upload request may carry. Workbench's background refuses a request body
 * over 5 MiB (core/api-validation.js BODY_MAX_BYTES), and 1000 items of up to 30 KB each can be
 * far more than that, so the run closes a batch early once its documents reach this size.
 * (The userscript had no such cap: Tampermonkey sent whatever it was given.)
 */
export const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

/** Offset paging re-serves / drops items when the catalog changes mid-export: re-sweep this often. */
export const EXPORT_MAX_SWEEPS = 3;
export const EXPORT_PAGE_SIZE = 1000;       // the userscript's default; Iterable documents no maximum

export const CATALOG_FAILURE_COLUMNS = Object.freeze(['row_number', 'itemId', 'reason', 'detail']);
export const CATALOG_SCOPE_PREFIX = 'catalog:';

// URL segments that are views *of* a catalog rather than a catalog name.
// /catalogs/table/Verity-Codes → "Verity-Codes"; /catalogs/Verity-Codes → same.
const CATALOG_VIEW_SEGMENTS = new Set(['table', 'list', 'items', 'item', 'fields', 'settings', 'new', 'edit', 'upload']);

// ── Routes ────────────────────────────────────────────────────────────────

/** Which page family the drawer is on: the catalogs index opens on Catalogs, the lists index on Users/Lists. */
export function areaOf(pathname) {
  return /^\/catalogs(?:\/|$)/.test(String(pathname || '')) ? 'catalogs' : 'lists';
}

/** The catalogs index itself (/catalogs, any query string), not a catalog page. */
export function isCatalogsIndexPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') === '/catalogs';
}

/**
 * The catalog name in an app pathname, or '' when the path isn't a catalog page. Only
 * /catalogs/table/<name> is confirmed against the live app; /catalogs/<name> is handled too.
 */
export function catalogNameFromPath(pathname) {
  const clean = String(pathname || '').split('/').filter(Boolean);
  const at = clean.indexOf('catalogs');
  if (at === -1) return '';
  const rest = clean.slice(at + 1);
  if (!rest.length) return '';
  let name = rest[0];
  if (CATALOG_VIEW_SEGMENTS.has(name.toLowerCase())) {
    if (rest.length < 2) return '';
    name = rest[1];
  }
  if (CATALOG_VIEW_SEGMENTS.has(String(name).toLowerCase())) return '';
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name;
}

// ── Upload: columns, values, documents ───────────────────────────────────

/** The column most likely to hold the item ID (in order of confidence), or null. */
export function detectIdColumn(header) {
  const wanted = ['id', 'itemid', 'catalogitemid', 'catalogid', 'key', 'sku', 'code'];
  for (const w of wanted) {
    for (const col of header) if (normalizeCol(col) === w) return col;
  }
  return null;
}

/**
 * Header columns containing a period. Iterable: "Do not use field names with periods" (a period
 * addresses a nested path), so these block the upload rather than being silently renamed.
 */
export function periodColumns(header) {
  return header.filter((c) => String(c).indexOf('.') !== -1);
}

/**
 * Catalog field types are set by the first value written and stick, so inference is a one-way
 * door. forceText sends every non-empty cell as its string, unchanged. undefined = omit.
 */
export function coerceCell(raw, forceText) {
  if (!forceText) return inferValue(raw);
  if (raw == null) return undefined;
  const s = typeof raw === 'string' ? raw : String(raw);
  if (s.trim() === '') return undefined;
  return s;
}

/** UTF-8 byte length without Blob/TextEncoder. */
export function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // surrogate pair
    else n += 3;
  }
  return n;
}

/** null when the ID is usable, otherwise the failure reason. */
export function validateItemId(id) {
  if (!id) return 'missing_id';
  if (id.length > ITEM_ID_MAX) return 'id_too_long';
  if (!ITEM_ID_RE.test(id)) return 'id_bad_chars';
  return null;
}

/**
 * One CSV row object → { id, doc, bytes }, or { error, id, bytes? } when it can't be uploaded.
 * The ID column becomes the key in the `documents` map and is NOT repeated as a field. Empty
 * cells are omitted: under replaceUploadedFieldsOnly they leave the existing value alone; under a
 * full overwrite the field simply isn't part of the new document.
 */
export function buildDocument(row, idCol, forceText) {
  const id = idCol ? String(row[idCol] == null ? '' : row[idCol]).trim() : '';
  const bad = validateItemId(id);
  if (bad) return { error: bad, id };
  const doc = {};
  for (const col in row) {
    if (!Object.prototype.hasOwnProperty.call(row, col) || col === idCol) continue;
    const v = row[col];
    const val = coerceCell(typeof v === 'string' ? v : String(v), forceText);
    if (val !== undefined) doc[col] = val;
  }
  const bytes = utf8Bytes(JSON.stringify(doc));
  if (bytes > MAX_DOC_BYTES) return { error: 'doc_too_large', id, bytes };
  return { id, doc, bytes };
}

/** Failure-file detail for a buildDocument error. */
export function documentErrorDetail(built) {
  if (built.error === 'doc_too_large') return nf(built.bytes) + ' bytes > ' + nf(MAX_DOC_BYTES);
  if (built.error === 'id_too_long') return 'id is ' + nf(built.id.length) + ' characters (max ' + ITEM_ID_MAX + ')';
  if (built.error === 'id_bad_chars') return 'only letters, digits and dashes are allowed';
  if (built.error === 'missing_id') return 'the ID cell is empty';
  return '';
}

/**
 * buildDocument in the run engine's terms: the item, or { skip: record } for a row that is
 * recorded in the failures file and not sent.
 */
export function catalogRunItem(row, idCol, forceText) {
  const built = buildDocument(row, idCol, forceText);
  if (built.error) return { skip: { itemId: built.id || '', reason: built.error, detail: documentErrorDetail(built) } };
  return built;
}

/** Approximate share of the request body one item takes: `"id":{doc},`. */
export function documentWeight(item) {
  return item.bytes + utf8Bytes(item.id) + 4;
}

/**
 * Fold a batch of { id, doc } into the `documents` map the API wants. Two rows sharing an ID
 * collapse into one entry (the last row wins), which is silent data loss inside one request, so
 * the collision count comes back with it.
 */
export function documentsMap(items) {
  const out = Object.create(null);
  let collisions = 0;
  for (const it of items) {
    if (Object.prototype.hasOwnProperty.call(out, it.id)) collisions++;
    out[it.id] = it.doc;
  }
  // A plain object for JSON (an ID "__proto__" can't pass ITEM_ID_RE, but stay prototype-safe).
  return { documents: Object.assign({}, out), collisions };
}

/** Request for one upload batch. merge → replaceUploadedFieldsOnly: true. */
export function catalogBatchRequest(catalogName, items, { merge }) {
  const m = documentsMap(items);
  const body = { documents: m.documents };
  if (merge) body.replaceUploadedFieldsOnly = true;
  return { path: catalogItemsPath(catalogName), body, collisions: m.collisions };
}

// ── Checkpoint scope ─────────────────────────────────────────────────────

/**
 * Catalog, write mode, ID column and text mode all change what a resumed run would do, so they
 * are all part of the checkpoint's identity: 'catalog:Shoes|merge|id:sku' (+ '|text').
 */
export function catalogScope({ catalogName, merge, idCol, forceText }) {
  return CATALOG_SCOPE_PREFIX + (catalogName || '?') + '|' + (merge ? 'merge' : 'overwrite') + '|id:' + (idCol || '') +
    (forceText ? '|text' : '');
}

/** Human-readable target for a catalog scope; checkpoint data (when given) wins for the names. */
export function describeCatalogScope(scope, data) {
  const parts = String(scope).split('|');
  const cat = (data && data.catalogName) || parts[0].replace(CATALOG_SCOPE_PREFIX, '');
  const mode = parts[1] === 'merge' ? 'merge fields only' : 'full overwrite';
  const idc = (data && data.idCol) || String(parts[2] || '').replace('id:', '');
  return cat + ', ' + mode + ', ID column ' + idc + (parts.includes('text') ? ', all values as text' : '');
}

// ── Catalog list ──────────────────────────────────────────────────────────

// ── Export ────────────────────────────────────────────────────────────────

/**
 * One exported item → { id, fields }. The docs render `value` as { underlying: {...} } (a Scala
 * JsObject artefact); the live API has been seen returning the object directly. Unwrap exactly
 * that one shape, so a real field named "underlying" survives.
 */
export function exportItemToRow(item) {
  if (!item) return null;
  let v = item.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'underlying' && v.underlying && typeof v.underlying === 'object') v = v.underlying;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
  return { id: item.itemId == null ? '' : String(item.itemId), fields: v };
}

/** Union of every field name across rows, in first-seen order. */
export function exportColumns(rows) {
  const seen = new Set();
  const cols = [];
  for (const r of rows) {
    for (const k of Object.keys(r.fields)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return cols;
}

/** Scalars as plain text; objects/arrays as JSON (what inferValue parses back); null → empty. */
export function exportCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * The export CSV in chunks of `linesPerChunk` lines (Blob parts, so a big catalog never becomes
 * one giant string). First column "id", the name detectIdColumn() picks first, so the file
 * re-imports on the upload side unchanged; lastModified and size are item metadata and are left
 * out on purpose (as columns they'd be pushed back into every document). LF line endings like
 * the userscript. Not formula-neutralised: the file is meant to round-trip byte for byte.
 */
export function exportCsvChunks(rows, columns = exportColumns(rows), linesPerChunk = 2000) {
  const chunks = [];
  let buf = [['id'].concat(columns).map(csvEscape).join(',')];
  for (const r of rows) {
    const f = r.fields;
    const line = [csvEscape(r.id)];
    for (const c of columns) line.push(csvEscape(Object.prototype.hasOwnProperty.call(f, c) ? exportCell(f[c]) : ''));
    buf.push(line.join(','));
    if (buf.length >= linesPerChunk) { chunks.push(buf.join('\n') + '\n'); buf = []; }
  }
  if (buf.length) chunks.push(buf.join('\n') + '\n');
  return chunks;
}

/** Whole export CSV as one string → { csv, columns } (small catalogs and tests). */
export function buildExportCsv(rows) {
  const columns = exportColumns(rows);
  return { csv: exportCsvChunks(rows, columns).join(''), columns };
}

export function exportFileName(catalogName, ts) {
  return 'catalog_' + String(catalogName).replace(/[^A-Za-z0-9-]+/g, '_') + '_' + ts + '.csv';
}

/**
 * Deduplicating collector for export pages: first copy of an itemId wins (a prototype-less set,
 * so an item called "constructor" can't read as seen). add(items) → { added, dupes }.
 */
export function createExportCollector() {
  const seen = new Set();
  const rows = [];
  return {
    rows,
    add(items) {
      let added = 0, dupes = 0;
      for (const it of items || []) {
        const r = exportItemToRow(it);
        if (!r) continue;
        if (seen.has(r.id)) { dupes++; continue; }
        seen.add(r.id);
        rows.push(r);
        added++;
      }
      return { added, dupes };
    },
  };
}

/**
 * Whether a sweep over the pages is over after a page: a short or empty page, or reaching the
 * reported total counted in *unique* items (re-served items inflate the raw count).
 */
export function sweepDone({ pageLength, pageSize, unique, total }) {
  return !pageLength || pageLength < pageSize || (total > 0 && unique >= total);
}
