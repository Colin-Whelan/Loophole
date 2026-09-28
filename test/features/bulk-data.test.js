import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCol, detectKeyColumns, inferValue, clearSetOf, isEmptyCell, countCleared, clearFingerprint,
  buildUser, buildSubscriber, usersBatchRequest, toBatches, nextBatchNo, collectPartialFailures,
  isIterableSuccess, classifyFailure, fileFingerprint, checkpointName, scopeOfCheckpointName, pushScope,
  describeScope, otherPushCheckpointNames, failuresCsv, retryCsv, USER_FAILURE_COLUMNS, fmtDuration, fmtBytes,
  clampRate, clampBatch, tsName, neutralizeFormula, createStartGuard, resumeBlocker,
  listCreatedAt, fmtListDate, sortLists, fuzzyListScore, fuzzyMatchLists, LIST_SORTS, DEFAULT_LIST_SORT,
} from '../../src/features/bulk-data/logic.js';
import { parseCsvAll } from '../../src/core/csv.js';

// All data below is synthetic.

// ── Key columns ────────────────────────────────────────────────────────

test('normalizeCol / detectKeyColumns', () => {
  assert.equal(normalizeCol('User_ID'), 'userid');
  assert.equal(normalizeCol(' E mail '), 'email');
  assert.deepEqual(detectKeyColumns(['Email', 'user_id', 'plan']), { userIdCol: 'user_id', emailCol: 'Email' });
  assert.deepEqual(detectKeyColumns(['a', 'b']), { userIdCol: null, emailCol: null });
  // First match wins.
  assert.deepEqual(detectKeyColumns(['email', 'EMAIL']), { userIdCol: null, emailCol: 'email' });
});

// ── inferValue ─────────────────────────────────────────────────────────

test('inferValue: empty cells are omitted', () => {
  assert.equal(inferValue(''), undefined);
  assert.equal(inferValue('   '), undefined);
  assert.equal(inferValue(null), undefined);
});

test('inferValue: booleans, case-insensitive', () => {
  assert.equal(inferValue('true'), true);
  assert.equal(inferValue('FALSE'), false);
  assert.equal(inferValue(' True '), true);
});

test('inferValue: integers, leading zeros, big ints', () => {
  assert.equal(inferValue('42'), 42);
  assert.equal(inferValue('-7'), -7);
  assert.equal(inferValue('0'), 0);
  assert.equal(inferValue('07030'), '07030');                  // zip code stays a string
  assert.equal(inferValue('-012'), '-012');
  assert.equal(inferValue('9007199254740991'), 9007199254740991); // 2^53 - 1 is exact
  assert.equal(inferValue('9007199254740992'), '9007199254740992'); // 2^53: string
  assert.equal(inferValue('123456789012345678901'), '123456789012345678901');
});

test('inferValue: floats and exponents', () => {
  assert.equal(inferValue('3.14'), 3.14);
  assert.equal(inferValue('1e5'), 100000);
  assert.equal(inferValue('-0.5'), -0.5);
  assert.equal(inferValue('1.2.3'), '1.2.3');
  assert.equal(inferValue('hello'), 'hello');
  assert.equal(inferValue('e'), 'e');
});

test('inferValue: JSON objects and arrays; invalid JSON stays a string', () => {
  assert.deepEqual(inferValue('{"a":1,"b":[true]}'), { a: 1, b: [true] });
  assert.deepEqual(inferValue('[1,"x"]'), [1, 'x']);
  assert.equal(inferValue('{not json}'), '{not json}');
  assert.equal(inferValue('[1.5'), '[1.5');
});

test('inferValue: strings keep their original whitespace; "null" is a string', () => {
  assert.equal(inferValue('  padded '), '  padded ');
  assert.equal(inferValue('null'), 'null');
});

// ── Row → payload ──────────────────────────────────────────────────────

test('buildUser: userId preferred (hybrid projects)', () => {
  const row = { userId: 'u1', email: 'a@example.com', plan: 'gold', n: '5', empty: '' };
  assert.deepEqual(buildUser(row, 'userId', 'email', 'userId', false, null), {
    userId: 'u1', preferUserId: true, email: 'a@example.com', dataFields: { plan: 'gold', n: 5 },
  });
});

test('buildUser: email preferred keeps userId as a plain field', () => {
  const row = { userId: 'u1', email: 'a@example.com', plan: 'gold' };
  assert.deepEqual(buildUser(row, 'userId', 'email', 'email', false, null), {
    email: 'a@example.com', userId: 'u1', dataFields: { plan: 'gold' },
  });
});

test('buildUser: only one key present; neither → null', () => {
  assert.deepEqual(buildUser({ userId: 'u9', email: '' }, 'userId', 'email', 'email', false),
    { userId: 'u9', preferUserId: true });
  assert.deepEqual(buildUser({ userId: ' ', email: 'b@example.com' }, 'userId', 'email', 'userId', false),
    { email: 'b@example.com' });
  assert.equal(buildUser({ userId: '', email: '  ', x: '1' }, 'userId', 'email', 'userId', false), null);
  assert.deepEqual(buildUser({ email: 'c@example.com' }, null, 'email', 'userId', false), { email: 'c@example.com' });
});

test('buildUser: mergeNestedObjects and JSON fields', () => {
  const u = buildUser({ email: 'a@example.com', profile: '{"tier":"gold"}' }, null, 'email', 'userId', true);
  assert.deepEqual(u, { email: 'a@example.com', dataFields: { profile: { tier: 'gold' } }, mergeNestedObjects: true });
});

test('buildUser: clear set sends null only for ticked empty columns', () => {
  const row = { email: 'a@example.com', loyalty: '', city: '', plan: 'x' };
  const u = buildUser(row, null, 'email', 'userId', false, ['loyalty']);
  assert.deepEqual(u.dataFields, { loyalty: null, plan: 'x' });
  assert.equal(countCleared(u), 1);
  // Key columns never clear.
  assert.equal(buildUser({ email: '', loyalty: '' }, null, 'email', 'userId', false, ['email', 'loyalty']), null);
});

test('clearSetOf: prototype names are never treated as ticked', () => {
  assert.equal(clearSetOf(null), null);
  assert.equal(clearSetOf([]), null);
  assert.equal(clearSetOf({ a: false }), null);
  assert.deepEqual([...clearSetOf(['a', '', null, 'b'])], ['a', 'b']);
  assert.deepEqual([...clearSetOf({ a: true, b: false })], ['a']);
  const u = buildUser({ email: 'a@example.com', toString: '', constructor: '' }, null, 'email', 'userId', false, { plan: true });
  assert.equal(u.dataFields, undefined);
});

test('isEmptyCell / countCleared', () => {
  assert.equal(isEmptyCell(''), true);
  assert.equal(isEmptyCell(' \t'), true);
  assert.equal(isEmptyCell('0'), false);
  assert.equal(countCleared({ dataFields: { a: null, b: 1, c: null } }), 2);
  assert.equal(countCleared({}), 0);
});

test('buildSubscriber: keys only', () => {
  assert.deepEqual(buildSubscriber({ userId: 'u1', email: 'a@example.com', x: '1' }, 'userId', 'email', 'userId'),
    { userId: 'u1', preferUserId: true });
  assert.deepEqual(buildSubscriber({ userId: 'u1', email: 'a@example.com' }, 'userId', 'email', 'email'), { email: 'a@example.com' });
  assert.equal(buildSubscriber({ userId: '', email: '' }, 'userId', 'email', 'userId'), null);
});

test('row → payload end to end from CSV text', () => {
  const rows = parseCsvAll('email,zip,score,tags\r\na@example.com,07030,12.5,"[""a"",""b""]"\r\n,,,\r\n');
  const [header, ...data] = rows;
  const keys = detectKeyColumns(header);
  const obj = Object.fromEntries(header.map((h, i) => [h, data[0][i]]));
  assert.deepEqual(buildUser(obj, keys.userIdCol, keys.emailCol, 'userId', false),
    { email: 'a@example.com', dataFields: { zip: '07030', score: 12.5, tags: ['a', 'b'] } });
});

test('usersBatchRequest: bulkUpdate vs lists/subscribe', () => {
  const items = [{ email: 'a@example.com' }];
  assert.deepEqual(usersBatchRequest(items, {}), { path: '/api/users/bulkUpdate', body: { users: items } });
  assert.deepEqual(usersBatchRequest(items, { listId: '42' }), { path: '/api/lists/subscribe', body: { listId: 42, subscribers: items } });
  assert.deepEqual(usersBatchRequest(items, { listId: '42', updateExistingOnly: true }).body,
    { listId: 42, subscribers: items, updateExistingUsersOnly: true });
});

// ── Batching ───────────────────────────────────────────────────────────

test('toBatches / nextBatchNo', () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(toBatches(items, 3), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(toBatches([], 3), []);
  assert.equal(toBatches(Array(2500).fill(0), 5000).length, 3); // clamped to 1000
  assert.equal(nextBatchNo(0, 500), 1);
  assert.equal(nextBatchNo(1000, 500), 3);
});

test('clampRate / clampBatch', () => {
  assert.equal(clampRate('4'), 4);
  assert.equal(clampRate(50), 10);
  assert.equal(clampRate(0), 5);
  assert.equal(clampRate('x'), 5);
  assert.equal(clampRate(0.01), 0.1);
  assert.equal(clampBatch('250'), 250);
  assert.equal(clampBatch(5000), 1000);
  assert.equal(clampBatch(-1), 500);
});

// ── Responses ──────────────────────────────────────────────────────────

test('collectPartialFailures: bulkUpdate nested shape', () => {
  const r = collectPartialFailures({ successCount: 3, failCount: 2,
    failedUpdates: { invalidEmails: ['bad@example'], notFoundUserIds: ['u404'] } });
  assert.equal(r.success, 3);
  assert.equal(r.fail, 2);
  assert.deepEqual(r.records, [
    { userId: '', email: 'bad@example', reason: 'invalidEmails' },
    { userId: 'u404', email: '', reason: 'notFoundUserIds' },
  ]);
});

test('collectPartialFailures: subscribe top-level shape, failCount missing', () => {
  const r = collectPartialFailures({ successCount: 1, invalidUserIds: ['x'] });
  assert.equal(r.fail, 1);
  assert.equal(r.records[0].reason, 'invalidUserIds');
  assert.deepEqual(collectPartialFailures(null), { success: 0, fail: 0, records: [] });
});

test('isIterableSuccess checks code where present', () => {
  assert.equal(isIterableSuccess({ ok: true, data: { successCount: 1 } }), true);
  assert.equal(isIterableSuccess({ ok: true, data: { code: 'Success' } }), true);
  assert.equal(isIterableSuccess({ ok: true, data: { code: 'BadParams' } }), false);
  assert.equal(isIterableSuccess({ ok: true, data: 123 }), true);
  assert.equal(isIterableSuccess({ ok: false, status: 500 }), false);
});

test('classifyFailure: unknown outcome, HTTP, missing key', () => {
  const net = classifyFailure({ ok: false, status: 0, error: { code: 'NETWORK', message: 'offline' } });
  assert.equal(net.reason, 'outcome_unknown');
  assert.equal(net.unknown, true);
  assert.match(net.detail, /Outcome unknown/);
  const to = classifyFailure({ ok: false, status: 0, error: { code: 'TIMEOUT', message: 't' } });
  assert.match(to.summary, /timed out/);
  const http = classifyFailure({ ok: false, status: 400, data: { code: 'BadParams', msg: 'Invalid email x@example.com' }, error: { code: 'HTTP' } });
  assert.equal(http.reason, 'http_400');
  assert.equal(http.summary, 'HTTP 400 BadParams');             // the log never sees the message
  assert.ok(!http.summary.includes('example.com'));
  assert.match(http.detail, /Invalid email/);                     // the failures file does
  assert.equal(classifyFailure({ ok: false, status: 0, error: { code: 'NO_KEY', message: 'none' } }).reason, 'no_key');
  assert.equal(classifyFailure({ ok: false, status: 200, data: { code: 'Nope' } }).reason, 'rejected');
});

// ── Checkpoints ────────────────────────────────────────────────────────

const FILE = { name: 'customers.csv', size: 1234, lastModified: 1700000000000 };

test('checkpoint names derive from scope + file fingerprint', () => {
  assert.equal(fileFingerprint(FILE), 'customers.csv|1234|1700000000000');
  assert.equal(checkpointName('push', FILE), 'ckpt:push:customers.csv|1234|1700000000000');
  assert.equal(checkpointName('subscribe', FILE), 'ckpt:subscribe:customers.csv|1234|1700000000000');
  assert.equal(scopeOfCheckpointName(checkpointName('push:list42|clrdeadbeef', FILE), FILE), 'push:list42|clrdeadbeef');
  assert.equal(scopeOfCheckpointName('ckpt:push:other.csv|1|2', FILE), null);
  assert.equal(scopeOfCheckpointName('ui', FILE), null);
  // A changed file (size or mtime) gets a different name.
  assert.notEqual(checkpointName('push', FILE), checkpointName('push', { ...FILE, size: 1235 }));
});

test('pushScope carries the target and the clear set', () => {
  assert.equal(pushScope({}), 'push');
  assert.equal(pushScope({ listId: '42' }), 'push:list42');
  const withClear = pushScope({ clearCols: ['b', 'a'] });
  assert.match(withClear, /^push\|clr[0-9a-f]{8}$/);
  assert.equal(withClear, pushScope({ clearCols: ['a', 'b'] }));  // order-independent
  assert.notEqual(withClear, pushScope({ clearCols: ['a'] }));
  assert.match(pushScope({ listId: 7, clearCols: ['a'] }), /^push:list7\|clr/);
});

test('clearFingerprint: stable, order-independent, empty → ""', () => {
  assert.equal(clearFingerprint([]), '');
  assert.equal(clearFingerprint(null), '');
  assert.equal(clearFingerprint(['x', 'y']), clearFingerprint(new Set(['y', 'x'])));
  assert.equal(clearFingerprint(['x', 'y']), clearFingerprint({ x: true, y: true, z: false }));
  assert.equal(clearFingerprint(['loyalty_type']), clearFingerprint(['loyalty_type'])); // deterministic
  assert.match(clearFingerprint(['a']), /^clr[0-9a-f]{8}$/);
});

test('describeScope / otherPushCheckpointNames', () => {
  assert.equal(describeScope('push'), 'profile sync only');
  assert.equal(describeScope('push:list42'), 'list 42');
  assert.equal(describeScope('push|clr00000000', { clearCols: ['a', 'b'] }), 'profile sync only, clearing 2 columns: a, b');
  const names = [checkpointName('push', FILE), checkpointName('push:list9', FILE), checkpointName('subscribe', FILE),
    checkpointName('push', { ...FILE, name: 'x.csv' }), 'ui'];
  assert.deepEqual(otherPushCheckpointNames(names, FILE, 'push').map((o) => o.scope), ['push:list9']);
});

// ── Output files ───────────────────────────────────────────────────────

test('failuresCsv quotes values and keeps column order', () => {
  const csv = failuresCsv([
    { row_number: 2, userId: '', email: 'a@example.com', reason: 'http_400', detail: 'BadParams: bad, "quoted"' },
    { row_number: '', userId: 'u1', email: '', reason: 'invalidUserIds', detail: '' },
  ], USER_FAILURE_COLUMNS);
  assert.equal(csv,
    'row_number,userId,email,reason,detail\n' +
    '2,,a@example.com,http_400,"BadParams: bad, ""quoted"""\n' +
    ',u1,,invalidUserIds,\n');
  assert.equal(failuresCsv([]), 'row_number,userId,email,reason,detail\n');
  // Round-trips through the parser.
  assert.deepEqual(parseCsvAll(csv)[1], ['2', '', 'a@example.com', 'http_400', 'BadParams: bad, "quoted"']);
});

test('retryCsv reproduces the original columns', () => {
  const csv = retryCsv(['email', 'note'], [['a@example.com', 'line1\nline2']]);
  assert.equal(csv, 'email,note\na@example.com,"line1\nline2"\n');
});

test('failuresCsv neutralises formula-looking cells; retryCsv stays byte-exact', () => {
  assert.equal(neutralizeFormula('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  for (const c of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) assert.equal(neutralizeFormula(c), "'" + c);
  assert.equal(neutralizeFormula('a=b'), 'a=b');
  assert.equal(neutralizeFormula(''), '');
  assert.equal(neutralizeFormula(null), '');
  assert.equal(neutralizeFormula(7), '7');
  const csv = failuresCsv([{ row_number: 3, userId: '=1+1', email: '@evil', reason: 'http_400', detail: '-cmd' }]);
  assert.equal(csv, "row_number,userId,email,reason,detail\n3,'=1+1,'@evil,http_400,'-cmd\n");
  const row = ['=1+1', '+x', '-y', '@z', '\tt'];
  const retry = retryCsv(['a', 'b', 'c', 'd', 'e'], [row]);
  assert.equal(retry, 'a,b,c,d,e\n=1+1,+x,-y,@z,\tt\n');
  assert.deepEqual(parseCsvAll(retry)[1], row);
});

// ── Starting runs ──────────────────────────────────────────────────────

test('createStartGuard: a second start while the first awaits is ignored', async () => {
  const changes = [];
  const guard = createStartGuard((b) => changes.push(b));
  let release;
  let calls = 0;
  const gate = new Promise((r) => { release = r; });
  const first = guard.run(async () => { calls++; await gate; });
  // Busy synchronously, before the first await resolves.
  assert.equal(guard.busy, true);
  assert.deepEqual(changes, [true]);
  const second = await guard.run(async () => { calls++; });
  assert.equal(second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(guard.busy, false);
  assert.deepEqual(changes, [true, false]);
  // Usable again afterwards.
  assert.equal(await guard.run(async () => { calls++; }), true);
  assert.equal(calls, 2);
});

test('createStartGuard: busy clears when the start throws or returns early', async () => {
  const guard = createStartGuard();
  await assert.rejects(guard.run(async () => { await null; throw new Error('boom'); }), /boom/);
  assert.equal(guard.busy, false);
  assert.equal(await guard.run(() => {}), true);
  assert.equal(guard.busy, false);
});

test('resumeBlocker: same project required, and the list must be in it', () => {
  assert.equal(resumeBlocker(null, 'us:1'), null);
  assert.equal(resumeBlocker({ projectKey: 'us:1' }, 'us:1'), null);
  assert.equal(resumeBlocker({ projectKey: 'us:2' }, 'us:1'), 'project');
  // A checkpoint without a projectKey no longer resumes into any project.
  assert.equal(resumeBlocker({ committedRows: 5 }, 'us:1'), 'project');
  assert.equal(resumeBlocker({ projectKey: '' }, 'us:1'), 'project');
  assert.equal(resumeBlocker({ projectKey: 'us:1' }, null), 'project');
  const ck = { projectKey: 'us:1', listId: 42 };
  assert.equal(resumeBlocker(ck, 'us:1', { projectKey: 'us:1', ids: [7, '42'] }), null);
  assert.equal(resumeBlocker(ck, 'us:1', { projectKey: 'us:1', ids: [7] }), 'list');
  assert.equal(resumeBlocker(ck, 'us:1', { projectKey: 'us:2', ids: [42] }), 'lists');
  assert.equal(resumeBlocker(ck, 'us:1', { projectKey: null, ids: [] }), 'lists');
  assert.equal(resumeBlocker({ projectKey: 'us:1' }, 'us:1', { projectKey: 'us:1', ids: [42] }), 'list');
});

// ── Formatting ─────────────────────────────────────────────────────────

test('fmtDuration / fmtBytes / tsName', () => {
  assert.equal(fmtDuration(Infinity), '?');
  assert.equal(fmtDuration(42), '42s');
  assert.equal(fmtDuration(125), '2m5s');
  assert.equal(fmtDuration(3725), '1h2m');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1048576), '5.0 MB');
  assert.equal(tsName(new Date(2026, 0, 2, 3, 4, 5)), '20260102_030405');
});

// ── List sorting / fuzzy search ───────────────────────────────────────────

test('listCreatedAt: ms epoch, numeric string, ISO string, `created` fallback, unparseable', () => {
  assert.equal(listCreatedAt({ createdAt: 1700000000000 }), 1700000000000);
  assert.equal(listCreatedAt({ createdAt: '1700000000000' }), 1700000000000);
  assert.equal(listCreatedAt({ createdAt: '2024-01-02T03:04:05Z' }), Date.parse('2024-01-02T03:04:05Z'));
  assert.equal(listCreatedAt({ created: 1700000000000 }), 1700000000000);
  assert.equal(listCreatedAt({ createdAt: 'not a date' }), null);
  assert.equal(listCreatedAt({}), null);
  assert.equal(listCreatedAt({ createdAt: '' }), null);
});

test('fmtListDate: a short local date, or empty when there is no usable creation time', () => {
  assert.equal(fmtListDate({}), '');
  assert.notEqual(fmtListDate({ createdAt: '2024-01-02T03:04:05Z' }), '');
});

test('sortLists: newest first by createdAt, undated lists last, id desc breaks ties', () => {
  const a = { id: 1, name: 'A', createdAt: 1000 };
  const b = { id: 2, name: 'B', createdAt: 3000 };
  const c = { id: 3, name: 'C' };            // no date: sorts after any dated list
  const d = { id: 4, name: 'D', createdAt: 3000 };  // ties with b: higher id first
  assert.deepEqual(sortLists([a, b, c, d], 'newest').map((l) => l.id), [4, 2, 1, 3]);
  // Neither list has a date: falls back to id desc.
  const e = { id: 5, name: 'E' }, f = { id: 6, name: 'F' };
  assert.deepEqual(sortLists([e, f], 'newest').map((l) => l.id), [6, 5]);
});

test('sortLists: name, case-insensitive, id desc breaks ties', () => {
  const lists = [{ id: 1, name: 'banana' }, { id: 2, name: 'Apple' }, { id: 3, name: 'apple' }, { id: 4, name: 'Cherry' }];
  assert.deepEqual(sortLists(lists, 'name').map((l) => l.id), [3, 2, 1, 4]);
  assert.deepEqual(LIST_SORTS, ['newest', 'name']);
  assert.equal(DEFAULT_LIST_SORT, 'newest');
});

test('sortLists / fuzzyMatchLists never mutate their input', () => {
  const lists = [{ id: 2, name: 'B' }, { id: 1, name: 'A' }];
  const copy = lists.map((l) => ({ ...l }));
  sortLists(lists, 'name');
  fuzzyMatchLists(lists, 'a');
  assert.deepEqual(lists, copy);
});

test('fuzzyListScore: exact > prefix > word prefix > substring > id > subsequence > no match', () => {
  const l = { id: 42, name: 'New Deal List' };
  assert.equal(fuzzyListScore(l, 'new deal list'), 0);
  assert.equal(fuzzyListScore(l, 'new'), 1);
  assert.equal(fuzzyListScore(l, 'deal'), 2);     // whole-word prefix, not at the start
  assert.equal(fuzzyListScore(l, 'w de'), 3);      // plain substring of the name
  assert.equal(fuzzyListScore(l, '42'), 4);        // matches the id, not the name
  assert.equal(fuzzyListScore(l, 'ndl'), 5);       // subsequence of "new deal list"
  assert.equal(fuzzyListScore(l, 'xyz'), -1);
  assert.equal(fuzzyListScore(l, ''), 0);
  assert.equal(fuzzyListScore(l, '  '), 0);
});

test('fuzzyListScore is case-insensitive', () => {
  assert.equal(fuzzyListScore({ id: 1, name: 'Newsletter' }, 'NEWS'), 1);
});

test('fuzzyMatchLists: best matches first, non-matches dropped, capped at max', () => {
  const lists = [
    { id: 1, name: 'Weekly Newsletter' },
    { id: 2, name: 'Newsletter Archive' },
    { id: 3, name: 'Some other list' },
    { id: 4, name: 'newsletter' },
  ];
  const r = fuzzyMatchLists(lists, 'news');
  assert.deepEqual(r.map((l) => l.id), [2, 4, 1]);   // name-prefix matches (input order) before a word-prefix match
  assert.equal(fuzzyMatchLists(lists, 'zzz').length, 0);
  assert.equal(fuzzyMatchLists(lists, 'news', 1).length, 1);
  assert.deepEqual(fuzzyMatchLists(lists, ''), lists);
  assert.deepEqual(fuzzyMatchLists(lists, '  '), lists);
});

test('fuzzyMatchLists: ties keep the original order', () => {
  const lists = [{ id: 1, name: 'Zebra' }, { id: 2, name: 'Zeppelin' }];
  assert.deepEqual(fuzzyMatchLists(lists, 'ze').map((l) => l.id), [1, 2]);
});
