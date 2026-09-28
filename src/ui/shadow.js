// Shadow-root mounting for everything Workbench injects into Iterable (ARCHITECTURE §7).
// Each mount gets its own shadow root with theme.css inside and a themed `.wb` wrapper `el`.

import themeCss from './theme.css';
import { themed } from './theme.js';

export const LAYERS = Object.freeze({
  float: 2147483000,
  drawer: 2147483100,
  modal: 2147483200,
  toast: 2147483300,
});

const HOST_TAG = 'wb-host';

// The host resets everything it could inherit from the page. `display: contents` for inline
// mounts lets the .wb wrapper take part in the page's own flex/grid layout.
//
// Everything the host itself needs goes in this :host rule, after `all:initial`. Never style the
// host with inline `!important` styles: for !important declarations the shadow tree's :host rule
// wins over the outer tree (even over the element's own style attribute), so `all:initial` would
// silently reset them (an overlay would end up position:static, z-index:auto, under the page).
function hostCss(display, extra = '') {
  return `:host{all:initial !important; display:${display} !important;${extra}}`;
}

/** :host declarations for an overlay: a 0×0 fixed box at the top-left on layer `z`. */
export function overlayHostCss(z) {
  return hostCss('block', ` position:fixed !important; top:0 !important; left:0 !important; width:0 !important;` +
    ` height:0 !important; overflow:visible !important; z-index:${z} !important;`);
}

function createHost(hostRule) {
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = hostRule + '\n' + themeCss;
  const el = document.createElement('div');
  el.className = 'wb';
  root.append(style, el);
  const unregister = themed(el);
  return {
    host,
    root,
    el,
    destroy() {
      unregister();
      host.remove();
    },
  };
}

/**
 * Mount a shadow-rooted `.wb` wrapper next to/inside `target`.
 * where: 'before' | 'after' | 'prepend' | 'append'.
 * Options: className (added to el), display (host display, default 'contents').
 */
export function mountInline(target, where = 'append', { className = '', display = 'contents' } = {}) {
  const m = createHost(hostCss(display));
  if (className) m.el.classList.add(...className.split(/\s+/).filter(Boolean));
  switch (where) {
    case 'before': target.before(m.host); break;
    case 'after': target.after(m.host); break;
    case 'prepend': target.prepend(m.host); break;
    case 'append': target.append(m.host); break;
    default: throw new Error(`mountInline: unknown position "${where}"`);
  }
  return m;
}

/**
 * Mount a page-level overlay on one of the shared layers (float, drawer, modal, toast).
 * The host is a 0×0 fixed box at the top-left; position content inside with position:fixed.
 */
export function mountOverlay(layer = 'float', { className = '' } = {}) {
  const z = LAYERS[layer];
  if (!z) throw new Error(`mountOverlay: unknown layer "${layer}"`);
  const m = createHost(overlayHostCss(z));
  m.host.setAttribute('data-wb-layer', layer); // lets components tell an overlay from an inline mount
  if (className) m.el.classList.add(...className.split(/\s+/).filter(Boolean));
  (document.body || document.documentElement).append(m.host);
  return m;
}

/**
 * The overlay layer `node` renders in ('float', 'modal', …), or null when it is in an inline
 * mount or on a plain page. Extension pages count as null too.
 */
export function layerOf(node) {
  let n = node;
  while (n) {
    const root = n.getRootNode?.();
    const host = root && root !== n ? root.host : null;
    if (!host) return null;
    const layer = host.getAttribute?.('data-wb-layer');
    if (layer) return layer;
    n = host;
  }
  return null;
}
