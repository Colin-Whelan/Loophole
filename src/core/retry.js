// Rate limiting and retry policy, lifted from the Iterable User Push userscript.
// The background API proxy never retries; features compose these helpers instead.

import { parseRetryAfter as strictRetryAfter, RETRY_AFTER_MAX_MS } from './api-validation.js';

export const DEFAULT_BACKOFFS = Object.freeze([2000, 4000, 8000, 16000, 32000]);

/**
 * Error codes for requests Workbench refused locally (no key saved, invalid request). They never
 * reach Iterable and won't fix themselves, so they are never retried, whatever the policy says.
 */
export const LOCAL_REFUSAL_CODES = Object.freeze(['NO_KEY', 'BAD_REQUEST']);

/** Codes where the request may or may not have reached Iterable (see "outcome unknown" below). */
export const UNKNOWN_OUTCOME_CODES = Object.freeze(['NETWORK', 'TIMEOUT']);

const codeOf = (response) => (typeof response?.error?.code === 'string' ? response.error.code : '');

/** Refused by Workbench itself (NO_KEY, BAD_REQUEST): nothing was sent. */
export function isLocalRefusal(response) {
  return LOCAL_REFUSAL_CODES.includes(codeOf(response));
}

/**
 * The request may or may not have been applied: no HTTP status, and a NETWORK/TIMEOUT error (or
 * no code at all, e.g. a thrown send()).
 */
export function isOutcomeUnknown(response) {
  if ((Number(response?.status) || 0) !== 0) return false;
  const code = codeOf(response);
  return !code || UNKNOWN_OUTCOME_CODES.includes(code);
}

/**
 * Retry: status 0 with an unknown outcome (NETWORK/TIMEOUT), 429, and every 5xx.
 * Predicates are called as (status, response).
 */
export const DEFAULT_RETRYABLE = (status, response) =>
  (status === 0 ? isOutcomeUnknown(response ?? { status }) : status === 429 || status >= 500);

/**
 * Fatal: the whole operation should stop, not just this request. A rejected (401/403) or missing
 * key, or a request Workbench refuses, won't fix itself.
 */
export const DEFAULT_FATAL = (status, response) => status === 401 || status === 403 || isLocalRefusal(response);

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(done, Math.min(MAX_TIMER_MS, Math.max(0, Number(ms) || 0)));
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(t); reject(abortError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** Min-interval throttle: at least 1/rate seconds between request *starts*. */
export class RateLimiter {
  constructor(perSecond, { now = Date.now, wait = sleep } = {}) {
    this.now = now;
    this.wait = wait;
    this.last = 0;
    this.setRate(perSecond);
  }

  setRate(perSecond) {
    this.minInterval = perSecond > 0 ? 1000 / perSecond : 0;
  }

  async throttle(signal) {
    const delay = this.last + this.minInterval - this.now();
    if (delay > 0) await this.wait(delay, signal);
    this.last = this.now();
  }
}

/**
 * Parse a Retry-After value (digits-only delta-seconds, or an HTTP-date ending in GMT) into
 * milliseconds, capped at 24 h (RETRY_AFTER_MAX_MS). The strict parser is the background's
 * (core/api-validation.js), so junk ("soon 2099", "May 2030", "1.5") is refused rather than
 * read as a date. Returns null when absent, unparseable, zero or in the past. Callers still apply
 * their own, smaller caps.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const ms = strictRetryAfter(String(value), now);
  return ms > 0 ? ms : null;
}

/** setTimeout's largest delay (2^31 − 1 ms, ~24.8 days); anything longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

function asPredicate(p, fallback) {
  if (p == null) return fallback;
  if (typeof p === 'function') return p;
  if (Array.isArray(p)) return (status) => p.includes(status);
  throw new TypeError('status policy must be a function or an array of status codes');
}

/**
 * Send one request with a retry policy.
 *
 * `send()` resolves a response shaped like the wb:api response (`{ ok, status, data?,
 * retryAfterMs?, error? }`) or throws on a network failure (treated as status 0).
 *
 * Options:
 *   limiter       RateLimiter, throttled before every attempt (retries included)
 *   backoffs      delay per retry in ms; its length is the retry budget
 *   retryable     (status, response) => bool, or an array of statuses
 *   fatal         (status, response) => bool, or an array; checked first, never retried, sets
 *                 result.fatal
 *     `response` is the failed wb:api-shaped response, so a policy can look at error.code
 *     (NO_KEY, BAD_REQUEST, NETWORK, TIMEOUT, HTTP) as well as the status. A local refusal
 *     (isLocalRefusal: NO_KEY / BAD_REQUEST) is never retried, whatever `retryable` says; it is
 *     fatal under DEFAULT_FATAL.
 *   isSuccess     (response) => bool, default: response.ok or a 2xx status
 *   onRetry       ({ attempt, retries, delayMs, status, error, response }) => void, for run logs
 *   signal        AbortSignal; aborts waits (rejects with an AbortError)
 *   wait          (ms, signal) => Promise, injectable for tests
 *
 * Resolves `{ ok, status, data, error, response, attempts, fatal }`. Never rejects except on abort.
 * A server Retry-After (response.retryAfterMs) raises the wait but never lowers it, as before.
 *
 * Response shape reminders (core/api.js): every non-HTTP failure (NO_KEY, BAD_REQUEST, NETWORK,
 * TIMEOUT) has status 0, so tell them apart by error.code; an empty body gives data null; a
 * non-JSON body gives data as a string.
 *
 * Caution, non-idempotent calls (DELETE, bulk POSTs): a NETWORK or TIMEOUT failure means the
 * outcome is UNKNOWN; Iterable may already have applied the request. Retrying is safe only when
 * repeating it is harmless (bulkUpdate of the same rows is; a delete that must not double-fire,
 * or an append, may not be). For those, pass `retryable` without status 0 and report the
 * uncertainty to the user instead (isOutcomeUnknown(response) tells you which failures those are;
 * onRetry gets the same `response`).
 * A 2xx is not always success: where Iterable returns `{ code: 'Success' }`, pass
 * `isSuccess: (r) => r.ok && r.data?.code === 'Success'` (and still check per-item failure
 * counts in bulk responses).
 */
export async function sendWithRetry(send, options = {}) {
  const {
    limiter = null,
    backoffs = DEFAULT_BACKOFFS,
    isSuccess = (r) => r.ok === true || (r.ok === undefined && r.status >= 200 && r.status < 300),
    onRetry = null,
    signal,
    wait = sleep,
  } = options;
  const retryable = asPredicate(options.retryable, DEFAULT_RETRYABLE);
  const fatal = asPredicate(options.fatal, DEFAULT_FATAL);

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    if (limiter) await limiter.throttle(signal);

    let response;
    try {
      response = await send();
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      response = { ok: false, status: 0, error: { code: 'NETWORK', message: err?.message || String(err) } };
    }
    const status = Number(response?.status) || 0;
    const attempts = attempt + 1;

    if (response && isSuccess(response)) {
      return { ok: true, status, data: response.data, error: null, response, attempts, fatal: false };
    }

    const error = response?.error || { code: 'HTTP', message: `HTTP ${status}` };
    const failed = { ...response, status, error };
    if (fatal(status, failed)) {
      return { ok: false, status, data: response?.data, error, response, attempts, fatal: true };
    }
    if (isLocalRefusal(failed) || !retryable(status, failed) || attempt >= backoffs.length) {
      return { ok: false, status, data: response?.data, error, response, attempts, fatal: false };
    }

    let delayMs = backoffs[attempt];
    const ra = Number(response?.retryAfterMs);
    if (ra > 0) delayMs = Math.min(RETRY_AFTER_MAX_MS, Math.max(delayMs, ra));
    onRetry?.({ attempt: attempt + 1, retries: backoffs.length, delayMs, status, error, response: failed });
    await wait(delayMs, signal);
    attempt++;
  }
}
