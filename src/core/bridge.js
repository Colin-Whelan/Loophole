// Isolated world <-> MAIN world messaging over window CustomEvents (ARCHITECTURE §5.4, §6.3).
//
// The detail is always a JSON string: Firefox hands isolated-world listeners an Xray wrapper for
// page-created objects, but strings cross cleanly in both browsers.
// The page sees every event on this bridge and can dispatch its own. Never send secrets, and
// validate what you receive.

export const BRIDGE_EVENT = 'wb-bridge:v1';
/** Largest bridge event detail (JSON text, characters) either side accepts. */
export const BRIDGE_MAX_CHARS = 8 * 1024 * 1024;

/**
 * JSON.parse that drops `__proto__` keys (so a later Object.assign / merge can't swap an object's
 * prototype). Returns { ok, value }.
 */
export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text, (key, value) => (key === '__proto__' ? undefined : value)) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** Dispatch one bridge message. Returns false if it couldn't be encoded or is over the cap. */
export function emit(type, payload = {}) {
  let detail;
  try { detail = JSON.stringify({ type, payload }); } catch { return false; }
  if (typeof detail !== 'string' || detail.length > BRIDGE_MAX_CHARS) return false;
  window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail }));
  return true;
}

/** Listen for one message type. Returns an unsubscribe function. */
export function on(type, cb, { signal } = {}) {
  const listener = (event) => {
    const detail = event.detail;
    if (typeof detail !== 'string' || detail.length > BRIDGE_MAX_CHARS) return;
    const res = safeJsonParse(detail);
    const msg = res.value;
    if (!res.ok || !msg || typeof msg !== 'object' || msg.type !== type) return;
    cb(msg.payload);
  };
  window.addEventListener(BRIDGE_EVENT, listener, { signal });
  return () => window.removeEventListener(BRIDGE_EVENT, listener);
}

export const BRIDGE = Object.freeze({
  LOCATION: 'location',             // MAIN → isolated: history.pushState/replaceState happened
  // Page-world RPC (core/page-rpc.js ↔ page/rpc-host.js)
  RPC_ACTIVATE: 'rpc:activate',     // isolated → MAIN { f }: feature f is mounted; its handlers may answer
  RPC_DEACTIVATE: 'rpc:deactivate', // isolated → MAIN { f }
  RPC_CALL: 'rpc:call',             // isolated → MAIN { f, id, m, a }
  RPC_RESULT: 'rpc:result',         // MAIN → isolated { f, id, ok, r? , e? }
  RPC_EVENT: 'rpc:event',           // MAIN → isolated { f, e, p }
  RPC_READY: 'rpc:ready',           // MAIN → isolated {}: a (new) host started; re-send activations
  MAIN_TAKEOVER: 'main:takeover',   // MAIN → MAIN { n }: a newer copy of main-world.js was injected
});
