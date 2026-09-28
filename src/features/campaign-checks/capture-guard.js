// Capture integrity for the approval view's screenshots (ARCHITECTURE §8.5, §9).
//
// captureVisibleTab takes whatever the tab shows. Before every capture (popup, command, in-page
// button) the content script checks that our approval overlay is really what is on screen, and
// after the capture that nothing changed; otherwise the image is discarded:
//   - the overlay host is mounted where we put it (a child of <body>), no fullscreen element, no
//     page element in the top layer (:modal, :popover-open, :fullscreen);
//   - the host's ancestors (<body>, <html>) have no opacity / filter / blend / clip / mask /
//     transform / zoom that could hide or distort it (they can't restyle the host itself: its
//     :host rule is `all:initial !important` plus !important positioning);
//   - document.elementsFromPoint at a 5×5 grid (corners, edges, centre) hits one of our overlay
//     hosts first;
//   - no page element (light DOM, open or closed page shadow roots, ::before / ::after) has a
//     z-index at or above ours: that is how pointer-events:none layers would get above us
//     without showing up in hit testing; no running animation / transition of z-index;
//   - during the capture window: a MutationObserver on the page (our own hosts excepted), the
//     same checks again on every animation frame, and a stylesheet fingerprint; after the capture
//     the full check runs again and the grid must hit the same hosts.
//
// The pure parts are exported for unit tests; the DOM part needs a browser.

import { isOwnHost, containsDeep, ownHosts } from '../../core/own-roots.js';

export const COVERED_MESSAGE = 'Something is covering the approval view — screenshot not taken.';
export const CHANGED_MESSAGE = 'The page changed while the screenshot was taken, so it was discarded. Try again.';
export const MAX_SCAN_ELEMENTS = 60_000;

// ── Pure parts ──────────────────────────────────────────────────────────────

/** A (steps+1)² grid over a width × height viewport, `inset` px in from the edges. */
export function gridPoints(width, height, { steps = 4, inset = 2 } = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const span = (len, i) => {
    const lo = Math.min(inset, len - 1);
    const hi = Math.max(lo, len - 1 - inset);
    return Math.round(lo + ((hi - lo) * i) / steps);
  };
  const pts = [];
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) pts.push({ x: span(w, i), y: span(h, j) });
  }
  return pts;
}

const isNone = (v) => v == null || v === '' || v === 'none';

/**
 * Why an ancestor's computed style could hide or distort our overlay, or null when it is neutral.
 * `cs` is a CSSStyleDeclaration-like object (only the properties read here matter).
 */
export function ancestorStyleProblem(cs) {
  if (!cs) return 'no computed style';
  const op = Number.parseFloat(cs.opacity);
  if (cs.opacity != null && cs.opacity !== '' && op !== 1) return `opacity ${cs.opacity}`;
  if (!isNone(cs.filter)) return `filter ${cs.filter}`;
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return `mix-blend-mode ${cs.mixBlendMode}`;
  if (!isNone(cs.clipPath)) return `clip-path ${cs.clipPath}`;
  if (!isNone(cs.maskImage)) return `mask-image ${cs.maskImage}`;
  if (!isNone(cs.webkitMaskImage)) return `mask-image ${cs.webkitMaskImage}`;
  if (!isNone(cs.transform)) return `transform ${cs.transform}`;
  if (cs.zoom != null && cs.zoom !== '' && cs.zoom !== 'normal' && Number.parseFloat(cs.zoom) !== 1) return `zoom ${cs.zoom}`;
  if (cs.contentVisibility && cs.contentVisibility !== 'visible') return `content-visibility ${cs.contentVisibility}`;
  if (cs.display === 'none') return 'display none';
  return null;
}

/** Does a computed z-index ('auto' or an integer string) put an element at or above `ourZ`? */
export function zIndexThreat(zIndex, ourZ) {
  const s = String(zIndex ?? '').trim();
  if (!/^-?\d+$/.test(s)) return false;
  return Number(s) >= ourZ;
}

/** Index of the first grid point whose top element isn't ours (-1 when every point is ours). */
export function firstUncovered(firstHits, isOurs) {
  return firstHits.findIndex((el) => !el || !isOurs(el));
}

/** Same top element at every grid point? */
export function sameHits(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Do keyframe / transition property names include z-index? */
export function animatesZIndex(props) {
  return props.some((p) => p === 'zIndex' || p === 'z-index' || p === 'all');
}

// ── DOM parts ───────────────────────────────────────────────────────────────

/** A page element's shadow root, open or closed (content scripts may read closed page roots). */
function pageShadowRoot(el) {
  try {
    if ('openOrClosedShadowRoot' in el) return el.openOrClosedShadowRoot || null; // Firefox content scripts
  } catch { /* not exposed */ }
  try {
    const d = globalThis.chrome?.dom;
    if (typeof d?.openOrClosedShadowRoot === 'function') return d.openOrClosedShadowRoot(el) || null; // Chrome 88+
  } catch { /* not a host */ }
  return el.shadowRoot || null;
}

function isOurOverlay(el) {
  return isOwnHost(el) && el.hasAttribute?.('data-wb-layer');
}

/** Is `node` inside one of our hosts (so: our own UI, rendered in our closed roots)? */
function insideOurs(node) {
  for (const h of ownHosts()) if (containsDeep(h, node)) return true;
  return false;
}

function inTopLayer(el) {
  for (const sel of [':modal', ':popover-open', ':fullscreen']) {
    try { if (el.matches(sel)) return true; } catch { /* selector unsupported here */ }
  }
  return false;
}

/**
 * Walk the page (light DOM + page shadow roots), skipping our hosts. → { problem, roots }
 * `roots`: page shadow roots found (the capture window observes them too).
 */
export function scanPage(ourZ, { doc = globalThis.document, win = globalThis.window, max = MAX_SCAN_ELEMENTS } = {}) {
  const roots = [];
  const stack = doc.documentElement ? [doc.documentElement] : [];
  let n = 0;
  while (stack.length) {
    const el = stack.pop();
    if (isOwnHost(el)) continue;
    if (++n > max) return { problem: `the page has more than ${max} elements to check`, roots };
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (inTopLayer(el)) return { problem: `a page <${el.localName}> is in the top layer`, roots };
    if (zIndexThreat(cs.zIndex, ourZ)) return { problem: `a page <${el.localName}> has z-index ${cs.zIndex}`, roots };
    for (const pseudo of ['::before', '::after']) {
      const p = win.getComputedStyle(el, pseudo);
      if (p && !isNone(p.content) && p.content !== 'normal' && zIndexThreat(p.zIndex, ourZ)) {
        return { problem: `a page <${el.localName}>${pseudo} has z-index ${p.zIndex}`, roots };
      }
    }
    const sr = pageShadowRoot(el);
    if (sr) { roots.push(sr); for (const c of sr.children) stack.push(c); }
    for (const c of el.children) stack.push(c);
  }
  // A z-index animated or transitioning right now could put something above us mid-capture.
  try {
    for (const a of doc.getAnimations?.() || []) {
      const t = a.effect?.target;
      if (!t || insideOurs(t)) continue;
      const props = typeof a.transitionProperty === 'string' ? [a.transitionProperty]
        : (a.effect.getKeyframes?.() || []).flatMap((k) => Object.keys(k));
      if (animatesZIndex(props)) return { problem: 'a page element is animating its z-index', roots };
    }
  } catch { /* getAnimations unsupported */ }
  return { problem: null, roots };
}

/**
 * The first element at a point, skipping <html> / <body> at the head of the list: they can't
 * paint above their positioned descendants, so a hit on them before our overlay is an overlay
 * scrollbar (Firefox) or a pseudo-element, and pseudo-elements that could cover us are caught by
 * scanPage (z-index), ancestors' effects by ancestorStyleProblem.
 */
export function topHit(list, doc) {
  let i = 0;
  while (i < list.length - 1 && (list[i] === doc.documentElement || list[i] === doc.body)) i++;
  return list[i] || null;
}

/**
 * One full inspection. → { problem: string | null, hits: [Element], roots: [ShadowRoot] }
 */
export function inspectCapture(host, { doc = globalThis.document, win = globalThis.window, ourZ } = {}) {
  const fail = (problem) => ({ problem, hits: [], roots: [] });
  if (!host?.isConnected) return fail('the approval view is not open');
  if (host.parentNode !== doc.body && host.parentNode !== doc.documentElement) return fail('the approval view was moved');
  if (doc.fullscreenElement || doc.webkitFullscreenElement) return fail('something is in fullscreen');
  const z = ourZ ?? Number.parseInt(win.getComputedStyle(host).zIndex, 10);
  if (!Number.isFinite(z)) return fail('the approval view has no stacking layer');
  for (let a = host.parentElement; a; a = a.parentElement) {
    const p = ancestorStyleProblem(win.getComputedStyle(a));
    if (p) return fail(`<${a.localName}> has ${p}`);
  }
  // The layout viewport without the page's scrollbars (our fixed overlay covers exactly that).
  const vw = doc.documentElement.clientWidth || win.innerWidth;
  const vh = doc.documentElement.clientHeight || win.innerHeight;
  const hits = gridPoints(vw, vh).map(({ x, y }) => topHit(doc.elementsFromPoint(x, y) || [], doc));
  const bad = firstUncovered(hits, isOurOverlay);
  if (bad >= 0) return fail(`the view isn't on top at grid point ${bad}`);
  const scan = scanPage(z, { doc, win });
  if (scan.problem) return fail(scan.problem);
  return { problem: null, hits, roots: scan.roots };
}

/** Rule counts of every stylesheet the page can reach (a cheap before/after fingerprint). */
function sheetFingerprint(doc) {
  const parts = [];
  const add = (sheet) => {
    let n = -1;
    try { n = sheet.cssRules.length; } catch { /* cross-origin sheet */ }
    parts.push(`${sheet.disabled ? 'd' : 'e'}${n}`);
  };
  try { for (const s of doc.styleSheets) add(s); } catch { /* none */ }
  try { for (const s of doc.adoptedStyleSheets || []) add(s); } catch { /* none */ }
  return parts.join(',');
}

/** Mutation records that could change what the capture shows (ours excepted). */
function relevantMutation(r) {
  if (isOwnHost(r.target)) return false;
  if (r.type === 'childList') {
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return nodes.some((x) => x.nodeType === 1 && !isOwnHost(x)) || nodes.some((x) => x.nodeType === 3 && x.textContent.trim());
  }
  return r.type === 'attributes';
}

/**
 * Start a capture window for overlay `host`. → { ok: false, reason, detail } when the view isn't
 * cleanly on top now, else { ok: true, id, finish() → { intact, reason?, detail? }, cancel() }.
 * Call finish() right after the capture (before changing the view back).
 */
export function startCaptureGuard(host, { doc = globalThis.document, win = globalThis.window } = {}) {
  const ourZ = host?.isConnected ? Number.parseInt(win.getComputedStyle(host).zIndex, 10) : NaN;
  const first = inspectCapture(host, { doc, win, ourZ });
  if (first.problem) return { ok: false, reason: COVERED_MESSAGE, detail: first.problem };
  let changed = null;
  const mo = new win.MutationObserver((records) => {
    if (changed) return;
    const r = records.find(relevantMutation);
    if (r) changed = `the page changed (${r.type} on <${r.target?.localName || r.target?.nodeName || '?'}>)`;
  });
  const opts = { subtree: true, childList: true, attributes: true };
  mo.observe(doc.documentElement, opts);
  for (const r of first.roots) { try { mo.observe(r, opts); } catch { /* gone */ } }
  const sheets = sheetFingerprint(doc);
  let raf = 0;
  let pollProblem = null;
  let done = false;
  const poll = () => {
    raf = 0;
    if (done) return;
    if (!pollProblem) {
      const p = inspectCapture(host, { doc, win, ourZ });
      if (p.problem) pollProblem = p.problem;
      else if (!sameHits(first.hits, p.hits)) pollProblem = 'the top elements changed';
    }
    raf = win.requestAnimationFrame(poll);
  };
  raf = win.requestAnimationFrame(poll);
  const stop = () => {
    done = true;
    if (raf) win.cancelAnimationFrame(raf);
    mo.disconnect();
  };
  const id = globalThis.crypto.randomUUID();
  return {
    ok: true,
    id,
    cancel: stop,
    finish() {
      if (done) return { intact: false, reason: CHANGED_MESSAGE, detail: 'already finished' };
      for (const r of mo.takeRecords()) if (!changed && relevantMutation(r)) changed = `the page changed (${r.type})`;
      stop();
      const last = inspectCapture(host, { doc, win, ourZ });
      const detail = changed || pollProblem || last.problem
        || (!sameHits(first.hits, last.hits) ? 'the top elements changed' : null)
        || (sheetFingerprint(doc) !== sheets ? 'the page stylesheets changed' : null);
      return detail ? { intact: false, reason: last.problem ? COVERED_MESSAGE : CHANGED_MESSAGE, detail } : { intact: true };
    },
  };
}
