// Iterable static lists through the public API (ctx.api.request, saved key). Lifted from the
// Bulk data feature. Unlike the rest of lib/iterable these resolve { ok, …, res } and never throw
// (except AbortError): `res` is core/retry.js's sendWithRetry result, so callers can describe
// failures and spot a rejected key (res.fatal / res.status) the way Bulk data does.

import { sendWithRetry, RateLimiter } from '../../core/retry.js';

/** lists/{id}/size has a low rate limit; every size lookup shares one limiter at this rate. */
export const LIST_SIZE_RATE = 2;

/** A 2xx whose body, when it carries `code`, says 'Success'. */
export function isIterableSuccess(res) {
  if (!res || res.ok !== true) return false;
  const d = res.data;
  if (d == null || typeof d !== 'object') return true;
  return d.code == null || d.code === 'Success';
}

/** One-off call (no limiter). `retryable` defaults to core's policy. */
function once(api, projectKey, opts, { retryable, signal } = {}) {
  return sendWithRetry(() => api.request({ ...opts, projectKey }), { isSuccess: isIterableSuccess, retryable, signal, backoffs: [2000, 4000, 8000] });
}

/** fetchLists({ api }, { projectKey, signal }) → GET /api/lists → { ok, lists: [{ id, name, … }], res }. */
export async function fetchLists({ api }, { projectKey, signal } = {}) {
  const res = await once(api, projectKey, { method: 'GET', path: '/api/lists' }, { signal });
  const lists = res.ok && res.data && Array.isArray(res.data.lists) ? res.data.lists : [];
  return { ok: res.ok, lists, res };
}

/**
 * createList({ api }, { projectKey, name, signal }) → POST /api/lists { name } → { ok, listId, res }.
 * Not retried on status 0: if the first attempt did land, a retry would create a second list with
 * the same name.
 */
export async function createList({ api }, { projectKey, name, signal } = {}) {
  const res = await once(api, projectKey, { method: 'POST', path: '/api/lists', body: { name } },
    { signal, retryable: (s) => s === 429 });
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  const listId = d.listId != null ? d.listId : (d.params && d.params.listId != null ? d.params.listId : null);
  return { ok: res.ok, listId, res };
}

/** deleteList({ api }, { projectKey, listId, signal }) → DELETE /api/lists/{id} → { ok, res }. */
export async function deleteList({ api }, { projectKey, listId, signal } = {}) {
  const res = await once(api, projectKey, { method: 'DELETE', path: '/api/lists/' + encodeURIComponent(listId) },
    { signal, retryable: (s) => s === 429 });
  return { ok: res.ok, res };
}

const sizeLimiter = new RateLimiter(LIST_SIZE_RATE);

/** listSize({ api }, { projectKey, listId, signal }) → GET /api/lists/{id}/size (a bare number) → { ok, size, res }. */
export async function listSize({ api }, { projectKey, listId, signal } = {}) {
  const res = await sendWithRetry(() => api.request({ method: 'GET', path: '/api/lists/' + encodeURIComponent(listId) + '/size', projectKey }),
    { limiter: sizeLimiter, signal, backoffs: [2000, 4000] });
  let size = null;
  if (res.ok) {
    const n = Number(typeof res.data === 'string' ? res.data.trim() : res.data);
    size = Number.isFinite(n) ? n : null;
  }
  return { ok: res.ok, size, res };
}
