import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFetch, HttpError } from '../src/core/http.js';

// appFetch against a stubbed fetch; no network. Synthetic data only.
function stubFetch(t, { status = 200, body = '', headers = {} }) {
  const prevDoc = globalThis.document;
  globalThis.document = { cookie: '' };
  t.after(() => { globalThis.document = prevDoc; });
  t.mock.method(globalThis, 'fetch', async () => new Response(body || null, { status, headers }));
}

test('appFetch: 2xx parses JSON', async (t) => {
  stubFetch(t, { body: '{"a":1}' });
  assert.deepEqual(await appFetch('/x'), { a: 1 });
});

test('appFetch: non-2xx throws HttpError with status and retryAfterMs (seconds)', async (t) => {
  stubFetch(t, { status: 429, body: '{"msg":"slow down"}', headers: { 'Retry-After': '7' } });
  await assert.rejects(appFetch('/x'), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterMs, 7000);
    assert.deepEqual(e.body, { msg: 'slow down' });
    return true;
  });
});

test('appFetch: Retry-After as an HTTP date', async (t) => {
  const when = new Date(Date.now() + 30_000).toUTCString();
  stubFetch(t, { status: 503, headers: { 'Retry-After': when } });
  await assert.rejects(appFetch('/x'), (e) => {
    assert.equal(e.status, 503);
    // Second resolution in the header: within (0, 30 s].
    assert.ok(e.retryAfterMs > 25_000 && e.retryAfterMs <= 30_000, String(e.retryAfterMs));
    return true;
  });
});

test('appFetch: missing or junk Retry-After → retryAfterMs null', async (t) => {
  stubFetch(t, { status: 500 });
  await assert.rejects(appFetch('/x'), (e) => e.status === 500 && e.retryAfterMs === null);
  t.mock.restoreAll();
  stubFetch(t, { status: 429, headers: { 'Retry-After': 'soon' } });
  await assert.rejects(appFetch('/x'), (e) => e.status === 429 && e.retryAfterMs === null);
});
