// Frame channel: a feature's top-frame half (app.iterable.com, content/app.js) and its app.getbee.io
// editor-frame half (content/bee.js) exchange small JSON messages over window.postMessage.
// Contract: docs/ARCHITECTURE.md §6.2. Security rules: §9.
//
//   ctx.frames.send(type, payload, { to }?) → number of frames posted to (0 when nobody's there)
//   ctx.frames.on(type, cb)                → unsubscribe;  cb(payload, { peer })
//   ctx.frames.onPeer(cb)                  → unsubscribe;  cb({ peer, connected })
//   ctx.frames.peers()                     → [peer]   ctx.frames.available → boolean
//
// Presence is per feature. A peer is "connected" for feature X when the other side's content
// script is up AND X is mounted there (its hub announces X when it mounts, and withdraws it on
// unmount). So `connected: true` means "the other half of this feature is listening now": the
// robust pattern is "sync on connect" (send, or ask for, the current state when it fires). onPeer
// also replays already-connected peers to a new subscriber. Delivery is live, not stored: send()
// posts only to peers where the feature is up, and a message that arrives while nothing listens
// for its type is dropped. Register on() handlers synchronously in mount() (before any await).
// Peers are per document: a reloaded frame disconnects and comes back as a new peer id.
//
// Every message type a feature sends or accepts is declared in its meta (`frameMessages`, a small
// declarative schema, compiled by compileFrameMessages below). Undeclared types are dropped, and a
// payload that doesn't match its schema exactly is dropped (on receive) or refused (on send).
//
// Trust model. Everything on this channel is visible to, and can be forged by, the pages involved:
//  - The Iterable page sees every bee→top message (they are posted to its window) and can post
//    top→bee messages itself (it is the frame's parent, with an Iterable origin).
//  - The app.getbee.io page sees every top→bee message and can post bee→top messages itself.
// So: no secrets, ever (no API keys, no key status, nothing from the vault); receivers validate and
// treat payloads as page-controlled input; never do anything privileged (API calls, storage writes
// of arbitrary data, navigation) just because a frame message said so.
//
// What the checks do guarantee:
//  - top side: only trusted (browser-dispatched, not synthetic) 'message' events whose origin is
//    exactly https://app.getbee.io and whose source is a direct child frame of this top window.
//    Top→bee posts go only to such frames that introduced themselves, with the exact BEE target
//    origin (the browser drops the message if the frame has navigated anywhere else).
//  - bee side: only trusted events whose source is window.parent, whose origin is exactly the
//    Iterable app origin this frame's embedding was verified against (bee.js), and only when the
//    parent is the top window. Bee→top posts use that exact origin as target.

import { APP_ORIGINS, BEE_ORIGINS } from './api-validation.js';
import { safeJsonParse } from './bridge.js';

export { safeJsonParse };

export const FRAME_ENVELOPE = 'wb-frames';
export const FRAME_VERSION = 1;
/** Hard cap on one message's payload JSON text (characters). A type's maxChars can't exceed it. */
export const FRAME_MAX_CHARS = 8 * 1024 * 1024;
/** Per-type default when frameMessages[type].maxChars is not given. */
export const FRAME_DEFAULT_MAX_CHARS = 64 * 1024;
/** Top side: how often live peers are checked for removed frames (only while there are peers). */
export const PEER_PRUNE_MS = 2000;
/** Bee side: hello retries until the top answers (content/app.js may start after this frame). */
export const HELLO_DELAYS_MS = Object.freeze([0, 500, 2000, 5000, 10_000, 20_000]);
/** Most feature ids one side may announce as mounted. */
const MAX_UP = 64;

const FEATURE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const FRAME_TYPE_RE = /^[a-z][A-Za-z0-9_.:-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const KINDS = new Set(['hello', 'ack', 'bye', 'up', 'down', 'msg']);

const isFeatureId = (f) => typeof f === 'string' && f.length <= 64 && FEATURE_ID_RE.test(f);

// ---------------------------------------------------------------------------
// Envelope + JSON helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Validate a postMessage `data` value as a frame-channel envelope. Returns a plain copy or null.
 * Only reads the known fields, each once.
 *   hello / ack  { k, s, m }  s = sender session id (changes when the document is replaced),
 *                             m = feature ids mounted on the sender's side (channel users)
 *   bye          { k, s }
 *   up / down    { k, f }     feature f was mounted / unmounted on the sender's side
 *   msg          { k, f, t, p }  featureId, message type, payload as JSON text
 */
export function parseEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  let wb; let v; let k; let s; let m; let f; let t; let p;
  try { ({ wb, v, k, s, m, f, t, p } = data); } catch { return null; }
  if (wb !== FRAME_ENVELOPE || v !== FRAME_VERSION || typeof k !== 'string' || !KINDS.has(k)) return null;
  if (k === 'hello' || k === 'ack' || k === 'bye') {
    if (typeof s !== 'string' || !SESSION_RE.test(s)) return null;
    if (k === 'bye') return { k, s };
    let ids = [];
    if (m !== undefined) {
      if (!Array.isArray(m) || m.length > MAX_UP) return null;
      ids = [...m];
      if (!ids.every(isFeatureId)) return null;
    }
    return { k, s, m: ids };
  }
  if (!isFeatureId(f)) return null;
  if (k === 'up' || k === 'down') return { k, f };
  if (typeof t !== 'string' || !FRAME_TYPE_RE.test(t)) return null;
  if (typeof p !== 'string' || p.length > FRAME_MAX_CHARS) return null;
  return { k, f, t, p };
}

export function makeEnvelope(k, fields = {}) {
  return { wb: FRAME_ENVELOPE, v: FRAME_VERSION, k, ...fields };
}

/** JSON text for a value, or null if it isn't JSON-serialisable (cycles, BigInt, undefined). */
export function toJsonText(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

export function newSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Declarative payload schemas (pure)
// ---------------------------------------------------------------------------
//
// meta.frameMessages = {
//   <type>: { fields: { <name>: <spec> }, maxChars?: number },
// }
// <spec>: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'json' (any JSON value),
//         with a trailing '?' for optional; or an object
//         { type, optional?, maxLength? (string/array), min?, max? (number/integer),
//           enum? (string), items? (<spec>, array), fields? ({...}, object) }
// The payload itself is always an object with exactly the declared fields (extra keys → invalid).

const SIMPLE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'json', 'array', 'object']);
const MAX_SPEC_DEPTH = 6;
const MAX_FIELDS = 64;

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function compileSpec(spec, where, depth) {
  if (depth > MAX_SPEC_DEPTH) throw new Error(`${where}: schema nested too deeply`);
  let s = spec;
  if (typeof s === 'string') {
    const optional = s.endsWith('?');
    s = { type: optional ? s.slice(0, -1) : s, optional };
  }
  if (!isPlainObject(s) || typeof s.type !== 'string' || !SIMPLE_TYPES.has(s.type)) {
    throw new Error(`${where}: unknown field spec ${JSON.stringify(spec)}`);
  }
  const optional = s.optional === true;
  const num = (v, name) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ${name} must be a number`);
    return v;
  };
  const maxLength = num(s.maxLength, 'maxLength');
  const min = num(s.min, 'min');
  const max = num(s.max, 'max');
  let check;
  switch (s.type) {
    case 'string': {
      const en = s.enum == null ? null : s.enum;
      if (en && (!Array.isArray(en) || !en.every((x) => typeof x === 'string'))) throw new Error(`${where}: enum must be strings`);
      check = (v) => typeof v === 'string' && (maxLength == null || v.length <= maxLength) && (!en || en.includes(v));
      break;
    }
    case 'number':
    case 'integer': {
      const int = s.type === 'integer';
      check = (v) => typeof v === 'number' && Number.isFinite(v) && (!int || Number.isInteger(v))
        && (min == null || v >= min) && (max == null || v <= max);
      break;
    }
    case 'boolean': check = (v) => typeof v === 'boolean'; break;
    case 'null': check = (v) => v === null; break;
    case 'json': check = (v) => v !== undefined; break; // anything JSON.parse produced
    case 'array': {
      const item = s.items == null ? null : compileSpec(s.items, `${where}[]`, depth + 1);
      check = (v) => Array.isArray(v) && (maxLength == null || v.length <= maxLength) && (!item || v.every((x) => item.check(x)));
      break;
    }
    case 'object': {
      const obj = s.fields == null ? null : compileFields(s.fields, where, depth + 1);
      check = (v) => isPlainObject(v) && (!obj || obj(v));
      break;
    }
    default: throw new Error(`${where}: unknown type`);
  }
  return { optional, check };
}

function compileFields(fields, where, depth) {
  if (!isPlainObject(fields)) throw new Error(`${where}: fields must be an object`);
  const entries = Object.entries(fields);
  if (entries.length > MAX_FIELDS) throw new Error(`${where}: too many fields`);
  const compiled = entries.map(([name, spec]) => {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new Error(`${where}: field name ${name} is not allowed`);
    return [name, compileSpec(spec, `${where}.${name}`, depth)];
  });
  const names = new Set(compiled.map(([n]) => n));
  return (obj) => {
    for (const key of Object.keys(obj)) if (!names.has(key)) return false;
    for (const [name, c] of compiled) {
      if (!Object.hasOwn(obj, name)) { if (c.optional) continue; return false; }
      if (!c.check(obj[name])) return false;
    }
    return true;
  };
}

/**
 * Compile meta.frameMessages → Map(type → { maxChars, validate(payload) → boolean }).
 * Throws on a malformed declaration (the build calls this for every feature, so mistakes fail
 * the build rather than silently dropping messages at runtime).
 */
export function compileFrameMessages(frameMessages, featureId = '?') {
  const out = new Map();
  if (frameMessages == null) return out;
  if (!isPlainObject(frameMessages)) throw new Error(`${featureId}: frameMessages must be an object`);
  for (const [type, decl] of Object.entries(frameMessages)) {
    const where = `${featureId}.frameMessages.${type}`;
    if (!FRAME_TYPE_RE.test(type)) throw new Error(`${where}: invalid message type name`);
    if (!isPlainObject(decl)) throw new Error(`${where}: must be { fields, maxChars? }`);
    for (const k of Object.keys(decl)) if (k !== 'fields' && k !== 'maxChars') throw new Error(`${where}: unknown key ${k}`);
    const maxChars = decl.maxChars == null ? FRAME_DEFAULT_MAX_CHARS : decl.maxChars;
    if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > FRAME_MAX_CHARS) {
      throw new Error(`${where}: maxChars must be an integer between 2 and ${FRAME_MAX_CHARS}`);
    }
    const fields = compileFields(decl.fields ?? {}, where, 0);
    out.set(type, { maxChars, validate: (payload) => isPlainObject(payload) && fields(payload) });
  }
  return out;
}

const compiledByMeta = new WeakMap();
function specsFor(meta) {
  let specs = compiledByMeta.get(meta);
  if (!specs) {
    specs = compileFrameMessages(meta.frameMessages, meta.id);
    compiledByMeta.set(meta, specs);
  }
  return specs;
}

/**
 * Encode an outgoing payload: JSON-serialisable, within the type's size cap, and valid against the
 * type's schema *as the receiver will see it* (after a JSON round trip). Throws TypeError otherwise:
 * sending something invalid is a bug in the sending feature.
 */
export function encodePayload(meta, type, payload) {
  const spec = specsFor(meta).get(type);
  if (!spec) throw new TypeError(`${meta.id}: frame message type "${type}" is not declared in meta.frameMessages`);
  const text = toJsonText(payload);
  if (text === null) throw new TypeError(`${meta.id}: frame message "${type}" payload is not JSON-serialisable`);
  if (text.length > spec.maxChars) throw new TypeError(`${meta.id}: frame message "${type}" is ${text.length} chars (limit ${spec.maxChars})`);
  const round = safeJsonParse(text);
  if (!round.ok || !spec.validate(round.value)) throw new TypeError(`${meta.id}: frame message "${type}" payload does not match its schema`);
  return text;
}

/** Decode an incoming payload. Returns { ok, value }; ok is false for anything to drop. */
export function decodePayload(meta, type, text) {
  const spec = specsFor(meta).get(type);
  if (!spec || typeof text !== 'string' || text.length > spec.maxChars) return { ok: false };
  const parsed = safeJsonParse(text);
  if (!parsed.ok || !spec.validate(parsed.value)) return { ok: false };
  return { ok: true, value: parsed.value };
}

// ---------------------------------------------------------------------------
// Frame relationship checks
// ---------------------------------------------------------------------------

/** Is `source` (a MessageEvent.source) one of `win`'s direct child frames? */
export function isChildFrame(win, source) {
  if (!source) return false;
  try {
    const n = win.length;
    for (let i = 0; i < n; i++) if (win[i] === source) return true;
  } catch { /* ignore */ }
  return false;
}

function isGone(win, peerWin) {
  try { if (peerWin.closed) return true; } catch { return true; }
  return !isChildFrame(win, peerWin);
}

// ---------------------------------------------------------------------------
// Shared per-feature handler + presence bookkeeping
// ---------------------------------------------------------------------------

function createRegistry(log) {
  // featureId → { meta, handlers: Map(type → Set(cb)), peerCbs: Set(cb) }
  const features = new Map();

  function entry(meta) {
    let e = features.get(meta.id);
    if (!e) {
      e = { meta, handlers: new Map(), peerCbs: new Set() };
      features.set(meta.id, e);
    }
    return e;
  }

  function dispatch(featureId, type, text, info) {
    const e = features.get(featureId);
    const set = e?.handlers.get(type);
    if (!set || !set.size) return false; // nobody listening (feature not mounted here): drop unparsed
    const dec = decodePayload(e.meta, type, text);
    if (!dec.ok) { log?.debug?.(`frames: dropped invalid "${type}" for ${featureId}`); return false; }
    for (const cb of [...set]) {
      try { cb(dec.value, info); } catch (err) { log?.error?.(`frames: ${featureId} "${type}" handler threw`, err); }
    }
    return true;
  }

  /** Presence change of feature `featureId` on a peer. */
  function peerEvent(featureId, ev) {
    const e = features.get(featureId);
    if (!e) return;
    for (const cb of [...e.peerCbs]) {
      try { cb(ev); } catch (err) { log?.error?.(`frames: ${featureId} onPeer handler threw`, err); }
    }
  }

  /** Register `cb` for (meta, type); removed on unsubscribe or signal abort. */
  function addHandler(meta, type, cb, signal) {
    if (typeof cb !== 'function') throw new TypeError('frames.on(type, cb): cb must be a function');
    if (!specsFor(meta).has(type)) throw new TypeError(`${meta.id}: frame message type "${type}" is not declared in meta.frameMessages`);
    if (signal?.aborted) return () => {};
    const e = entry(meta);
    let set = e.handlers.get(type);
    if (!set) { set = new Set(); e.handlers.set(type, set); }
    const wrapped = (...a) => cb(...a);
    set.add(wrapped);
    const off = () => { set.delete(wrapped); cleanupEntry(meta.id); };
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  /**
   * `livePeers()` → peers where this feature is up right now. They are replayed to the new
   * subscriber as { peer, connected: true } in a microtask (after the mounting feature has
   * registered its on() handlers), so a feature that mounts after its other half still hears of it.
   */
  function addPeerCb(meta, cb, signal, livePeers) {
    if (typeof cb !== 'function') throw new TypeError('frames.onPeer(cb): cb must be a function');
    if (signal?.aborted) return () => {};
    const e = entry(meta);
    const wrapped = (ev) => cb(ev);
    e.peerCbs.add(wrapped);
    const off = () => { e.peerCbs.delete(wrapped); cleanupEntry(meta.id); };
    signal?.addEventListener('abort', off, { once: true });
    const snapshot = livePeers();
    if (snapshot.length) {
      queueMicrotask(() => {
        const still = new Set(livePeers());
        for (const peer of snapshot) {
          if (!e.peerCbs.has(wrapped) || signal?.aborted || !still.has(peer)) continue;
          try { wrapped({ peer, connected: true }); } catch (err) { log?.error?.(`frames: ${meta.id} onPeer handler threw`, err); }
        }
      });
    }
    return off;
  }

  function cleanupEntry(id) {
    const e = features.get(id);
    if (!e) return;
    for (const [t, set] of e.handlers) if (!set.size) e.handlers.delete(t);
    if (!e.handlers.size && !e.peerCbs.size) features.delete(id);
  }

  return { dispatch, peerEvent, addHandler, addPeerCb };
}

/**
 * Local presence: which channel-using features (meta.frameMessages declared) are mounted on this
 * side. A mount is announced at once (makeContext runs in the same task as mount(), and a reply
 * can only arrive in a later task, so handlers mount() registers synchronously are in place) and
 * withdrawn on ctx.signal abort. `announce(kind, featureId)` posts up/down to the other side(s).
 */
function createLocalPresence(announce) {
  const up = new Map(); // featureId → number of live mounts (normally 0 or 1)
  function track(meta, signal) {
    if (!specsFor(meta).size || signal?.aborted) return;
    const n = up.get(meta.id) || 0;
    up.set(meta.id, n + 1);
    if (n === 0) announce('up', meta.id);
    signal?.addEventListener('abort', () => {
      const left = (up.get(meta.id) || 1) - 1;
      if (left > 0) { up.set(meta.id, left); return; }
      up.delete(meta.id);
      announce('down', meta.id);
    }, { once: true });
  }
  return { track, ids: () => [...up.keys()].slice(0, MAX_UP) };
}

// ---------------------------------------------------------------------------
// Top side (content/app.js)
// ---------------------------------------------------------------------------

/**
 * createTopHub({ win, log, beeOrigin?, sessionId?, pruneMs? }) — one per top-frame content script.
 * hub.start() begins listening and asks already-loaded BEE frames to (re)introduce themselves.
 * hub.forFeature(meta, signal) → the ctx.frames object for one mounted feature.
 */
export function createTopHub({ win, log, beeOrigin = BEE_ORIGINS[0], sessionId = newSessionId(), pruneMs = PEER_PRUNE_MS } = {}) {
  const registry = createRegistry(log);
  const peers = new Map(); // WindowProxy → { id, win, session, features: Set(featureId) }
  let nextPeer = 1;
  let pruneTimer = null;
  let started = false;
  const local = createLocalPresence((k, f) => {
    for (const [source] of [...peers]) post(source, makeEnvelope(k, { f }));
  });

  function post(target, env) {
    try { target.postMessage(env, beeOrigin); return true; } catch { return false; }
  }

  function setRemote(peer, f, isUp) {
    if (isUp === peer.features.has(f)) return;
    if (isUp) peer.features.add(f); else peer.features.delete(f);
    registry.peerEvent(f, { peer: peer.id, connected: isUp });
  }

  function dropPeer(source) {
    const peer = peers.get(source);
    if (!peer) return;
    peers.delete(source);
    for (const f of [...peer.features]) setRemote(peer, f, false);
    if (!peers.size) stopPruning();
  }

  function prune() {
    for (const [source] of [...peers]) if (isGone(win, source)) dropPeer(source);
  }
  function ensurePruning() {
    if (pruneTimer == null && pruneMs > 0) pruneTimer = setInterval(prune, pruneMs);
  }
  function stopPruning() {
    if (pruneTimer != null) clearInterval(pruneTimer);
    pruneTimer = null;
  }

  function onMessage(event) {
    if (!event || event.isTrusted !== true) return; // page-dispatched synthetic events can fake origin/source
    if (event.origin !== beeOrigin) return;
    const source = event.source;
    if (!isChildFrame(win, source)) return;
    const env = parseEnvelope(event.data);
    if (!env) return;
    if (env.k === 'hello') {
      let peer = peers.get(source);
      if (peer && peer.session !== env.s) { dropPeer(source); peer = null; } // reloaded without a bye
      if (!peer) {
        peer = { id: nextPeer++, win: source, session: env.s, features: new Set() };
        peers.set(source, peer);
        ensurePruning();
      }
      post(source, makeEnvelope('ack', { s: sessionId, m: local.ids() }));
      const now = new Set(env.m);
      for (const f of [...peer.features]) if (!now.has(f)) setRemote(peer, f, false);
      for (const f of now) setRemote(peer, f, true);
      return;
    }
    const peer = peers.get(source);
    if (!peer) return; // introduce yourself first (bee hubs always do)
    if (env.k === 'bye') { if (peer.session === env.s) dropPeer(source); return; }
    if (env.k === 'up' || env.k === 'down') {
      if (env.k === 'up' && !peer.features.has(env.f) && peer.features.size >= MAX_UP) return;
      setRemote(peer, env.f, env.k === 'up');
      return;
    }
    if (env.k === 'msg') registry.dispatch(env.f, env.t, env.p, { peer: peer.id });
  }

  /** Ask BEE frames that are already loaded to say hello (e.g. after this content script restarted). */
  function sweep() {
    let frames = [];
    try { frames = [...win.document.querySelectorAll('iframe')]; } catch { /* ignore */ }
    for (const frame of frames) {
      let src;
      try { src = new URL(frame.src, win.location.href); } catch { continue; }
      if (src.origin !== beeOrigin) continue;
      const w = frame.contentWindow;
      if (!w) continue;
      try { void w.location.href; continue; } catch { /* cross-origin: fine */ }
      post(w, makeEnvelope('hello', { s: sessionId, m: local.ids() }));
    }
  }

  function livePeersFor(featureId) {
    return [...peers.values()].filter((p) => p.features.has(featureId) && !isGone(win, p.win)).map((p) => p.id);
  }

  function send(meta, type, payload, { to } = {}) {
    const text = encodePayload(meta, type, payload);
    let n = 0;
    for (const [source, peer] of [...peers]) {
      if (to != null && peer.id !== to) continue;
      if (!peer.features.has(meta.id)) continue; // the other half isn't mounted there
      if (isGone(win, source)) { dropPeer(source); continue; }
      if (post(source, makeEnvelope('msg', { f: meta.id, t: type, p: text }))) n++;
    }
    return n;
  }

  return {
    sessionId,
    start() {
      if (started) return;
      started = true;
      win.addEventListener('message', onMessage);
      sweep();
      setTimeout(sweep, 2000);
    },
    stop() {
      win.removeEventListener('message', onMessage);
      stopPruning();
      peers.clear();
      started = false;
    },
    forFeature(meta, signal) {
      local.track(meta, signal);
      return Object.freeze({
        available: true,
        send: (type, payload, opts) => send(meta, type, payload, opts),
        on: (type, cb) => registry.addHandler(meta, type, cb, signal),
        onPeer: (cb) => registry.addPeerCb(meta, cb, signal, () => livePeersFor(meta.id)),
        peers: () => livePeersFor(meta.id),
      });
    },
    // For tests.
    _onMessage: onMessage,
    _peerCount: () => peers.size,
  };
}

// ---------------------------------------------------------------------------
// Bee side (content/bee.js)
// ---------------------------------------------------------------------------

/**
 * Which Iterable origin may talk to this bee frame over the channel, or null (channel off).
 * Only a direct child of the Iterable top page qualifies: parent must be top, and the origin must
 * be an app origin the embedding check established (ancestorOrigins[0], or the handshake origin).
 */
export function beeChannelOrigin({ verifiedOrigin, parentIsTop }) {
  if (parentIsTop !== true) return null;
  return typeof verifiedOrigin === 'string' && APP_ORIGINS.includes(verifiedOrigin) ? verifiedOrigin : null;
}

/**
 * createBeeHub({ win, parentOrigin, log, sessionId?, helloDelays? }) — one per bee content script.
 * `parentOrigin` from beeChannelOrigin(); null → an inert hub (available: false, send → 0).
 */
export function createBeeHub({ win, parentOrigin, log, sessionId = newSessionId(), helloDelays = HELLO_DELAYS_MS } = {}) {
  const registry = createRegistry(log);
  const available = !!parentOrigin && APP_ORIGINS.includes(parentOrigin);
  let top = null; // { session, features: Set(featureId) } once the top hub answered
  let started = false;
  const timers = [];
  const local = createLocalPresence((k, f) => post(makeEnvelope(k, { f })));

  function parentWin() {
    try { return win.parent !== win && win.parent === win.top ? win.parent : null; } catch { return null; }
  }

  function post(env) {
    if (!started) return false;
    const p = parentWin();
    if (!p) return false;
    try { p.postMessage(env, parentOrigin); return true; } catch { return false; }
  }

  function setRemote(f, isUp) {
    if (!top || isUp === top.features.has(f)) return;
    if (isUp) top.features.add(f); else top.features.delete(f);
    registry.peerEvent(f, { peer: 'top', connected: isUp });
  }

  function dropTop() {
    if (!top) return;
    for (const f of [...top.features]) setRemote(f, false);
    top = null;
  }

  function hello() {
    post(makeEnvelope('hello', { s: sessionId, m: local.ids() }));
  }

  function onMessage(event) {
    if (!event || event.isTrusted !== true) return;
    const p = parentWin();
    if (!p || event.source !== p || event.origin !== parentOrigin) return;
    const env = parseEnvelope(event.data);
    if (!env) return;
    if (env.k === 'ack') {
      if (top && top.session !== env.s) dropTop();
      if (!top) top = { session: env.s, features: new Set() };
      const now = new Set(env.m);
      for (const f of [...top.features]) if (!now.has(f)) setRemote(f, false);
      for (const f of now) setRemote(f, true);
    } else if (env.k === 'hello') {
      // The top hub (re)started: introduce ourselves again.
      if (top && top.session !== env.s) dropTop();
      hello();
    } else if (!top) {
      // Nothing else counts before the top answered.
    } else if (env.k === 'up' || env.k === 'down') {
      if (env.k === 'up' && !top.features.has(env.f) && top.features.size >= MAX_UP) return;
      setRemote(env.f, env.k === 'up');
    } else if (env.k === 'msg') {
      registry.dispatch(env.f, env.t, env.p, { peer: 'top' });
    }
  }

  function onPageHide() {
    post(makeEnvelope('bye', { s: sessionId }));
  }

  const livePeersFor = (featureId) => (top && top.features.has(featureId) ? ['top'] : []);

  return {
    available,
    sessionId,
    start() {
      if (started || !available) return;
      started = true;
      win.addEventListener('message', onMessage);
      win.addEventListener('pagehide', onPageHide);
      for (const ms of helloDelays) timers.push(setTimeout(() => { if (!top) hello(); }, ms));
    },
    stop() {
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
      for (const t of timers) clearTimeout(t);
      started = false;
    },
    forFeature(meta, signal) {
      if (!available) return inertFrames(meta);
      local.track(meta, signal);
      return Object.freeze({
        available: true,
        send(type, payload) {
          const text = encodePayload(meta, type, payload);
          if (!top || !top.features.has(meta.id)) return 0; // the top half isn't mounted
          return post(makeEnvelope('msg', { f: meta.id, t: type, p: text })) ? 1 : 0;
        },
        on: (type, cb) => registry.addHandler(meta, type, cb, signal),
        onPeer: (cb) => registry.addPeerCb(meta, cb, signal, () => livePeersFor(meta.id)),
        peers: () => livePeersFor(meta.id),
      });
    },
    _onMessage: onMessage,
    _connected: () => !!top,
  };
}

/** ctx.frames where no channel exists (auth frames, nested or unverified bee frames). */
export function inertFrames(meta) {
  return Object.freeze({
    available: false,
    send(type, payload) { encodePayload(meta, type, payload); return 0; },
    on(type, cb) {
      if (typeof cb !== 'function') throw new TypeError('frames.on(type, cb): cb must be a function');
      if (!specsFor(meta).has(type)) throw new TypeError(`${meta.id}: frame message type "${type}" is not declared in meta.frameMessages`);
      return () => {};
    },
    onPeer: () => () => {},
    peers: () => [],
  });
}
