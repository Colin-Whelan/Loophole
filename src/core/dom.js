// Small DOM helpers shared by content scripts and extension pages.

import { parseShortcut, matchesShortcut } from './shortcut.js';
import { deepOrigin, eventWithin, deepActiveElement } from './own-roots.js';

// Shortcut string helpers, re-exported so features reach them through ctx.dom.
export { formatShortcut, normalizeShortcut, shortcutParts, isMac } from './shortcut.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'rect', 'g', 'circle', 'line', 'polyline', 'polygon', 'use', 'symbol', 'defs']);

/**
 * h('button', { class: 'wb-btn', onClick: fn, dataset: { id: 1 }, style: {...} }, 'Label', child…)
 * - `on<Event>` props become listeners; `class`/`className` set the class; `style` may be a string
 *   or an object; `dataset` fills data-*; boolean true sets an empty attribute; false/null skip it.
 * - Children may be nodes, strings, numbers, arrays (flattened), or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, ...children);
  return el;
}

/**
 * Children as h() takes them → a flat list of nodes/strings: arrays (nested too) are flattened,
 * null / undefined / false / true are skipped, numbers become strings.
 */
export function childNodes(children, out = []) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) childNodes(c, out);
    else out.push(c instanceof Node ? c : String(c));
  }
  return out;
}

/**
 * Safe el.append(): the native one prints `null` / `false` as text and an array as
 * "[object HTMLElement],…". This one takes children like h(): arrays flattened, null / false
 * skipped. Returns el. Use it (or h()) whenever a child may be conditional or a list.
 */
export function append(el, ...children) {
  el.append(...childNodes(children));
  return el;
}

/** Safe el.prepend(), same rules as append(). Returns el. */
export function prepend(el, ...children) {
  el.prepend(...childNodes(children));
  return el;
}

/** Safe el.replaceChildren(), same rules as append(); no children clears el. Returns el. */
export function replaceChildren(el, ...children) {
  el.replaceChildren(...childNodes(children));
  return el;
}

/**
 * An AbortSignal that aborts as soon as any of `signals` does (with that signal's reason).
 * Falsy entries are ignored; arrays are flattened. Uses AbortSignal.any where it exists (Chrome
 * 116+, Firefox 124+), else a manual link for Chrome 111–115. Typical use: a child controller
 * whose work must also stop on unmount:
 *   const ac = new AbortController();
 *   ui.navSlot({ featureId, signal: linkSignal(ctx.signal, ac.signal) });   // …later ac.abort()
 */
export function linkSignal(...signals) {
  const list = signals.flat().filter(Boolean);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  return linkSignalFallback(list);
}

/** linkSignal() without AbortSignal.any (exported for tests). */
export function linkSignalFallback(list) {
  const ac = new AbortController();
  const first = list.find((s) => s.aborted);
  if (first) { ac.abort(first.reason); return ac.signal; }
  const onAbort = (e) => {
    for (const s of list) s.removeEventListener('abort', onAbort);
    ac.abort(e.target.reason);
  };
  for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

/** Remove every child of `el`. */
export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/**
 * Call `cb(el)` once for every element matching `selector`: those present now and any added later.
 * Stops when `signal` aborts. Returns a stop function.
 */
export function onElement(selector, cb, { root = document, signal } = {}) {
  const seen = new WeakSet();
  const scan = () => {
    for (const el of root.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      try { cb(el); } catch (e) { console.error('[Loophole:dom] onElement callback threw', e); }
    }
  };
  let scheduled = false;
  const obs = new MutationObserver(() => {
    // Coalesce bursts of mutations (SPA renders) into one scan per frame.
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; scan(); });
  });
  scan();
  obs.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
  const stop = () => obs.disconnect();
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

/**
 * Set an input's value so frameworks (React, Angular) notice: use the prototype's native setter,
 * then fire input + change.
 */
export function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export { deepOrigin, eventWithin, deepActiveElement };

// ── Trusted input (ARCHITECTURE §7 "Trusted input", §9) ─────────────────────
//
// Page script can dispatch synthetic events (`el.click()`, `dispatchEvent(new KeyboardEvent…)`)
// at anything it can reach: window / document listeners, and any element outside our closed
// shadow roots. Those events have `isTrusted === false`; events from the person (mouse, touch,
// keyboard, including Enter / Space activating a focused button) are trusted. Every control that
// writes data, spends the API key, clicks Iterable's own Save, captures, copies or downloads
// acts only on trusted events.

/** True for an event the browser generated from real user input. */
export function isTrustedEvent(e) {
  return !!e && typeof e === 'object' && e.isTrusted === true;
}

/**
 * Wrap an event handler so it runs only for trusted events (synthetic ones are ignored and the
 * wrapper returns undefined). Use for every privileged control:
 *   h('button', { onClick: trusted(() => save()) })   or   ui.button('Save', { onClick, trusted: true })
 */
export function trusted(handler) {
  if (typeof handler !== 'function') return handler;
  return function trustedHandler(e, ...rest) {
    if (!isTrustedEvent(e)) return undefined;
    return handler.call(this, e, ...rest);
  };
}

/**
 * Save a Blob (or string) as a file download. The temporary <a download> lives in a closed
 * shadow root, so page script never sees the blob: URL (a page can fetch a content script's blob
 * URLs). Call it from a trusted user action.
 */
export function downloadBlob(filename, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const host = document.createElement('wb-host');
  const root = host.attachShadow({ mode: 'closed' });
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  root.append(a);
  (document.body || document.documentElement).append(host);
  try { a.click(); } finally { host.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** True when keyboard focus is in a text-entry control (input, textarea, select, contenteditable). */
export function isEditableTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(el.type);
}

/**
 * Run `handler(event)` when the shortcut `combo` is pressed ('Mod+Shift+L'; the `shortcut`
 * settings field's format, see core/shortcut.js). Listens on window in the capture phase, so the
 * page can't swallow the key first. The event's default action is prevented unless the handler
 * returns false. Keys typed into inputs, textareas, selects and contenteditable elements
 * (including inside shadow roots) are ignored unless `allowInInputs`. Auto-repeat is ignored
 * unless `repeat: true`. An empty or invalid combo registers nothing.
 * Synthetic keyboard events (isTrusted false: page script can dispatch them on window) are
 * ignored unless `trustedOnly: false` (nothing in Loophole passes that).
 * Stops when `signal` aborts; returns a stop function.
 */
export function onShortcut(combo, handler, {
  signal, allowInInputs = false, repeat = false, target = globalThis.window, trustedOnly = true,
} = {}) {
  const parsed = parseShortcut(combo);
  if (!parsed || !target || signal?.aborted) {
    if (combo && !parsed) console.warn('[Loophole:dom] onShortcut: invalid shortcut', combo);
    return () => {};
  }
  const onKey = (e) => {
    if (trustedOnly && !isTrustedEvent(e)) return;
    if (e.isComposing || (e.repeat && !repeat)) return;
    if (!matchesShortcut(parsed, e)) return;
    if (!allowInInputs) {
      // deepOrigin: our shadow roots are closed, so composedPath() stops at our host.
      if (isEditableTarget(deepOrigin(e))) return;
    }
    let result;
    try { result = handler(e); } catch (err) { console.error('[Loophole:dom] shortcut handler threw', err); }
    if (result !== false) { e.preventDefault(); e.stopPropagation(); }
  };
  target.addEventListener('keydown', onKey, { capture: true });
  const stop = () => target.removeEventListener('keydown', onKey, { capture: true });
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
