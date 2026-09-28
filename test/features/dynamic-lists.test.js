import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_SIZE, profileDetailsPath, dynamicListsFrom, segmentQueryBody, isHit,
  mapLimit, findMemberships, ageLabel, ageTone, lastCheckedText, listUrl, cacheStateName, legacyCacheStateNames, userHash, legacyUserHash, readCache,
  writeCache, clampInt, toResponse, failureMessage, MAX_RETRY_AFTER_MS,
} from '../../src/features/dynamic-lists/logic.js';
// The feature reads who is on screen through the shared profile-page reader.
import { profileIdFromPath, pickEmail, emailFromContactRows } from '../../src/lib/iterable/profile-page.js';
import { HttpError } from '../../src/core/http.js';
import { projectSlot } from '../../src/core/state.js';
import { stableHash64 } from '../../src/core/hash.js';
import importer, { mapDynamicLists } from '../../src/features/dynamic-lists/import.js';
import meta from '../../src/features/dynamic-lists/meta.js';
import { decodeStorage } from '../../src/options/importer/decode.js';
import { mergeValues } from '../../src/core/settings.js';
import { RESTORE_NAME_RE } from '../../src/options/importer/backup.js';
import { sendWithRetry } from '../../src/core/retry.js';

// All data synthetic.
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const lists = (n) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), name: `L${i}` }));

test('meta: routes match only the profile Lists tab', () => {
  const m = (p) => meta.routes.some((r) => r.test(p));
  assert.ok(m('/users/profiles/abc123/lists'));
  assert.ok(m('/users/profiles/abc123/lists?page=2'));
  assert.ok(m('/users/profiles/abc123/lists/'));
  assert.ok(!m('/users/profiles/abc123'));
  assert.ok(!m('/users/profiles/abc123/events'));
  assert.ok(!m('/users/profiles/abc123/listsx'));
  assert.ok(!m('/lists/123'));
});

test('meta: settings defaults and bounds', () => {
  const byKey = Object.fromEntries(meta.settings.map((s) => [s.key, s]));
  assert.equal(byKey.autoStart.default, false);
  assert.equal(byKey.batchSize.default, 8);
  assert.deepEqual([byKey.batchSize.min, byKey.batchSize.max], [1, 16]);
  assert.equal(byKey.showProgressBar.default, true);
  assert.equal(byKey.cacheDays.default, 14);
  assert.deepEqual([byKey.cacheDays.min, byKey.cacheDays.max], [1, 60]);
  assert.deepEqual(meta.legacy, ['Iterable Dynamic Lists Checker']);
});

test('profileIdFromPath / profileDetailsPath', () => {
  assert.equal(profileIdFromPath('/users/profiles/abc123/lists'), 'abc123');
  assert.equal(profileIdFromPath('/users/profiles/abc123'), 'abc123');
  assert.equal(profileIdFromPath('/users/profiles/'), '');
  assert.equal(profileIdFromPath('/users/profiles/../lists'), '');
  assert.equal(profileIdFromPath('/campaigns/1'), '');
  assert.equal(profileIdFromPath(undefined), '');
  assert.equal(profileDetailsPath('abc123'), '/users/profiles/abc123/getProfileDetails');
});

test('pickEmail / emailFromContactRows (shared reader)', () => {
  assert.equal(pickEmail([null, 'no', ' a@example.test ']), 'a@example.test');
  assert.equal(pickEmail(['has space@x.test']), null);
  assert.equal(pickEmail(['tab	x@x.test']), null);
  assert.equal(pickEmail([]), null);
  // The "User ID: …" row is skipped even when the userId looks like an email.
  assert.equal(emailFromContactRows([
    { text: 'User ID: id@example.test', titles: ['id@example.test'] },
    { text: 'a@exam…', titles: ['a@example.test'] },
  ]), 'a@example.test');
});

test('dynamicListsFrom keeps Dynamic lists in order, dedupes, tolerates junk', () => {
  const out = dynamicListsFrom({
    userLists: [
      { id: 1, name: 'Static', emailListType: 'Standard' },
      { id: 2, name: ' Dyn A ', emailListType: 'Dynamic' },
      null,
      { id: 3, emailListType: 'Dynamic' },
      { id: 2, name: 'dup', emailListType: 'Dynamic' },
      { name: 'no id', emailListType: 'Dynamic' },
    ],
  });
  assert.deepEqual(out, [{ id: '2', name: 'Dyn A' }, { id: '3', name: 'List 3' }]);
  assert.deepEqual(dynamicListsFrom(null), []);
  assert.deepEqual(dynamicListsFrom({ userLists: 'x' }), []);
});

test('segmentQueryBody matches the userscript shape', () => {
  const b = segmentQueryBody(['7', 8], 'a@example.test');
  assert.equal(b.page, 1);
  assert.equal(b.pageSize, 1);
  assert.equal(b.sorting, 'desc');
  assert.equal(b.searchQuery.combinator, 'And');
  const [or, who] = b.searchQuery.searchQueries;
  assert.equal(or.combinator, 'Or');
  assert.equal(or.searchQueries.length, 2);
  assert.deepEqual(or.searchQueries[1].searchCombo.searchQueries[0],
    { value: '8', dataType: 'user', field: 'userListIds', comparatorType: 'Equals', fieldType: 'long' });
  assert.deepEqual(who.searchQueries[0].searchCombo.searchQueries[0],
    { value: 'a@example.test', dataType: 'user', field: 'email', comparatorType: 'Equals', fieldType: 'string' });
});

test('isHit', () => {
  assert.equal(isHit({ count: 1 }), true);
  assert.equal(isHit({ count: 0 }), false);
  assert.equal(isHit({}), false);
  assert.equal(isHit(null), false);
  assert.equal(isHit('3'), false);
});

test('mapLimit bounds concurrency and stops on abort', async () => {
  let inFlight = 0, peak = 0;
  const done = [];
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--; done.push(x);
  });
  assert.equal(peak, 3);
  assert.equal(done.length, 7);

  const ac = new AbortController();
  const seen = [];
  await assert.rejects(mapLimit([1, 2, 3, 4], 1, async (x) => { seen.push(x); if (x === 2) ac.abort(); }, ac.signal),
    { name: 'AbortError' });
  assert.deepEqual(seen, [1, 2]);
});

function oracle(members) {
  const set = new Set(members);
  const calls = [];
  return {
    calls,
    test: async (ids) => { calls.push(ids.length); return ids.some((id) => set.has(id)); },
  };
}

test('findMemberships: none, some, all; input order kept', async () => {
  const L = lists(75);
  let o = oracle([]);
  let r = await findMemberships(L, { test: o.test, concurrency: 4 });
  assert.deepEqual(r.found, []);
  assert.equal(r.queries, 3);   // ceil(75 / 30) groups, all negative
  assert.deepEqual(o.calls, [30, 30, 15]);

  o = oracle(['1074', '1001', '1040']);
  r = await findMemberships(L, { test: o.test, concurrency: 2 });
  assert.deepEqual(r.found.map((l) => l.id), ['1001', '1040', '1074']);
  assert.equal(r.queries, o.calls.length);

  o = oracle(L.map((l) => l.id).slice(0, 5));
  const progress = [];
  r = await findMemberships(L.slice(0, 5), { test: o.test, groupSize: GROUP_SIZE, onProgress: (p) => progress.push(p.resolved) });
  assert.equal(r.found.length, 5);
  assert.equal(progress.at(-1), 5);
});

test('findMemberships: a single hit costs ~log2 queries, not one per list', async () => {
  const L = lists(30);
  const o = oracle(['1017']);
  const r = await findMemberships(L, { test: o.test });
  assert.deepEqual(r.found.map((l) => l.id), ['1017']);
  assert.ok(r.queries <= 1 + 2 * Math.ceil(Math.log2(30)), `queries=${r.queries}`);
});

test('findMemberships: a failing query rejects the whole search', async () => {
  const L = lists(40);
  await assert.rejects(findMemberships(L, {
    test: async (ids) => { if (ids.length < 30) throw new Error('boom'); return true; },
  }), /boom/);
});

test('findMemberships: abort stops further queries', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(findMemberships(lists(90), {
    concurrency: 1, signal: ac.signal,
    test: async () => { calls++; ac.abort(); return false; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('ageLabel / ageTone / lastCheckedText', () => {
  const now = 10 * DAY;
  assert.equal(ageLabel(now - 10 * 1000, now), 'now');
  assert.equal(ageLabel(now - 12 * MIN, now), '12 min');
  assert.equal(ageLabel(now - 5 * HOUR, now), '5 h');
  assert.equal(ageLabel(now - DAY, now), '1 day');
  assert.equal(ageLabel(now - 3 * DAY - HOUR, now), '3 days');
  assert.equal(ageLabel(now + MIN, now), 'now');   // clock skew
  assert.equal(ageTone(now - HOUR, now), 'ok');
  assert.equal(ageTone(now - 3 * DAY, now), 'warn');
  assert.equal(ageTone(now - 7 * DAY, now), 'bad');
  assert.equal(lastCheckedText(now - 5 * 1000, now), 'Checked just now');
  assert.equal(lastCheckedText(now - MIN, now), 'Last checked 1 minute ago');
  assert.equal(lastCheckedText(now - 2 * HOUR, now), 'Last checked 2 hours ago');
  assert.equal(lastCheckedText(now - 3 * DAY, now), 'Last checked 3 days ago');
});

test('listUrl is relative and encoded', () => {
  assert.equal(listUrl('123'), '/segmentation?emailListId=123');
  assert.equal(listUrl('1&x=2'), '/segmentation?emailListId=1%26x%3D2');
});

test('cacheStateName: projectSlot-based, backup-safe for any project key; legacy name kept for migration', () => {
  assert.equal(cacheStateName('us:18244'), 'cache:' + projectSlot('us:18244'));
  assert.match(cacheStateName('us:18244'), /^cache:p[0-9a-f]{16}$/);
  const n = cacheStateName('us:name:My Project/é');
  assert.match(n, RESTORE_NAME_RE);
  assert.notEqual(n, cacheStateName('us:name:My_Project__'));   // the old sanitising collided
  assert.equal(cacheStateName(''), '');
  assert.deepEqual(legacyCacheStateNames('us:18244'), ['cache:us:18244']);
  assert.deepEqual(legacyCacheStateNames('us:name:My Project/é'), ['cache:us:name:My_Project__']);
  assert.deepEqual(legacyCacheStateNames(''), []);
});

test('userHash: 16 hex, synchronous (no crypto.subtle), stable, differs by project and user', () => {
  const a = userHash('us:1', 'someone@example.test');
  assert.equal(typeof a, 'string');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, stableHash64('us:1' + String.fromCharCode(10) + 'someone@example.test'));
  assert.equal(a, userHash('us:1', 'someone@example.test'));
  assert.notEqual(a, userHash('us:2', 'someone@example.test'));
  assert.notEqual(a, userHash('us:1', 'other@example.test'));
});

test('legacyUserHash: the old SHA-256 key where computable, null where crypto.subtle fails', async () => {
  const old = await legacyUserHash('us:1', 'someone@example.test');
  assert.match(old, /^[0-9a-f]{16}$/);
  assert.notEqual(old, userHash('us:1', 'someone@example.test'));
  const { subtle } = globalThis.crypto;
  const digest = subtle.digest;
  // Firefox content scripts: reading the digest throws (Xray). Simulate a throwing digest.
  subtle.digest = async () => { throw new Error("Permission denied to access property 'constructor'"); };
  try {
    assert.equal(await legacyUserHash('us:1', 'someone@example.test'), null);
  } finally {
    subtle.digest = digest;
  }
});

test('readCache / writeCache: expiry, cap, validation', () => {
  const now = 100 * DAY;
  const maxAgeMs = 14 * DAY;
  const h1 = 'aaaaaaaaaaaaaaaa', h2 = 'bbbbbbbbbbbbbbbb', h3 = 'cccccccccccccccc';
  let c = writeCache(null, h1, [{ id: '1', name: 'A' }, { id: 2 }, null], { now, maxAgeMs });
  assert.deepEqual(readCache(c, h1, { now, maxAgeMs }), { at: now, lists: [{ id: '1', name: 'A' }, { id: '2', name: 'List 2' }] });
  assert.equal(readCache(c, h2, { now, maxAgeMs }), null);
  assert.equal(readCache(c, h1, { now: now + 15 * DAY, maxAgeMs }), null);
  assert.ok(readCache(c, h1, { now: now + 13 * DAY, maxAgeMs }));
  assert.equal(readCache(c, '__proto__', { now, maxAgeMs }), null);
  assert.equal(readCache('junk', h1, { now, maxAgeMs }), null);
  assert.equal(readCache({ users: { [h1]: { at: 'x', lists: [] } } }, h1, { now, maxAgeMs }), null);

  // Expired and malformed entries are dropped on write; the cap keeps the newest.
  c = { v: 1, users: { [h1]: { at: now - 20 * DAY, lists: [] }, [h2]: { at: now - DAY, lists: [] }, bad: { at: now, lists: [] } } };
  c = writeCache(c, h3, [], { now, maxAgeMs });
  assert.deepEqual(Object.keys(c.users).sort(), [h2, h3]);
  c = writeCache(c, h1, [], { now: now + 1, maxAgeMs, maxUsers: 2 });
  assert.deepEqual(Object.keys(c.users).sort(), [h1, h3]);

});

test('clampInt', () => {
  assert.equal(clampInt('20', 1, 16, 8), 16);
  assert.equal(clampInt(0, 1, 16, 8), 1);
  assert.equal(clampInt('x', 1, 16, 8), 8);
  assert.equal(clampInt(3.6, 1, 16, 8), 4);
});

test('toResponse + sendWithRetry: retries 429/5xx, stops on 401/403', async () => {
  assert.deepEqual(toResponse({ status: 429, message: 'HTTP 429' }).status, 429);
  assert.equal(toResponse(new TypeError('Failed to fetch')).error.code, 'NETWORK');

  const run = async (statuses) => {
    let i = 0;
    const res = await sendWithRetry(async () => {
      const st = statuses[i++];
      if (st === 200) return { ok: true, status: 200, data: { count: 1 } };
      return toResponse({ status: st, message: `HTTP ${st}` });
    }, { backoffs: [1, 1, 1], wait: async () => {} });
    return { res, calls: i };
  };
  let { res, calls } = await run([429, 503, 200]);
  assert.equal(res.ok, true);
  assert.equal(calls, 3);
  ({ res, calls } = await run([401]));
  assert.equal(res.fatal, true);
  assert.equal(calls, 1);
  ({ res, calls } = await run([403]));
  assert.equal(res.fatal, true);
  ({ res, calls } = await run([500, 500, 500, 500]));
  assert.equal(res.ok, false);
  assert.equal(res.fatal, false);
  assert.equal(calls, 4);
  ({ res, calls } = await run([400]));
  assert.equal(calls, 1);
});

test('toResponse carries Retry-After (capped) and sendWithRetry waits at least that long', async () => {
  assert.equal(toResponse(new HttpError(429, 'HTTP 429', null, { retryAfterMs: 5000 })).retryAfterMs, 5000);
  assert.equal(toResponse(new HttpError(429, 'HTTP 429', null, { retryAfterMs: 10 * 60 * 1000 })).retryAfterMs, MAX_RETRY_AFTER_MS);
  assert.equal('retryAfterMs' in toResponse(new HttpError(503, 'HTTP 503')), false);

  const waits = [];
  let i = 0;
  const res = await sendWithRetry(async () => {
    if (i++ === 0) return toResponse(new HttpError(429, 'HTTP 429', null, { retryAfterMs: 3000 }));
    return { ok: true, status: 200, data: {} };
  }, { backoffs: [1000, 2000, 4000], wait: async (ms) => { waits.push(ms); } });
  assert.equal(res.ok, true);
  assert.deepEqual(waits, [3000]);
});

test('failureMessage', () => {
  assert.match(failureMessage(401), /session may have expired/);
  assert.match(failureMessage(403), /HTTP 403/);
  assert.match(failureMessage(429), /rate limiting/);
  assert.match(failureMessage(502), /server error/);
  assert.match(failureMessage(0), /network/);
});

// ── import.js ────────────────────────────────────────────────────────────

test('import: settings mapped, batch size clamped, caches skipped', () => {
  const storage = decodeStorage({
    batchSize: 'n20', showProgressBar: 'bfalse', autoStart: 'btrue',
    dynamicLists_abc: 'o' + JSON.stringify(JSON.stringify({ timestamp: 1, lists: [] })),
    dynamicLists_def: 's{"timestamp":1,"lists":[]}',
    dynamicLists_cleared: 'u',
  }, { tagged: true });
  const r = mapDynamicLists(storage);
  assert.deepEqual(r.values, { batchSize: 16, showProgressBar: false, autoStart: true });
  assert.ok(r.notes.some((n) => /lowered from 20 to 16/.test(n)));
  assert.ok(r.notes.some((n) => /Skipped 2 cached results/.test(n)));
  assert.ok(!r.notes.some((n) => /Automatic checks are off/.test(n)));
  assert.equal(r.state, undefined);
  // Mapped values survive settings validation.
  const merged = mergeValues(meta, r.values);
  assert.equal(merged.batchSize, 16);
  assert.equal(merged.autoStart, true);
});

test('import: untoggled autoStart stays off with a note; empty storage imports nothing', () => {
  const r = mapDynamicLists({ batchSize: 4 });
  assert.deepEqual(r.values, { batchSize: 4 });
  assert.ok(r.notes.some((n) => /Automatic checks are off/.test(n)));
  assert.deepEqual(mapDynamicLists({}), { values: {}, notes: [] });
  assert.deepEqual(mapDynamicLists(null), { values: {}, notes: [] });
  const bad = mapDynamicLists({ batchSize: 'lots', autoStart: 'maybe', showProgressBar: 'true' });
  assert.deepEqual(bad.values, { showProgressBar: true });
  assert.ok(bad.notes.some((n) => /could not be read/.test(n)));
  assert.deepEqual(importer.scripts, ['Iterable Dynamic Lists Checker']);
});
