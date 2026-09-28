// Typed errors for the Iterable data layer (ARCHITECTURE §5.5). Messages are safe to show to the
// user; they never carry request bodies, identifiers or keys (log `code` / `status`, not `data`).

/**
 * code:
 *   'HTTP'          non-2xx from an internal endpoint (status set)
 *   'NETWORK'       no response (status 0); for writes the outcome is unknown
 *   'BAD_RESPONSE'  2xx but the body isn't the expected shape (e.g. a login page instead of JSON)
 *   'GRAPHQL'       the GraphQL response carried `errors` (see GraphqlError)
 *   'API'           a public-API call failed; `apiCode` holds wb:api's error.code
 *                   (NO_KEY, BAD_REQUEST, NETWORK, TIMEOUT, HTTP) or Iterable's body `code`
 *   'INVALID'       the caller's input was refused before anything was sent
 */
export class IterableError extends Error {
  constructor(message, { code = 'HTTP', status = 0, apiCode, data, outcomeUnknown = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'IterableError';
    this.code = code;
    this.status = status;
    if (apiCode !== undefined) this.apiCode = apiCode;
    if (data !== undefined) this.data = data;
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;   // server Retry-After, in ms
    this.outcomeUnknown = !!outcomeUnknown;
  }
}

/** GraphQL `errors` array → `errors` ([{ message, path?, extensions? }]); `data` is any partial data. */
export class GraphqlError extends IterableError {
  constructor(message, { errors = [], data, status = 200, operationName } = {}) {
    super(message, { code: 'GRAPHQL', status, data });
    this.name = 'GraphqlError';
    this.errors = errors;
    if (operationName) this.operationName = operationName;
  }
}

export const isAbortError = (err) => err?.name === 'AbortError';

/**
 * Re-throw what ctx.http.appFetch threw as an IterableError. AbortErrors pass through untouched,
 * as do errors that are already IterableErrors.
 */
export function wrapFetchError(err, what) {
  if (isAbortError(err) || err instanceof IterableError) return err;
  if (err?.name === 'HttpError' || Number.isInteger(err?.status)) {
    const status = err.status || 0;
    const hint = status === 401 || status === 403 ? ' (are you still signed in to Iterable?)' : '';
    return new IterableError(`${what} failed: HTTP ${status}${hint}`, { code: 'HTTP', status, data: err.body, retryAfterMs: err.retryAfterMs });
  }
  return new IterableError(`${what} failed: ${err?.message || 'network error'}`, { code: 'NETWORK', status: 0 });
}
