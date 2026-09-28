// Sanitising HTML for Loophole's own previews (approval view email, snippet viewer) and
// neutralising navigation in the live preview frame (ARCHITECTURE §9 "Previews").
//
// The previews render in <iframe sandbox=""> (no scripts, opaque origin, no popups, no top
// navigation) with a CSP meta that blocks the network unless "Load remote images" is on. That
// still leaves the frame free to navigate ITSELF when the person clicks a link (a network request
// and a remote page shown in place of the email), plus resource hints and <meta refresh>. So the
// document is also stripped here, before it becomes the srcdoc:
//   - removed: <base>, every <meta http-equiv>, resource-hint <link>s (dns-prefetch, preconnect,
//     prefetch, preload, prerender, modulepreload), scripts, and nested browsing contexts / plugins
//     (iframe, frame, frameset, object, embed, portal, applet);
//   - navigation attributes removed: href / xlink:href on HTML <a> / <area>, SVG <a> and any MathML
//     element; action on <form>; formaction on anything; ping and target everywhere;
//   - a style that makes links inert (pointer-events:none), in case anything is left;
//   - our CSP meta first in <head>, then referrer no-referrer.
//
// Pure DOM manipulation on an inert (DOMParser) document: nothing here loads or runs anything.

export const HINT_RELS = Object.freeze(['dns-prefetch', 'preconnect', 'prefetch', 'preload', 'prerender', 'modulepreload']);
export const REMOVED_ELEMENTS = 'base, meta[http-equiv], script, iframe, frame, frameset, object, embed, portal, applet';
export const INERT_LINKS_CSS = 'a,area{pointer-events:none !important;cursor:default !important}';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** True for a <link> whose rel includes a resource hint. */
export function isHintLink(el) {
  if (el.localName !== 'link') return false;
  const rels = String(el.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
  return rels.some((r) => HINT_RELS.includes(r));
}

/** Does attribute `attr` on element `el` navigate (or ping) somewhere? */
export function isNavigationAttribute(el, attr) {
  const name = String(attr.localName || attr.name || '').toLowerCase();
  if (name === 'ping' || name === 'target' || name === 'formaction') return true;
  if (name === 'action') return el.localName === 'form';
  if (name !== 'href') return false;
  const ns = el.namespaceURI;
  if (ns === MATHML_NS) return true;
  if (ns === SVG_NS) return el.localName === 'a';
  if (ns === HTML_NS || ns == null) return el.localName === 'a' || el.localName === 'area';
  return false;
}

/**
 * Neutralise `doc` (an inert DOMParser document) in place. Options:
 *   csp  Content-Security-Policy text for a meta tag first in <head> (omit for none)
 * Returns doc.
 */
export function sanitizePreviewDocument(doc, { csp } = {}) {
  for (const el of [...doc.querySelectorAll(REMOVED_ELEMENTS)]) el.remove();
  for (const el of [...doc.querySelectorAll('link')]) if (isHintLink(el)) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (isNavigationAttribute(el, attr)) el.removeAttributeNode(attr);
    }
  }
  const root = doc.documentElement || doc.appendChild(doc.createElement('html'));
  const head = doc.head || root.insertBefore(doc.createElement('head'), doc.body || null);
  const first = [];
  if (csp) {
    const meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', csp);
    first.push(meta);
  }
  const ref = doc.createElement('meta');
  ref.setAttribute('name', 'referrer');
  ref.setAttribute('content', 'no-referrer');
  const style = doc.createElement('style');
  style.textContent = INERT_LINKS_CSS;
  first.push(ref, style);
  head.prepend(...first);
  return doc;
}

/**
 * Live preview (a same-origin, script-less sandboxed frame showing Iterable's rendered email):
 * make link / form activation inert inside `doc`, and hand the person's own link clicks to
 * `onLink(url)` (which may offer to open it). Idempotent per document. → true when attached.
 */
const guarded = new WeakSet();
export function guardFrameDocument(doc, { onLink } = {}) {
  if (!doc || guarded.has(doc)) return false;
  guarded.add(doc);
  const stop = (e) => {
    const t = e.target;
    const link = t && typeof t.closest === 'function' ? t.closest('a, area') : null;
    if (e.type === 'submit') { e.preventDefault(); e.stopPropagation(); return; }
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== 'click' || !e.isTrusted) return;
    const raw = link.getAttribute('href') ?? link.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href');
    if (raw) onLink?.(raw, doc.baseURI);
  };
  for (const type of ['click', 'auxclick', 'submit']) doc.addEventListener(type, stop, true);
  return true;
}
