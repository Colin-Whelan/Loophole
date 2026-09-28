// Page-world RPC: the isolated hub (src/core/page-rpc.js) against the MAIN-world host
// (src/page/rpc-host.js) over the real bridge (src/core/bridge.js), with a Node EventTarget standing
// in for the shared `window`, and the example handler module (src/page/example.main.js) driving a
// fake `window.ace`. Covers ids, timeouts, activation, forged traffic and cleanup.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
const editorEl = { id: 'content-editor-ace' };
globalThis.document = { querySelector: (sel) => (sel === '#content-editor-ace' ? editorEl : null) };

function fakeAce() {
  let value = '<p>hello</p>';
  const listeners = new Set();
  const session = {
    on(ev, fn) { if (ev === 'change') listeners.add(fn); },
    off(ev, fn) { listeners.delete(fn); },
    getLength: () => value.split('\n').length,
  };
  const ed = {
    session,
    getValue: () => value,
    setValue(v) { value = v; for (const fn of listeners) fn(); },
  };
  return { edit: (el) => (el === editorEl ? ed : null), ed, listeners };
}

const { createPageHub, PageCallError, PAGE_ERROR, clampTimeout, parseResult, PAGE_MAX_CHARS } = await import('../src/core/page-rpc.js');
const { startRpcHost } = await import('../src/page/rpc-host.js');
const { BRIDGE, BRIDGE_EVENT, emit } = await import('../src/core/bridge.js');
const example = await import('../src/page/example.main.js');

let host = null;
let slow = null;
const hang = new Promise(() => {});
const REGISTRY = {
  'live-preview': example,
  'other-feature': { methods: { secretless: () => 'from other' } },
  'test-feature': {
    methods: {
      echo: (a) => a,
      slow: () => new Promise((r) => { slow = r; }),
      hang: () => hang,
      throws: () => { throw new Error('bad things'); },
      huge: () => 'x'.repeat(PAGE_MAX_CHARS + 10),
      cyclic: () => { const o = {}; o.o = o; return o; },
      proto: () => JSON.parse('{"a":1,"__proto__":{"polluted":true}}'),
      nothing: () => undefined,
    },
  },
};

/** Everything that crosses the bridge, as the page would see it. */
const seen = [];
window.addEventListener(BRIDGE_EVENT, (e) => seen.push(JSON.parse(e.detail)));
const forge = (type, payload) => window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: JSON.stringify({ type, payload }) }));

beforeEach(() => {
  window.ace = fakeAce();
  host = startRpcHost(REGISTRY, window);
  seen.length = 0;
});
afterEach(() => { host.stop(); });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('page RPC round trip', () => {
  test('call → result, with a fresh random id per call; activation happens on first use', async () => {
    const hub = createPageHub({});
    const ctl = new AbortController();
    const page = hub.forFeature('live-preview', ctl.signal);
    assert.equal(page.available, true);
    const r = await page.call('getValue', { selector: '#content-editor-ace' });
    assert.deepEqual(r, { found: true, value: '<p>hello</p>' });
    assert.deepEqual(await page.call('setValue', { selector: '#content-editor-ace', value: 'new' }), { ok: true });
    assert.equal(window.ace.ed.getValue(), 'new');
    const calls = seen.filter((m) => m.type === BRIDGE.RPC_CALL);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].payload.id, calls[1].payload.id);
    assert.match(calls[0].payload.id, /^[A-Za-z0-9-]{8,64}$/);
    assert.equal(seen.filter((m) => m.type === BRIDGE.RPC_ACTIVATE).length, 1, 'activated once');
    ctl.abort();
  });

  test('handler errors, unknown methods and prototype names come back as PageCallError codes', async () => {
    const page = createPageHub({}).forFeature('test-feature', new AbortController().signal);
    await assert.rejects(page.call('throws'), (e) => e instanceof PageCallError && e.code === PAGE_ERROR.HANDLER_ERROR && /bad things/.test(e.message));
    for (const m of ['missing', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      await assert.rejects(page.call(m), (e) => e.code === PAGE_ERROR.NO_METHOD, m);
    }
    await assert.rejects(page.call('__proto__'), (e) => e.code === PAGE_ERROR.BAD_ARGS, 'invalid method name refused before sending');
    await assert.rejects(page.call('echo', { big: 1n }), (e) => e.code === PAGE_ERROR.BAD_ARGS);
    const cyc = {}; cyc.cyc = cyc;
    await assert.rejects(page.call('echo', cyc), (e) => e.code === PAGE_ERROR.BAD_ARGS);
    await assert.rejects(page.call('echo', 'x'.repeat(PAGE_MAX_CHARS + 1)), (e) => e.code === PAGE_ERROR.BAD_ARGS);
    await assert.rejects(page.call('huge'), (e) => e.code === PAGE_ERROR.TOO_LARGE);
    await assert.rejects(page.call('cyclic'), (e) => e.code === PAGE_ERROR.BAD_RESULT);
    assert.equal(await page.call('nothing'), null);
    assert.deepEqual(await page.call('echo', { a: [1, 'two', null] }), { a: [1, 'two', null] });
  });

  test('results are plain JSON copies with __proto__ keys dropped', async () => {
    const page = createPageHub({}).forFeature('test-feature', new AbortController().signal);
    const r = await page.call('proto');
    assert.deepEqual(Object.keys(r), ['a']);
    assert.equal(Object.getPrototypeOf(r), Object.prototype);
    assert.equal({}.polluted, undefined);
  });

  test('timeout rejects with TIMEOUT; a late answer is ignored', async () => {
    const page = createPageHub({}).forFeature('test-feature', new AbortController().signal);
    const t0 = Date.now();
    const p = page.call('slow', null, { timeoutMs: 30 });
    await assert.rejects(p, (e) => e.code === PAGE_ERROR.TIMEOUT);
    assert.ok(Date.now() - t0 >= 25);
    slow('late'); // the page finally answers: nothing is pending under that id any more
    await flush();
    assert.equal(clampTimeout(0), 10);
    assert.equal(clampTimeout(1e9), 120_000);
    assert.equal(clampTimeout('5'), 5000);
  });

  test('no MAIN-world host at all → TIMEOUT; unavailable hub → UNAVAILABLE at once', async () => {
    host.stop();
    const page = createPageHub({}).forFeature('test-feature', new AbortController().signal);
    await assert.rejects(page.call('echo', 1, { timeoutMs: 20 }), (e) => e.code === PAGE_ERROR.TIMEOUT);
    const none = createPageHub({ available: false }).forFeature('test-feature', new AbortController().signal);
    assert.equal(none.available, false);
    await assert.rejects(none.call('echo'), (e) => e.code === PAGE_ERROR.UNAVAILABLE);
  });
});

describe('activation and forged traffic', () => {
  test('only activated features answer; a page-forged call to an inactive feature gets NOT_ACTIVE', async () => {
    forge(BRIDGE.RPC_CALL, { f: 'other-feature', id: 'forged-call-0001', m: 'secretless', a: null });
    const res = seen.find((m) => m.type === BRIDGE.RPC_RESULT && m.payload.id === 'forged-call-0001');
    assert.equal(res.payload.ok, false);
    assert.equal(res.payload.e.code, 'NOT_ACTIVE');
    // Forging activation just switches on a harmless handler (documented, §6.3).
    forge(BRIDGE.RPC_ACTIVATE, { f: 'other-feature' });
    forge(BRIDGE.RPC_CALL, { f: 'other-feature', id: 'forged-call-0002', m: 'secretless', a: null });
    await flush();
    const ok = seen.find((m) => m.type === BRIDGE.RPC_RESULT && m.payload.id === 'forged-call-0002');
    assert.equal(ok.payload.ok, true);
    // A feature with no main.js can't be activated at all.
    forge(BRIDGE.RPC_ACTIVATE, { f: 'no-such-feature' });
    forge(BRIDGE.RPC_CALL, { f: 'no-such-feature', id: 'forged-call-0003', m: 'x', a: null });
    assert.equal(seen.find((m) => m.payload?.id === 'forged-call-0003' && m.type === BRIDGE.RPC_RESULT).payload.e.code, 'NOT_ACTIVE');
  });

  test('forged results: unknown ids and wrong feature ids are ignored; the first answer wins', async () => {
    const page = createPageHub({}).forFeature('test-feature', new AbortController().signal);
    const p = page.call('slow', null, { timeoutMs: 2000 });
    const call = seen.find((m) => m.type === BRIDGE.RPC_CALL && m.payload.m === 'slow');
    const id = call.payload.id;
    forge(BRIDGE.RPC_RESULT, { f: 'test-feature', id: 'not-a-pending-id', ok: true, r: 'forged' });
    forge(BRIDGE.RPC_RESULT, { f: 'other-feature', id, ok: true, r: 'wrong feature' });
    forge(BRIDGE.RPC_RESULT, { f: 'test-feature', id, ok: 'yes', r: 'malformed' });
    forge(BRIDGE.RPC_RESULT, { f: 'test-feature', id: '../x', ok: true, r: 'bad id' });
    // The page CAN race the real answer for a pending id it has seen (it sees the call event):
    // that is why every result is untrusted input. The first answer wins; the real one is ignored.
    forge(BRIDGE.RPC_RESULT, { f: 'test-feature', id, ok: true, r: { page: 'raced' } });
    slow('real');
    assert.deepEqual(await p, { page: 'raced' });
    assert.equal(parseResult({ f: 'test-feature', id, ok: false, e: { code: 'lower', message: 'x'.repeat(999) } }).code, 'HANDLER_ERROR');
    assert.equal(parseResult({ f: 'test-feature', id, ok: false, e: { code: 'TIMEOUT', message: 'x'.repeat(999) } }).message.length, 300);
  });

  test('page events reach only the active feature that listens, and stop after unmount', async () => {
    const hub = createPageHub({});
    const ctl = new AbortController();
    const page = hub.forFeature('live-preview', ctl.signal);
    const got = [];
    page.on('change', (p) => got.push(p));
    assert.equal(window.ace.listeners.size, 1, 'example activate() hooked the editor');
    window.ace.ed.setValue('a\nb');
    assert.deepEqual(got, [{ length: 2 }]);
    forge(BRIDGE.RPC_EVENT, { f: 'live-preview', e: 'change', p: { forged: true } });
    assert.deepEqual(got.at(-1), { forged: true }, 'events are page-forgeable: listeners validate');
    forge(BRIDGE.RPC_EVENT, { f: 'test-feature', e: 'change', p: 'not mine' });
    forge(BRIDGE.RPC_EVENT, { f: 'live-preview', e: 'Bad Event', p: 1 });
    assert.equal(got.length, 2);
    assert.throws(() => page.on('Bad Event', () => {}), /invalid event/);

    const pending = page.call('slow', null, { timeoutMs: 5000 }).catch((e) => e);
    // live-preview has no 'slow' → NO_METHOD comes back quickly; use test-feature for a pending call.
    await pending;
    const other = hub.forFeature('test-feature', ctl.signal);
    const stuck = other.call('hang', null, { timeoutMs: 5000 });
    ctl.abort(); // unmount
    await assert.rejects(stuck, (e) => e.code === PAGE_ERROR.ABORTED);
    assert.equal(hub._pendingCount(), 0);
    assert.equal(window.ace.listeners.size, 0, 'deactivate ran the cleanup');
    window.ace.ed.setValue('c');
    assert.equal(got.length, 2);
    await assert.rejects(page.call('getValue'), (e) => e.code === PAGE_ERROR.ABORTED);
    assert.ok(seen.some((m) => m.type === BRIDGE.RPC_DEACTIVATE && m.payload.f === 'live-preview'));
  });

  test('a newer injected host takes over; the isolated hub re-activates on rpc:ready', async () => {
    const hub = createPageHub({});
    const page = hub.forFeature('test-feature', new AbortController().signal);
    assert.equal(await page.call('echo', 1), 1);
    const second = startRpcHost(REGISTRY, window); // e.g. Firefox re-injected main-world.js after an update
    seen.length = 0;
    assert.equal(await page.call('echo', 2), 2);
    const answers = seen.filter((m) => m.type === BRIDGE.RPC_RESULT);
    assert.equal(answers.length, 1, 'only the newest host answers');
    second.stop();
  });

  test('bridge refuses to emit oversize details', () => {
    assert.equal(emit('x', { big: 'y'.repeat(8 * 1024 * 1024) }), false);
  });
});
