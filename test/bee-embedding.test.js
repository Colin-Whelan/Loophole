// Bee-frame embedding gate: classifyEmbedding (ancestorOrigins / referrer), the embed-hello
// handshake check (acceptEmbedHello) for the "can't tell" case, and the waiter bee.js uses.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyEmbedding, isEmbeddedByIterable, acceptEmbedHello, EMBED_HELLO, EMBED_HELLO_TIMEOUT_MS,
} = await import('../src/core/api-validation.js');
const { waitForEmbedHello, sendEmbedHello } = await import('../src/content/embed-handshake.js');

const IT = 'https://app.iterable.com';
const EU = 'https://app.eu.iterable.com';
const BEE = 'https://app.getbee.io';
const EVIL = 'https://evil.example';

const cls = (ancestorOrigins, referrer = '', isTop = false) => classifyEmbedding({ ancestorOrigins, referrer, isTop });

describe('classifyEmbedding', () => {
  test('Chrome, normal editor iframe: ancestorOrigins names the Iterable top', () => {
    assert.equal(cls([IT], `${IT}/templates/editor?templateId=1`), 'iterable');
    assert.equal(cls([EU]), 'iterable');
    assert.equal(cls([BEE, IT]), 'iterable', 'nested bee frame under an Iterable top');
  });

  test('Firefox, no-referrer iframe: "null" ancestor and empty referrer -> unknown', () => {
    assert.equal(cls(['null'], ''), 'unknown');
    assert.equal(cls(['null', 'null']), 'unknown');
    assert.equal(cls([BEE, 'null']), 'unknown');
    assert.equal(cls(['null', IT]), 'unknown', 'opaque hop under an Iterable top');
    assert.equal(cls([''], ''), 'unknown');
    assert.equal(isEmbeddedByIterable({ ancestorOrigins: ['null'], referrer: '', isTop: false }), false, 'unknown never counts as embedded');
  });

  test('a referrer never upgrades opaque ancestors to iterable, but a foreign one rules them out', () => {
    assert.equal(cls(['null'], `${IT}/templates`), 'unknown');
    assert.equal(cls(['null'], `${BEE}/editor`), 'unknown', 'the frame navigated itself');
    assert.equal(cls(['null'], `${EVIL}/page`), 'other');
  });

  test('a definite non-Iterable ancestor -> other (refuse immediately)', () => {
    assert.equal(cls([EVIL]), 'other');
    assert.equal(cls([EVIL], `${IT}/`), 'other', 'the referrer cannot override a foreign ancestor');
    assert.equal(cls([IT, EVIL]), 'other', 'Iterable framed by another site');
    assert.equal(cls([EVIL, IT]), 'other');
    assert.equal(cls(['null', EVIL]), 'other', 'opaque parent, foreign top');
    assert.equal(cls([EVIL, 'null']), 'other', 'foreign parent, opaque top');
    assert.equal(cls([BEE]), 'other', 'top-most ancestor is app.getbee.io itself');
    assert.equal(cls(['null', BEE]), 'other');
    assert.equal(cls(['https://app.iterable.com.evil.example']), 'other');
    assert.equal(cls(['http://app.iterable.com']), 'other', 'scheme matters');
  });

  test('a top-level getbee page -> other, whatever else is claimed', () => {
    assert.equal(cls(null, '', true), 'other');
    assert.equal(cls([IT], `${IT}/`, true), 'other');
    assert.equal(cls(['null'], '', true), 'other');
    assert.equal(classifyEmbedding({ ancestorOrigins: [IT], referrer: '', isTop: undefined }), 'other', 'isTop must be exactly false');
  });

  test('no ancestorOrigins (older Firefox): referrer decides, empty -> unknown', () => {
    assert.equal(cls(null, `${IT}/templates/editor?id=1`), 'iterable');
    assert.equal(cls(null, `${EU}/`), 'iterable');
    assert.equal(cls([], `${IT}/`), 'iterable', 'an empty list is treated as no list');
    assert.equal(cls(null, ''), 'unknown');
    assert.equal(cls([], ''), 'unknown');
    assert.equal(cls(null, undefined), 'unknown');
    assert.equal(cls(null, 'not a url'), 'unknown');
    assert.equal(cls(null, `${BEE}/`), 'unknown');
    assert.equal(cls(null, `${EVIL}/?${IT}`), 'other');
    assert.equal(cls(null, 'https://app.iterable.com.evil.example/'), 'other');
  });
});

describe('acceptEmbedHello', () => {
  const self = { name: 'bee frame' };
  const parent = { name: 'iterable top' };
  const other = { name: 'some other window' };
  const ok = (over = {}) => acceptEmbedHello({ data: { ...EMBED_HELLO }, origin: IT, source: parent, self, parent, top: parent, ...over });

  test('right origin, source is the parent and the top -> accept', () => {
    assert.equal(ok(), true);
    assert.equal(ok({ origin: EU }), true);
  });

  test('wrong origin -> reject', () => {
    assert.equal(ok({ origin: EVIL }), false);
    assert.equal(ok({ origin: BEE }), false, 'a getbee sibling/child cannot vouch');
    assert.equal(ok({ origin: 'null' }), false);
    assert.equal(ok({ origin: '' }), false);
    assert.equal(ok({ origin: 'http://app.iterable.com' }), false);
    assert.equal(ok({ origin: `${IT}/` }), false, 'exact origin string only');
    assert.equal(ok({ origin: undefined }), false);
  });

  test('wrong source -> reject', () => {
    assert.equal(ok({ source: other }), false, 'e.g. a popup or sibling that is an Iterable page');
    assert.equal(ok({ source: null }), false);
    assert.equal(ok({ source: self }), false);
    assert.equal(ok({ source: self, parent: self, top: self }), false, 'a top-level window is its own parent');
    assert.equal(ok({ parent: null, source: null }), false);
  });

  test('parent must be the top page (an Iterable page framed by another site cannot vouch)', () => {
    assert.equal(ok({ top: other }), false);
  });

  test('wrong payload -> reject', () => {
    assert.equal(ok({ data: null }), false);
    assert.equal(ok({ data: 'embed-hello' }), false);
    assert.equal(ok({ data: { wb: 'embed-hello', v: 2 } }), false);
    assert.equal(ok({ data: { wb: 'other', v: 1 } }), false);
    assert.equal(ok({ data: { v: 1 } }), false);
  });
});

describe('waitForEmbedHello', () => {
  function fakeWin() {
    const listeners = new Set();
    const top = { name: 'top' };
    return {
      parent: top,
      top,
      addEventListener(type, fn) { assert.equal(type, 'message'); listeners.add(fn); },
      removeEventListener(type, fn) { assert.equal(type, 'message'); listeners.delete(fn); },
      dispatch(event) { for (const fn of [...listeners]) fn(event); },
      get listenerCount() { return listeners.size; },
    };
  }

  test('accepts the first valid hello, then removes its listener', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const win = fakeWin();
    const onAccept = mock.fn();
    const onTimeout = mock.fn();
    waitForEmbedHello({ win, onAccept, onTimeout });
    assert.equal(win.listenerCount, 1);
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: EVIL, source: win.parent });
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: IT, source: { name: 'popup' } });
    assert.equal(onAccept.mock.callCount(), 0);
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: IT, source: win.parent });
    assert.equal(onAccept.mock.callCount(), 1);
    assert.deepEqual(onAccept.mock.calls[0].arguments, [IT]);
    assert.equal(win.listenerCount, 0);
    t.mock.timers.tick(EMBED_HELLO_TIMEOUT_MS * 2);
    assert.equal(onTimeout.mock.callCount(), 0, 'the timeout was cleared');
  });

  test('times out after 10 s without starting, and removes its listener', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(EMBED_HELLO_TIMEOUT_MS, 10_000);
    const win = fakeWin();
    const onAccept = mock.fn();
    const onTimeout = mock.fn();
    waitForEmbedHello({ win, onAccept, onTimeout });
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: EVIL, source: win.parent });
    t.mock.timers.tick(EMBED_HELLO_TIMEOUT_MS - 1);
    assert.equal(onTimeout.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(onTimeout.mock.callCount(), 1);
    assert.equal(win.listenerCount, 0);
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: IT, source: win.parent });
    assert.equal(onAccept.mock.callCount(), 0, 'a late hello never starts it');
  });

  test('a page-dispatched (synthetic, isTrusted false) hello never counts, whatever it claims', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const win = fakeWin();
    const onAccept = mock.fn();
    waitForEmbedHello({ win, onAccept, onTimeout() {} });
    win.dispatch({ isTrusted: false, data: { ...EMBED_HELLO }, origin: IT, source: win.parent });
    win.dispatch({ data: { ...EMBED_HELLO }, origin: IT, source: win.parent }); // no isTrusted at all
    assert.equal(onAccept.mock.callCount(), 0);
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: IT, source: win.parent });
    assert.equal(onAccept.mock.callCount(), 1);
  });

  test('a window whose parent/top throws on access never accepts', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const win = fakeWin();
    const src = win.parent;
    Object.defineProperty(win, 'parent', { get() { throw new Error('SecurityError'); } });
    const onAccept = mock.fn();
    waitForEmbedHello({ win, onAccept, onTimeout() {} });
    win.dispatch({ isTrusted: true, data: { ...EMBED_HELLO }, origin: IT, source: src });
    assert.equal(onAccept.mock.callCount(), 0);
  });
});

describe('sendEmbedHello (top side)', () => {
  const PAGE = `${IT}/templates/editor?templateId=1`;
  /** A fake <iframe>. `sameOrigin`: its location.href is readable (about:blank, still ours). */
  function fakeFrame({ src = `${BEE}/editor`, sameOrigin = false, detached = false } = {}) {
    const posted = [];
    const win = {
      location: {
        get href() {
          if (!sameOrigin) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
          return 'about:blank';
        },
      },
      postMessage(data, targetOrigin) { posted.push({ data, targetOrigin }); },
    };
    return { frame: { src, contentWindow: detached ? null : win }, posted };
  }

  test('posts once the frame is cross-origin, to exactly the BEE origin', () => {
    const { frame, posted } = fakeFrame();
    assert.equal(sendEmbedHello(frame, PAGE), true);
    assert.deepEqual(posted, [{ data: { ...EMBED_HELLO }, targetOrigin: BEE }]);
  });

  test('skips a frame that is still about:blank / same-origin (no target-origin mismatch error)', () => {
    const { frame, posted } = fakeFrame({ sameOrigin: true });
    assert.equal(sendEmbedHello(frame, PAGE), false);
    assert.equal(posted.length, 0);
  });

  test('skips non-BEE, unparsable and detached frames', () => {
    for (const opts of [{ src: `${EVIL}/x` }, { src: 'http://[bad' }, { detached: true }]) {
      const { frame, posted } = fakeFrame(opts);
      assert.equal(sendEmbedHello(frame, PAGE), false, JSON.stringify(opts));
      assert.equal(posted.length, 0);
    }
  });
});
