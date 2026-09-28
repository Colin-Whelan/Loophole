import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Run } from '../../src/features/bulk-data/engine.js';
import { buildUser, countCleared, collectPartialFailures, usersBatchRequest } from '../../src/features/bulk-data/logic.js';
import { sendBatch, boundRequest, RUN_FATAL } from '../../src/features/bulk-data/requests.js';

// Synthetic data only.
function csvBlob(n, { header = 'email,plan', row = (i) => `user${i}@example.com,p${i}` } = {}) {
  const lines = [header];
  for (let i = 1; i <= n; i++) lines.push(row(i));
  return new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
}

function memoryStore() {
  const s = { saved: [], cleared: 0, last: null };
  return { s, api: { save: async (d) => { s.saved.push(d); s.last = d; }, clear: async () => { s.cleared++; s.last = null; } } };
}

function makeRun(file, overrides = {}) {
  const store = memoryStore();
  const logs = [];
  const sent = [];
  const run = new Run({
    file, header: ['email', 'plan'], batchSize: 3,
    buildItem: (obj) => buildUser(obj, null, 'email', 'userId', false, null),
    countCleared,
    skipRecord: () => ({ userId: '', email: '' }),
    idsOf: (obj) => ({ userId: '', email: obj.email || '' }),
    sendBatch: async (items) => { sent.push(items); return { ok: true, status: 200, data: { successCount: items.length, failCount: 0 } }; },
    onBatchOk: (res, items, r) => {
      const p = collectPartialFailures(res.data);
      for (const rec of p.records) r.addFailureRecord({ row_number: '', ...rec, detail: '' });
      if (p.fail) r.addFailure('api_reported', p.fail);
      return p;
    },
    checkpoints: store.api,
    checkpointMeta: { projectKey: 'us:1', listId: null },
    onLog: (m, c) => logs.push([c, m]),
    ...overrides,
  });
  return { run, store: store.s, logs, sent };
}

test('streams, batches and finishes; checkpoint cleared at the end', async () => {
  const { run, store, sent } = makeRun(csvBlob(7));
  await run.start();
  assert.equal(run.finished, true);
  assert.deepEqual(sent.map((b) => b.length), [3, 3, 1]);
  assert.deepEqual(sent[0][0], { email: 'user1@example.com', dataFields: { plan: 'p1' } });
  assert.equal(run.stats.sentOk, 7);
  assert.equal(run.committed, 7);
  assert.equal(run.batchNo, 3);
  assert.equal(store.saved.length, 3);
  assert.equal(store.saved[0].committedRows, 3);
  assert.equal(store.saved[0].projectKey, 'us:1');
  assert.equal(store.cleared, 1);
});

test('rows without a key are skipped and recorded, but still committed', async () => {
  const file = csvBlob(4, { row: (i) => (i === 2 ? ',p2' : `user${i}@example.com,p${i}`) });
  const { run, sent } = makeRun(file);
  await run.start();
  assert.equal(run.stats.skipped, 1);
  assert.equal(run.committed, 4);
  assert.deepEqual(sent.map((b) => b.length), [2, 1]);
  assert.deepEqual(run.failures, [{ row_number: 2, userId: '', email: '', reason: 'missing_key', detail: 'row has neither userId nor email' }]);
});

test('stop keeps the checkpoint; a second run resumes after the committed rows', async () => {
  const file = csvBlob(8);
  const first = makeRun(file);
  first.run.cfg.sendBatch = async (items) => {
    first.sent.push(items);
    if (first.sent.length === 1) first.run.stop();
    return { ok: true, status: 200, data: { successCount: items.length } };
  };
  await first.run.start();
  assert.equal(first.run.finished, false);
  assert.equal(first.store.cleared, 0);
  const ck = first.store.last;
  assert.equal(ck.committedRows, 3);

  const second = makeRun(file);
  await second.run.start(ck.committedRows, ck.stats);
  assert.deepEqual(second.sent.flat().map((u) => u.email), ['user4@example.com', 'user5@example.com', 'user6@example.com', 'user7@example.com', 'user8@example.com']);
  assert.equal(second.run.stats.sentOk, 8);   // carried over from the checkpoint
  assert.equal(second.run.batchNo, 3);
  assert.equal(second.run.finished, true);
});

test('pause waits between batches until resume', async () => {
  const { run, sent } = makeRun(csvBlob(6));
  run.cfg.sendBatch = async (items) => { sent.push(items); if (sent.length === 1) run.pause(); return { ok: true, status: 200, data: {} }; };
  const done = run.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
  assert.equal(run.paused, true);
  run.resume();
  await done;
  assert.equal(sent.length, 2);
  assert.equal(run.stats.sentOk, 6); // no counts in the body → whole batch counted ok
});

test('a failed batch is recorded row by row and the run continues', async () => {
  const { run, logs } = makeRun(csvBlob(5));
  let n = 0;
  run.cfg.sendBatch = async (items) => (++n === 1
    ? { ok: false, status: 400, data: { code: 'BadParams', msg: 'bad row user1@example.com' }, error: { code: 'HTTP', message: 'HTTP 400' } }
    : { ok: true, status: 200, data: { successCount: items.length } });
  await run.start();
  assert.equal(run.finished, true);
  assert.equal(run.stats.failed, 3);
  assert.equal(run.stats.failReasons.http_400, 3);
  assert.equal(run.retryRows.length, 3);
  assert.deepEqual(run.failures[0], { row_number: 1, userId: '', email: 'user1@example.com', reason: 'http_400', detail: 'BadParams: bad row user1@example.com' });
  // The on-screen log gets the status and code, never row data.
  const failLine = logs.find(([c]) => c === 'bad')[1];
  assert.match(failLine, /HTTP 400 BadParams/);
  assert.ok(!logs.some(([, m]) => m.includes('@example.com')));
});

test('a fatal status stops the run without committing that batch', async () => {
  const { run, store } = makeRun(csvBlob(9));
  let n = 0;
  run.cfg.sendBatch = async (items) => (++n === 2
    ? { ok: false, status: 401, fatal: true, error: { code: 'HTTP', message: 'HTTP 401' } }
    : { ok: true, status: 200, data: { successCount: items.length } });
  await run.start();
  assert.equal(run.finished, false);
  assert.equal(run.fatal.status, 401);
  assert.equal(n, 2);
  assert.equal(run.committed, 3);           // batch 2 will be re-sent on resume
  assert.equal(store.last.committedRows, 3);
  assert.equal(store.cleared, 0);
});

test('partial failures inside a 200 are counted and listed', async () => {
  const { run } = makeRun(csvBlob(3));
  run.cfg.sendBatch = async () => ({ ok: true, status: 200, data: { successCount: 2, failCount: 1, failedUpdates: { invalidEmails: ['user2@example.com'] } } });
  await run.start();
  assert.equal(run.stats.sentOk, 2);
  assert.equal(run.stats.failed, 1);
  assert.equal(run.failures[0].reason, 'invalidEmails');
});

test('abort (unmount) ends the run like Stop and keeps the checkpoint', async () => {
  const ac = new AbortController();
  const { run, store } = makeRun(csvBlob(9), { signal: ac.signal });
  let n = 0;
  run.cfg.sendBatch = async (items) => { if (++n === 1) ac.abort(); return { ok: true, status: 200, data: { successCount: items.length } }; };
  await run.start();
  assert.equal(run.finished, false);
  assert.equal(store.cleared, 0);
  assert.equal(store.last.committedRows, 3);
});

// ── sendBatch / request policy ─────────────────────────────────────────

function fakeCtx(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    ctx: { api: { request: async (opts) => { calls.push(opts); return responses[Math.min(i++, responses.length - 1)]; } } },
  };
}

function fakeRun() {
  const logs = [];
  return { logs, retries: 0, noteRetry() { this.retries++; }, log(m, c) { logs.push([c, m]); } };
}

test('sendBatch pins the project key and retries 429 and unknown outcomes', async () => {
  const { ctx, calls } = fakeCtx([
    { ok: false, status: 429, retryAfterMs: 10, error: { code: 'HTTP' } },
    { ok: false, status: 0, error: { code: 'TIMEOUT', message: 't' } },
    { ok: true, status: 200, data: { successCount: 1 } },
  ]);
  const run = fakeRun();
  const req = usersBatchRequest([{ email: 'a@example.com' }], {});
  const waits = [];
  const res = await sendBatch({ request: boundRequest(ctx, 'us:9'), path: req.path, body: req.body, run,
    wait: async (ms) => { waits.push(ms); } });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.projectKey === 'us:9'));
  assert.equal(run.retries, 2);
  assert.deepEqual(waits, [2000, 4000]);
  assert.match(run.logs[1][1], /may or may not have been applied/);
  assert.ok(run.logs.every(([c]) => c === 'warn'));
});

test('sendBatch: NO_KEY is fatal, not retried; 401 is fatal', async () => {
  const noKey = fakeCtx([{ ok: false, status: 0, error: { code: 'NO_KEY', message: 'none' } }]);
  const run = fakeRun();
  const r1 = await sendBatch({ request: boundRequest(noKey.ctx, 'us:9'), path: '/api/users/bulkUpdate', body: { users: [] }, run });
  assert.equal(r1.fatal, true);
  assert.equal(r1.status, 0);
  assert.equal(r1.error.code, 'NO_KEY');
  assert.equal(noKey.calls.length, 1);

  const refused = fakeCtx([{ ok: false, status: 0, error: { code: 'BAD_REQUEST', message: 'bad path' } }]);
  const r3 = await sendBatch({ request: boundRequest(refused.ctx, 'us:9'), path: '/api/users/bulkUpdate', body: { users: [] }, run });
  assert.equal(r3.fatal, true);
  assert.equal(refused.calls.length, 1);

  const denied = fakeCtx([{ ok: false, status: 401, error: { code: 'HTTP' } }]);
  const r2 = await sendBatch({ request: boundRequest(denied.ctx, 'us:9'), path: '/api/users/bulkUpdate', body: { users: [] }, run });
  assert.equal(r2.fatal, true);
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.calls[0].timeoutMs, 120000);
});

test('sendBatch: a 200 whose code is not Success is a failure, not retried', async () => {
  const { ctx, calls } = fakeCtx([{ ok: true, status: 200, data: { code: 'BadParams', msg: 'x' } }]);
  const res = await sendBatch({ request: boundRequest(ctx, 'us:9'), path: '/api/lists/subscribe', body: {}, run: fakeRun() });
  assert.equal(res.ok, false);
  assert.equal(res.fatal, false);
  assert.equal(calls.length, 1);
});

test('Stop pressed while the final batch is in flight still counts as finished', async () => {
  const { run, store } = makeRun(csvBlob(5));
  let n = 0;
  run.cfg.sendBatch = async (items) => { if (++n === 2) run.stop(); return { ok: true, status: 200, data: { successCount: items.length } }; };
  await run.start();
  assert.equal(n, 2);
  assert.equal(run.committed, 5);
  assert.equal(run.finished, true);
  assert.equal(store.cleared, 1);
});

test('Stop before the last partial batch leaves it unsent and resumable', async () => {
  const { run, store, sent } = makeRun(csvBlob(5));
  run.cfg.sendBatch = async (items) => { sent.push(items); run.stop(); return { ok: true, status: 200, data: {} }; };
  await run.start();
  assert.equal(sent.length, 1);
  assert.equal(run.finished, false);
  assert.equal(store.last.committedRows, 3);
});
