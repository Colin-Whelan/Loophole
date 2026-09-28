// ui/shadow.js: overlay hosts must get their stacking from the shadow root's :host rule, not
// from inline styles (which `:host{all:initial !important}` overrides). Real-browser proof of
// the cascade lives in the live checklist; this pins the generated CSS and the mount wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// theme.css is an esbuild text import; give node an empty stand-in.
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default "/*theme*/";', shortCircuit: true };
  return next(url, context);
}`));

const { mountOverlay, mountInline, overlayHostCss, LAYERS } = await import('../src/ui/shadow.js');

function fakeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: {},
    classList: { add() {} },
    style: { setProperty() { throw new Error('host must not get inline styles'); } },
    setAttribute(k, v) { el.attrs[k] = v; },
    append(...c) { el.children.push(...c); },
    remove() { el.removed = true; },
    attachShadow() { el.shadowRoot = fakeEl('#shadow'); return el.shadowRoot; },
    before(n) { el.placed = ['before', n]; },
  };
  return el;
}

function withDocument(t) {
  const prev = globalThis.document;
  const body = fakeEl('body');
  globalThis.document = { body, documentElement: body, createElement: fakeEl };
  t.after(() => { globalThis.document = prev; });
  return body;
}

const decls = (css) => {
  const m = /^:host\{(.*)\}$/.exec(css);
  assert.ok(m, css);
  return m[1].split(';').map((d) => d.trim()).filter(Boolean);
};

test('overlay :host rule: all:initial first, then fixed 0×0 positioning and the layer z-index', () => {
  for (const [layer, z] of Object.entries(LAYERS)) {
    const d = decls(overlayHostCss(z));
    assert.equal(d[0], 'all:initial !important', layer);
    for (const want of ['display:block', 'position:fixed', 'top:0', 'left:0', 'width:0', 'height:0',
      'overflow:visible', `z-index:${z}`]) {
      const i = d.indexOf(want + ' !important');
      assert.ok(i > 0, `${layer}: ${want} missing or before all:initial`);
    }
  }
});

test('layers stack float < drawer < modal < toast', () => {
  assert.ok(LAYERS.float < LAYERS.drawer && LAYERS.drawer < LAYERS.modal && LAYERS.modal < LAYERS.toast);
});

test('mountOverlay puts the positioning in the shadow style, never on the host', (t) => {
  const body = withDocument(t);
  const m = mountOverlay('drawer');
  assert.equal(body.children[0], m.host);
  assert.equal(m.host.tagName, 'WB-HOST');
  const style = m.root.children[0];
  assert.ok(style.textContent.startsWith(overlayHostCss(LAYERS.drawer) + '\n'), style.textContent.slice(0, 200));
  m.destroy();
  assert.equal(m.host.removed, true);
  assert.throws(() => mountOverlay('nope'), /unknown layer/);
});

test('mountInline keeps display:contents in the :host rule', (t) => {
  withDocument(t);
  const target = fakeEl('div');
  const m = mountInline(target, 'before');
  assert.equal(target.placed[1], m.host);
  assert.deepEqual(decls(m.root.children[0].textContent.split('\n')[0]),
    ['all:initial !important', 'display:contents !important']);
});
