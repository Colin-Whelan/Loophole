import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataFieldsForRow, findJsonRootForRow, isCustomEvent, isHistoryPath, parseJsonRoot, SELECTORS,
} from '../../src/features/event-copy/parse.js';
import meta from '../../src/features/event-copy/meta.js';

// ── A minimal DOM: just enough of Element for parse.js ─────────────────────
// Markup parser (tags, quoted attributes, text) and a selector engine for compound selectors
// (tag, *, .class, [attr], [attr="v"], [attr$="v"], [attr^="v"], :scope) joined by descendant
// or child combinators, in comma lists.

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
  }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get textContent() { return this.childNodes.map((n) => (n instanceof El ? n.textContent : n)).join(''); }
  get classList() {
    const set = new Set((this.attrs.class || '').split(/\s+/).filter(Boolean));
    return { contains: (c) => set.has(c) };
  }
  getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
  get nextElementSibling() {
    const sibs = this.parentElement?.children || [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  *descendants() {
    for (const c of this.children) { yield c; yield* c.descendants(); }
  }
  matches(sel, scope = null) { return parseSelector(sel).some((cx) => matchComplex(this, cx, cx.length - 1, scope)); }
  querySelectorAll(sel) {
    const list = parseSelector(sel);
    return [...this.descendants()].filter((el) => list.some((cx) => matchComplex(el, cx, cx.length - 1, this)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function parseSelector(sel) {
  return sel.split(',').map((part) => {
    const out = [];
    let comb = null;
    for (const m of part.trim().matchAll(/\s*(>)\s*|\s+|([^\s>]+)/g)) {
      if (m[1]) comb = '>';
      else if (m[2]) { out.push({ comb: out.length ? (comb || ' ') : null, cmp: parseCompound(m[2]) }); comb = null; }
    }
    return out;
  });
}

function parseCompound(s) {
  const cmp = { tag: null, classes: [], attrs: [], scope: false };
  let rest = s.replace(/^(\*|[a-zA-Z][\w-]*)/, (t) => { if (t !== '*') cmp.tag = t.toUpperCase(); return ''; });
  while (rest) {
    let m;
    if ((m = rest.match(/^\.([\w-]+)/))) cmp.classes.push(m[1]);
    else if ((m = rest.match(/^\[([\w-]+)(?:([$^]?=)"([^"]*)")?\]/))) cmp.attrs.push({ name: m[1], op: m[2], value: m[3] });
    else if ((m = rest.match(/^:scope/))) cmp.scope = true;
    else throw new Error(`test DOM: unsupported selector "${s}"`);
    rest = rest.slice(m[0].length);
  }
  return cmp;
}

function matchCompound(el, cmp, scope) {
  if (cmp.scope && el !== scope) return false;
  if (cmp.tag && el.tagName !== cmp.tag) return false;
  if (!cmp.classes.every((c) => el.classList.contains(c))) return false;
  return cmp.attrs.every(({ name, op, value }) => {
    const v = el.getAttribute(name);
    if (v === null) return false;
    if (!op) return true;
    if (op === '=') return v === value;
    if (op === '$=') return v.endsWith(value);
    return v.startsWith(value);
  });
}

function matchComplex(el, cx, i, scope) {
  if (!el || !matchCompound(el, cx[i].cmp, scope)) return false;
  if (i === 0) return true;
  if (cx[i].comb === '>') return matchComplex(el.parentElement, cx, i - 1, scope);
  for (let a = el.parentElement; a; a = a.parentElement) if (matchComplex(a, cx, i - 1, scope)) return true;
  return false;
}

/** Parse markup into a detached <body> El. */
function html(markup) {
  const body = new El('body');
  const stack = [body];
  for (const m of markup.matchAll(/<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[1]) { stack.pop(); continue; }
    if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
      const el = new El(m[2], attrs);
      el.parentElement = top;
      top.childNodes.push(el);
      if (!m[4]) stack.push(el);
      continue;
    }
    if (m[5].trim()) top.childNodes.push(m[5].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  }
  return body;
}

// ── Fixture builders, shaped like Iterable's rendered JSON tree ────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const key = (k) => (k == null ? ''
  : `<span class="json-property-key"><span data-test="key-unmatched">${esc(k)}</span>: </span>`);
const leaf = (k, type, text) => `<div data-test="json-leaf-raw" class="json-leaf-raw"><div class="json-leaf">${key(k)}`
  + `<span class="json-property-value json-property-${type}"><span data-test="value-unmatched">${esc(text)}</span></span></div></div>`;
const branch = (k, type, rows) => `<div data-test="json-branch-raw" class="json-branch-raw"><div class="json-leaf">${key(k)}`
  + `<span class="json-property-value json-property-${type}">${type === 'array' ? '[' : '{'}</span></div>`
  + (rows == null ? '' : `<div data-test="json-branch-value"><div><div>${rows.join('')}</div></div></div>`)
  + `<div class="json-property">${type === 'array' ? ']' : '}'}</div></div>`;
const root = (rows) => `<div data-test="json-root-raw"><span>{</span>${rows.join('')}<span>}</span></div>`;
const parse = (rows) => parseJsonRoot(html(root(rows)).querySelector(SELECTORS.jsonRoot));

// ── Parser ─────────────────────────────────────────────────────────────────

test('scalars keep their types', () => {
  assert.deepEqual(parse([
    leaf('name', 'string', 'Maya'),
    leaf('zip', 'string', '00123'),
    leaf('flag', 'string', 'true'),
    leaf('items', 'number', '3'),
    leaf('total', 'number', '142.5'),
    leaf('delta', 'number', '-7'),
    leaf('big', 'number', '1e21'),
    leaf('yes', 'boolean', 'true'),
    leaf('no', 'boolean', 'false'),
    leaf('none', 'null', 'null'),
    leaf('odd', 'mystery', 'as text'),
    leaf('empty', 'string', ''),
  ]), {
    name: 'Maya', zip: '00123', flag: 'true', items: 3, total: 142.5, delta: -7, big: 1e21,
    yes: true, no: false, none: null, odd: 'as text', empty: '',
  });
});

test('nested objects and arrays', () => {
  assert.deepEqual(parse([
    leaf('eventName', 'string', 'cartAbandoned'),
    branch('dataFields', 'object', [
      leaf('cartId', 'string', 'c_1'),
      branch('items', 'array', [
        branch(null, 'object', [leaf('sku', 'string', 'A-1'), leaf('qty', 'number', '2')]),
        branch(null, 'object', [leaf('sku', 'string', 'B-2'), leaf('qty', 'number', '1')]),
      ]),
      branch('tags', 'array', [leaf(null, 'string', 'x'), leaf(null, 'number', '4'), leaf(null, 'null', 'null')]),
      branch('matrix', 'array', [branch(null, 'array', [leaf(null, 'number', '1')]), branch(null, 'array', [])]),
      branch('meta', 'object', [branch('deep', 'object', [leaf('ok', 'boolean', 'true')])]),
    ]),
  ]), {
    eventName: 'cartAbandoned',
    dataFields: {
      cartId: 'c_1',
      items: [{ sku: 'A-1', qty: 2 }, { sku: 'B-2', qty: 1 }],
      tags: ['x', 4, null],
      matrix: [[1], []],
      meta: { deep: { ok: true } },
    },
  });
});

test('array rows with index keys still push in order', () => {
  assert.deepEqual(parse([branch('list', 'array', [leaf('0', 'string', 'a'), leaf('1', 'string', 'b')])]),
    { list: ['a', 'b'] });
});

test('branches without a value block become empty containers of their type', () => {
  assert.deepEqual(parse([branch('o', 'object', null), branch('a', 'array', null)]), { o: {}, a: [] });
});

test('value block without the two wrapper divs is used directly (when nothing matches div > div)', () => {
  // As in the userscript, the fallback only applies when the block has no div > div at all: with
  // `leaf()` rows (which nest div.json-leaf) the row's head would be taken as the list instead.
  const flatLeaf = '<div data-test="json-leaf-raw">' + key('x')
    + '<span class="json-property-value json-property-number">1</span></div>';
  const markup = root([
    `<div data-test="json-branch-raw"><div class="json-leaf">${key('d')}<span class="json-property-value json-property-object">{</span></div>`
    + `<div data-test="json-branch-value">${flatLeaf}</div></div>`,
  ]);
  assert.deepEqual(parseJsonRoot(html(markup).querySelector(SELECTORS.jsonRoot)), { d: { x: 1 } });
});

test('key text: inner unmatched span, styled-component span, or the trimmed key span', () => {
  const rows = [
    `<div data-test="json-leaf-raw"><div class="json-leaf"><span class="json-property-key"><span class="sc-jWPcaf"> sc </span>: </span>`
      + '<span class="json-property-value json-property-number"><span class="sc-jWPcaf">5</span></span></div></div>',
    `<div data-test="json-leaf-raw"><div class="json-leaf"><span class="json-property-key">  plain  </span>`
      + '<span class="json-property-value json-property-string">v</span></div></div>',
    // Key span directly on the row (no .json-leaf head).
    `<div data-test="json-leaf-raw"><span class="json-property-key">flat</span>`
      + '<span class="json-property-value json-property-boolean">false</span></div>',
  ];
  assert.deepEqual(parse(rows), { sc: 5, plain: 'v', flat: false });
});

test('rows without a value span or key, and non-row children, are skipped', () => {
  assert.deepEqual(parse([
    `<div data-test="json-leaf-raw"><div class="json-leaf">${key('noValue')}</div></div>`,
    `<div data-test="json-leaf-raw"><div class="json-leaf"><span class="json-property-value json-property-string">orphan</span></div></div>`,
    '<div class="something-else">ignored</div>',
    leaf('kept', 'string', 'yes'),
  ]), { kept: 'yes' });
});

test('special characters survive', () => {
  assert.deepEqual(parse([leaf('quote', 'string', 'say "hi" & <bye>')]), { quote: 'say "hi" & <bye>' });
});

// ── Rows ───────────────────────────────────────────────────────────────────

const nameCell = (custom, label) => `<div data-test="event-history-name-cell">`
  + (custom ? '<svg data-test="icon-custom"></svg>' : '<svg data-test="icon-email"></svg>') + `<span>${label}</span></div>`;

function table() {
  return html(`<div class="grid">${nameCell(true, 'cartAbandoned')}<div>details</div>`
    + `<div class="collapse"><div>${root([leaf('eventName', 'string', 'cartAbandoned'),
      branch('dataFields', 'object', [leaf('total', 'number', '142.5'), leaf('coupon', 'null', 'null')])])}</div></div>`
    + `${nameCell(false, 'emailSend')}<div>details</div>`
    + `${nameCell(true, 'productViewed')}<div>details</div>`
    + `${root([leaf('eventName', 'string', 'productViewed')])}`
    + `${nameCell(true, 'collapsed')}<div>details</div>`
    + `${nameCell(true, 'last')}<div>details</div></div>`);
}

test('isCustomEvent looks for the custom icon', () => {
  const cells = table().querySelectorAll(SELECTORS.nameCell);
  assert.deepEqual(cells.map(isCustomEvent), [true, false, true, true, true]);
});

test('findJsonRootForRow walks forward siblings and stops at the next name cell', () => {
  const cells = table().querySelectorAll(SELECTORS.nameCell);
  assert.equal(findJsonRootForRow(cells[0])?.getAttribute('data-test'), 'json-root-raw'); // nested in a sibling
  assert.equal(findJsonRootForRow(cells[1]), null); // next row's tree isn't ours
  assert.equal(findJsonRootForRow(cells[2])?.parentElement.getAttribute('class'), 'grid'); // sibling itself
  assert.equal(findJsonRootForRow(cells[3]), null);
  assert.equal(findJsonRootForRow(cells[4]), null); // end of the list
});

test('dataFieldsForRow: prettified dataFields, or why not', () => {
  const cells = table().querySelectorAll(SELECTORS.nameCell);
  assert.deepEqual(dataFieldsForRow(cells[0]), { status: 'ok', text: '{\n  "total": 142.5,\n  "coupon": null\n}' });
  assert.deepEqual(dataFieldsForRow(cells[2]), { status: 'no-datafields' });
  assert.deepEqual(dataFieldsForRow(cells[3]), { status: 'no-json' });
});

test('dataFieldsForRow copies scalar and empty dataFields too', () => {
  const one = (rows) => dataFieldsForRow(html(`${nameCell(true, 'e')}${root(rows)}`).querySelector(SELECTORS.nameCell));
  assert.deepEqual(one([branch('dataFields', 'object', [])]), { status: 'ok', text: '{}' });
  assert.deepEqual(one([leaf('dataFields', 'null', 'null')]), { status: 'ok', text: 'null' });
});

test('isHistoryPath', () => {
  assert.equal(isHistoryPath('/users/profiles/abc/event/history'), true);
  assert.equal(isHistoryPath('/users/profiles/abc/event/history/'), true);
  assert.equal(isHistoryPath('/users/profiles/abc/fields'), false);
});

test('meta', () => {
  assert.equal(meta.id, 'event-copy');
  assert.ok(meta.routes.some((r) => r.test('/users/profiles/abc/event/history')));
  assert.deepEqual(meta.settings.map((s) => [s.key, s.type, s.default]), [['allEvents', 'boolean', false]]);
  assert.deepEqual(meta.legacy, ['Iterable Event History - Copy dataFields']);
});
