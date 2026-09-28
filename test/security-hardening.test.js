// Security hardening (ARCHITECTURE §7 "Trusted input", §9): the trusted-event helpers, closed
// shadow roots (own-roots registry, deep event origins), the preview sanitiser and live-preview
// link guard, the capture guard's pure checks, and the capture-page message validation.
// No real DOM in node: small stand-ins below; the real-browser proof is in the live checklist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default "";', shortCircuit: true };
  return next(url, context);
}`));

const { trusted, isTrustedEvent } = await import('../src/core/dom.js');
const { armButton } = await import('../src/ui/components.js');
const {
  registerOwnRoot, unregisterOwnRoot, ownRootOf, isOwnHost, ownHosts, deepOrigin, eventWithin, containsDeep,
  deepActiveElement,
} = await import('../src/core/own-roots.js');
const {
  sanitizePreviewDocument, isNavigationAttribute, isHintLink, guardFrameDocument, HINT_RELS, INERT_LINKS_CSS,
} = await import('../src/core/preview.js');
const {
  gridPoints, ancestorStyleProblem, zIndexThreat, firstUncovered, sameHits, animatesZIndex, COVERED_MESSAGE, topHit,
} = await import('../src/features/campaign-checks/capture-guard.js');
const {
  checkCaptureOpen, checkCaptureTake, captureFileName, senderAllowed, CAPTURE_OPEN_MAX_CHARS, DEFAULT_CAPTURE_NAME,
} = await import('../src/core/api-validation.js');

// ── Trusted input ────────────────────────────────────────────────────────────

describe('trusted()', () => {
  test('runs the handler only for events with isTrusted === true', () => {
    const seen = [];
    const fn = trusted(function (e, extra) { seen.push([e.id, extra, this?.tag]); return 'ran'; });
    assert.equal(fn.call({ tag: 't' }, { id: 1, isTrusted: true }, 'x'), 'ran');
    assert.equal(fn({ id: 2, isTrusted: false }), undefined);
    assert.equal(fn({ id: 3 }), undefined);
    assert.equal(fn({ id: 4, isTrusted: 'true' }), undefined);
    assert.equal(fn({ id: 5, isTrusted: 1 }), undefined);
    assert.equal(fn(null), undefined);
    assert.equal(fn(), undefined);
    assert.deepEqual(seen, [[1, 'x', 't']]);
  });

  test('isTrustedEvent; a real (script-dispatched) Event is never trusted', () => {
    assert.equal(isTrustedEvent({ isTrusted: true }), true);
    assert.equal(isTrustedEvent({ isTrusted: false }), false);
    const e = new Event('click');
    assert.equal(isTrustedEvent(e), false);
    assert.throws(() => { 'use strict'; e.isTrusted = true; }); // own, unforgeable getter
    assert.equal(isTrustedEvent(e), false);
    assert.equal(trusted(undefined), undefined);
  });

  test('armButton: synthetic clicks neither arm nor fire (delete-user)', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const listeners = [];
    const classes = new Set();
    const btn = {
      textContent: 'Delete user',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      addEventListener: (type, f) => listeners.push(f),
      removeEventListener: () => {},
    };
    let fired = 0;
    armButton(btn, { seconds: 4, onConfirm: () => { fired++; } });
    const click = (isTrusted) => listeners.forEach((f) => f({ isTrusted, preventDefault() {} }));
    click(false); click(false);
    assert.equal(fired, 0);
    assert.equal(classes.has('armed'), false, 'a forged click does not even arm it');
    click(true);
    assert.equal(classes.has('armed'), true);
    click(false);
    assert.equal(fired, 0, 'a forged second click does not fire an armed button');
    click(true);
    assert.equal(fired, 1);
  });
});

// ── Closed roots: own-roots registry ─────────────────────────────────────────

function node(name, parent = null) {
  const n = { localName: name, nodeType: 1, parentNode: parent };
  return n;
}

describe('own-roots', () => {
  test('registry: our hosts and roots only; destroy unlists', () => {
    const host = { isConnected: true, nodeType: 1 };
    const root = { nodeType: 11, host };
    registerOwnRoot(host, root);
    assert.equal(ownRootOf(host), root);
    assert.equal(isOwnHost(host), true);
    assert.equal(isOwnHost({}), false);
    assert.equal(ownRootOf({ shadowRoot: {} }), null, 'page roots are never ours');
    assert.ok(ownHosts().includes(host));
    unregisterOwnRoot(host);
    assert.ok(!ownHosts().includes(host));
    assert.equal(ownRootOf(host), root, 'late lookups still work');
  });

  test('deepOrigin / eventWithin see through our closed roots (keyboard: focus, pointer: hit test)', () => {
    const host = { isConnected: true, nodeType: 1, localName: 'wb-host' };
    const root = { nodeType: 11, host };
    const panel = node('div', root);
    const input = node('input', panel);
    const other = node('button', root);
    root.activeElement = input;
    root.elementFromPoint = (x, y) => (x < 10 ? other : panel);
    registerOwnRoot(host, root);
    const retargeted = (props) => ({ composedPath: () => [host, { localName: 'body' }], target: host, ...props });
    assert.equal(deepOrigin(retargeted({ type: 'keydown' })), input);
    assert.equal(deepOrigin(retargeted({ type: 'pointerdown', clientX: 5, clientY: 5 })), other);
    assert.equal(deepOrigin(retargeted({ type: 'pointerdown', clientX: 50, clientY: 5 })), panel);
    // A keyboard-activated click (detail 0, clientX/Y 0): the focused element, not the hit test.
    assert.equal(deepOrigin(retargeted({ type: 'click', detail: 0, clientX: 0, clientY: 0 })), input);
    assert.equal(eventWithin(retargeted({ type: 'keydown' }), panel), true);
    assert.equal(eventWithin(retargeted({ type: 'pointerdown', clientX: 5, clientY: 5 }), panel), false);
    assert.equal(eventWithin(retargeted({ type: 'pointerdown', clientX: 5, clientY: 5 }), host), true);
    assert.equal(containsDeep(host, input), true);
    assert.equal(containsDeep(panel, other), false);
    assert.equal(deepActiveElement({ activeElement: host }), input);
    unregisterOwnRoot(host);
  });
});

// ── Preview sanitiser (fake inert document) ──────────────────────────────────

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATH = 'http://www.w3.org/1998/Math/MathML';
const XLINK = 'http://www.w3.org/1999/xlink';

class El {
  constructor(doc, localName, ns = HTML, attrs = {}) {
    this.ownerDocument = doc;
    this.localName = localName;
    this.namespaceURI = ns;
    this.nodeType = 1;
    this.children = [];
    this.parent = null;
    this.textContent = '';
    this._attrs = [];
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  get attributes() { return this._attrs.slice(); }
  setAttribute(name, value) {
    const [prefix, local] = name.includes(':') ? name.split(':') : [null, name];
    const ns = prefix === 'xlink' ? XLINK : null;
    const a = this._attrs.find((x) => x.name === name);
    if (a) a.value = String(value); else this._attrs.push({ name, localName: local, namespaceURI: ns, value: String(value) });
  }
  getAttribute(name) { return this._attrs.find((x) => x.name === name)?.value ?? null; }
  hasAttribute(name) { return this._attrs.some((x) => x.name === name); }
  removeAttributeNode(a) { this._attrs = this._attrs.filter((x) => x !== a); }
  append(...kids) { for (const k of kids) { k.remove?.(); k.parent = this; this.children.push(k); } return this; }
  prepend(...kids) { for (const k of kids.reverse()) { k.remove?.(); k.parent = this; this.children.unshift(k); } }
  insertBefore(k, ref) { k.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(k); else this.children.splice(i, 0, k); return k; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
}

/** Selectors used by the sanitiser: '*', 'tag', 'tag[attr]', comma lists. */
function matches(el, sel) {
  return sel.split(',').map((s) => s.trim()).some((s) => {
    if (s === '*') return true;
    const m = /^([a-z]+)(?:\[([a-z-]+)\])?$/.exec(s);
    return !!m && el.localName === m[1] && (!m[2] || el.hasAttribute(m[2]));
  });
}

function fakeDoc(build) {
  const doc = {};
  const html = new El(doc, 'html');
  const head = new El(doc, 'head');
  const body = new El(doc, 'body');
  html.append(head, body);
  Object.assign(doc, {
    documentElement: html, head, body,
    createElement: (n) => new El(doc, n),
    querySelectorAll: (sel) => [...html.walk()].filter((e) => matches(e, sel)),
  });
  build({ doc, head, body, el: (n, attrs, ns) => new El(doc, n, ns, attrs) });
  return doc;
}

describe('sanitizePreviewDocument', () => {
  test('strips every navigation vector, removes base / meta / hints / frames, keeps what renders', () => {
    const doc = fakeDoc(({ head, body, el }) => {
      head.append(
        el('base', { href: 'https://evil.example/' }),
        el('meta', { 'http-equiv': 'refresh', content: '0;url=https://evil.example' }),
        el('meta', { 'http-equiv': 'Content-Security-Policy', content: 'default-src *' }),
        el('meta', { charset: 'utf-8' }),
        ...HINT_RELS.map((rel) => el('link', { rel, href: `https://${rel}.example/` })),
        el('link', { rel: 'Preload stylesheet', href: 'https://mixed.example/x' }),
        el('link', { rel: 'stylesheet', href: 'https://fonts.example/a.css' }),
      );
      const svg = el('svg', {}, SVG);
      svg.append(el('a', { href: 'https://svg.example/', 'xlink:href': 'https://xlink.example/' }, SVG),
        el('use', { href: '#icon' }, SVG), el('image', { href: 'https://img.example/i.png' }, SVG));
      const form = el('form', { action: 'https://form.example/', method: 'post' });
      form.append(el('button', { formaction: 'https://btn.example/' }), el('input', { type: 'submit', formaction: 'https://inp.example/' }));
      body.append(
        el('a', { href: 'https://click.example/?utm=1', ping: 'https://ping.example/', target: '_self', title: 'Buy' }),
        el('area', { href: 'https://area.example/', target: '_top' }),
        svg,
        el('math', { href: 'https://math.example/' }, MATH),
        form,
        el('iframe', { src: 'https://frame.example/' }), el('object', { data: 'x.swf' }), el('embed', { src: 'x.swf' }),
        el('portal', { src: 'https://portal.example/' }), el('script', { src: 'https://js.example/a.js' }),
        el('img', { src: 'https://img.example/p.gif', srcset: 'https://img.example/p2.gif 2x' }),
        el('div', { target: '_blank' }),
      );
    });
    sanitizePreviewDocument(doc, { csp: "default-src 'none'" });
    const all = [...doc.documentElement.walk()];
    const names = all.map((e) => e.localName);
    for (const gone of ['base', 'iframe', 'object', 'embed', 'portal', 'script']) assert.ok(!names.includes(gone), gone);
    const metas = all.filter((e) => e.localName === 'meta');
    assert.deepEqual(metas.filter((m) => m.hasAttribute('http-equiv')).map((m) => m.getAttribute('content')), ["default-src 'none'"], 'only our CSP');
    assert.ok(metas.some((m) => m.hasAttribute('charset')));
    const links = all.filter((e) => e.localName === 'link');
    assert.deepEqual(links.map((l) => l.getAttribute('href')), ['https://fonts.example/a.css'], 'hints gone, stylesheet kept (CSP decides)');
    const navAttrs = ['href', 'xlink:href', 'action', 'formaction', 'ping', 'target'];
    for (const e of all) {
      if (['link', 'use', 'image'].includes(e.localName)) continue;
      for (const a of navAttrs) assert.equal(e.hasAttribute(a), false, `${e.localName}[${a}]`);
    }
    const a = all.find((e) => e.localName === 'a' && e.namespaceURI === HTML);
    assert.equal(a.getAttribute('title'), 'Buy', 'other attributes stay');
    assert.equal(all.find((e) => e.localName === 'use').getAttribute('href'), '#icon', 'svg <use> keeps its reference');
    assert.equal(all.find((e) => e.localName === 'image').getAttribute('href'), 'https://img.example/i.png', 'svg <image> is an image (CSP img-src)');
    assert.equal(all.find((e) => e.localName === 'img').getAttribute('src'), 'https://img.example/p.gif');
    assert.equal(all.find((e) => e.localName === 'form').getAttribute('method'), 'post');
    // Head order: our CSP first, then referrer, then the inert-links style.
    const [c0, c1, c2] = doc.head.children;
    assert.deepEqual([c0.getAttribute('http-equiv'), c1.getAttribute('name'), c2.localName], ['Content-Security-Policy', 'referrer', 'style']);
    assert.equal(c1.getAttribute('content'), 'no-referrer');
    assert.equal(c2.textContent, INERT_LINKS_CSS);
    assert.match(INERT_LINKS_CSS, /a,area\{pointer-events:none !important/);
  });

  test('isNavigationAttribute / isHintLink', () => {
    const doc = {};
    const at = (name) => ({ name, localName: name.split(':').pop() });
    assert.equal(isNavigationAttribute(new El(doc, 'a'), at('href')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'link'), at('href')), false);
    assert.equal(isNavigationAttribute(new El(doc, 'a', SVG), at('xlink:href')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'use', SVG), at('href')), false);
    assert.equal(isNavigationAttribute(new El(doc, 'mi', MATH), at('href')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'form'), at('action')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'div'), at('action')), false);
    assert.equal(isNavigationAttribute(new El(doc, 'button'), at('formaction')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'img'), at('ping')), true);
    assert.equal(isNavigationAttribute(new El(doc, 'img'), at('src')), false);
    assert.equal(isHintLink(new El(doc, 'link', HTML, { rel: 'DNS-Prefetch' })), true);
    assert.equal(isHintLink(new El(doc, 'link', HTML, { rel: 'icon' })), false);
    assert.equal(isHintLink(new El(doc, 'a', HTML, { rel: 'preconnect' })), false);
  });
});

describe('guardFrameDocument (live preview)', () => {
  function fakeFrameDoc() {
    const listeners = {};
    return {
      baseURI: 'https://app.iterable.com/templates/showHtml?x=1',
      addEventListener: (type, fn, capture) => { assert.equal(capture, true); (listeners[type] ||= []).push(fn); },
      fire(type, props) {
        const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props };
        for (const fn of listeners[type] || []) fn(e);
        return e;
      },
    };
  }
  const link = (href) => { const a = { getAttribute: (n) => (n === 'href' ? href : null) }; return { closest: () => a }; };
  const plain = { closest: () => null };

  test('link activation never navigates; only a trusted click is offered to the person', () => {
    const doc = fakeFrameDoc();
    const offered = [];
    assert.equal(guardFrameDocument(doc, { onLink: (u, base) => offered.push([u, base]) }), true);
    assert.equal(guardFrameDocument(doc, { onLink: () => {} }), false, 'once per document');
    assert.equal(doc.fire('click', { target: link('https://t.example/c'), isTrusted: true }).defaultPrevented, true);
    assert.equal(doc.fire('click', { target: link('https://t.example/forged'), isTrusted: false }).defaultPrevented, true);
    assert.equal(doc.fire('auxclick', { target: link('https://t.example/mid'), isTrusted: true }).defaultPrevented, true);
    assert.equal(doc.fire('submit', { target: plain, isTrusted: true }).defaultPrevented, true);
    assert.equal(doc.fire('click', { target: plain, isTrusted: true }).defaultPrevented, false, 'other clicks untouched');
    assert.deepEqual(offered, [['https://t.example/c', 'https://app.iterable.com/templates/showHtml?x=1']]);
  });
});

// ── Capture guard (pure parts) ───────────────────────────────────────────────

describe('capture guard', () => {
  test('gridPoints: 5×5 over the viewport, corners / edges / centre, inside the edges', () => {
    const pts = gridPoints(1000, 800);
    assert.equal(pts.length, 25);
    const has = (x, y) => pts.some((p) => p.x === x && p.y === y);
    assert.ok(has(2, 2) && has(997, 2) && has(2, 797) && has(997, 797), 'corners');
    assert.ok(has(500, 400), 'centre');
    assert.ok(has(500, 2) && has(2, 400) && has(997, 400) && has(500, 797), 'edge midpoints');
    for (const p of pts) assert.ok(p.x >= 0 && p.x < 1000 && p.y >= 0 && p.y < 800);
    assert.equal(gridPoints(1, 1).length, 25);
    assert.ok(gridPoints(1, 1).every((p) => p.x === 0 && p.y === 0));
  });

  test('ancestorStyleProblem: anything that could hide or distort the overlay', () => {
    const neutral = { opacity: '1', filter: 'none', mixBlendMode: 'normal', clipPath: 'none', maskImage: 'none', transform: 'none', zoom: '1', contentVisibility: 'visible', display: 'block' };
    assert.equal(ancestorStyleProblem(neutral), null);
    assert.equal(ancestorStyleProblem({ ...neutral, zoom: 'normal', webkitMaskImage: 'none' }), null);
    for (const [k, v] of [['opacity', '0'], ['opacity', '0.99'], ['filter', 'opacity(0)'], ['mixBlendMode', 'multiply'],
      ['clipPath', 'inset(50%)'], ['maskImage', 'linear-gradient(red, red)'], ['webkitMaskImage', 'url(x.png)'],
      ['transform', 'matrix(0.1, 0, 0, 0.1, 0, 0)'], ['zoom', '0.5'], ['contentVisibility', 'hidden'], ['display', 'none']]) {
      assert.ok(ancestorStyleProblem({ ...neutral, [k]: v }), `${k}: ${v}`);
    }
    assert.ok(ancestorStyleProblem(null));
  });

  test('zIndexThreat: integer z-index at or above ours; auto never', () => {
    const OUR = 2147483100;
    assert.equal(zIndexThreat('2147483100', OUR), true);
    assert.equal(zIndexThreat('2147483647', OUR), true);
    assert.equal(zIndexThreat('2147483099', OUR), false);
    assert.equal(zIndexThreat('auto', OUR), false);
    assert.equal(zIndexThreat('', OUR), false);
    assert.equal(zIndexThreat(' 2147483647 ', OUR), true);
    assert.equal(zIndexThreat('-5', OUR), false);
  });

  test('topHit: <html> / <body> ahead of our overlay (overlay scrollbars) are skipped, nothing else', () => {
    const html = { n: 'html' }, body = { n: 'body' }, ours = { n: 'ours' }, frame = { n: 'iframe' };
    const doc = { documentElement: html, body };
    assert.equal(topHit([html, ours, body], doc), ours);
    assert.equal(topHit([body, ours], doc), ours);
    assert.equal(topHit([frame, ours, html], doc), frame);
    assert.equal(topHit([html, frame, ours], doc), frame);
    assert.equal(topHit([html], doc), html, 'nothing but the root: not ours');
    assert.equal(topHit([], doc), null);
  });

  test('firstUncovered / sameHits / animatesZIndex', () => {
    const ours = { ours: true };
    const page = { ours: false };
    const isOurs = (e) => e.ours;
    assert.equal(firstUncovered([ours, ours], isOurs), -1);
    assert.equal(firstUncovered([ours, page, ours], isOurs), 1);
    assert.equal(firstUncovered([ours, null], isOurs), 1);
    assert.equal(sameHits([ours, ours], [ours, ours]), true);
    assert.equal(sameHits([ours, ours], [ours, page]), false);
    assert.equal(sameHits([ours], [ours, ours]), false);
    assert.equal(animatesZIndex(['opacity', 'zIndex']), true);
    assert.equal(animatesZIndex(['z-index']), true);
    assert.equal(animatesZIndex(['all']), true);
    assert.equal(animatesZIndex(['transform', 'offset']), false);
    assert.match(COVERED_MESSAGE, /covering the approval view — screenshot not taken/);
  });
});

// ── Capture page messages ────────────────────────────────────────────────────

describe('capture page message validation', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const app = { tab: { id: 3, windowId: 1 }, frameId: 0 };
  const EXT = 'chrome-extension://abc/capture.html';

  test('policy: open from our pages and app content scripts only; take from our pages only', () => {
    assert.equal(senderAllowed('wb:capture:open', 'app'), true);
    assert.equal(senderAllowed('wb:capture:open', 'extension'), true);
    assert.equal(senderAllowed('wb:capture:open', 'bee'), false);
    assert.equal(senderAllowed('wb:capture:open', 'auth'), false);
    assert.equal(senderAllowed('wb:capture:take', 'extension'), true);
    for (const k of ['app', 'bee', 'auth', null]) assert.equal(senderAllowed('wb:capture:take', k), false);
  });

  test('checkCaptureOpen', () => {
    assert.deepEqual(checkCaptureOpen({ type: 't', dataUrl: PNG, name: 'approval-1-view.png' }, app, 'app'),
      { ok: true, dataUrl: PNG, name: 'approval-1-view.png', openerTabId: 3 });
    assert.deepEqual(checkCaptureOpen({ type: 't', dataUrl: PNG }, {}, 'extension'), { ok: true, dataUrl: PNG, name: DEFAULT_CAPTURE_NAME });
    const bad = (msg, sender = app, kind = 'app') => assert.equal(checkCaptureOpen(msg, sender, kind).ok, false, JSON.stringify(msg).slice(0, 60));
    bad({ type: 't', dataUrl: PNG }, app, 'bee');
    bad({ type: 't', dataUrl: PNG }, { ...app, frameId: 2 });
    bad({ type: 't', dataUrl: PNG }, { frameId: 0 });
    bad({ type: 't', dataUrl: PNG, url: 'x' });
    bad({ type: 't', dataUrl: 'data:image/jpeg;base64,AAAA' });
    bad({ type: 't', dataUrl: 'data:image/png;base64,AA AA' });
    bad({ type: 't', dataUrl: 'data:image/png;base64,' });
    bad({ type: 't', dataUrl: 'data:image/png;base64,' + 'A'.repeat(CAPTURE_OPEN_MAX_CHARS) });
    bad(null);
  });

  test('captureFileName keeps plain .png names only', () => {
    assert.equal(captureFileName('approval-4412871-card.png'), 'approval-4412871-card.png');
    for (const n of ['../x.png', 'a/b.png', 'x.exe', '.png', 'x..png', '', null, 'a'.repeat(120) + '.png', 'x.png\n']) {
      assert.equal(captureFileName(n), DEFAULT_CAPTURE_NAME, String(n));
    }
  });

  test('checkCaptureTake', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.deepEqual(checkCaptureTake({ type: 't', id }, { url: EXT + '#' + id }, 'extension', EXT), { ok: true, id });
    assert.equal(checkCaptureTake({ type: 't', id }, { url: EXT }, 'extension', EXT).ok, true);
    assert.equal(checkCaptureTake({ type: 't', id }, { url: 'chrome-extension://abc/popup.html' }, 'extension', EXT).ok, false);
    assert.equal(checkCaptureTake({ type: 't', id }, { url: EXT }, 'app', EXT).ok, false);
    assert.equal(checkCaptureTake({ type: 't', id: 'x' }, { url: EXT }, 'extension', EXT).ok, false);
    assert.equal(checkCaptureTake({ type: 't', id, more: 1 }, { url: EXT }, 'extension', EXT).ok, false);
    assert.equal(checkCaptureTake({ type: 't', id }, { url: EXT }, 'extension', '').ok, false);
  });
});
