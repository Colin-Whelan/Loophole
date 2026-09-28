// Iterable's app GraphQL endpoint (POST /graphql, session cookie + XSRF via ctx.http.appFetch).
// Used by the Image Path Selector, Creative Library previews and Snippet Viewer ports.

import { GraphqlError, IterableError, wrapFetchError } from './errors.js';

export const GRAPHQL_PATH = '/graphql';

function firstMessage(errors, fallback) {
  const m = Array.isArray(errors) && errors.length ? errors[0]?.message : '';
  return typeof m === 'string' && m ? m : fallback;
}

/**
 * appGraphql({ http }, { operationName, query, variables, signal }) → `data` (the response's
 * `data` object).
 * Throws:
 *   GraphqlError   the response carried a non-empty `errors` array (also on a 4xx whose body is a
 *                  GraphQL error document); `.errors`, `.data` (partial data, if any)
 *   IterableError  HTTP (non-2xx), NETWORK, or BAD_RESPONSE (no `data` object in the body)
 *   AbortError     when `signal` aborts
 */
export async function appGraphql({ http }, { operationName, query, variables = {}, signal } = {}) {
  if (!query || typeof query !== 'string') throw new IterableError('GraphQL query is required.', { code: 'INVALID' });
  const what = operationName || 'GraphQL request';
  let body;
  try {
    body = await http.appFetch(GRAPHQL_PATH, {
      method: 'POST',
      body: { operationName, variables, query },
      signal,
    });
  } catch (err) {
    const b = err?.body;
    if (b && typeof b === 'object' && Array.isArray(b.errors) && b.errors.length) {
      throw new GraphqlError(firstMessage(b.errors, `${what} failed`), { errors: b.errors, data: b.data, status: err.status || 0, operationName });
    }
    throw wrapFetchError(err, what);
  }
  if (!body || typeof body !== 'object') {
    throw new IterableError(`${what}: unexpected response from Iterable (are you still signed in?).`, { code: 'BAD_RESPONSE', status: 200 });
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new GraphqlError(firstMessage(body.errors, `${what} failed`), { errors: body.errors, data: body.data, operationName });
  }
  if (!body.data || typeof body.data !== 'object') {
    throw new IterableError(`${what}: the response had no data.`, { code: 'BAD_RESPONSE', status: 200 });
  }
  return body.data;
}
