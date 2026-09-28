// Bulk data: pure logic (no DOM, no storage, no network). Lifted from the "Iterable User Push"
// userscript's tested Section 1, plus the small helpers the run engine and the tabs share.
// Unit-tested by test/features/bulk-data*.test.js.

import { csvEscape } from '../../core/csv.js';

// Where Iterable returns `code`, only 'Success' is success; a body without one is fine. The list
// size rate: lists/{id}/size has a low limit, so it always runs gently. Both live with the list
// calls in the shared data layer (lib/iterable/lists.js).
export { isIterableSuccess, LIST_SIZE_RATE } from '../../lib/iterable/lists.js';

export const MAX_RATE_LIMIT = 10;     // Iterable's bulkUpdate cap
export const MAX_BATCH_SIZE = 1000;   // Iterable's per-request user cap
export const DEFAULT_RATE = 5;
export const DEFAULT_BATCH = 500;

// Catalogs (Catalog Push port): POST /api/catalogs/{name}/items takes up to 1000 items per request
// and is capped at 100 requests/second per project, the limits the userscript clamped to. Its own
// defaults were 10 req/s and 1000 items per batch.
export const MAX_CATALOG_RATE = 100;
export const MAX_CATALOG_BATCH = 1000;
export const DEFAULT_CATALOG_RATE = 10;
export const DEFAULT_CATALOG_BATCH = 1000;
export const DRY_RUN_ROWS = 1000;
export const LOG_LINE_CAP = 500;
export const FAILURE_CAP = 200000;
export const RETRY_ROW_CAP = 200000;
export const REQUEST_TIMEOUT_MS = 120000;

const MAX_SAFE_INT = Math.pow(2, 53);   // beyond this, JSON numbers lose precision
const INT_RE = /^-?\d+$/;

/** Categories Iterable may return inside `failedUpdates` (or top level) on a 200 response. */
export const FAILED_UPDATE_KEYS = Object.freeze([
  'invalidEmails', 'invalidUserIds',
  'conflictEmails', 'conflictUserIds',
  'forgottenEmails', 'forgottenUserIds',
  'invalidDataEmails', 'invalidDataUserIds',
  'notFoundEmails', 'notFoundUserIds',
]);

// ── Key columns ───────────────────────────────────────────────────────────

/** "User_ID" → "userid", "E-mail " → "e-mail". Used only for key detection. */
export function normalizeCol(name) {
  return String(name).split('_').join('').split(' ').join('').trim().toLowerCase();
}

/** Find which header columns are the userId / email keys (or null). */
export function detectKeyColumns(header) {
  let userIdCol = null, emailCol = null;
  for (const col of header) {
    const norm = normalizeCol(col);
    if (norm === 'userid' && userIdCol === null) userIdCol = col;
    else if (norm === 'email' && emailCol === null) emailCol = col;
  }
  return { userIdCol, emailCol };
}

// ── Type inference ────────────────────────────────────────────────────────

/**
 * Convert one CSV string value to a typed JSON value. undefined means "omit this field".
 *
 *   ""            → omit          (never send empty strings)
 *   true/FALSE    → boolean
 *   "42"          → number        (but "07030" stays a string: zip codes!)
 *   huge integers → string        (JSON loses precision beyond 2^53)
 *   "3.14","1e5"  → number
 *   "{..}","[..]" → parsed JSON object/array
 *   anything else → string, unchanged (the *untrimmed* original)
 */
export function inferValue(raw) {
  if (raw == null || raw.trim() === '') return undefined;
  const s = raw.trim();
  const low = s.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (INT_RE.test(s)) {
    const digits = s.replace(/^-/, '');
    if (digits.length > 1 && digits.charAt(0) === '0') return raw;  // leading zero
    const n = Number(s);
    if (Math.abs(n) >= MAX_SAFE_INT) return raw;                     // too big for exact JSON
    return n;
  }
  if ((s.indexOf('.') !== -1 || low.indexOf('e') !== -1) && s.charAt(0) !== '{' && s.charAt(0) !== '[') {
    const f = Number(s);
    if (!Number.isNaN(f)) return f;   // "1.2.3" is NaN and falls through to the string case
  }
  if (s.charAt(0) === '{' || s.charAt(0) === '[') {
    try { return JSON.parse(s); } catch { /* not JSON, keep as string */ }
  }
  return raw;
}

// ── Clearing empty cells ─────────────────────────────────────────────────
//
// Iterable has no delete-field API: JSON null inside dataFields clears a field. inferValue()
// keeps returning undefined for "omit", so the clear decision is made per column here.

/**
 * Normalise a clear set (array of column names, or a {col: bool} map) into a Set, or null when
 * nothing is selected ("toggle on, nothing ticked" behaves exactly like off). A Set, not a plain
 * object: a CSV column called toString/constructor must never read back as ticked.
 */
export function clearSetOf(cols) {
  if (!cols) return null;
  if (cols instanceof Set) return cols.size ? cols : null;
  const set = new Set();
  if (Array.isArray(cols)) {
    for (const c of cols) if (c != null && c !== '') set.add(String(c));
  } else {
    for (const k in cols) {
      if (!Object.prototype.hasOwnProperty.call(cols, k) || !cols[k]) continue;
      set.add(String(k));
    }
  }
  return set.size ? set : null;
}

/** Empty / whitespace-only: the exact condition inferValue() omits on. */
export function isEmptyCell(raw) {
  return raw == null || String(raw).trim() === '';
}

/** How many dataFields of a built item are explicit nulls (only the clear set produces null). */
export function countCleared(item) {
  let n = 0;
  const df = item && item.dataFields;
  if (!df) return 0;
  for (const k in df) if (Object.prototype.hasOwnProperty.call(df, k) && df[k] === null) n++;
  return n;
}

/**
 * Stable short fingerprint of a clear set (FNV-1a, order-independent). Namespaces checkpoints so
 * a run that clears fields can never resume into one that doesn't, or one clearing other columns.
 */
export function clearFingerprint(cols) {
  let arr = [];
  if (Array.isArray(cols)) arr = cols.slice();
  else if (cols instanceof Set) cols.forEach((c) => arr.push(c));
  else if (cols) {
    for (const k in cols) if (Object.prototype.hasOwnProperty.call(cols, k) && cols[k]) arr.push(k);
  }
  if (!arr.length) return '';
  const s = arr.sort().join('');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'clr' + ('0000000' + h.toString(16)).slice(-8);
}

// ── Row → payload ─────────────────────────────────────────────────────────

/**
 * Build one bulkUpdate user object from a CSV row object, or null if the row has neither a
 * userId nor an email.
 *
 * Hybrid projects:
 *   - userId present & preferred (default): { userId, preferUserId: true } (+ email if present).
 *   - email preferred (or only email present): { email } (+ userId if present).
 * Every other column goes into dataFields after type inference. An empty cell in a clearSet
 * column is sent as null (clears the field) instead of being omitted. Key columns never clear.
 */
export function buildUser(row, userIdCol, emailCol, preferKey, mergeNested, clearSet) {
  const userId = userIdCol ? String(row[userIdCol] == null ? '' : row[userIdCol]).trim() : '';
  const email = emailCol ? String(row[emailCol] == null ? '' : row[emailCol]).trim() : '';
  if (!userId && !email) return null;

  const user = {};
  if (userId && (preferKey === 'userId' || !email)) {
    user.userId = userId;
    user.preferUserId = true;
    if (email) user.email = email;
  } else {
    user.email = email;
    if (userId) user.userId = userId;
  }

  const cs = (clearSet && typeof clearSet.has === 'function') ? clearSet : clearSetOf(clearSet);

  const dataFields = {};
  let any = false;
  for (const col in row) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) continue;
    if (col === userIdCol || col === emailCol) continue;
    const v = row[col];
    const val = inferValue(typeof v === 'string' ? v : String(v));
    if (val !== undefined) { dataFields[col] = val; any = true; }
    else if (cs && cs.has(col)) { dataFields[col] = null; any = true; }
  }
  if (any) user.dataFields = dataFields;
  if (mergeNested) user.mergeNestedObjects = true;
  return user;
}

/** Minimal subscriber for the keys-only lists/subscribe path (Lists tab): no dataFields. */
export function buildSubscriber(row, userIdCol, emailCol, preferKey) {
  const userId = userIdCol ? String(row[userIdCol] == null ? '' : row[userIdCol]).trim() : '';
  const email = emailCol ? String(row[emailCol] == null ? '' : row[emailCol]).trim() : '';
  if (!userId && !email) return null;
  if (userId && (preferKey === 'userId' || !email)) return { userId, preferUserId: true };
  return { email };
}

/** Request body for one Users-tab batch: bulkUpdate, or lists/subscribe when a list is chosen. */
export function usersBatchRequest(items, { listId, updateExistingOnly } = {}) {
  if (!listId) return { path: '/api/users/bulkUpdate', body: { users: items } };
  const body = { listId: Number(listId), subscribers: items };
  if (updateExistingOnly) body.updateExistingUsersOnly = true;
  return { path: '/api/lists/subscribe', body };
}

// ── Batching ──────────────────────────────────────────────────────────────

/** Split an array into batches of `size` (the engine streams; this is for tests and small jobs). */
export function toBatches(items, size) {
  const n = clampBatch(size);
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Batch number (1-based) the next batch will get when resuming at `offset` committed rows. */
export function nextBatchNo(offset, batchSize) {
  return Math.floor((offset || 0) / batchSize) + 1;
}

// ── Response interpretation ──────────────────────────────────────────────

/**
 * A 200 can still contain per-user failures. bulkUpdate nests them under `failedUpdates`;
 * lists/subscribe reports them at the top level. Returns
 * { success, fail, records: [{ userId, email, reason }] }.
 */
export function collectPartialFailures(body) {
  const b = body && typeof body === 'object' ? body : {};
  const success = typeof b.successCount === 'number' ? b.successCount : 0;
  let fail = Number(b.failCount) || 0;
  const fu = b.failedUpdates && typeof b.failedUpdates === 'object' ? b.failedUpdates : {};
  const records = [];
  for (const key of FAILED_UPDATE_KEYS) {
    const nested = Array.isArray(fu[key]) ? fu[key] : [];
    const top = Array.isArray(b[key]) ? b[key] : [];
    const arr = nested.concat(top);
    const isEmail = key.indexOf('Email') !== -1;
    for (const ident of arr) {
      records.push({ userId: isEmail ? '' : String(ident), email: isEmail ? String(ident) : '', reason: key });
    }
  }
  if (!fail && records.length) fail = records.length;
  return { success, fail, records };
}

/**
 * Classify a failed request (a sendWithRetry result) for the failure file and the log.
 *   → { reason, summary, detail, unknown }
 * unknown: the request may or may not have reached Iterable (network error / timeout).
 * `summary` is safe for the on-screen log (status and Iterable's error code only, never the
 * message, which can echo row data). `detail` goes to the failures file.
 */
export function classifyFailure(res) {
  const status = Number(res?.status) || 0;
  const code = res?.error?.code || '';
  const data = res?.data && typeof res.data === 'object' ? res.data : null;
  const apiCode = data && typeof data.code === 'string' ? data.code : '';
  const apiMsg = data && typeof data.msg === 'string' ? data.msg : '';
  const message = String(res?.error?.message || '');
  if (code === 'NO_KEY') {
    return { reason: 'no_key', summary: 'no API key for this project', detail: message, unknown: false };
  }
  if (code === 'BAD_REQUEST') {
    return { reason: 'bad_request', summary: 'request refused by Workbench', detail: message, unknown: false };
  }
  if (status <= 0) {
    return {
      reason: 'outcome_unknown',
      summary: (code === 'TIMEOUT' ? 'timed out' : 'no response') + '; Iterable may or may not have applied it',
      detail: 'Outcome unknown (' + (code || 'NETWORK') + '): ' + message,
      unknown: true,
    };
  }
  if (status >= 200 && status < 300) {
    return {
      reason: 'rejected', summary: 'HTTP ' + status + (apiCode ? ' ' + apiCode : ''),
      detail: [apiCode, apiMsg].filter(Boolean).join(': ') || 'Iterable did not report success', unknown: false,
    };
  }
  return {
    reason: 'http_' + status, summary: 'HTTP ' + status + (apiCode ? ' ' + apiCode : ''),
    detail: [apiCode, apiMsg].filter(Boolean).join(': ') || message || 'HTTP ' + status, unknown: false,
  };
}

// ── Checkpoints ───────────────────────────────────────────────────────────

export const CKPT_PREFIX = 'ckpt:';

/** name|size|lastModified: identifies "the same file" across sessions. */
export function fileFingerprint(file) {
  return file.name + '|' + file.size + '|' + file.lastModified;
}

/** ctx.state name for a checkpoint: ckpt:<scope>:<fingerprint>. */
export function checkpointName(scope, file) {
  return CKPT_PREFIX + scope + ':' + fileFingerprint(file);
}

/** Inverse of checkpointName for a known file → scope, or null when the name isn't for it. */
export function scopeOfCheckpointName(name, file) {
  const fp = fileFingerprint(file);
  if (typeof name !== 'string' || !name.startsWith(CKPT_PREFIX) || !name.endsWith(':' + fp)) return null;
  return name.slice(CKPT_PREFIX.length, name.length - fp.length - 1) || null;
}

/**
 * The Users tab's checkpoint scope: target list AND clear set. 'push', 'push:list42',
 * 'push|clr1a2b3c4d', 'push:list42|clr…'. A run toward list A can't resume into list B.
 */
export function pushScope({ listId, clearCols } = {}) {
  const base = listId ? 'push:list' + listId : 'push';
  const fp = clearFingerprint(clearCols || []);
  return fp ? base + '|' + fp : base;
}

export const SUBSCRIBE_SCOPE = 'subscribe';

/** Human-readable target for a push scope (the checkpoint data carries the column names). */
export function describeScope(scope, data) {
  const base = String(scope).split('|')[0];
  let label = base === 'push' ? 'profile sync only' : 'list ' + base.replace('push:list', '');
  const cols = (data && Array.isArray(data.clearCols)) ? data.clearCols : [];
  if (String(scope).indexOf('|clr') !== -1) {
    label += cols.length
      ? ', clearing ' + cols.length + ' column' + (cols.length === 1 ? '' : 's') + ': ' + cols.join(', ')
      : ', clearing empty cells';
  }
  return label;
}

/**
 * Among state names, find a push checkpoint for this file saved against a *different* target
 * (so the UI can explain why it isn't offered). Returns the matching names.
 */
export function otherPushCheckpointNames(names, file, currentScope) {
  return otherCheckpointNames(names, file, currentScope, 'push');
}

/** otherPushCheckpointNames for any scope family ('push', 'catalog:'). */
export function otherCheckpointNames(names, file, currentScope, prefix) {
  const out = [];
  for (const n of names || []) {
    const scope = scopeOfCheckpointName(n, file);
    if (!scope || scope === currentScope || scope.indexOf(prefix) !== 0) continue;
    out.push({ name: n, scope });
  }
  return out;
}

// ── Output files ──────────────────────────────────────────────────────────

export const USER_FAILURE_COLUMNS = Object.freeze(['row_number', 'userId', 'email', 'reason', 'detail']);

// A cell starting with one of these is a formula to Excel / Sheets / LibreOffice.
const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralise spreadsheet formula injection: prefix a formula-looking cell with a single quote. */
export function neutralizeFormula(v) {
  const s = v == null ? '' : String(v);
  return FORMULA_START.test(s) ? "'" + s : s;
}

/**
 * Failures CSV (header + one line per record), LF line endings like the userscript. Meant to be
 * opened in a spreadsheet, and the values come from the API / the uploaded file, so formula-like
 * cells are neutralised (see neutralizeFormula).
 */
export function failuresCsv(failures, columns = USER_FAILURE_COLUMNS) {
  const out = [columns.map(csvEscape).join(',')];
  for (const f of failures) out.push(columns.map((c) => csvEscape(neutralizeFormula(f[c]))).join(','));
  return out.join('\n') + '\n';
}

/**
 * Retry CSV: the original header plus the raw fields of every row in a failed batch. Byte-exact
 * on purpose (it is re-uploaded), so no formula neutralising here.
 */
export function retryCsv(header, rows) {
  const out = [header.map(csvEscape).join(',')];
  for (const r of rows) out.push(r.map(csvEscape).join(','));
  return out.join('\n') + '\n';
}

// ── Starting runs ─────────────────────────────────────────────────────────

/**
 * One start at a time. `run(fn)` sets busy (and calls onChange(true)) synchronously, before fn's
 * first await, so a second click during the project/key check or a confirm dialog is ignored.
 * Busy clears on every exit path. → Promise<boolean> (false: already busy, fn not called).
 */
export function createStartGuard(onChange = () => {}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(fn) {
      if (busy) return false;
      busy = true;
      onChange(true);
      try { await fn(); } finally { busy = false; onChange(false); }
      return true;
    },
  };
}

/**
 * Why a checkpoint can't be resumed into the pinned project, or null when it can.
 *   'project'  the checkpoint has no project, or a different one
 *   'lists'    (list checks only) the loaded lists aren't this project's
 *   'list'     (list checks only) the checkpoint's list isn't among this project's lists
 * `lists` = { projectKey, ids } of the loaded lists, or omitted to skip the list checks.
 */
export function resumeBlocker(ck, projectKey, lists) {
  if (!ck) return null;
  if (!ck.projectKey || !projectKey || ck.projectKey !== projectKey) return 'project';
  if (lists) {
    if (lists.projectKey !== projectKey) return 'lists';
    if (ck.listId == null || ck.listId === '' || !(lists.ids || []).some((id) => String(id) === String(ck.listId))) return 'list';
  }
  return null;
}

// ── Formatting & clamps ──────────────────────────────────────────────────

export function fmtDuration(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '?';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  return m > 0 ? m + 'm' + s + 's' : s + 's';
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export const nf = (n) => Number(n || 0).toLocaleString();

/** yyyymmdd_hhmmss for download names. */
export function tsName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

export function clampRate(v) {
  let n = parseFloat(v);
  if (!(n > 0)) n = DEFAULT_RATE;
  return Math.max(0.1, Math.min(n, MAX_RATE_LIMIT));
}

export function clampBatch(v) {
  let n = parseInt(v, 10);
  if (!(n > 0)) n = DEFAULT_BATCH;
  return Math.max(1, Math.min(n, MAX_BATCH_SIZE));
}

export function clampCatalogRate(v) {
  let n = parseFloat(v);
  if (!(n > 0)) n = DEFAULT_CATALOG_RATE;
  return Math.max(0.1, Math.min(n, MAX_CATALOG_RATE));
}

export function clampCatalogBatch(v) {
  let n = parseInt(v, 10);
  if (!(n > 0)) n = DEFAULT_CATALOG_BATCH;
  return Math.max(1, Math.min(n, MAX_CATALOG_BATCH));
}

/**
 * The two pacing groups: which settings keys they use and their limits. The Users and Lists tabs
 * share `users`; the Catalogs tab (upload and export) uses `catalogs`.
 */
export const PACING = Object.freeze({
  users: Object.freeze({ rateKey: 'rateLimit', batchKey: 'batchSize', maxRate: MAX_RATE_LIMIT, maxBatch: MAX_BATCH_SIZE, clampRate, clampBatch }),
  catalogs: Object.freeze({ rateKey: 'catalogRateLimit', batchKey: 'catalogBatchSize', maxRate: MAX_CATALOG_RATE, maxBatch: MAX_CATALOG_BATCH,
    clampRate: clampCatalogRate, clampBatch: clampCatalogBatch }),
});
