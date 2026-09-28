// The shared Workbench strip in Iterable's top navbar (ARCHITECTURE §7.1).
//
// Several features put things in the navbar (quicklinks, user lookup, snippets …). The old
// userscripts each inserted their own wrapper right after #navbar-logo and fought over the
// navbar grid's `links` area. Here there is one strip (mockup `.wb-navstrip`: the mark, then each
// feature's item in `order`), injected once, re-injected when Iterable re-renders its navbar, and
// removed when the last item goes away.
//
// Popovers opened from a strip item must not render inside the strip (the navbar clips them and
// the page stacks over them): use anchorFloat(), which puts them on the float overlay layer.

import { h } from '../core/dom.js';
import { mountInline, mountOverlay } from './shadow.js';
import { mark } from './components.js';

/** Where the strip goes. Exported so a fix for an Iterable markup change is one line. */
export const NAVBAR = {
  navbar: '#navbar',
  logo: '#navbar-logo',
  gridArea: 'links', // used when the logo's container is a grid that defines this area
};

const items = []; // { featureId, order, seq, el }
let seq = 0;
let strip = null; // mountInline() result; strip.el is the `.wb.wb-navstrip` element
let observer = null;
let scheduled = false;

function createStrip() {
  // mountInline needs a target; create it detached and let place() put the host in the navbar.
  const holder = document.createElement('div');
  const m = mountInline(holder, 'append', { className: 'wb-navstrip' });
  m.host.remove();
  m.host.setAttribute('data-wb-navstrip', '');
  m.el.setAttribute('role', 'toolbar');
  m.el.setAttribute('aria-label', 'Workbench');
  m.el.append(mark());
  return m;
}

/** Put the strip host after the navbar logo (again) when it isn't in the current navbar. */
function place() {
  if (!strip) return;
  const navbar = document.querySelector(NAVBAR.navbar);
  const logo = navbar?.querySelector(NAVBAR.logo);
  if (!navbar || !logo) return; // navbar not rendered (yet): wait for the observer
  if (strip.host.isConnected && navbar.contains(strip.host)) return;
  logo.after(strip.host);
  const container = logo.parentElement;
  const cs = container ? getComputedStyle(container) : null;
  const inGrid = cs && /grid/.test(cs.display)
    && new RegExp(`(^|[\\s"])${NAVBAR.gridArea}([\\s"]|$)`).test(cs.gridTemplateAreas || '');
  // With `display: contents` on the host, strip.el is the navbar's grid/flex item.
  strip.el.style.gridArea = inGrid ? NAVBAR.gridArea : '';
  strip.el.classList.toggle('in-grid', !!inGrid);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; place(); });
}

function ensureStrip() {
  if (strip) return;
  strip = createStrip();
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  place();
}

function destroyStrip() {
  observer?.disconnect();
  observer = null;
  strip?.destroy();
  strip = null;
}

/**
 * Reserve a spot in the navbar strip for `featureId`. → an element (a flex row) inside the strip;
 * put buttons, links, a lookup form … in it. Items are ordered by `order` (lower first, default
 * 100), then by call order. The item is removed when `signal` aborts (pass ctx.signal, or a child
 * AbortController's signal to remove it earlier); the strip goes away with its last item.
 * The strip survives navbar re-renders: the same element is moved into the new navbar, so
 * listeners and state in the item are kept. Top frame only.
 */
export function navSlot({ featureId, order = 100, signal, className } = {}) {
  if (!featureId) throw new Error('navSlot: featureId is required');
  if (!signal) throw new Error('navSlot: signal is required (pass ctx.signal)');
  const el = h('div', { class: ['wb-navitem', className], dataset: { feature: featureId } });
  if (signal.aborted) return el;
  const entry = { featureId, order: Number.isFinite(order) ? order : 100, seq: ++seq, el };
  items.push(entry);
  items.sort((a, b) => a.order - b.order || a.seq - b.seq);
  ensureStrip();
  const next = items[items.indexOf(entry) + 1];
  strip.el.insertBefore(el, next ? next.el : null);
  signal.addEventListener('abort', () => {
    const i = items.indexOf(entry);
    if (i >= 0) items.splice(i, 1);
    el.remove();
    if (!items.length) destroyStrip();
  }, { once: true });
  return el;
}

/**
 * Show `content` in a floating box anchored to `anchor` (a strip item, a button …), on the float
 * overlay layer, so it is never clipped by the navbar or covered by the page.
 * Options:
 *   placement  'bottom-end' (default) | 'bottom-start' | 'top-end' | 'top-start'; flips
 *              vertically when there's no room, and stays inside the viewport
 *   offset     gap in px (default 6)
 *   width      CSS width for the box (e.g. 320); default: the content's own width
 *   signal     destroys the float when aborted (pass ctx.signal)
 *   dismiss    default true: a pointerdown outside the float and the anchor, or Escape, closes it
 *   onDismiss  called after a dismiss (not after destroy())
 * → { el, root, host, reposition(), destroy() }. It follows the anchor on scroll/resize; while the
 * anchor is out of the document (a navbar re-render) the float is hidden.
 */
export function anchorFloat(anchor, content, {
  placement = 'bottom-end', offset = 6, width, signal, dismiss = true, onDismiss,
} = {}) {
  const m = mountOverlay('float');
  const box = h('div', { class: 'wb-float', style: width != null ? { width: typeof width === 'number' ? `${width}px` : width } : null }, content);
  m.el.append(box);
  let frame = 0;
  let destroyed = false;

  const reposition = () => {
    frame = 0;
    if (destroyed) return;
    if (!anchor.isConnected) { box.style.visibility = 'hidden'; return; }
    box.style.visibility = '';
    const a = anchor.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    const [side, align] = placement.split('-');
    let top = side === 'top' ? a.top - offset - b.height : a.bottom + offset;
    if (side !== 'top' && top + b.height > vh - 8 && a.top - offset - b.height >= 8) top = a.top - offset - b.height;
    if (side === 'top' && top < 8 && a.bottom + offset + b.height <= vh - 8) top = a.bottom + offset;
    let left = align === 'start' ? a.left : a.right - b.width;
    left = Math.min(Math.max(8, left), Math.max(8, vw - 8 - b.width));
    box.style.top = `${Math.max(8, top)}px`;
    box.style.left = `${left}px`;
  };
  const request = () => { if (!frame) frame = requestAnimationFrame(reposition); };

  const onPointer = (e) => {
    const path = e.composedPath();
    if (path.includes(box) || path.includes(anchor)) return;
    close();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(request) : null;
  ro?.observe(box);
  ro?.observe(anchor);
  window.addEventListener('scroll', request, true);
  window.addEventListener('resize', request);
  if (dismiss) {
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
  }

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    ro?.disconnect();
    window.removeEventListener('scroll', request, true);
    window.removeEventListener('resize', request);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    m.destroy();
  };
  function close() {
    destroy();
    onDismiss?.();
  }
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  else reposition();
  return { el: box, root: m.root, host: m.host, reposition, destroy };
}
