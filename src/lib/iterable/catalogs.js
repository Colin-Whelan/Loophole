// Iterable catalogs through the public API (ctx.api.request, saved key). Lifted from the Bulk data
// feature's Catalogs tab (ex "Iterable Catalog Push"). Like lists.js these resolve `{ ok, …, res }`
// or core/retry.js's sendWithRetry result and never throw (except AbortError), so callers can
// describe failures and spot a rejected key (res.fatal / res.status).
//   GET  /api/catalogs?page&pageSize                      list (paged)
//   GET  /api/catalogs/{name}/items?page&pageSize&orderBy export pages
//   POST /api/catalogs/{name}/items { documents, replaceUploadedFieldsOnly? }   bulk upload

import { sendWithRetry, DEFAULT_FATAL } from '../../core/retry.js';
import { isIterableSuccess } from './lists.js';

export const CATALOG_LIST_PAGE_SIZE = 50;
const MAX_CATALOG_LIST_PAGES = 200;
/** Uploads and export pages can be slow on big catalogs; the background's timeout for them. */
export const CATALOG_REQUEST_TIMEOUT_MS = 120000;

/**
 * Upload failures that end a whole run: core's default fatal policy plus 400 and 404 (the Catalog
 * Push userscript's FATAL_STATUSES): a missing catalog or a request shape Iterable rejects hits
 * every remaining batch the same way.
 */
export const CATALOG_FATAL = (status, response) => DEFAULT_FATAL(status, response) || status === 400 || status === 404;

export function catalogItemsPath(catalogName) {
  return '/api/catalogs/' + encodeURIComponent(catalogName) + '/items';
}

/**
 * GET /api/catalogs → { names, total }. Iterable wraps it in its usual envelope
 * ({ code, msg, params: { catalogNames: [{ name }], totalCatalogsCount } }); accept the bare
 * object, plain strings, or neither (an empty page).
 */
export function parseCatalogList(body) {
  if (!body || typeof body !== 'object') return { names: [], total: null };
  const src = body.params && typeof body.params === 'object' ? body.params : body;
  const arr = Array.isArray(src.catalogNames) ? src.catalogNames : Array.isArray(src.catalogs) ? src.catalogs : [];
  const names = [];
  for (const x of arr) {
    const n = typeof x === 'string' ? x : (x && typeof x.name === 'string' ? x.name : '');
    if (n) names.push(n);
  }
  const total = typeof src.totalCatalogsCount === 'number' ? src.totalCatalogsCount : null;
  return { names, total };
}

/**
 * The item-list endpoint's real response is the standard envelope
 * { code, msg, params: { catalogItemsWithProperties, totalItemsCount } }, not the bare object the
 * docs sample shows. Accept both; a body with neither is an empty page.
 */
export function unwrapListResponse(body) {
  if (!body || typeof body !== 'object') return { items: [], total: null };
  const src = (body.params && typeof body.params === 'object' &&
               (body.params.catalogItemsWithProperties || body.params.totalItemsCount != null))
    ? body.params : body;
  const items = Array.isArray(src.catalogItemsWithProperties) ? src.catalogItemsWithProperties : [];
  const total = typeof src.totalItemsCount === 'number' ? src.totalItemsCount : null;
  return { items, total };
}

/**
 * fetchCatalogs({ api }, { projectKey, signal }) → every catalog name in the project, sorted:
 * { ok, names, res }. Pages GET /api/catalogs; stops on a short page, on reaching the reported
 * total, or after 200 pages.
 */
export async function fetchCatalogs({ api }, { projectKey, signal, wait } = {}) {
  const names = [];
  let res = null;
  for (let page = 1; page <= MAX_CATALOG_LIST_PAGES; page++) {
    res = await sendWithRetry(() => api.request({ method: 'GET', path: '/api/catalogs', query: { page, pageSize: CATALOG_LIST_PAGE_SIZE }, projectKey }),
      { isSuccess: isIterableSuccess, signal, wait, backoffs: [2000, 4000, 8000] });
    if (!res.ok) return { ok: false, names, res };
    const p = parseCatalogList(res.data);
    for (const n of p.names) if (!names.includes(n)) names.push(n);
    if (p.names.length < CATALOG_LIST_PAGE_SIZE || (p.total != null && names.length >= p.total)) break;
  }
  names.sort((a, b) => a.localeCompare(b));
  return { ok: true, names, res };
}

/**
 * One export page: GET /api/catalogs/{name}/items. Read-only, so every retryable failure, status
 * 0 included, is retried. Pass `catalogName` (or a ready `path`). → sendWithRetry result plus
 * { items, total } when ok. onRetry gets core's retry info ({ attempt, retries, delayMs, status }).
 */
export async function fetchCatalogItemsPage({ api }, {
  projectKey, catalogName, path = catalogItemsPath(catalogName), page, pageSize, orderBy, limiter, signal, onRetry, wait,
  timeoutMs = CATALOG_REQUEST_TIMEOUT_MS,
} = {}) {
  const query = { page, pageSize };
  if (orderBy) query.orderBy = orderBy;
  const res = await sendWithRetry(() => api.request({ method: 'GET', path, query, timeoutMs, projectKey }), {
    limiter, signal, wait, isSuccess: isIterableSuccess, onRetry,
  });
  if (!res.ok) return res;
  return { ...res, ...unwrapListResponse(res.data) };
}

/**
 * One bulk upload: POST /api/catalogs/{name}/items with `body` ({ documents: { [id]: fields },
 * replaceUploadedFieldsOnly? }). Status 0 IS retried: it rewrites the same documents, so a repeat
 * of a batch that did land is harmless (the caller records a final no-response as outcome
 * unknown). Stops for good on CATALOG_FATAL unless `fatal` says otherwise. → sendWithRetry result.
 */
export function uploadCatalogItems({ api }, {
  projectKey, catalogName, path = catalogItemsPath(catalogName), body, limiter, signal, onRetry, wait,
  fatal = CATALOG_FATAL, timeoutMs = CATALOG_REQUEST_TIMEOUT_MS,
} = {}) {
  return sendWithRetry(() => api.request({ method: 'POST', path, body, timeoutMs, projectKey }), {
    limiter, signal, wait, fatal, onRetry, isSuccess: isIterableSuccess,
  });
}
