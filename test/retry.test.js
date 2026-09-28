import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendWithRetry, RateLimiter, parseRetryAfter, DEFAULT_BACKOFFS, DEFAULT_RETRYABLE, DEFAULT_FATAL,
  isLocalRefusal, isOutcomeUnknown, MAX_TIMER_MS, sleep,
} from '../src/core/retry.js';

/** send() that returns the queued responses in order (or throws Error instances). */
function scripted(...responses) {
  let i = 0;
  const fn = async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = () => i;
  return fn;
}

function recorder() {
  const waits = [];
  return { waits, wait: async (ms) => { waits.push(ms); } };
}

test('returns data on the first success without waiting', async () => {
  const w = recorder();
  const res = await sendWithRetry(scripted({ ok: true, status: 200, data: { a: 1 } }), { wait: w.wait });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { a: 1 });
  assert.equal(res.attempts, 1);
  assert.deepEqual(w.waits, []);
});

test('retries 429, 5xx, status 0 and thrown network errors with the backoff schedule', async () => {
  const w = recorder();
  const send = scripted(
    { ok: false, status: 429 },
    { ok: false, status: 503 },
    { ok: false, status: 0, error: { code: 'NETWORK', message: 'x' } },
    new Error('socket hang up'),
    { ok: true, status: 200, data: 'done' },
  );
  const retries = [];
  const res = await sendWithRetry(send, { wait: w.wait, onRetry: (r) => retries.push(r.status) });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 5);
  assert.deepEqual(w.waits, [2000, 4000, 8000, 16000]);
  assert.deepEqual(retries, [429, 503, 0, 0]);
});

test('Retry-After raises the wait but never lowers it', async () => {
  const w = recorder();
  await sendWithRetry(scripted(
    { ok: false, status: 429, retryAfterMs: 10_000 },
    { ok: false, status: 429, retryAfterMs: 500 },
    { ok: true, status: 200 },
  ), { wait: w.wait });
  assert.deepEqual(w.waits, [10_000, 4000]);
});

test('gives up after the backoff budget is spent', async () => {
  const w = recorder();
  const send = scripted({ ok: false, status: 500, error: { code: 'HTTP', message: 'boom' } });
  const res = await sendWithRetry(send, { wait: w.wait, backoffs: [1, 2] });
  assert.equal(res.ok, false);
  assert.equal(res.fatal, false);
  assert.equal(res.status, 500);
  assert.equal(res.attempts, 3);
  assert.equal(send.calls(), 3);
  assert.deepEqual(w.waits, [1, 2]);
});

test('non-retryable 4xx returns immediately; 401/403 are fatal by default', async () => {
  const w = recorder();
  const bad = await sendWithRetry(scripted({ ok: false, status: 400 }), { wait: w.wait });
  assert.equal(bad.ok, false);
  assert.equal(bad.fatal, false);
  assert.equal(bad.attempts, 1);
  const unauth = await sendWithRetry(scripted({ ok: false, status: 401 }), { wait: w.wait });
  assert.equal(unauth.fatal, true);
  assert.deepEqual(w.waits, []);
});

test('retryable and fatal policies accept arrays or predicates', async () => {
  const w = recorder();
  const send = scripted({ ok: false, status: 409 }, { ok: true, status: 200 });
  const res = await sendWithRetry(send, { wait: w.wait, retryable: [409], backoffs: [5] });
  assert.equal(res.ok, true);
  assert.deepEqual(w.waits, [5]);

  const fatal = await sendWithRetry(scripted({ ok: false, status: 503 }), { wait: w.wait, fatal: (s) => s === 503 });
  assert.equal(fatal.fatal, true);
  assert.equal(fatal.attempts, 1);
});

const NO_KEY = { ok: false, status: 0, error: { code: 'NO_KEY', message: 'No API key saved' } };
const BAD_REQUEST = { ok: false, status: 0, error: { code: 'BAD_REQUEST', message: 'bad path' } };
const TIMEOUT = { ok: false, status: 0, error: { code: 'TIMEOUT', message: 't' } };

test('NO_KEY and BAD_REQUEST are fatal by default and never retried', async () => {
  for (const r of [NO_KEY, BAD_REQUEST]) {
    const w = recorder();
    const send = scripted(r, { ok: true, status: 200 });
    const res = await sendWithRetry(send, { wait: w.wait });
    assert.equal(res.ok, false);
    assert.equal(res.fatal, true);
    assert.equal(res.status, 0);
    assert.equal(res.error.code, r.error.code);
    assert.equal(send.calls(), 1);
    assert.deepEqual(w.waits, []);
  }
});

test('a local refusal is not retried even when a custom policy would retry status 0', async () => {
  const w = recorder();
  const send = scripted(NO_KEY, { ok: true, status: 200 });
  const res = await sendWithRetry(send, { wait: w.wait, retryable: [0], fatal: () => false });
  assert.equal(res.ok, false);
  assert.equal(res.fatal, false);
  assert.equal(send.calls(), 1);
});

test('NETWORK / TIMEOUT stay retryable by default and can be excluded by a policy', async () => {
  const w = recorder();
  const ok = await sendWithRetry(scripted(TIMEOUT, { ok: true, status: 200 }), { wait: w.wait });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2);
  const noUnknownRetry = await sendWithRetry(scripted(TIMEOUT, { ok: true, status: 200 }),
    { wait: w.wait, retryable: (s) => s === 429 });
  assert.equal(noUnknownRetry.ok, false);
  assert.equal(noUnknownRetry.attempts, 1);
});

test('policies receive (status, response) with the error code; onRetry gets the response', async () => {
  const w = recorder();
  const seen = [];
  const retried = [];
  await sendWithRetry(scripted(TIMEOUT, { ok: false, status: 502, error: { code: 'HTTP', message: 'x' } }, { ok: true, status: 200 }), {
    wait: w.wait,
    retryable: (status, response) => { seen.push([status, response.error.code]); return true; },
    fatal: (status, response) => { seen.push(['fatal?', response.error.code]); return false; },
    onRetry: ({ response }) => retried.push(response.error.code),
  });
  assert.deepEqual(seen, [['fatal?', 'TIMEOUT'], [0, 'TIMEOUT'], ['fatal?', 'HTTP'], [502, 'HTTP']]);
  assert.deepEqual(retried, ['TIMEOUT', 'HTTP']);
});

test('default predicates and helpers', () => {
  assert.equal(DEFAULT_RETRYABLE(0, TIMEOUT), true);
  assert.equal(DEFAULT_RETRYABLE(0, NO_KEY), false);
  assert.equal(DEFAULT_RETRYABLE(0), true);              // bare status 0: unknown outcome
  assert.equal(DEFAULT_RETRYABLE(429), true);
  assert.equal(DEFAULT_RETRYABLE(404), false);
  assert.equal(DEFAULT_FATAL(403), true);
  assert.equal(DEFAULT_FATAL(0, BAD_REQUEST), true);
  assert.equal(DEFAULT_FATAL(0, TIMEOUT), false);
  assert.equal(isLocalRefusal(NO_KEY), true);
  assert.equal(isLocalRefusal(TIMEOUT), false);
  assert.equal(isOutcomeUnknown(TIMEOUT), true);
  assert.equal(isOutcomeUnknown({ ok: false, status: 0 }), true);
  assert.equal(isOutcomeUnknown(NO_KEY), false);
  assert.equal(isOutcomeUnknown({ ok: false, status: 500 }), false);
});

test('abort stops before the next attempt', async () => {
  const ac = new AbortController();
  const send = scripted({ ok: false, status: 500 });
  await assert.rejects(
    sendWithRetry(send, { signal: ac.signal, wait: async () => { ac.abort(); } }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(send.calls(), 1);
});

test('default backoff schedule matches the User Push script', () => {
  assert.deepEqual([...DEFAULT_BACKOFFS], [2000, 4000, 8000, 16000, 32000]);
});

test('RateLimiter spaces request starts by 1/rate seconds', async () => {
  let now = 1_000_000;
  const waits = [];
  const limiter = new RateLimiter(4, { now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
  await limiter.throttle();
  await limiter.throttle();
  now += 100;
  await limiter.throttle();
  assert.deepEqual(waits, [250, 150]);
  const free = new RateLimiter(0, { now: () => now, wait: async (ms) => { waits.push(ms); } });
  await free.throttle(); await free.throttle();
  assert.equal(waits.length, 2);
});

test('parseRetryAfter handles seconds, HTTP dates and junk', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('0'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), null);
});

test('parseRetryAfter is strict and capped (shared with the background parser)', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  for (const junk of ['soon 2099', 'soon 2099 GMT', 'Thursday, 01-Jan-99 00:00:05 GMT', 'May 2030', '1.5', '-3', '3s', 'Thu, 01 Jan 2099 00:00:05']) {
    assert.equal(parseRetryAfter(junk, now), null, junk);
  }
  assert.equal(parseRetryAfter('9'.repeat(400), now), 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT', now), 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfter(7, now), 7000);
});

test('a huge Retry-After is capped at 24 h and sleep never overflows setTimeout', async () => {
  const waits = [];
  const send = scripted({ ok: false, status: 429, retryAfterMs: Infinity }, { ok: true, status: 200 });
  const r = await sendWithRetry(send, { backoffs: [10], wait: async (ms) => { waits.push(ms); } });
  assert.equal(r.ok, true);
  assert.deepEqual(waits, [24 * 60 * 60 * 1000]);   // capped, never Infinity
  const waits2 = [];
  await sendWithRetry(scripted({ ok: false, status: 429, retryAfterMs: 10 ** 12 }, { ok: true, status: 200 }),
    { backoffs: [10], wait: async (ms) => { waits2.push(ms); } });
  assert.deepEqual(waits2, [24 * 60 * 60 * 1000]);
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1);
  const ac = new AbortController();
  const p = sleep(1e15, ac.signal);   // would fire immediately if passed to setTimeout unclamped
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  ac.abort();
  await assert.rejects(p);
});
