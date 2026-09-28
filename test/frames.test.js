// Frame channel (src/core/frames.js): envelope + schema validation, and the acceptance rules of the
// top and bee hubs, driven through a small fake of window.postMessage (per-viewer WindowProxy
// handles, browser-set origin/source, targetOrigin filtering, isTrusted).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseEnvelope, makeEnvelope, compileFrameMessages, encodePayload, decodePayload, createTopHub, createBeeHub,
  beeChannelOrigin, inertFrames, FRAME_MAX_CHARS, FRAME_DEFAULT_MAX_CHARS, FRAME_ENVELOPE,
} = await import('../src/core/frames.js');

const IT = 'https://app.iterable.com';
const EU = 'https://app.eu.iterable.com';
const BEE = 'https://app.getbee.io';
const EVIL = 'https://evil.example';

const META = {
  id: 'auto-confirm',
  frameMessages: {
    baseline: { fields: { json: 'string' }, maxChars: 1024 },
    undo: { fields: {} },
    state: { fields: { steps: { type: 'integer', min: 0, max: 20 }, label: 'string?', tags: { type: 'array', items: 'string', maxLength: 3 } } },
  },
};
const OTHER = { id: 'other-feature', frameMessages: { baseline: { fields: { json: 'string' } } } };

// ---------------------------------------------------------------------------
// A tiny postMessage world
// ---------------------------------------------------------------------------

function makeWorld() {
  const queue = [];
  const handles = new Map(); // `${viewer.id}->${target.id}` → handle
  let nextId = 1;

  function handle(target, viewer) {
    if (target === viewer) return viewer.self;
    const k = `${viewer.id}->${target.id}`;
    if (!handles.has(k)) {
      handles.set(k, {
        postMessage(data, targetOrigin) { deliver(viewer, target, data, targetOrigin); },
        get closed() { return target.closed; },
      });
    }
    return handles.get(k);
  }

  function deliver(from, to, data, targetOrigin) {
    if (typeof targetOrigin !== 'string') throw new TypeError('targetOrigin required');
    const cloned = structuredClone(data);
    queue.push(() => {
      if (to.closed) return;
      if (targetOrigin !== '*' && targetOrigin !== to.origin) return; // the browser drops it
      to.fire('message', { isTrusted: true, origin: from.origin, source: handle(from, to), data: cloned });
    });
  }

  function makeWin(origin, parent = null) {
    const listeners = new Map();
    const w = { id: nextId++, origin, parentReal: parent, children: [], closed: false };
    const self = {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      get length() { return w.children.length; },
      get parent() { return w.parentReal ? handle(w.parentReal, w) : self; },
      get top() { let t = w; while (t.parentReal) t = t.parentReal; return handle(t, w); },
      document: { querySelectorAll: () => [] },
      location: { href: origin + '/' },
      listenerCount(type) { return listeners.get(type)?.size || 0; },
    };
    w.self = self;
    w.fire = (type, ev) => { for (const fn of [...(listeners.get(type) || [])]) fn(ev); };
    w.addChild = (child) => {
      child.parentReal = w;
      w.children.push(child);
      Object.defineProperty(self, String(w.children.length - 1), { configurable: true, get: () => handle(child, w) });
    };
    w.removeChild = (child) => {
      w.children = w.children.filter((c) => c !== child);
      child.closed = true;
      for (let i = 0; i <= w.children.length; i++) delete self[i];
      w.children.forEach((c, i) => Object.defineProperty(self, String(i), { configurable: true, get: () => handle(c, w) }));
    };
    /** Something inside this document posts to the real window `target`. */
    w.post = (target, data, targetOrigin) => deliver(w, target, data, targetOrigin);
    /** Page script dispatches a synthetic MessageEvent on this window. */
    w.forge = (ev) => w.fire('message', { isTrusted: false, ...ev });
    return w;
  }

  async function flush() {
    for (let i = 0; i < 50 && queue.length; i++) {
      const batch = queue.splice(0);
      for (const f of batch) f();
      await Promise.resolve();
    }
  }

  return { makeWin, handle, flush };
}

function setup({ topOrigin = IT, beeOrigin = BEE, parentOrigin = topOrigin, helloDelays = [0] } = {}) {
  const world = makeWorld();
  const top = world.makeWin(topOrigin);
  const bee = world.makeWin(beeOrigin);
  top.addChild(bee);
  const topHub = createTopHub({ win: top.self, pruneMs: 0 });
  const beeHub = createBeeHub({ win: bee.self, parentOrigin, helloDelays });
  return { world, top, bee, topHub, beeHub };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Let hub timers (hello, presence announcements) fire and deliver everything posted. */
async function settle(world, rounds = 3) {
  for (let i = 0; i < rounds; i++) { await tick(); await world.flush(); }
}

// ---------------------------------------------------------------------------

describe('parseEnvelope', () => {
  const msg = (over = {}) => ({ wb: FRAME_ENVELOPE, v: 1, k: 'msg', f: 'auto-confirm', t: 'undo', p: '{}', ...over });
  const env = (k, x) => ({ wb: FRAME_ENVELOPE, v: 1, k, ...x });

  test('accepts well-formed envelopes and copies only the known fields', () => {
    assert.deepEqual(parseEnvelope(msg({ extra: 1 })), { k: 'msg', f: 'auto-confirm', t: 'undo', p: '{}' });
    assert.deepEqual(parseEnvelope(env('hello', { s: 'abcdef12-3456' })), { k: 'hello', s: 'abcdef12-3456', m: [] });
    assert.deepEqual(parseEnvelope(env('ack', { s: 'abcdef12-3456', m: ['a', 'b-c'] })), { k: 'ack', s: 'abcdef12-3456', m: ['a', 'b-c'] });
    assert.deepEqual(parseEnvelope(env('bye', { s: 'abcdef12-3456', m: ['x'] })), { k: 'bye', s: 'abcdef12-3456' });
    assert.deepEqual(parseEnvelope(env('up', { f: 'auto-confirm', t: 'x' })), { k: 'up', f: 'auto-confirm' });
    assert.deepEqual(parseEnvelope(env('down', { f: 'auto-confirm' })), { k: 'down', f: 'auto-confirm' });
  });

  test('rejects anything else', () => {
    for (const bad of [
      null, 'string', 42, [], {}, msg({ wb: 'x' }), msg({ v: 2 }), msg({ k: 'nope' }), msg({ f: 'Bad_Id' }), msg({ f: '' }),
      msg({ f: 'a'.repeat(65) }), msg({ t: '1abc' }), msg({ t: 'a'.repeat(65) }), msg({ t: 'has space' }), msg({ p: {} }),
      msg({ p: 'x'.repeat(FRAME_MAX_CHARS + 1) }), env('hello', {}), env('ack', { s: 'short' }),
      env('bye', { s: '<script>alert(1)</script>' }), env('hello', { s: 'abcdef12-3456', m: 'a' }),
      env('hello', { s: 'abcdef12-3456', m: ['Bad Id'] }), env('hello', { s: 'abcdef12-3456', m: Array(65).fill('a') }),
      env('up', {}), env('down', { f: '__proto__' }),
    ]) assert.equal(parseEnvelope(bad), null, JSON.stringify(bad)?.slice(0, 80));
  });

  test('a throwing getter is a rejection, not an exception', () => {
    const evil = {};
    Object.defineProperty(evil, 'wb', { get() { throw new Error('boom'); } });
    assert.equal(parseEnvelope(evil), null);
  });
});

describe('frameMessages schemas', () => {
  test('compile and validate exactly the declared shape', () => {
    const specs = compileFrameMessages(META.frameMessages, META.id);
    const st = specs.get('state');
    assert.equal(st.maxChars, FRAME_DEFAULT_MAX_CHARS);
    assert.equal(st.validate({ steps: 3, tags: ['a'] }), true);
    assert.equal(st.validate({ steps: 3, label: 'x', tags: [] }), true);
    assert.equal(st.validate({ steps: 3.5, tags: [] }), false, 'integer');
    assert.equal(st.validate({ steps: 21, tags: [] }), false, 'max');
    assert.equal(st.validate({ steps: 1, tags: ['a', 'b', 'c', 'd'] }), false, 'array maxLength');
    assert.equal(st.validate({ steps: 1, tags: [1] }), false, 'array items');
    assert.equal(st.validate({ steps: 1 }), false, 'missing required');
    assert.equal(st.validate({ steps: 1, tags: [], more: 1 }), false, 'unknown key');
    assert.equal(st.validate([1]), false);
    assert.equal(st.validate(null), false);
    assert.equal(specs.get('undo').validate({}), true);
    assert.equal(specs.get('undo').validate({ a: 1 }), false);
  });

  test('malformed declarations throw (the build turns that into an error)', () => {
    for (const bad of [
      { 'Bad Type': { fields: {} } },
      { x: { fields: { a: 'strang' } } },
      { x: { fields: {}, maxChars: FRAME_MAX_CHARS + 1 } },
      { x: { fields: {}, other: 1 } },
      JSON.parse('{"x":{"fields":{"__proto__":"string"}}}'),
      { x: { fields: { constructor: 'string' } } },
      { x: 'string' },
      [],
    ]) assert.throws(() => compileFrameMessages(bad, 't'), undefined, JSON.stringify(bad));
    assert.equal(compileFrameMessages(undefined).size, 0);
  });

  test('encode refuses undeclared types, non-JSON, oversize and schema mismatches', () => {
    assert.equal(encodePayload(META, 'baseline', { json: 'x' }), '{"json":"x"}');
    assert.throws(() => encodePayload(META, 'nope', {}), /not declared/);
    const cyc = {}; cyc.self = cyc;
    assert.throws(() => encodePayload(META, 'undo', cyc), /JSON/);
    assert.throws(() => encodePayload(META, 'baseline', { json: 1n }), /JSON/);
    assert.throws(() => encodePayload(META, 'baseline', { json: 'x'.repeat(2000) }), /limit/);
    assert.throws(() => encodePayload(META, 'baseline', { json: 5 }), /schema/);
    assert.equal(encodePayload(META, 'undo', { fn() {} }), '{}', 'functions vanish in JSON: what is checked is what the receiver gets');
    assert.throws(() => encodePayload(META, 'undo', { a: 1 }), /schema/);
  });

  test('decode drops __proto__ keys and anything invalid', () => {
    const d = decodePayload({ id: 'x', frameMessages: { any: { fields: { v: 'json' } } } }, 'any', '{"v":{"__proto__":{"polluted":1},"a":1}}');
    assert.equal(d.ok, true);
    assert.deepEqual(Object.keys(d.value.v), ['a']);
    assert.equal({}.polluted, undefined);
    assert.equal(decodePayload(META, 'baseline', 'not json').ok, false);
    assert.equal(decodePayload(META, 'baseline', '{"json":"' + 'x'.repeat(1100) + '"}').ok, false, 'over the type cap');
    assert.equal(decodePayload(META, 'unknown', '{}').ok, false);
  });
});

describe('beeChannelOrigin', () => {
  test('only an Iterable origin, and only when the parent is the top page', () => {
    assert.equal(beeChannelOrigin({ verifiedOrigin: IT, parentIsTop: true }), IT);
    assert.equal(beeChannelOrigin({ verifiedOrigin: EU, parentIsTop: true }), EU);
    assert.equal(beeChannelOrigin({ verifiedOrigin: IT, parentIsTop: false }), null, 'nested bee frame');
    assert.equal(beeChannelOrigin({ verifiedOrigin: BEE, parentIsTop: true }), null);
    assert.equal(beeChannelOrigin({ verifiedOrigin: EVIL, parentIsTop: true }), null);
    assert.equal(beeChannelOrigin({ verifiedOrigin: null, parentIsTop: true }), null);
  });
});

describe('top ↔ bee round trip', () => {
  test('both directions, namespaced by feature; connected means "the other half is mounted"', async () => {
    const { world, topHub, beeHub } = setup();
    const ctl = new AbortController();
    topHub.start();
    beeHub.start();
    const topF = topHub.forFeature(META, ctl.signal);
    const beeF = beeHub.forFeature(META, ctl.signal);
    const otherBee = beeHub.forFeature(OTHER, ctl.signal); // OTHER isn't mounted on the top side
    const topPeers = [];
    const beePeers = [];
    const otherPeers = [];
    topF.onPeer((e) => topPeers.push(e));
    beeF.onPeer((e) => beePeers.push(e));
    otherBee.onPeer((e) => otherPeers.push(e));
    const gotTop = [];
    const gotBee = [];
    topF.on('baseline', (p, info) => gotTop.push([p, info]));
    beeF.on('undo', (p, info) => gotBee.push([p, info]));
    await settle(world);
    assert.deepEqual(topPeers, [{ peer: 1, connected: true }]);
    assert.deepEqual(beePeers, [{ peer: 'top', connected: true }]);
    assert.deepEqual(otherPeers, [], 'the top side has no "other-feature" half');
    assert.deepEqual(topF.peers(), [1]);
    assert.deepEqual(beeF.peers(), ['top']);
    assert.equal(otherBee.send('baseline', { json: 'x' }), 0, 'nobody to send to');

    assert.equal(beeF.send('baseline', { json: '{"rows":[]}' }), 1);
    assert.equal(topF.send('undo', {}), 1);
    await world.flush();
    assert.deepEqual(gotTop, [[{ json: '{"rows":[]}' }, { peer: 1 }]]);
    assert.deepEqual(gotBee, [[{}, { peer: 'top' }]]);
  });

  test('the other half mounting later / unmounting shows up as connected true / false', async () => {
    const { world, topHub, beeHub } = setup();
    topHub.start(); beeHub.start();
    const topCtl = new AbortController();
    const topF = topHub.forFeature(META, topCtl.signal);
    const events = [];
    topF.onPeer((e) => events.push(e));
    await settle(world);
    assert.deepEqual(events, [], 'transport is up, but the bee half is not mounted');
    assert.equal(topF.send('undo', {}), 0);

    const beeCtl = new AbortController();
    const beeF = beeHub.forFeature(META, beeCtl.signal);
    const got = [];
    beeF.on('undo', () => got.push(1));
    await settle(world);
    assert.deepEqual(events, [{ peer: 1, connected: true }]);
    assert.equal(topF.send('undo', {}), 1);
    await world.flush();
    assert.deepEqual(got, [1]);

    beeCtl.abort(); // bee half unmounted (e.g. disabled)
    await settle(world);
    assert.deepEqual(events.at(-1), { peer: 1, connected: false });
    assert.equal(topF.send('undo', {}), 0);

    // Remount on the bee side, then the top half unmounts: the bee half hears about it.
    const beeCtl2 = new AbortController();
    const beeF2 = beeHub.forFeature(META, beeCtl2.signal);
    const beeEvents = [];
    beeF2.onPeer((e) => beeEvents.push(e));
    await settle(world);
    assert.deepEqual(beeEvents, [{ peer: 'top', connected: true }]);
    topCtl.abort();
    await settle(world);
    assert.deepEqual(beeEvents.at(-1), { peer: 'top', connected: false });
    assert.equal(beeF2.send('baseline', { json: 'x' }), 0);
  });

  test('a feature that subscribes after its other half connected hears about it (replayed once, async)', async () => {
    const { world, topHub, beeHub } = setup();
    topHub.start(); beeHub.start();
    const ctl = new AbortController();
    const topF = topHub.forFeature(META, ctl.signal);
    const beeF = beeHub.forFeature(META, ctl.signal);
    await settle(world);
    const topPeers = [];
    const beePeers = [];
    topF.onPeer((e) => topPeers.push(e));
    beeF.onPeer((e) => beePeers.push(e));
    assert.deepEqual(topPeers, [], 'not synchronously (the feature is still registering its handlers)');
    await Promise.resolve();
    assert.deepEqual(topPeers, [{ peer: 1, connected: true }]);
    assert.deepEqual(beePeers, [{ peer: 'top', connected: true }]);
    const late = [];
    const off = topF.onPeer((e) => late.push(e));
    off(); // unsubscribed before the microtask: no replay
    await Promise.resolve();
    assert.deepEqual(late, []);
  });

  test('a half that mounts late and syncs on the replayed connect gets an answer (no presence race)', async () => {
    const { world, topHub, beeHub } = setup();
    topHub.start(); beeHub.start();
    const beeF = beeHub.forFeature(META, new AbortController().signal);
    const replies = [];
    beeF.on('undo', () => { replies.push(beeF.send('baseline', { json: 'state' })); });
    await settle(world);
    // The top half mounts now: its replayed connect fires before anything else happens.
    const topF = topHub.forFeature(META, new AbortController().signal);
    const got = [];
    topF.on('baseline', (p) => got.push(p.json));
    topF.onPeer((e) => { if (e.connected) topF.send('undo', {}, { to: e.peer }); });
    await settle(world);
    assert.deepEqual(replies, [1], 'the bee half could answer at once');
    assert.deepEqual(got, ['state']);
  });

  test('unknown types, invalid payloads and oversize payloads are dropped on receive', async () => {
    const { world, top, bee, topHub, beeHub } = setup();
    const ctl = new AbortController();
    const got = [];
    topHub.start(); beeHub.start();
    const topF = topHub.forFeature(META, ctl.signal);
    beeHub.forFeature(META, ctl.signal);
    topF.on('baseline', (p) => got.push(p));
    await settle(world);
    const post = (t, p) => bee.post(top, makeEnvelope('msg', { f: META.id, t, p }), IT);
    post('baseline', '{"json":5}');                 // schema
    post('baseline', '{"json":"x","extra":1}');     // extra key
    post('baseline', 'nope');                       // not JSON
    post('baseline', JSON.stringify({ json: 'x'.repeat(2000) })); // over maxChars (1024)
    post('undeclared', '{}');                       // unknown type
    post('baseline', '{"json":"ok"}');
    await world.flush();
    assert.deepEqual(got, [{ json: 'ok' }]);
  });
});

describe('top-side acceptance rules', () => {
  test('only trusted events from a direct child frame with the exact BEE origin that said hello', async () => {
    const world = makeWorld();
    const top = world.makeWin(IT);
    const bee = world.makeWin(BEE);
    const foreign = world.makeWin(EVIL);
    const lookalike = world.makeWin('https://app.getbee.io.evil.example');
    const grandchild = world.makeWin(BEE);
    top.addChild(bee); top.addChild(foreign); top.addChild(lookalike);
    bee.addChild(grandchild);
    const stranger = world.makeWin(BEE); // a BEE window that is not our child (e.g. a popup)
    const hub = createTopHub({ win: top.self, pruneMs: 0 });
    const ctl = new AbortController();
    const got = [];
    const peers = [];
    const f = hub.forFeature(META, ctl.signal);
    f.on('undo', () => got.push('undo'));
    f.onPeer((e) => peers.push(e));
    hub.start();
    const hello = (from, s) => from.post(top, makeEnvelope('hello', { s, m: [META.id] }), IT);
    const undo = (from) => from.post(top, makeEnvelope('msg', { f: META.id, t: 'undo', p: '{}' }), IT);

    undo(bee); // before hello: ignored
    hello(foreign, 'session-foreign'); undo(foreign);
    hello(lookalike, 'session-lookalike'); undo(lookalike);
    hello(grandchild, 'session-grandchild'); undo(grandchild);
    hello(stranger, 'session-stranger'); undo(stranger);
    await settle(world);
    assert.deepEqual(got, []);
    assert.deepEqual(peers, []);
    assert.equal(hub._peerCount(), 0);

    // Page script on the Iterable page forging a MessageEvent that claims to be the bee frame.
    top.forge({ origin: BEE, source: world.handle(bee, top), data: makeEnvelope('hello', { s: 'forged-session', m: [META.id] }) });
    top.forge({ origin: BEE, source: world.handle(bee, top), data: makeEnvelope('msg', { f: META.id, t: 'undo', p: '{}' }) });
    assert.deepEqual(peers, []);
    assert.deepEqual(got, []);

    hello(bee, 'session-bee-1');
    undo(bee);
    await settle(world);
    assert.deepEqual(peers, [{ peer: 1, connected: true }]);
    assert.deepEqual(got, ['undo']);
    assert.equal(hub._peerCount(), 1);
  });

  test('top posts only to verified peers where the feature is up, with the exact BEE target origin', async () => {
    const world = makeWorld();
    const top = world.makeWin(IT);
    const bee = world.makeWin(BEE);
    top.addChild(bee);
    const targets = [];
    const beeHandle = world.handle(bee, top);
    const orig = beeHandle.postMessage;
    beeHandle.postMessage = (d, o) => { targets.push(o); orig(d, o); };
    const hub = createTopHub({ win: top.self, pruneMs: 0 });
    hub.start();
    const f = hub.forFeature(META, new AbortController().signal);
    assert.equal(f.send('undo', {}), 0, 'no peers yet: nothing posted anywhere');
    bee.post(top, makeEnvelope('hello', { s: 'session-bee-1' }), IT); // transport only, feature not up
    await settle(world);
    assert.equal(f.send('undo', {}), 0);
    bee.post(top, makeEnvelope('up', { f: META.id }), IT);
    await world.flush();
    assert.equal(f.send('undo', {}), 1);
    assert.ok(targets.length >= 2 && targets.every((o) => o === BEE), JSON.stringify(targets));
    assert.equal(f.send('undo', {}, { to: 99 }), 0, 'targeted at an unknown peer');
  });

  test('a peer may not announce an unbounded number of features', async () => {
    const world = makeWorld();
    const top = world.makeWin(IT);
    const bee = world.makeWin(BEE);
    top.addChild(bee);
    const hub = createTopHub({ win: top.self, pruneMs: 0 });
    hub.start();
    bee.post(top, makeEnvelope('hello', { s: 'session-bee-1', m: Array.from({ length: 64 }, (_, i) => `f${i}`) }), IT);
    await world.flush();
    const f = hub.forFeature(META, new AbortController().signal);
    bee.post(top, makeEnvelope('up', { f: META.id }), IT);
    await world.flush();
    assert.deepEqual(f.peers(), [], 'the 65th announced feature is ignored');
  });

  test('multiple bee frames, a reload (new session), and a removed frame', async () => {
    const world = makeWorld();
    const top = world.makeWin(IT);
    const a = world.makeWin(BEE);
    const b = world.makeWin(BEE);
    top.addChild(a); top.addChild(b);
    const hub = createTopHub({ win: top.self, pruneMs: 0 });
    hub.start();
    const ctl = new AbortController();
    const f = hub.forFeature(META, ctl.signal);
    const peers = [];
    f.onPeer((e) => peers.push(e));
    let hubA = createBeeHub({ win: a.self, parentOrigin: IT, helloDelays: [0] });
    const hubB = createBeeHub({ win: b.self, parentOrigin: IT, helloDelays: [0] });
    hubA.start(); hubB.start();
    const beeGot = { a: 0, b: 0 };
    hubA.forFeature(META, ctl.signal).on('undo', () => beeGot.a++);
    hubB.forFeature(META, ctl.signal).on('undo', () => beeGot.b++);
    await settle(world);
    assert.deepEqual(peers.map((p) => p.peer).sort(), [1, 2]);
    assert.equal(f.send('undo', {}), 2);
    assert.equal(f.send('undo', {}, { to: 2 }), 1);
    await world.flush();
    assert.deepEqual(beeGot, { a: 1, b: 2 });

    // Frame A reloads: pagehide → bye, then the new document says hello with a new session.
    const before = peers.length;
    a.fire('pagehide', {});
    await world.flush();
    hubA.stop();
    assert.equal(peers.length, before + 1);
    assert.equal(peers.at(-1).connected, false);
    const oldA = peers.at(-1).peer;
    hubA = createBeeHub({ win: a.self, parentOrigin: IT, helloDelays: [0] });
    hubA.start();
    let aGot = 0;
    hubA.forFeature(META, ctl.signal).on('undo', () => aGot++);
    await settle(world);
    assert.deepEqual(peers.at(-1), { peer: 3, connected: true }, 'same frame, new document → new peer id');
    assert.notEqual(oldA, 3);
    assert.equal(f.send('undo', {}), 2);
    await world.flush();
    assert.equal(aGot, 1);

    // Frame B is removed from the page: the next send (or the prune timer) drops it.
    top.removeChild(b);
    assert.equal(f.send('undo', {}), 1);
    assert.equal(peers.at(-1).connected, false);
    assert.deepEqual(f.peers(), [3]);

    // A duplicate hello from the same document doesn't reconnect.
    const n = peers.length;
    a.post(top, makeEnvelope('hello', { s: hubA.sessionId, m: [META.id] }), IT);
    await world.flush();
    assert.equal(peers.length, n);
  });

  test('a restarted top hub (extension reload) gets every bee frame to introduce itself again', async () => {
    const { world, top, bee, beeHub } = setup();
    top.self.document = { querySelectorAll: () => [{ src: BEE + '/editor', contentWindow: world.handle(bee, top) }] };
    beeHub.start();
    const beeF = beeHub.forFeature(META, new AbortController().signal);
    const beeEvents = [];
    beeF.onPeer((e) => beeEvents.push(e));
    const hub1 = createTopHub({ win: top.self, pruneMs: 0 });
    hub1.start();
    hub1.forFeature(META, new AbortController().signal);
    await settle(world);
    assert.deepEqual(beeEvents, [{ peer: 'top', connected: true }]);
    hub1.stop();
    const hub2 = createTopHub({ win: top.self, pruneMs: 0 }); // new session
    const f2 = hub2.forFeature(META, new AbortController().signal);
    hub2.start(); // sweep: hello to BEE frames → they say hello back
    await settle(world, 5);
    assert.deepEqual(beeEvents.map((e) => e.connected), [true, false, true]);
    assert.deepEqual(f2.peers(), [1]);
  });

  test('handlers are removed when the feature unmounts (ctx.signal)', async () => {
    const { world, top, bee, topHub, beeHub } = setup();
    const ctl = new AbortController();
    const got = [];
    topHub.start(); beeHub.start();
    topHub.forFeature(META, ctl.signal).on('undo', () => got.push(1));
    beeHub.forFeature(META, new AbortController().signal);
    await settle(world);
    const undo = () => bee.post(top, makeEnvelope('msg', { f: META.id, t: 'undo', p: '{}' }), IT);
    undo(); await world.flush();
    ctl.abort();
    undo(); await world.flush();
    assert.deepEqual(got, [1]);
  });

  test('on() refuses undeclared types and non-functions (programming errors)', () => {
    const hub = createTopHub({ win: makeWorld().makeWin(IT).self, pruneMs: 0 });
    const f = hub.forFeature(META, new AbortController().signal);
    assert.throws(() => f.on('nope', () => {}), /not declared/);
    assert.throws(() => f.on('undo', 'x'), /function/);
  });
});

describe('bee-side acceptance rules', () => {
  test('only trusted events from window.parent with the verified origin', async () => {
    const world = makeWorld();
    const top = world.makeWin(IT);
    const bee = world.makeWin(BEE);
    const sibling = world.makeWin(IT);
    top.addChild(bee); top.addChild(sibling);
    const hub = createBeeHub({ win: bee.self, parentOrigin: IT, helloDelays: [] });
    const ctl = new AbortController();
    hub.start();
    const f = hub.forFeature(META, ctl.signal);
    const got = [];
    const peers = [];
    f.on('undo', () => got.push(1));
    f.onPeer((e) => peers.push(e));
    const ack = makeEnvelope('ack', { s: 'top-session-1', m: [META.id] });
    const undo = makeEnvelope('msg', { f: META.id, t: 'undo', p: '{}' });

    sibling.post(bee, ack, BEE);                 // right origin, wrong source
    sibling.post(bee, undo, BEE);
    bee.forge({ origin: IT, source: bee.self.parent, data: ack }); // page script forging the parent
    bee.forge({ origin: IT, source: bee.self.parent, data: undo });
    await settle(world);
    assert.deepEqual(peers, []);
    assert.deepEqual(got, []);

    top.post(bee, undo, BEE); // from the parent, but before any ack: dropped
    top.post(bee, ack, BEE);
    top.post(bee, undo, BEE);
    await world.flush();
    assert.deepEqual(peers, [{ peer: 'top', connected: true }]);
    assert.deepEqual(got, [1]);
  });

  test('a parent with a different (even Iterable) origin than the verified one is refused', async () => {
    const world = makeWorld();
    const top = world.makeWin(EU);
    const bee = world.makeWin(BEE);
    top.addChild(bee);
    const hub = createBeeHub({ win: bee.self, parentOrigin: IT, helloDelays: [0] });
    const peers = [];
    hub.start();
    hub.forFeature(META, new AbortController().signal).onPeer((e) => peers.push(e));
    await tick();
    top.post(bee, makeEnvelope('ack', { s: 'top-session-1', m: [META.id] }), BEE);
    await world.flush();
    assert.deepEqual(peers, []);
  });

  test('a foreign embedder: the hub never opens, and its hello never reaches it', async () => {
    const world = makeWorld();
    const evilTop = world.makeWin(EVIL);
    const bee = world.makeWin(BEE);
    evilTop.addChild(bee);
    // bee.js computes parentOrigin with beeChannelOrigin: a foreign parent is never verified.
    const hub = createBeeHub({ win: bee.self, parentOrigin: beeChannelOrigin({ verifiedOrigin: EVIL, parentIsTop: true }), helloDelays: [0] });
    assert.equal(hub.available, false);
    hub.start();
    const f = hub.forFeature(META, new AbortController().signal);
    assert.equal(f.available, false);
    assert.equal(f.send('undo', {}), 0);
    const posted = [];
    const h = world.handle(evilTop, bee);
    const orig = h.postMessage;
    h.postMessage = (d, o) => { posted.push(o); orig(d, o); };
    await settle(world);
    assert.deepEqual(posted, [], 'nothing posted to a foreign parent');
    assert.equal(bee.self.listenerCount('message'), 0);
  });

  test('bee-to-top posts use the verified parent origin as target, so a swapped parent gets nothing', async () => {
    const world = makeWorld();
    const top = world.makeWin(EVIL); // pretend the parent navigated to a foreign page
    const bee = world.makeWin(BEE);
    top.addChild(bee);
    const got = [];
    top.self.addEventListener('message', (e) => got.push(e));
    const hub = createBeeHub({ win: bee.self, parentOrigin: IT, helloDelays: [0] });
    hub.start();
    hub.forFeature(META, new AbortController().signal);
    await settle(world);
    assert.deepEqual(got, [], 'the browser drops a post whose targetOrigin doesn’t match');
  });

  test('inertFrames (auth / nested frames) still validates what a feature tries to send', () => {
    const f = inertFrames(META);
    assert.equal(f.available, false);
    assert.equal(f.send('undo', {}), 0);
    assert.throws(() => f.send('nope', {}), /not declared/);
    assert.deepEqual(f.peers(), []);
  });
});
