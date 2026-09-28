// Page-world RPC, isolated side (ARCHITECTURE §6.3). A feature may ship src/features/<id>/main.js,
// which the build bundles into the MAIN-world script (page/main-world.js, page/rpc-host.js). The
// feature's isolated code then reaches it through ctx.page:
//
//   ctx.page.available                         false where no MAIN-world script runs (bee, auth)
//   ctx.page.call(method, args?, { timeoutMs }?) → Promise<result>  (rejects with PageCallError)
//   ctx.page.on(event, cb)                      → unsubscribe;  cb(payload)
//
// Transport: bridge CustomEvents (core/bridge.js) with a random per-call id. The page sees and can
// forge every one of them, so:
//  - nothing secret goes over it (args, results and events are page-visible);
//  - the MAIN handlers are harmless by design: anything they do, page script could already do;
//  - results and events are UNTRUSTED input: validate them like data from the network;
//  - "activation" (which features' handlers may answer) is a convenience, not a security check.
//    Forging it only switches on handlers that are harmless by design.

import { BRIDGE, on as bridgeOn, emit as bridgeEmit, BRIDGE_MAX_CHARS } from './bridge.js';
import { newSessionId } from './frames.js';

export const PAGE_DEFAULT_TIMEOUT_MS = 5000;
export const PAGE_MIN_TIMEOUT_MS = 10;
export const PAGE_MAX_TIMEOUT_MS = 120_000;
/** Largest args / result / event payload as JSON text (the whole event stays under BRIDGE_MAX_CHARS). */
export const PAGE_MAX_CHARS = BRIDGE_MAX_CHARS - 4096;

export const FEATURE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const METHOD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const EVENT_RE = /^[a-z][A-Za-z0-9_.:-]{0,63}$/;
export const CALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const CODE_RE = /^[A-Z_]{1,32}$/;

export const PAGE_ERROR = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',       // no MAIN-world script in this frame
  BAD_ARGS: 'BAD_ARGS',             // method name or args invalid / not JSON / too large
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',               // the feature unmounted
  NOT_ACTIVE: 'NOT_ACTIVE',         // MAIN side: feature not activated (or no main.js)
  NO_METHOD: 'NO_METHOD',
  HANDLER_ERROR: 'HANDLER_ERROR',
  TOO_LARGE: 'TOO_LARGE',           // result over PAGE_MAX_CHARS
  BAD_RESULT: 'BAD_RESULT',         // result not JSON-serialisable
});

export class PageCallError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PageCallError';
    this.code = code;
  }
}

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function clampTimeout(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return PAGE_DEFAULT_TIMEOUT_MS;
  return Math.min(PAGE_MAX_TIMEOUT_MS, Math.max(PAGE_MIN_TIMEOUT_MS, Math.round(ms)));
}

/** Validate an rpc:result payload (already JSON-parsed). → { f, id, ok, value } | { f, id, ok:false, code, message } | null */
export function parseResult(p) {
  if (!isRecord(p)) return null;
  const { f, id, ok } = p;
  if (typeof f !== 'string' || !FEATURE_ID_RE.test(f) || typeof id !== 'string' || !CALL_ID_RE.test(id)) return null;
  if (ok === true) return { f, id, ok: true, value: Object.hasOwn(p, 'r') ? p.r : null };
  if (ok !== false || !isRecord(p.e)) return null;
  const code = typeof p.e.code === 'string' && CODE_RE.test(p.e.code) ? p.e.code : PAGE_ERROR.HANDLER_ERROR;
  const message = typeof p.e.message === 'string' ? p.e.message.slice(0, 300) : '';
  return { f, id, ok: false, code, message };
}

/** Validate an rpc:event payload. → { f, e, value } | null */
export function parseEvent(p) {
  if (!isRecord(p)) return null;
  const { f, e } = p;
  if (typeof f !== 'string' || !FEATURE_ID_RE.test(f) || typeof e !== 'string' || !EVENT_RE.test(e)) return null;
  return { f, e, value: Object.hasOwn(p, 'p') ? p.p : null };
}

/**
 * createPageHub({ available, bridge?, log?, newId? }) — one per content script.
 * hub.forFeature(featureId, signal) → ctx.page.
 * `bridge` = { on(type, cb), emit(type, payload) } (core/bridge.js by default; tests pass a fake).
 */
export function createPageHub({ available = true, bridge = { on: bridgeOn, emit: bridgeEmit }, log, newId = newSessionId } = {}) {
  const pending = new Map();  // id → { f, resolve, reject, timer }
  const listeners = new Map(); // featureId → Map(event → Set(cb))
  const active = new Set();   // featureIds activated by this content script
  let listening = false;

  function listen() {
    if (listening) return;
    listening = true;
    bridge.on(BRIDGE.RPC_RESULT, onResult);
    bridge.on(BRIDGE.RPC_EVENT, onEvent);
    // A new MAIN host (e.g. re-injected after an extension update) starts with nothing active.
    bridge.on(BRIDGE.RPC_READY, () => { for (const f of active) bridge.emit(BRIDGE.RPC_ACTIVATE, { f }); });
  }

  function onResult(p) {
    const r = parseResult(p);
    if (!r) return;
    const call = pending.get(r.id);
    if (!call || call.f !== r.f) return; // unknown / answered / someone else's id
    pending.delete(r.id);
    clearTimeout(call.timer);
    if (r.ok) call.resolve(r.value);
    else call.reject(new PageCallError(r.code, r.message || `${r.f}: page call failed (${r.code})`));
  }

  function onEvent(p) {
    const ev = parseEvent(p);
    if (!ev || !active.has(ev.f)) return;
    const set = listeners.get(ev.f)?.get(ev.e);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(ev.value); } catch (err) { log?.error?.(`page: ${ev.f} "${ev.e}" listener threw`, err); }
    }
  }

  function forFeature(featureId, signal) {
    if (!available) return unavailablePage();
    let activated = false;
    const mine = new Set(); // this mount's pending ids

    function activate() {
      if (activated || signal?.aborted) return;
      activated = true;
      listen();
      active.add(featureId);
      bridge.emit(BRIDGE.RPC_ACTIVATE, { f: featureId });
    }

    signal?.addEventListener('abort', () => {
      for (const id of mine) {
        const call = pending.get(id);
        if (!call) continue;
        pending.delete(id);
        clearTimeout(call.timer);
        call.reject(new PageCallError(PAGE_ERROR.ABORTED, `${featureId}: unmounted`));
      }
      mine.clear();
      listeners.delete(featureId);
      if (activated) {
        active.delete(featureId);
        bridge.emit(BRIDGE.RPC_DEACTIVATE, { f: featureId });
      }
    }, { once: true });

    function call(method, args = null, { timeoutMs } = {}) {
      if (signal?.aborted) return Promise.reject(new PageCallError(PAGE_ERROR.ABORTED, `${featureId}: unmounted`));
      if (typeof method !== 'string' || !METHOD_RE.test(method)) {
        return Promise.reject(new PageCallError(PAGE_ERROR.BAD_ARGS, `invalid method name ${JSON.stringify(String(method)).slice(0, 80)}`));
      }
      let text;
      try { text = JSON.stringify(args === undefined ? null : args); } catch { text = undefined; }
      if (typeof text !== 'string') return Promise.reject(new PageCallError(PAGE_ERROR.BAD_ARGS, 'args are not JSON-serialisable'));
      if (text.length > PAGE_MAX_CHARS) return Promise.reject(new PageCallError(PAGE_ERROR.BAD_ARGS, 'args too large'));
      activate();
      const id = newId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          mine.delete(id);
          reject(new PageCallError(PAGE_ERROR.TIMEOUT, `${featureId}.${method}: no answer from the page within ${clampTimeout(timeoutMs)} ms`));
        }, clampTimeout(timeoutMs));
        pending.set(id, {
          f: featureId,
          resolve: (v) => { mine.delete(id); resolve(v); },
          reject: (e) => { mine.delete(id); reject(e); },
          timer,
        });
        mine.add(id);
        // The args go as parsed JSON (a plain copy): the page never gets our objects.
        if (!bridge.emit(BRIDGE.RPC_CALL, { f: featureId, id, m: method, a: JSON.parse(text) })) {
          pending.delete(id);
          mine.delete(id);
          clearTimeout(timer);
          reject(new PageCallError(PAGE_ERROR.BAD_ARGS, 'args too large'));
        }
      });
    }

    function onPageEvent(event, cb) {
      if (typeof event !== 'string' || !EVENT_RE.test(event)) throw new TypeError(`page.on: invalid event name ${String(event).slice(0, 80)}`);
      if (typeof cb !== 'function') throw new TypeError('page.on(event, cb): cb must be a function');
      if (signal?.aborted) return () => {};
      activate();
      let byEvent = listeners.get(featureId);
      if (!byEvent) { byEvent = new Map(); listeners.set(featureId, byEvent); }
      let set = byEvent.get(event);
      if (!set) { set = new Set(); byEvent.set(event, set); }
      const wrapped = (v) => cb(v);
      set.add(wrapped);
      return () => set.delete(wrapped);
    }

    return Object.freeze({ available: true, call, on: onPageEvent });
  }

  return { forFeature, _pendingCount: () => pending.size, _active: () => [...active] };
}

/** ctx.page where no MAIN-world script runs. */
export function unavailablePage() {
  return Object.freeze({
    available: false,
    call: () => Promise.reject(new PageCallError(PAGE_ERROR.UNAVAILABLE, 'No page-world script runs in this frame.')),
    on: () => () => {},
  });
}
