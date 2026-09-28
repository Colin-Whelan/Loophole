// Background API proxy: pure validation (src/core/api-validation.js) plus the message router in
// src/background/index.js driven through a fake chrome.* and a fake fetch. Never touches the network.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPath, validateApiRequest, buildApiUrl, parseRetryAfter, classifySender, senderAllowed,
  buildOptionsHash, redactSecret, describeHttpError, BODY_MAX_BYTES, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS,
} from '../src/core/api-validation.js';

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

describe('checkPath', () => {
  test('accepts ordinary API paths', () => {
    for (const p of [
      '/api/channels',
      '/api/users/byEmail/' + encodeURIComponent('a+b@example.com'),
      '/api/users/byEmail/' + encodeURIComponent('we/ird@example.com'), // %2F inside a segment
      '/api/users/byUserId/' + encodeURIComponent('user:123'),
      '/api/catalogs/products/items/sku-1.2_3~x',
      '/api/lists/',
      '/api/users/byEmail/' + encodeURIComponent('..@example.com'),
    ]) {
      assert.equal(checkPath(p), null, p);
    }
  });

  test('rejects traversal, absolute URLs, schemes, hosts, backslashes, encodings', () => {
    for (const p of [
      undefined, 42, '', 'api/users', '/API/users', '/apix/users', '/ap/i', '/api',
      'https://evil.example/api/x', '//evil.example/api/x', '/api/../admin', '/api/users/..',
      '/api/./users', '/api/users/%2e%2e/x', '/api/users/%2E%2E', '/api/users/.%2e/x',
      '/api/users/%252e%252e/x', '/api/users/%25252e%25252e/x', '/api/users/..%2F..%2Fadmin',
      '/api/users/x%2F..%2Fy', '/api/users/..%5Cadmin', '/api/users\\..\\admin', '/api/users/a\\b',
      '/api//users', '/api/users?x=1', '/api/users#frag', '/api/users/a b', '/api/users/\u00E9',
      '/api/users/%zz', '/api/users/%', '/api/users/%0d%0aX:1', '/api/users/%00', '/api/users/\t',
      '/api/users/%2525252525252e',
      '/api/' + 'a'.repeat(2100),
    ]) {
      assert.notEqual(checkPath(p), null, `should reject ${JSON.stringify(p)}`);
    }
  });
});

describe('checkPath with encodeURIComponent-ed user ids', () => {
  const byUserId = (id) => '/api/users/byUserId/' + encodeURIComponent(id);

  test('accepts ids with %, /, spaces, unicode, dots inside a name', () => {
    for (const id of ['100%', '%', '%%25', '50% off', 'a/b', 'a/b/c', 'with space', ' lead', 'café',
      '日本語', '😀', 'x..y', '.hidden', 'a.b', '%zz', '100%25', 'a\\b']) {
      assert.equal(checkPath(byUserId(id)), null, JSON.stringify(id));
    }
    assert.equal(checkPath('/api/users/100%25'), null);
    assert.equal(checkPath('/api/users/100%25/fields'), null);
  });

  test('still rejects traversal in any encoding', () => {
    // A literal id "%2e%2e" arrives as %252e%252e: indistinguishable from double-encoded
    // traversal, so it is refused too (fail closed).
    for (const id of ['..', '.', '../x', 'x/..', 'a/../b', '..\\admin', 'x/./y', '%2e%2e', '%2E%2e/x']) {
      assert.notEqual(checkPath(byUserId(id)), null, JSON.stringify(id));
    }
    for (const p of [
      '/api/users/%2e%2e', '/api/users/%2E%2e/x', '/api/users/%252e%252e', '/api/users/%25252e%25252e/x',
      '/api/users/%25%32%65%25%32%65', '/api/users/..%252Fadmin', '/api/users/a%252F..%252Fb', '/api/users/%255C..',
      '/api/users/%250d%250a', '/api/users/%2500', '/api/users/%', '/api/users/%zz', '/api/users/%E0%A4%A',
      '/api/users/%ff', // not valid UTF-8 as the first layer
    ]) {
      assert.notEqual(checkPath(p), null, p);
    }
  });
});

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

describe('validateApiRequest', () => {
  const base = { projectKey: 'us:18244', method: 'GET', path: '/api/channels' };

  test('happy path, defaults and host selection', () => {
    const r = validateApiRequest(base);
    assert.equal(r.ok, true);
    assert.equal(r.value.url, 'https://api.iterable.com/api/channels');
    assert.equal(r.value.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(r.value.bodyJson, null);
    const eu = validateApiRequest({ ...base, projectKey: 'eu:name:Prod EU', method: 'post', body: { a: 1 } });
    assert.equal(eu.ok, true);
    assert.equal(eu.value.method, 'POST');
    assert.equal(eu.value.url, 'https://api.eu.iterable.com/api/channels');
    assert.equal(eu.value.bodyJson, '{"a":1}');
    assert.equal(validateApiRequest({ projectKey: 'us:1', path: '/api/x' }).value.method, 'GET');
  });

  test('host can never come from the caller', () => {
    for (const extra of [{ host: 'evil.example' }, { url: 'https://evil.example/api/x' }, { baseUrl: 'https://evil.example' }]) {
      const r = validateApiRequest({ ...base, ...extra });
      assert.equal(new URL(r.value.url).host, 'api.iterable.com');
    }
    assert.equal(validateApiRequest({ ...base, path: '//evil.example/api/x' }).ok, false);
    assert.equal(validateApiRequest({ ...base, path: '/api/x@evil.example' }).value.url,
      'https://api.iterable.com/api/x@evil.example'); // '@' in a path is just a path char
  });

  test('query: flat primitives and arrays of primitives only', () => {
    const r = validateApiRequest({ ...base, query: { a: 'x y', b: 2, c: true, d: null, e: undefined, f: ['p', 'q'] } });
    assert.equal(r.ok, true);
    assert.equal(r.value.url, 'https://api.iterable.com/api/channels?a=x+y&b=2&c=true&f=p&f=q');
    const hostile = validateApiRequest({ ...base, query: { '#x': '&y=1', 'a b': '/../' } });
    assert.equal(new URL(hostile.value.url).pathname, '/api/channels');
    for (const query of [
      'a=1', ['a'], { a: { b: 1 } }, { a: [[1]] }, { a: [{}] }, { a: NaN }, { a: Infinity },
      { a: () => 1 }, { a: 'x'.repeat(5000) }, { '': 1 }, new Map([['a', 1]]),
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['k' + i, i])),
      { a: Array.from({ length: 101 }, () => 1) },
    ]) {
      assert.equal(validateApiRequest({ ...base, query }).ok, false, JSON.stringify(query));
    }
  });

  test('body rules', () => {
    assert.equal(validateApiRequest({ ...base, body: { a: 1 } }).ok, false, 'GET with body');
    const post = { ...base, method: 'POST' };
    assert.equal(validateApiRequest({ ...post, body: [{ a: 1 }] }).ok, true);
    assert.equal(validateApiRequest({ ...post, body: null }).value.bodyJson, null);
    for (const body of ['str', 1, true]) assert.equal(validateApiRequest({ ...post, body }).ok, false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(validateApiRequest({ ...post, body: cyclic }).ok, false);
    assert.equal(validateApiRequest({ ...post, body: { big: 1n } }).ok, false);
    assert.equal(validateApiRequest({ ...post, body: { s: 'x'.repeat(BODY_MAX_BYTES) } }).ok, false);
    // Multi-byte characters count as bytes, not UTF-16 units
    const n = Math.floor(BODY_MAX_BYTES / 3);
    assert.equal(validateApiRequest({ ...post, body: { s: '\u20AC'.repeat(n) } }).ok, false);
    assert.equal(validateApiRequest({ ...post, body: { s: 'x'.repeat(1024 * 1024) } }).ok, true);
  });

  test('method, projectKey, timeout', () => {
    for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'get ', 5, {}]) {
      assert.equal(validateApiRequest({ ...base, method }).ok, false, String(method));
    }
    for (const projectKey of [undefined, '18244', 'us:../1', 'xx:1', 'us:1/2']) {
      assert.equal(validateApiRequest({ ...base, projectKey }).ok, false, String(projectKey));
    }
    assert.equal(validateApiRequest({ ...base, timeoutMs: 5 }).value.timeoutMs, 1000);
    assert.equal(validateApiRequest({ ...base, timeoutMs: 10 * 60_000 }).value.timeoutMs, MAX_TIMEOUT_MS);
    assert.equal(validateApiRequest({ ...base, timeoutMs: 45_000 }).value.timeoutMs, 45_000);
    for (const timeoutMs of ['1000', NaN, Infinity]) {
      assert.equal(validateApiRequest({ ...base, timeoutMs }).ok, false);
    }
    assert.equal(validateApiRequest(null).ok, false);
    assert.equal(validateApiRequest([]).ok, false);
  });

  test('buildApiUrl refuses unknown data centers and inherited keys', () => {
    assert.equal(buildApiUrl('ap', '/api/x'), null);
    assert.equal(buildApiUrl('__proto__', '/api/x'), null);
    assert.equal(buildApiUrl('toString', '/api/x'), null);
    assert.equal(buildApiUrl('us', '/api/../x'), null);
  });
});

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  test('delta-seconds', () => {
    assert.equal(parseRetryAfter('7', now), 7000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
    assert.equal(parseRetryAfter('999999999', now), 24 * 3600 * 1000);
  });
  test('HTTP-date', () => {
    assert.equal(parseRetryAfter('Thu, 24 Sep 2026 12:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Thu, 24 Sep 2026 11:00:00 GMT', now), 0, 'past date \u2192 0');
    assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT', now), 0);
    assert.equal(parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT', now), 24 * 3600 * 1000, '24 h cap');
    assert.equal(parseRetryAfter('Thu, 24 Sep 2026 12:00:60 GMT', now), 59_000, 'leap second');
  });
  test('junk \u2192 undefined', () => {
    for (const v of [undefined, null, '', '-1', '1.5', 'soon', '2026-09-25', 'Thu, 99 Foo 2026 GMT', 5,
      // Date.parse would take these; a strict IMF-fixdate doesn't.
      'soon 2099 GMT', 'x 2099 GMT', 'Jan 2099 GMT', '2099 GMT', '+10 GMT', '1e3',
      'Thursday, 24-Sep-26 12:01:00 GMT',          // obsolete RFC 850 form
      'Thu Sep 24 12:01:00 2026',                  // asctime
      'thu, 24 sep 2026 12:01:00 gmt',             // case matters
      'Thu, 24 Sep 2026 12:01:00 UTC', 'Thu, 24 Sep 2026 12:01:00 +0000',
      'Thu, 4 Sep 2026 12:01:00 GMT', 'Thu, 24 Sep 26 12:01:00 GMT', 'Thu,24 Sep 2026 12:01:00 GMT',
      'Thu, 31 Feb 2026 12:00:00 GMT', 'Thu, 24 Sep 2026 24:00:00 GMT', 'Thu, 24 Sep 2026 12:61:00 GMT',
      'Thu, 24 Sep 2026 12:01:00 GMT junk', 'junk Thu, 24 Sep 2026 12:01:00 GMT']) {
      assert.equal(parseRetryAfter(v, now), undefined, String(v));
    }
  });
});

// ---------------------------------------------------------------------------
// Sender classification + policy
// ---------------------------------------------------------------------------

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_BASE = `chrome-extension://${RUNTIME_ID}/`;
const ctx = { runtimeId: RUNTIME_ID, extensionBaseUrl: EXT_BASE };
const tab = { id: 7, windowId: 1 };

describe('classifySender', () => {
  test('extension pages (popup without tab, options in a tab, Firefox moz-extension)', () => {
    assert.equal(classifySender({ id: RUNTIME_ID, url: EXT_BASE + 'popup.html' }, ctx), 'extension');
    assert.equal(classifySender({ id: RUNTIME_ID, url: EXT_BASE + 'options.html#keys', tab }, ctx), 'extension');
    const ff = { runtimeId: 'loophole@colin-whelan', extensionBaseUrl: 'moz-extension://1111-2222/' };
    assert.equal(classifySender({ id: ff.runtimeId, url: 'moz-extension://1111-2222/options.html', tab }, ff), 'extension');
  });

  test('content scripts on allowed hosts', () => {
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'https://app.iterable.com/users/profiles/x', origin: 'https://app.iterable.com' }, ctx), 'app');
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'https://app.eu.iterable.com/x' }, ctx), 'app'); // Firefox: no origin
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'https://app.getbee.io/editor', frameId: 3 }, ctx), 'bee');
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'https://auth.iterable.com/u/login?state=x', origin: 'https://auth.iterable.com' }, ctx), 'auth');
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'https://auth.iterable.com.evil.example/u/login' }, ctx), null);
    assert.equal(classifySender({ id: RUNTIME_ID, tab, url: 'http://auth.iterable.com/u/login' }, ctx), null);
  });

  test('rejects everything else', () => {
    const bad = [
      null, {},
      { id: 'other-extension', url: EXT_BASE + 'popup.html' },
      { url: EXT_BASE + 'popup.html' },
      { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}x/popup.html` },
      { id: RUNTIME_ID, url: 'https://app.iterable.com/x' }, // no tab → not a content script
      { id: RUNTIME_ID, tab, url: 'https://evil.example/x' },
      { id: RUNTIME_ID, tab, url: 'http://app.iterable.com/x' },
      { id: RUNTIME_ID, tab, url: 'https://app.iterable.com.evil.example/x' },
      { id: RUNTIME_ID, tab, url: 'https://evil.example/https://app.iterable.com' },
      { id: RUNTIME_ID, tab, url: 'https://evil.example/x', origin: 'https://app.iterable.com' }, // disagree
      { id: RUNTIME_ID, tab, url: 'https://app.iterable.com:8443/x' },
      { id: RUNTIME_ID, tab, url: 'about:blank', origin: 'null' },
      { id: RUNTIME_ID, tab, url: 'not a url' },
    ];
    for (const s of bad) assert.equal(classifySender(s, ctx), null, JSON.stringify(s));
    assert.equal(classifySender({ id: undefined, url: 'x' }, { runtimeId: undefined, extensionBaseUrl: EXT_BASE }), null);
  });

  test('policy table', () => {
    assert.equal(senderAllowed('wb:api', 'app'), true);
    assert.equal(senderAllowed('wb:api', 'extension'), true);
    assert.equal(senderAllowed('wb:api', 'bee'), false);
    assert.equal(senderAllowed('wb:keys:status', 'bee'), false);
    assert.equal(senderAllowed('wb:keys:test', 'app'), false);
    assert.equal(senderAllowed('wb:keys:test', 'extension'), true);
    assert.equal(senderAllowed('wb:open-options', 'bee'), true);
    // Sign-in pages (optional permission): only the options page, nothing touching keys or the API.
    assert.equal(senderAllowed('wb:open-options', 'auth'), true);
    assert.equal(senderAllowed('wb:api', 'auth'), false);
    assert.equal(senderAllowed('wb:keys:status', 'auth'), false);
    assert.equal(senderAllowed('wb:keys:test', 'auth'), false);
    assert.equal(senderAllowed('wb:open-options', null), false);
    assert.equal(senderAllowed('toString', 'extension'), false);
    assert.equal(senderAllowed('wb:tab:status', 'extension'), false);
  });
});

describe('misc helpers', () => {
  test('buildOptionsHash', () => {
    assert.equal(buildOptionsHash(), '');
    assert.equal(buildOptionsHash('keys'), '#keys');
    assert.equal(buildOptionsHash('keys', { projectKey: 'us:1', focus: true }), '#keys?projectKey=us%3A1&focus=true');
    for (const [s, p] of [
      ['Keys'], ['keys/x'], ['../x'], ['javascript:alert(1)'], ['a'.repeat(41)], [5],
      ['keys', 'x=1'], ['keys', { a: {} }], ['keys', { a: 'x'.repeat(513) }], [undefined, { a: 1 }],
    ]) {
      assert.equal(buildOptionsHash(s, p), null, JSON.stringify([s, p]));
    }
  });

  test('redactSecret / describeHttpError', () => {
    const k = '0123456789abcdef0123456789abcdef';
    assert.equal(redactSecret(`{"apiKey":"${k}","again":"${k}"}`, k), '{"apiKey":"0123\u2026cdef","again":"0123\u2026cdef"}');
    const slashy = 'abcd/efgh/ijkl/mnop/qrst';
    assert.equal(redactSecret(JSON.stringify({ k: slashy }).replace(/\//g, '\\/'), slashy).includes('efgh'), false);
    assert.equal(describeHttpError(401, { code: 'BadApiKey', msg: 'Invalid API key' }), 'HTTP 401 \u2014 BadApiKey: Invalid API key');
    assert.equal(describeHttpError(500, null), 'HTTP 500');
    assert.equal(describeHttpError(502, '<html>\n bad \n gateway</html>'), 'HTTP 502 \u2014 <html> bad gateway</html>');
  });
});

// ---------------------------------------------------------------------------
// Background router, end to end with fake chrome.* and fetch
// ---------------------------------------------------------------------------

const KEY_US = '0123456789abcdef0123456789abcdef';
const KEY_EU = 'fedcba9876543210fedcba9876543210';

const store = {};
const created = [];
const updated = [];
let contexts = [];
const listeners = {};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (p) => EXT_BASE + p,
    onMessage: { addListener: (f) => { listeners.message = f; } },
    onInstalled: { addListener: (f) => { listeners.installed = f; } },
    getContexts: async () => contexts,
  },
  storage: {
    local: {
      async get(k) { if (k == null) return clone(store); const o = {}; for (const key of [].concat(k)) if (key in store) o[key] = clone(store[key]); return o; },
      async set(o) { for (const [k, v] of Object.entries(o)) store[k] = clone(v); },
    },
    onChanged: { addListener: (f) => { listeners.storage = f; } },
  },
  // Optional-permission sync (background/index.js syncOptionalScripts): login-autofill is a
  // frame:'auth' feature, so real builds request "scripting"; this fake leaves chrome.scripting
  // out on purpose, so the sync is a no-op here (the plan itself is tested in feature-frames).
  permissions: {
    onAdded: { addListener: (f) => { listeners.permAdded = f; } },
    onRemoved: { addListener: (f) => { listeners.permRemoved = f; } },
    contains: async () => false,
  },
  tabs: {
    create: async (o) => { created.push(o); return { id: 99, ...o }; },
    update: async (id, o) => { updated.push([id, o]); return { id, ...o }; },
    query: async () => [],
  },
  windows: { update: async () => ({}) },
};

let fetchImpl = null;
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  if (!fetchImpl) throw new Error('unexpected fetch');
  return fetchImpl(url, init);
};

await import('./helpers/wb-virtual.js'); // the background imports wb-virtual:importers
const bg = await import('../src/background/index.js');
void bg;
const keys = await import('../src/core/keys.js');

const SENDERS = {
  app: { id: RUNTIME_ID, tab, url: 'https://app.iterable.com/users/profiles/x', origin: 'https://app.iterable.com', frameId: 0 },
  bee: { id: RUNTIME_ID, tab, url: 'https://app.getbee.io/editor', origin: 'https://app.getbee.io', frameId: 4 },
  auth: { id: RUNTIME_ID, tab, url: 'https://auth.iterable.com/u/login', origin: 'https://auth.iterable.com', frameId: 0 },
  popup: { id: RUNTIME_ID, url: EXT_BASE + 'popup.html' },
  options: { id: RUNTIME_ID, tab, url: EXT_BASE + 'options.html' },
  evil: { id: RUNTIME_ID, tab, url: 'https://evil.example/', origin: 'https://evil.example' },
  otherExt: { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' },
};

/** Dispatch like the browser does. Resolves the response, or NO_RESPONSE if the listener declined. */
function dispatch(msg, sender = SENDERS.app) {
  return new Promise((resolve) => {
    let responded = false;
    const ret = listeners.message(msg, sender, (r) => { responded = true; resolve(clone(r)); });
    if (ret !== true && !responded) resolve('NO_RESPONSE');
  });
}

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('background router', () => {
  beforeEach(async () => {
    for (const k of Object.keys(store)) delete store[k];
    fetchImpl = null;
    fetchCalls.length = 0;
    created.length = 0;
    updated.length = 0;
    contexts = [];
    await keys.setKey({ projectKey: 'us:18244', name: 'Prod', apiKey: KEY_US });
    await keys.setKey({ projectKey: 'eu:77', name: 'EU', apiKey: KEY_EU });
  });

  test('listeners registered synchronously at import', () => {
    assert.equal(typeof listeners.message, 'function');
    assert.equal(typeof listeners.installed, 'function');
  });

  test('wb:api happy path: host from data center, Api-Key header, hardened fetch options, no key in response', async () => {
    fetchImpl = async () => jsonResponse(200, { user: { email: 'a+b@example.com' }, echo: KEY_US });
    const res = await dispatch({
      type: 'wb:api', projectKey: 'us:18244', method: 'GET',
      path: '/api/users/byEmail/' + encodeURIComponent('a+b@example.com'), query: { x: 1 },
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.data.user.email, 'a+b@example.com');
    assert.equal(res.data.echo, '0123\u2026cdef', 'echoed key is redacted');
    assert.ok(!JSON.stringify(res).includes(KEY_US));

    const { url, init } = fetchCalls[0];
    assert.equal(url, 'https://api.iterable.com/api/users/byEmail/a%2Bb%40example.com?x=1');
    assert.equal(init.headers['Api-Key'], KEY_US);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('wb:api EU project goes to api.eu.iterable.com with the EU key and JSON body', async () => {
    fetchImpl = async () => jsonResponse(200, { code: 'Success' });
    const res = await dispatch({ type: 'wb:api', projectKey: 'eu:77', method: 'POST', path: '/api/users/update', body: { email: 'x@y.z' } }, SENDERS.popup);
    assert.equal(res.ok, true);
    assert.equal(fetchCalls[0].url, 'https://api.eu.iterable.com/api/users/update');
    assert.equal(fetchCalls[0].init.headers['Api-Key'], KEY_EU);
    assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(fetchCalls[0].init.body, '{"email":"x@y.z"}');
  });

  test('wb:api HTTP errors, Retry-After, non-JSON bodies', async () => {
    fetchImpl = async () => jsonResponse(429, { code: 'RateLimitExceeded', msg: 'slow down' }, { 'retry-after': '7' });
    let res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'DELETE', path: '/api/users/byEmail/a%40b.c' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.equal(res.retryAfterMs, 7000);
    assert.equal(res.error.code, 'HTTP');
    assert.match(res.error.message, /429.*RateLimitExceeded: slow down/);
    assert.equal(fetchCalls.length, 1, 'background never retries');

    fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 502 });
    res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/x' });
    assert.equal(res.status, 502);
    assert.equal(res.data, '<html>bad gateway</html>');
    assert.equal(res.retryAfterMs, undefined);

    fetchImpl = async () => new Response(null, { status: 204 });
    res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'DELETE', path: '/api/x' });
    assert.deepEqual(res, { ok: true, status: 204, data: null });
  });

  test('wb:api NO_KEY, BAD_REQUEST, NETWORK, TIMEOUT', async () => {
    let res = await dispatch({ type: 'wb:api', projectKey: 'us:1', method: 'GET', path: '/api/x' });
    assert.equal(res.error.code, 'NO_KEY');

    for (const path of ['/api/../x', 'https://evil.example/api/x', '/api/%2e%2e/x', '/api/a\\b']) {
      res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'BAD_REQUEST', path);
    }
    assert.equal(fetchCalls.length, 0, 'invalid requests never reach fetch');

    fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/x' });
    assert.equal(res.error.code, 'NETWORK');
    assert.equal(res.status, 0);
    assert.ok(!JSON.stringify(res).includes(KEY_US));

    fetchImpl = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const t0 = Date.now();
    res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/slow', timeoutMs: 1 });
    assert.equal(res.error.code, 'TIMEOUT');
    assert.ok(Date.now() - t0 >= 900, 'timeout clamped to >= 1s');
  });

  test('wb:api failures while reading the body are NETWORK/TIMEOUT with status 0 (§6)', async () => {
    const failingBody = (status) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"par')); c.error(new TypeError('connection reset')); },
    }), { status });
    for (const status of [200, 500]) {
      fetchImpl = async () => failingBody(status);
      const res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'POST', path: '/api/users/update', body: { a: 1 } });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0, 'status 0 even though HTTP ' + status + ' arrived');
      assert.equal(res.error.code, 'NETWORK');
      assert.match(res.error.message, new RegExp('HTTP ' + status));
    }

    fetchImpl = async () => new Response('x', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
    let res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/big' });
    assert.equal(res.status, 0);
    assert.equal(res.error.code, 'NETWORK');

    // Headers arrive, then the body stalls until the timeout aborts the read.
    fetchImpl = async (url, init) => new Response(new ReadableStream({
      start(c) { init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
    }), { status: 202 });
    res = await dispatch({ type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/slow-body', timeoutMs: 1000 });
    assert.equal(res.status, 0);
    assert.equal(res.error.code, 'TIMEOUT');
    const { isOutcomeUnknown } = await import('../src/core/retry.js');
    assert.equal(isOutcomeUnknown(res), true);
  });

  test('wb:api refuses a stored key whose data center disagrees with the projectKey', async () => {
    store['wb:keys'].projects['us:5'] = { name: 'x', dataCenter: 'eu', apiKey: KEY_EU, savedAt: 'x', lastTest: null };
    const res = await dispatch({ type: 'wb:api', projectKey: 'us:5', method: 'GET', path: '/api/x' });
    assert.equal(res.error.code, 'NO_KEY');
    assert.equal(fetchCalls.length, 0);
  });

  test('sender policy', async () => {
    fetchImpl = async () => jsonResponse(200, {});
    const api = { type: 'wb:api', projectKey: 'us:18244', method: 'GET', path: '/api/x' };
    assert.equal(await dispatch(api, SENDERS.evil), 'NO_RESPONSE');
    assert.equal(await dispatch(api, SENDERS.otherExt), 'NO_RESPONSE');
    const fromBee = await dispatch(api, SENDERS.bee);
    assert.equal(fromBee.ok, false);
    assert.equal(fromBee.error.code, 'BAD_REQUEST');
    assert.equal(fetchCalls.length, 0);
    assert.equal((await dispatch(api, SENDERS.options)).ok, true);

    const test = await dispatch({ type: 'wb:keys:test', projectKey: 'us:18244' }, SENDERS.app);
    assert.equal(test.ok, false);
    assert.equal(fetchCalls.length, 1, 'content cannot trigger a key test');

    const status = await dispatch({ type: 'wb:keys:status', projectKey: 'us:18244' }, SENDERS.bee);
    assert.equal(status.hasKey, false);
    assert.ok(status.error);

    // Sign-in page content script: refused for the API and key status, never fetches.
    const fromAuth = await dispatch(api, SENDERS.auth);
    assert.equal(fromAuth.ok, false);
    assert.equal(fromAuth.error.code, 'BAD_REQUEST');
    const authStatus = await dispatch({ type: 'wb:keys:status', projectKey: 'us:18244' }, SENDERS.auth);
    assert.equal(authStatus.hasKey, false);
    assert.equal(authStatus.masked, '');
    assert.ok(authStatus.error);
    assert.equal((await dispatch({ type: 'wb:keys:test', projectKey: 'us:18244' }, SENDERS.auth)).ok, false);
    assert.equal(fetchCalls.length, 1, 'no fetch from a sign-in page');
  });

  test('registers its settings / permission listeners for the optional content-script sync', () => {
    assert.equal(typeof listeners.storage, 'function');
    assert.equal(typeof listeners.permAdded, 'function');
    assert.equal(typeof listeners.permRemoved, 'function');
    // No chrome.scripting in this fake (real builds have it: login-autofill runs in the 'auth'
    // frame, so the build adds "scripting"). Without it the sync must be a harmless no-op.
    listeners.storage({ 'wb:settings': { newValue: {} } }, 'local');
    listeners.permAdded({ origins: ['https://auth.iterable.com/*'] });
  });

  test('unknown or malformed messages are ignored', async () => {
    for (const m of [null, 'wb:api', {}, { type: 5 }, { type: 'wb:tab:status' }, { type: 'toString' }, { type: 'constructor' }]) {
      assert.equal(await dispatch(m, SENDERS.popup), 'NO_RESPONSE', JSON.stringify(m));
    }
  });

  test('wb:keys:status is masked', async () => {
    const res = await dispatch({ type: 'wb:keys:status', projectKey: 'us:18244' });
    assert.deepEqual(res, { hasKey: true, masked: '0123\u2026cdef', name: 'Prod' });
    assert.deepEqual(await dispatch({ type: 'wb:keys:status', projectKey: 'us:404' }), { hasKey: false, masked: '', name: '' });
    assert.deepEqual(await dispatch({ type: 'wb:keys:status', projectKey: '../x' }), { hasKey: false, masked: '', name: '' });
  });

  test('wb:keys:test: GET /api/channels, records definitive results only', async () => {
    fetchImpl = async () => jsonResponse(200, { channels: [] });
    let res = await dispatch({ type: 'wb:keys:test', projectKey: 'eu:77' }, SENDERS.options);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.match(res.message, /api\.eu\.iterable\.com/);
    assert.equal(fetchCalls[0].url, 'https://api.eu.iterable.com/api/channels');
    assert.equal(fetchCalls[0].init.method, 'GET');
    assert.equal(store['wb:keys'].projects['eu:77'].lastTest.ok, true);

    fetchImpl = async () => jsonResponse(401, { code: 'BadApiKey', msg: 'Invalid API key' });
    res = await dispatch({ type: 'wb:keys:test', projectKey: 'us:18244' }, SENDERS.popup);
    assert.deepEqual([res.ok, res.status], [false, 401]);
    assert.match(res.message, /rejected this key/);
    assert.deepEqual(
      [store['wb:keys'].projects['us:18244'].lastTest.ok, store['wb:keys'].projects['us:18244'].lastTest.status],
      [false, 401]);

    fetchImpl = async () => jsonResponse(403, {});
    res = await dispatch({ type: 'wb:keys:test', projectKey: 'us:18244' }, SENDERS.popup);
    assert.match(res.message, /server-side key/);

    // A network failure says nothing about the key: previous result stays.
    fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    res = await dispatch({ type: 'wb:keys:test', projectKey: 'eu:77' }, SENDERS.options);
    assert.equal(res.ok, false);
    assert.match(res.message, /Couldn.t reach api\.eu\.iterable\.com/);
    assert.equal(store['wb:keys'].projects['eu:77'].lastTest.ok, true);

    res = await dispatch({ type: 'wb:keys:test', projectKey: 'us:404' }, SENDERS.options);
    assert.deepEqual(res, { ok: false, status: 0, message: 'No key saved for this project.' });
    assert.ok(!JSON.stringify(res).includes(KEY_US));
  });

  test('wb:open-options: create, focus existing, reject bad sections', async () => {
    let res = await dispatch({ type: 'wb:open-options', section: 'keys', params: { projectKey: 'us:18244' } });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(created.pop(), { url: EXT_BASE + 'options.html#keys?projectKey=us%3A18244' });

    contexts = [{ contextType: 'TAB', tabId: 12, windowId: 3, documentUrl: EXT_BASE + 'options.html#features' }];
    res = await dispatch({ type: 'wb:open-options', section: 'import' }, SENDERS.bee);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(updated.pop(), [12, { active: true, url: EXT_BASE + 'options.html#import' }]);
    assert.equal(created.length, 0);

    res = await dispatch({ type: 'wb:open-options', section: 'javascript:alert(1)' });
    assert.equal(res.ok, false);
    res = await dispatch({ type: 'wb:open-options', section: 'keys', params: { a: { nested: 1 } } });
    assert.equal(res.ok, false);
  });

  test('onInstalled opens the welcome page only on install', async () => {
    listeners.installed({ reason: 'update', previousVersion: '0.0.1' });
    listeners.installed({ reason: 'chrome_update' });
    assert.equal(created.length, 0);
    listeners.installed({ reason: 'install' });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(created.pop(), { url: EXT_BASE + 'options.html#welcome' });
  });

  test('onInstalled reason update runs newly available mappers on stashed legacy settings', async () => {
    const stashKey = 'wb:legacy:templatequicksearch';
    store[stashKey] = {
      name: 'Iterable Template Quick Search',
      storage: { iterableQuickSearchTags: JSON.stringify([{ id: 't1', label: 'Promo', colorGradient: { start: '#000000', end: '#ffffff' } }]) },
      savedAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
    };
    const before = clone(store['wb:settings']);
    listeners.installed({ reason: 'update', previousVersion: '0.0.1' });
    for (let i = 0; i < 50 && store[stashKey].status !== 'imported'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store[stashKey].status, 'imported');
    assert.equal(store[stashKey].featureId, 'quick-search');
    assert.equal(store[stashKey].announced, false); // the options page toasts it later
    assert.deepEqual(store['wb:settings'].features['quick-search'].values.tags.map((t) => t.label), ['Promo']);
    delete store[stashKey];
    if (before === undefined) delete store['wb:settings']; else store['wb:settings'] = before;
  });
});

// ---------------------------------------------------------------------------
// Content client (src/core/api.js) → background, end to end
// ---------------------------------------------------------------------------

describe('content api client', async () => {
  const api = await import('../src/core/api.js');
  let sendImpl;
  globalThis.chrome.runtime.sendMessage = (msg) => sendImpl(msg);

  beforeEach(async () => {
    for (const k of Object.keys(store)) delete store[k];
    fetchImpl = null;
    fetchCalls.length = 0;
    sendImpl = (msg) => dispatch(msg, SENDERS.app).then((r) => (r === 'NO_RESPONSE' ? undefined : r));
    await keys.setKey({ projectKey: 'us:18244', name: 'Prod', apiKey: KEY_US });
  });

  test('apiRequest round-trips and unwrap returns data', async () => {
    fetchImpl = async () => jsonResponse(200, { ok: 1 });
    const res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
    assert.deepEqual(res, { ok: true, status: 200, data: { ok: 1 } });
    assert.deepEqual(api.unwrap(res), { ok: 1 });
  });

  test('errors resolve (never reject); unwrap throws ApiError with code/status/retryAfterMs', async () => {
    fetchImpl = async () => jsonResponse(429, { msg: 'slow' }, { 'retry-after': '3' });
    const res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
    assert.equal(res.ok, false);
    assert.throws(() => api.unwrap(res), (e) => e instanceof api.ApiError && e.code === 'HTTP' && e.status === 429 && e.retryAfterMs === 3000);
    const bad = await api.apiRequest({ projectKey: 'us:18244', path: '/api/../x' });
    assert.equal(bad.error.code, 'BAD_REQUEST');
  });

  test('messaging failures map to NETWORK', async () => {
    sendImpl = async () => { throw new Error('Extension context invalidated.'); };
    let res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.equal(res.error.code, 'NETWORK');
    assert.match(res.error.message, /Refresh this page/);

    sendImpl = () => { throw new Error('Extension context invalidated.'); }; // synchronous throw
    res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
    assert.equal(res.error.code, 'NETWORK');

    sendImpl = async () => undefined; // nobody answered
    res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
    assert.equal(res.error.code, 'NETWORK');

    const id = globalThis.chrome.runtime.id;
    globalThis.chrome.runtime.id = undefined; // what an orphaned content script sees
    try {
      res = await api.apiRequest({ projectKey: 'us:18244', path: '/api/channels' });
      assert.equal(res.error.code, 'NETWORK');
      const st = await api.keyStatus('us:18244');
      assert.equal(st.hasKey, false);
      assert.equal(st.error.code, 'NETWORK');
      assert.equal((await api.openOptions('keys')).ok, false);
    } finally {
      globalThis.chrome.runtime.id = id;
    }
  });

  test('keyStatus and openOptions', async () => {
    assert.deepEqual(await api.keyStatus('us:18244'), { hasKey: true, masked: '0123\u2026cdef', name: 'Prod' });
    assert.deepEqual(await api.openOptions('keys', { projectKey: 'us:18244' }), { ok: true });
    assert.equal((await api.openOptions('Bad Section')).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Capture page stash (wb:capture:open / wb:capture:take): PNGs go to capture.html, never the page
// ---------------------------------------------------------------------------

describe('capture page stash', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOWXwAAAABJRU5ErkJggg==';
  const CAPTURE_URL = EXT_BASE + 'capture.html';
  const pageSender = (hash = '') => ({ id: RUNTIME_ID, tab, url: CAPTURE_URL + hash });
  beforeEach(() => { created.length = 0; });

  test('app content script (top frame): stashes, opens capture.html#<id> next to the tab; claimed once', async () => {
    const res = await dispatch({ type: 'wb:capture:open', dataUrl: PNG, name: 'approval-123-view.png' }, SENDERS.app);
    assert.deepEqual(res, { ok: true });
    assert.equal(created.length, 1);
    const url = created[0].url;
    assert.ok(url.startsWith(CAPTURE_URL + '#'), url);
    assert.ok(!url.includes('base64') && !url.includes('iVBOR'), 'the image never goes into the URL');
    assert.equal(created[0].openerTabId, tab.id);
    const id = url.split('#')[1];
    const got = await dispatch({ type: 'wb:capture:take', id }, pageSender());
    assert.deepEqual(got, { ok: true, dataUrl: PNG, name: 'approval-123-view.png' });
    const again = await dispatch({ type: 'wb:capture:take', id }, pageSender());
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'GONE');
  });

  test('the popup may hand over a capture too; a bad name falls back to the default', async () => {
    const res = await dispatch({ type: 'wb:capture:open', dataUrl: PNG, name: '../../evil.exe' }, SENDERS.popup);
    assert.equal(res.ok, true);
    const id = created[0].url.split('#')[1];
    assert.equal((await dispatch({ type: 'wb:capture:take', id }, pageSender('#' + id))).name, 'loophole-capture.png');
  });

  test('refused: BEE / sign-in / foreign senders, subframes, extra fields, non-PNG, bad base64, oversize', async () => {
    for (const s of [SENDERS.bee, SENDERS.auth]) {
      const r = await dispatch({ type: 'wb:capture:open', dataUrl: PNG }, s);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'BAD_REQUEST');
    }
    assert.equal(await dispatch({ type: 'wb:capture:open', dataUrl: PNG }, SENDERS.evil), 'NO_RESPONSE');
    assert.equal(await dispatch({ type: 'wb:capture:open', dataUrl: PNG }, SENDERS.otherExt), 'NO_RESPONSE');
    const sub = { ...SENDERS.app, frameId: 3 };
    for (const [msg, sender] of [
      [{ type: 'wb:capture:open', dataUrl: PNG }, sub],
      [{ type: 'wb:capture:open', dataUrl: PNG, extra: 1 }, SENDERS.app],
      [{ type: 'wb:capture:open', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, SENDERS.app],
      [{ type: 'wb:capture:open', dataUrl: 'data:image/png;base64,<script>' }, SENDERS.app],
      [{ type: 'wb:capture:open', dataUrl: 'data:image/png;base64,' }, SENDERS.app],
      [{ type: 'wb:capture:open', dataUrl: 42 }, SENDERS.app],
    ]) {
      const r = await dispatch(msg, sender);
      assert.equal(r.ok, false, JSON.stringify(msg).slice(0, 80));
      assert.equal(r.error.code, 'BAD_REQUEST');
    }
    assert.equal(created.length, 0, 'no tab opened for a refused capture');
  });

  test('wb:capture:take: only capture.html itself, only a UUID', async () => {
    await dispatch({ type: 'wb:capture:open', dataUrl: PNG }, SENDERS.app);
    const id = created[0].url.split('#')[1];
    for (const [msg, sender] of [
      [{ type: 'wb:capture:take', id }, SENDERS.popup],
      [{ type: 'wb:capture:take', id }, SENDERS.options],
      [{ type: 'wb:capture:take', id }, SENDERS.app],
      [{ type: 'wb:capture:take', id: 'not-a-uuid' }, pageSender()],
      [{ type: 'wb:capture:take', id, x: 1 }, pageSender()],
    ]) {
      const r = await dispatch(msg, sender);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'BAD_REQUEST');
    }
    // Still claimable by the page after all the refusals.
    assert.equal((await dispatch({ type: 'wb:capture:take', id }, pageSender())).ok, true);
  });

  test('at most a few captures are kept (oldest dropped)', async () => {
    for (let i = 0; i < 6; i++) await dispatch({ type: 'wb:capture:open', dataUrl: PNG }, SENDERS.app);
    const ids = created.map((c) => c.url.split('#')[1]);
    assert.equal((await dispatch({ type: 'wb:capture:take', id: ids[0] }, pageSender())).ok, false);
    assert.equal((await dispatch({ type: 'wb:capture:take', id: ids[5] }, pageSender())).ok, true);
  });
});
