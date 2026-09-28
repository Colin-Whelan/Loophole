// Bulk data: Iterable API calls through the Workbench background (ctx.api.request), with the
// retry policy from core/retry.js. Every call is bound to one projectKey chosen by the caller:
// runs pin the project at Start, so a project switch mid-run never changes where rows land.

import { sendWithRetry, DEFAULT_FATAL } from '../../core/retry.js';
import * as lib from '../../lib/iterable/lists.js';
import { isIterableSuccess, REQUEST_TIMEOUT_MS } from './logic.js';
import * as libCatalogs from '../../lib/iterable/catalogs.js';

/**
 * What ends a whole run: core's default fatal policy, i.e. a rejected key (401/403), no key
 * saved (NO_KEY) or a request Workbench refuses (BAD_REQUEST). None of those fix themselves.
 */
export const RUN_FATAL = DEFAULT_FATAL;

/** Catalog uploads also stop on 400 and 404 (lib/iterable/catalogs.js). */
export { CATALOG_FATAL } from '../../lib/iterable/catalogs.js';

/** ctx.api.request bound to `projectKey`. */
export function boundRequest(ctx, projectKey) {
  return (opts) => ctx.api.request({ ...opts, projectKey });
}

function secs(delayMs) {
  return (delayMs / 1000).toFixed(delayMs % 1000 ? 1 : 0) + 's';
}

function retryLine({ attempt, retries, delayMs, status }) {
  if (status === 0) { // only NETWORK/TIMEOUT get here: core never retries a local refusal
    return 'No response from Iterable (network error or timeout), so that batch may or may not have been applied. ' +
      'Retrying in ' + secs(delayMs) + ' (attempt ' + attempt + '/' + retries + ').';
  }
  return 'HTTP ' + status + ' from Iterable. Retrying in ' + secs(delayMs) + ' (attempt ' + attempt + '/' + retries + ').';
}

/**
 * Send one batch (users/bulkUpdate, lists/subscribe, catalogs/{name}/items) with retries.
 *
 * Status 0 (network error / timeout) IS retried here even though the outcome is unknown: each of
 * these writes the same values for the same users / items, so repeating a batch that did land is
 * harmless. The log says the outcome was unknown; if every retry fails, the rows are recorded as
 * `outcome_unknown` in the failures file.
 */
export function sendBatch({ request, path, body, limiter, signal, run, fatal = RUN_FATAL, wait }) {
  return sendWithRetry(() => request({ method: 'POST', path, body, timeoutMs: REQUEST_TIMEOUT_MS }), {
    limiter,
    signal,
    fatal,
    wait,   // tests only; undefined → core's sleep
    isSuccess: isIterableSuccess,
    onRetry: (info) => {
      run.noteRetry();
      run.log(retryLine(info), 'warn');
    },
  });
}

// ── Lists ────────────────────────────────────────────────────────────────
// The calls live in lib/iterable/lists.js (shared data layer, ARCHITECTURE §5.5); these keep the
// (request, …) signatures the list store uses. `request` is already bound to the pinned project.

const asApi = (request) => ({ api: { request } });

/** GET /api/lists → { ok, lists, res }. */
export function fetchLists(request, signal) {
  return lib.fetchLists(asApi(request), { signal });
}

/** POST /api/lists { name } → { ok, listId, res }. Not retried on status 0 (see lib). */
export function createList(request, name, signal) {
  return lib.createList(asApi(request), { name, signal });
}

/** DELETE /api/lists/{id} → { ok, res }. */
export function deleteList(request, id, signal) {
  return lib.deleteList(asApi(request), { listId: id, signal });
}

/** GET /api/lists/{id}/size → { ok, size, res }; every size lookup shares one gentle limiter. */
export function listSize(request, id, signal) {
  return lib.listSize(asApi(request), { listId: id, signal });
}

// ── Catalogs ─────────────────────────────────────────────────────────────
// The calls live in lib/iterable/catalogs.js; these keep the (request, …) signatures the catalog
// store and tab use, and add the run log lines.

/** Every catalog name in the project (GET /api/catalogs, paged) → { ok, names, res }. */
export function fetchCatalogs(request, signal, { wait } = {}) {
  return libCatalogs.fetchCatalogs(asApi(request), { signal, wait });
}

/**
 * One page of GET /api/catalogs/{name}/items (export), every retryable failure retried.
 * onRetry(line) gets a log line. → sendWithRetry result plus { items, total } when ok.
 */
export function fetchCatalogItemsPage({ request, path, page, pageSize, orderBy, limiter, signal, onRetry, wait }) {
  return libCatalogs.fetchCatalogItemsPage(asApi(request), {
    path, page, pageSize, orderBy, limiter, signal, wait, timeoutMs: REQUEST_TIMEOUT_MS,
    onRetry: (info) => onRetry?.(info.status === 0
      ? 'No response from Iterable (network error or timeout). Retrying in ' + secs(info.delayMs) + ' (attempt ' + info.attempt + '/' + info.retries + ').'
      : retryLine(info)),
  });
}

/** One catalog upload batch (POST /api/catalogs/{name}/items), logged like sendBatch; stops on CATALOG_FATAL. */
export function sendCatalogBatch({ request, path, body, limiter, signal, run, wait }) {
  return libCatalogs.uploadCatalogItems(asApi(request), {
    path, body, limiter, signal, wait, timeoutMs: REQUEST_TIMEOUT_MS,
    onRetry: (info) => {
      run.noteRetry();
      run.log(retryLine(info), 'warn');
    },
  });
}
