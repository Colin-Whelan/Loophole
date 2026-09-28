// core/dom.js pieces that don't need a real DOM: the safe append family and linkSignal.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {}
globalThis.Node ??= FakeNode;
const NodeCls = globalThis.Node;

const { append, prepend, replaceChildren, childNodes, linkSignal, linkSignalFallback } = await import('../src/core/dom.js');

function fakeEl() {
  const el = Object.create(NodeCls.prototype);
  el.kids = [];
  el.append = (...c) => { el.kids.push(...c); };
  el.prepend = (...c) => { el.kids.unshift(...c); };
  el.replaceChildren = (...c) => { el.kids = [...c]; };
  return el;
}

test('childNodes flattens arrays and skips null / undefined / booleans', () => {
  const a = fakeEl(), b = fakeEl();
  assert.deepEqual(childNodes([null, a, [b, [false, 'x', 3]], undefined, true, 0, '']), [a, b, 'x', '3', '0', '']);
});

test('append / prepend / replaceChildren never print null or [object …]', () => {
  const el = fakeEl();
  const n = fakeEl();
  assert.equal(append(el, null, [n, false], 'a'), el);
  assert.deepEqual(el.kids, [n, 'a']);
  prepend(el, undefined, ['b']);
  assert.deepEqual(el.kids, ['b', n, 'a']);
  replaceChildren(el, [null, 'c']);
  assert.deepEqual(el.kids, ['c']);
  replaceChildren(el);
  assert.deepEqual(el.kids, []);
});

for (const [name, link] of [['AbortSignal.any', (...s) => linkSignal(...s)], ['fallback (Chrome 111–115)', (...s) => linkSignalFallback(s.flat().filter(Boolean))]]) {
  test(`linkSignal via ${name}: aborts when any input aborts, with its reason`, () => {
    const a = new AbortController(), b = new AbortController();
    const s = link(a.signal, b.signal);
    assert.equal(s.aborted, false);
    b.abort('stop');
    assert.equal(s.aborted, true);
    assert.equal(s.reason, 'stop');
    a.abort('late');
    assert.equal(s.reason, 'stop');
  });

  test(`linkSignal via ${name}: already-aborted input → aborted result`, () => {
    const a = new AbortController();
    a.abort('gone');
    const s = link(a.signal, new AbortController().signal);
    assert.equal(s.aborted, true);
    assert.equal(s.reason, 'gone');
  });
}

test('linkSignal: one signal is returned as is; falsy entries ignored', () => {
  const a = new AbortController();
  assert.equal(linkSignal(a.signal, null, undefined), a.signal);
});
