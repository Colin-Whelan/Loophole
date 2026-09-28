// Content-script client for the background API proxy (docs/ARCHITECTURE.md §6).
//
// No key material ever passes through here: the background attaches the Api-Key header and
// only returns Iterable's response. Every function resolves (never rejects) to the §6 shapes,
// except unwrap(), which exists for callers that prefer exceptions.

import { MSG, API_ERROR, STORAGE } from './messages.js';
import * as storage from './storage.js';

/** Extra time on top of the request timeout before we give up on the background answering. */
const WATCHDOG_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor({ code, message, status = 0, retryAfterMs, data } = {}) {
    super(message || code || 'API error');
    this.name = 'ApiError';
    this.code = code || API_ERROR.NETWORK;
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (data !== undefined) this.data = data;
  }
}

function runtimeAlive() {
  // chrome.runtime.id becomes undefined once the extension is reloaded/updated underneath
  // an already-injected content script ("Extension context invalidated").
  try { return !!(globalThis.chrome?.runtime?.id); } catch { return false; }
}

function networkError(message) {
  return { ok: false, status: 0, error: { code: API_ERROR.NETWORK, message } };
}

function describeSendError(err) {
  const m = String(err && err.message || err || '');
  if (/context invalidated/i.test(m) || !runtimeAlive()) {
    return 'Workbench was updated or reloaded. Refresh this page to reconnect.';
  }
  if (/receiving end does not exist|could not establish connection/i.test(m)) {
    return 'Workbench background is not responding. Refresh this page and try again.';
  }
  if (/message port closed|message manager disconnected/i.test(m)) {
    return 'Workbench background stopped before answering. Try again.';
  }
  return 'Could not reach the Workbench background: ' + m.slice(0, 200);
}

/** chrome.runtime.sendMessage that always resolves: { value } or { error: message }. */
async function send(message, watchdogMs) {
  if (!runtimeAlive()) return { error: 'Workbench was updated or reloaded. Refresh this page to reconnect.' };
  let timer;
  try {
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: 'Workbench background did not answer in time.' }), watchdogMs);
    });
    const call = chrome.runtime.sendMessage(message).then(
      (value) => ({ value }),
      (err) => ({ error: describeSendError(err) }),
    );
    return await Promise.race([call, watchdog]);
  } catch (err) {
    // sendMessage can throw synchronously when the context is already gone.
    return { error: describeSendError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeApiResponse(r) {
  if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') {
    return networkError('Workbench background returned no usable response.');
  }
  const out = { ok: r.ok, status: Number.isInteger(r.status) ? r.status : 0 };
  if (r.data !== undefined) out.data = r.data;
  if (typeof r.retryAfterMs === 'number') out.retryAfterMs = r.retryAfterMs;
  if (!r.ok) {
    const e = r.error && typeof r.error === 'object' ? r.error : {};
    out.error = {
      code: typeof e.code === 'string' ? e.code : API_ERROR.NETWORK,
      message: typeof e.message === 'string' ? e.message : 'Request failed.',
    };
  }
  return out;
}

/**
 * Call the Iterable REST API through the background.
 *   apiRequest({ projectKey, method, path, query?, body?, timeoutMs? })
 * → { ok, status, data?, retryAfterMs?, error?: { code, message } }   (never rejects)
 */
export async function apiRequest({ projectKey, method = 'GET', path, query, body, timeoutMs } = {}) {
  const msg = { type: MSG.API, projectKey, method, path };
  if (query !== undefined) msg.query = query;
  if (body !== undefined) msg.body = body;
  if (timeoutMs !== undefined) msg.timeoutMs = timeoutMs;
  const t = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(0, timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const res = await send(msg, t + WATCHDOG_GRACE_MS);
  if (res.error) return networkError(res.error);
  return normalizeApiResponse(res.value);
}

/** Masked key status for a project → { hasKey, masked, name, error? } (never rejects). */
export async function keyStatus(projectKey) {
  const res = await send({ type: MSG.KEYS_STATUS, projectKey }, 15_000);
  if (res.error) return { hasKey: false, masked: '', name: '', error: { code: API_ERROR.NETWORK, message: res.error } };
  const v = res.value;
  if (!v || typeof v !== 'object') {
    return { hasKey: false, masked: '', name: '', error: { code: API_ERROR.NETWORK, message: 'No response from Workbench background.' } };
  }
  const out = {
    hasKey: v.hasKey === true,
    masked: typeof v.masked === 'string' ? v.masked : '',
    name: typeof v.name === 'string' ? v.name : '',
  };
  if (v.error) out.error = v.error;
  return out;
}

/** Open (or focus) the options page at `#section`, with optional flat params → { ok, error? }. */
export async function openOptions(section, params) {
  const msg = { type: MSG.OPEN_OPTIONS };
  if (section != null) msg.section = section;
  if (params != null) msg.params = params;
  const res = await send(msg, 15_000);
  if (res.error) return { ok: false, error: { code: API_ERROR.NETWORK, message: res.error } };
  const v = res.value;
  return v && typeof v === 'object' && v.ok === true ? { ok: true } : { ok: false, error: v?.error || { code: API_ERROR.NETWORK, message: 'Could not open settings.' } };
}

/**
 * cb() whenever the saved keys change (any project: added, replaced, removed, tested). Watches the
 * non-secret wb:keys-rev counter core/keys.js bumps with every vault write, never wb:keys itself.
 * Stops when `signal` aborts. Returns unsubscribe.
 */
export function onKeysChanged(cb, signal) {
  if (signal?.aborted) return () => {};
  const off = storage.subscribe(STORAGE.KEYS_REV, () => { if (!signal?.aborted) cb(); });
  signal?.addEventListener('abort', off, { once: true });
  return off;
}

/** Return res.data for a successful response, otherwise throw an ApiError(code, status, …). */
export function unwrap(res) {
  if (res && res.ok) return res.data;
  const e = (res && res.error) || {};
  throw new ApiError({
    code: e.code || API_ERROR.NETWORK,
    message: e.message || 'Request failed.',
    status: res && Number.isInteger(res.status) ? res.status : 0,
    retryAfterMs: res ? res.retryAfterMs : undefined,
    data: res ? res.data : undefined,
  });
}
