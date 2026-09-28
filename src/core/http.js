// Same-origin calls to Iterable's internal (cookie-authenticated) endpoints, e.g. /i/user/context.
// Content scripts only.

import { parseRetryAfter } from './retry.js';

/**
 * A non-2xx response. `status` is the HTTP status; `retryAfterMs` is the server's Retry-After
 * (delta-seconds or HTTP date) in ms, or null when absent/unparseable/in the past. Features map it
 * onto sendWithRetry's response shape ({ status, retryAfterMs }) so a 429/503 wait is honoured.
 */
export class HttpError extends Error {
  constructor(status, message, body, { retryAfterMs = null } = {}) {
    super(message || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

// Firefox runs a content script's own fetch with the extension's origin, which drops the page's
// cookies and trips CORS. content.fetch sends the request as the page would.
function pageFetch(...args) {
  const f = globalThis.content?.fetch ? globalThis.content.fetch.bind(globalThis.content) : fetch;
  return f(...args);
}

export function readCookie(name) {
  const prefix = name + '=';
  for (const part of document.cookie.split(';')) {
    const c = part.trim();
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
  }
  return null;
}

/**
 * appFetch(path, { method, body, headers, signal }) → parsed JSON (or text for non-JSON bodies,
 * null for empty ones). Throws HttpError{status, retryAfterMs} on a non-2xx response.
 */
export async function appFetch(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const h = { Accept: 'application/json', ...headers };
  const xsrf = readCookie('XSRF-TOKEN');
  if (xsrf) h['X-XSRF-TOKEN'] = xsrf;

  let payload = body;
  if (body != null && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
    payload = JSON.stringify(body);
    h['Content-Type'] = h['Content-Type'] || 'application/json';
  }

  const res = await pageFetch(path, { method, body: payload, headers: h, credentials: 'include', signal });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null);
    throw new HttpError(res.status, `HTTP ${res.status} for ${method} ${path}`, data, { retryAfterMs });
  }
  return data;
}
