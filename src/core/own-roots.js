// Loophole's own shadow roots are CLOSED (ARCHITECTURE §7, §9): page script can't reach inside
// them (`host.shadowRoot` is null for everyone), so it can't read what we render or find our
// controls to click. Our own code keeps the references here instead.
//
// Closed roots also retarget events for listeners outside them: a window / document listener sees
// the host as the target and `composedPath()` stops at the host. `deepOrigin(e)` recovers the
// real target inside our roots (the focused element for keyboard events, the element under the
// pointer for pointer events), and `eventWithin(e, node)` answers "did this happen inside node?".
//
// No DOM access at import time (unit tests import this in node).

const roots = new WeakMap(); // host → its closed ShadowRoot (ours only)
const live = new Set();      // hosts mounted and not destroyed yet

/** Record a host we created and its closed root. */
export function registerOwnRoot(host, root) {
  roots.set(host, root);
  live.add(host);
}

/** The host was destroyed: stop listing it (the WeakMap entry stays for late lookups). */
export function unregisterOwnRoot(host) {
  live.delete(host);
}

/** Our closed root for `host`, or null (not ours). Page shadow roots are never returned. */
export function ownRootOf(host) {
  return (host && roots.get(host)) || null;
}

/** True for a shadow host Loophole created. */
export function isOwnHost(node) {
  return !!node && roots.has(node);
}

/** Our hosts that are currently in the document. */
export function ownHosts() {
  return [...live].filter((h) => h.isConnected);
}

/** True for pointer-positioned events (not a keyboard-activated click, whose clientX/Y are 0). */
function hasPointerPosition(e) {
  if (typeof e?.clientX !== 'number' || typeof e?.clientY !== 'number') return false;
  if (e.type === 'click' && e.detail === 0) return false; // Enter / Space on a focused control
  return /^(pointer|mouse|click|dblclick|auxclick|contextmenu|wheel|touch|drag|drop)/.test(e.type || '');
}

/**
 * The event's original target, looking inside Loophole's closed roots: from the retargeted
 * target (our host), the element under the pointer (pointer events) or the focused element
 * (keyboard events) of that root, repeatedly for nested roots. For anything else: composedPath()[0]
 * (open roots) or e.target.
 */
export function deepOrigin(e) {
  let n = (typeof e?.composedPath === 'function' && e.composedPath()[0]) || e?.target || null;
  const byPoint = hasPointerPosition(e);
  for (let i = 0; n && i < 32; i++) {
    const root = roots.get(n);
    if (!root) break;
    let inner = null;
    if (byPoint && typeof root.elementFromPoint === 'function') {
      try { inner = root.elementFromPoint(e.clientX, e.clientY); } catch { inner = null; }
    }
    if (!inner) inner = root.activeElement || null;
    if (!inner || inner === n) break;
    n = inner;
  }
  return n;
}

/** Is `node` `ancestor` or inside it, crossing shadow boundaries (host ← root) on the way up? */
export function containsDeep(ancestor, node) {
  let n = node;
  for (let i = 0; n && i < 10_000; i++) {
    if (n === ancestor) return true;
    const p = n.parentNode;
    n = p && p.nodeType === 11 && p.host ? p.host : p;
  }
  return false;
}

/** Did event `e` originate inside `node` (which may live inside one of our closed roots)? */
export function eventWithin(e, node) {
  if (!node) return false;
  const path = typeof e?.composedPath === 'function' ? e.composedPath() : [];
  if (path.includes(node)) return true;
  return containsDeep(node, deepOrigin(e));
}

/** The focused element, descending into our closed roots (and open ones) as far as it goes. */
export function deepActiveElement(doc = globalThis.document) {
  let a = doc?.activeElement || null;
  for (let i = 0; a && i < 32; i++) {
    const root = roots.get(a) || a.shadowRoot || null;
    const inner = root?.activeElement || null;
    if (!inner || inner === a) break;
    a = inner;
  }
  return a;
}
