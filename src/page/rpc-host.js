// Page-world RPC, MAIN side (ARCHITECTURE §6.3). Bundled into main-world.js; answers ctx.page.call
// from the isolated world with the handlers in src/features/<id>/main.js.
//
// This code runs in the PAGE's JavaScript world with no extension privileges. Page script can call
// every handler here directly (by dispatching the same bridge events), so each handler must be
// harmless by design (the rules are in ARCHITECTURE §6.3). The primitives below are captured at
// document_start, before page script runs, so later monkey-patching can't redirect this code;
// that is robustness, not a security boundary: nothing here is more privileged than the page.
//
// src/features/<id>/main.js:
//   export const methods = { name(args, page) { … return jsonValue } }   // may be async
//   export function activate(page) { …; return () => { /* deactivate */ } }  // optional
//   page = { featureId, emit(event, payload) }

import { BRIDGE_EVENT, BRIDGE, BRIDGE_MAX_CHARS } from '../core/bridge.js';

const PAGE_MAX_CHARS = BRIDGE_MAX_CHARS - 4096;

const apply = Reflect.apply;
const hasOwn = Object.hasOwn;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const reTest = RegExp.prototype.test;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const dispatch = EventTarget.prototype.dispatchEvent;
const CustomEventCtor = CustomEvent;
const detailGetter = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get;
const MapCtor = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapHas = Map.prototype.has;
const mapDelete = Map.prototype.delete;
const mapForEach = Map.prototype.forEach;
const PromiseResolve = Promise.resolve.bind(Promise);
const promiseThen = Promise.prototype.then;
const StringCtor = String;
const strSlice = String.prototype.slice;
const mathRandom = Math.random;

const FEATURE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EVENT_RE = /^[a-z][A-Za-z0-9_.:-]{0,63}$/;
const CALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const test = (re, s) => typeof s === 'string' && apply(reTest, re, [s]);

/**
 * startRpcHost(registry, win?) — registry = { [featureId]: main.js module namespace }.
 * Returns { stop() } (tests; a newer injected copy stops older ones via main:takeover).
 */
export function startRpcHost(registry, win = window) {
  const modules = new MapCtor();
  for (const id of Object.keys(registry || {})) {
    const mod = registry[id];
    if (test(FEATURE_ID_RE, id) && mod && typeof mod === 'object') apply(mapSet, modules, [id, mod]);
  }
  const active = new MapCtor(); // featureId → cleanup | null
  const nonce = StringCtor(mathRandom()).slice(2) + StringCtor(Date.now());
  let stopped = false;

  function send(type, payload) {
    let detail;
    try { detail = apply(jsonStringify, JSON, [{ type, payload }]); } catch { return false; }
    if (typeof detail !== 'string' || detail.length > BRIDGE_MAX_CHARS) return false;
    apply(dispatch, win, [new CustomEventCtor(BRIDGE_EVENT, { detail })]);
    return true;
  }

  function fail(f, id, code, message) {
    send(BRIDGE.RPC_RESULT, { f, id, ok: false, e: { code, message: apply(strSlice, StringCtor(message || code), [0, 300]) } });
  }

  function pageApi(featureId) {
    return Object.freeze({
      featureId,
      emit(event, payload = null) {
        if (stopped || !apply(mapHas, active, [featureId]) || !test(EVENT_RE, event)) return false;
        let text;
        try { text = apply(jsonStringify, JSON, [payload === undefined ? null : payload]); } catch { return false; }
        if (typeof text !== 'string' || text.length > PAGE_MAX_CHARS) return false;
        return send(BRIDGE.RPC_EVENT, { f: featureId, e: event, p: apply(jsonParse, JSON, [text]) });
      },
    });
  }

  function activate(f) {
    if (!test(FEATURE_ID_RE, f) || apply(mapHas, active, [f])) return;
    const mod = apply(mapGet, modules, [f]);
    if (!mod) return;
    apply(mapSet, active, [f, null]);
    if (typeof mod.activate === 'function') {
      try {
        const cleanup = mod.activate(pageApi(f));
        if (typeof cleanup === 'function') apply(mapSet, active, [f, cleanup]);
      } catch (e) { console.error('[Loophole:page]', f, 'activate threw', e); }
    }
  }

  function deactivate(f) {
    if (!apply(mapHas, active, [f])) return;
    const cleanup = apply(mapGet, active, [f]);
    apply(mapDelete, active, [f]);
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch (e) { console.error('[Loophole:page]', f, 'deactivate threw', e); }
    }
  }

  function call(p) {
    const f = p.f; const id = p.id; const m = p.m;
    if (!test(FEATURE_ID_RE, f) || !test(CALL_ID_RE, id)) return; // can't even address an answer
    if (!test(METHOD_RE, m)) { fail(f, id, 'BAD_ARGS', 'invalid method name'); return; }
    if (!apply(mapHas, active, [f])) { fail(f, id, 'NOT_ACTIVE', `${f} is not active in the page`); return; }
    const methods = apply(mapGet, modules, [f]).methods;
    if (!methods || typeof methods !== 'object' || !apply(hasOwn, Object, [methods, m]) || typeof methods[m] !== 'function') {
      fail(f, id, 'NO_METHOD', `${f} has no page method ${m}`);
      return;
    }
    const args = hasOwnSafe(p, 'a') ? p.a : null;
    let out;
    try { out = PromiseResolve(methods[m](args, pageApi(f))); } catch (e) { fail(f, id, 'HANDLER_ERROR', errText(e)); return; }
    apply(promiseThen, out, [
      (r) => {
        let text;
        try { text = apply(jsonStringify, JSON, [r === undefined ? null : r]); } catch { text = undefined; }
        if (typeof text !== 'string') { fail(f, id, 'BAD_RESULT', 'result is not JSON-serialisable'); return; }
        if (text.length > PAGE_MAX_CHARS) { fail(f, id, 'TOO_LARGE', `result is ${text.length} chars`); return; }
        send(BRIDGE.RPC_RESULT, { f, id, ok: true, r: apply(jsonParse, JSON, [text]) });
      },
      (e) => fail(f, id, 'HANDLER_ERROR', errText(e)),
    ]);
  }

  function listener(event) {
    if (stopped) return;
    let detail;
    try { detail = apply(detailGetter, event, []); } catch { return; }
    if (typeof detail !== 'string' || detail.length > BRIDGE_MAX_CHARS) return;
    let msg;
    try { msg = apply(jsonParse, JSON, [detail]); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    switch (msg.type) {
      case BRIDGE.RPC_ACTIVATE: activate(p.f); break;
      case BRIDGE.RPC_DEACTIVATE: deactivate(p.f); break;
      case BRIDGE.RPC_CALL: call(p); break;
      case BRIDGE.MAIN_TAKEOVER: if (typeof p.n === 'string' && p.n !== nonce) stop(); break;
      default: break;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    apply(removeListener, win, [BRIDGE_EVENT, listener]);
    const ids = [];
    apply(mapForEach, active, [(_v, k) => { ids.push(k); }]);
    for (const f of ids) deactivate(f);
  }

  // An older copy (extension reloaded/updated while this page stayed open) steps aside.
  send(BRIDGE.MAIN_TAKEOVER, { n: nonce });
  apply(addListener, win, [BRIDGE_EVENT, listener]);
  send(BRIDGE.RPC_READY, {});
  return { stop };
}

function hasOwnSafe(o, k) {
  try { return apply(hasOwn, Object, [o, k]); } catch { return false; }
}

function errText(e) {
  try { return StringCtor((e && e.message) || e || 'error'); } catch { return 'error'; }
}
