import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileIdFromPath, extractUserId, pickEmail, emailFromContactRows, pickKind, apiHost, deletePath, publicLookupRequest,
  appLookupPath, interpretPublicLookup, interpretAppLookup, compareLookups, parseDateMs,
  isDeleteSuccess, isUncertain, classifyDelete, ellipsize,
} from '../../src/features/delete-user/logic.js';
import { sendWithRetry, DEFAULT_RETRYABLE } from '../../src/core/retry.js';
import { checkPath } from '../../src/core/api-validation.js';

// All data synthetic.

test('profileIdFromPath', () => {
  assert.equal(profileIdFromPath('/users/profiles/abc123'), 'abc123');
  assert.equal(profileIdFromPath('/users/profiles/abc123/event/history'), 'abc123');
  assert.equal(profileIdFromPath('/users/profiles/'), '');
  assert.equal(profileIdFromPath('/campaigns/1'), '');
  assert.equal(profileIdFromPath(undefined), '');
});

test('extractUserId and pickEmail', () => {
  assert.equal(extractUserId('User ID: 000001'), '000001');
  assert.equal(extractUserId('  user id:  a b  '), 'a b');
  assert.equal(extractUserId('Email: x@example.com'), null);
  assert.equal(pickEmail(['Name', null, 'has space@x', 'a@example.com']), 'a@example.com');
  assert.equal(pickEmail([]), null);
});

test('emailFromContactRows: title first, skips the User ID row', () => {
  // A userId that looks like an email must not be taken for the email.
  assert.equal(emailFromContactRows([
    { text: 'User ID: id@example.com', titles: ['id@example.com'] },
    { text: 'a@exam…', titles: ['a@example.com'] },
  ]), 'a@example.com');
  // Visible text is the fallback when no titled span carries it.
  assert.equal(emailFromContactRows([{ text: 'Name', titles: ['Name'] }, { text: 'b@example.com', titles: [] }]), 'b@example.com');
  assert.equal(emailFromContactRows([{ text: 'User ID: u@example.com', titles: [] }]), null);
  assert.equal(emailFromContactRows([]), null);
  assert.equal(emailFromContactRows(undefined), null);
});

test('pickKind: auto (the default) prefers userId like the userscript did', () => {
  const both = { email: 'a@example.com', userId: 'u1' };
  assert.equal(pickKind('auto', both), 'userId');
  assert.equal(pickKind('auto', { email: 'a@example.com', userId: null }), 'email');
  assert.equal(pickKind('auto', { email: null, userId: 'u1' }), 'userId');
  assert.equal(pickKind('auto', { email: null, userId: null }), null);
  assert.equal(pickKind(undefined, both), 'userId');
});

test('apiHost follows the data center', () => {
  assert.equal(apiHost('us'), 'api.iterable.com');
  assert.equal(apiHost('eu'), 'api.eu.iterable.com');
  assert.equal(apiHost(undefined), 'api.iterable.com');
});

test('pickKind honours the preference, falls back to what the page has', () => {
  const both = { email: 'a@example.com', userId: 'u1' };
  assert.equal(pickKind('email', both), 'email');
  assert.equal(pickKind('userId', both), 'userId');
  assert.equal(pickKind('userId', { email: 'a@example.com', userId: null }), 'email');
  assert.equal(pickKind('email', { email: null, userId: 'u1' }), 'userId');
  assert.equal(pickKind('email', { email: null, userId: null }), null);
});

test('deletePath encodes the identifier as one segment', () => {
  assert.equal(deletePath('email', 'a+b@example.com'), '/api/users/a%2Bb%40example.com');
  assert.equal(deletePath('userId', 'org/42'), '/api/users/byUserId/org%2F42');
  assert.equal(deletePath('userId', 'plain'), '/api/users/byUserId/plain');
  // The background proxy's path validator accepts what we build.
  assert.equal(checkPath(deletePath('email', 'a+b@example.com')), null);
  assert.equal(checkPath(deletePath('userId', 'org/42')), null);
  // …and refuses a dot-segment smuggled through an identifier.
  assert.notEqual(checkPath(deletePath('userId', '..')), null);
});

test('lookup requests', () => {
  assert.deepEqual(publicLookupRequest('email', 'a@example.com'), { path: '/api/users/getByEmail', query: { email: 'a@example.com' } });
  assert.deepEqual(publicLookupRequest('userId', 'u/1'), { path: '/api/users/byUserId/u%2F1' });
  assert.equal(appLookupPath('email', 'a+b@example.com'), '/users/profiles/getUserData?email=a%2Bb%40example.com');
  assert.equal(appLookupPath('userId', 'u 1'), '/users/profiles/getUserData?userId=u%201');
});

test('interpretPublicLookup handles the envelope, empty bodies, 404 and failures', () => {
  const found = interpretPublicLookup({
    ok: true, status: 200,
    data: { user: { email: 'a@example.com', userId: 'u1', dataFields: { signupDate: '2021-03-04 12:34:56 +00:00', firstName: 'A' } } },
  });
  // Display fields (firstName…) ride along for the lookup bar; compareLookups ignores them.
  assert.deepEqual(found, { status: 'found', user: { email: 'a@example.com', userId: 'u1', signupDate: '2021-03-04 12:34:56 +00:00', firstName: 'A' } });
  // Fields only inside dataFields are picked up too.
  assert.deepEqual(interpretPublicLookup({ ok: true, status: 200, data: { user: { dataFields: { email: 'b@example.com' } } } }),
    { status: 'found', user: { email: 'b@example.com' } });
  assert.deepEqual(interpretPublicLookup({ ok: true, status: 200, data: {} }), { status: 'not-found' });
  assert.deepEqual(interpretPublicLookup({ ok: true, status: 200, data: null }), { status: 'not-found' });
  assert.deepEqual(interpretPublicLookup({ ok: true, status: 200, data: { user: {} } }), { status: 'not-found' });
  assert.deepEqual(interpretPublicLookup({ ok: false, status: 404, error: { code: 'HTTP', message: 'HTTP 404' } }), { status: 'not-found' });
  assert.deepEqual(interpretPublicLookup({ ok: false, status: 401, error: { code: 'HTTP', message: 'HTTP 401 — InvalidApiKey' } }),
    { status: 'error', message: 'HTTP 401 — InvalidApiKey' });
  assert.equal(interpretPublicLookup({ ok: false, status: 0, error: { code: 'NETWORK', message: 'x' } }).status, 'error');
  assert.equal(interpretPublicLookup(null).status, 'error');
});

test('interpretAppLookup handles the flat record, error field, 404 and failures', () => {
  assert.deepEqual(interpretAppLookup({ data: { email: 'a@example.com', itblUserId: 'abc', signupDate: 1614861296000, firstName: 'A' } }),
    { status: 'found', user: { email: 'a@example.com', itblUserId: 'abc', signupDate: 1614861296000, firstName: 'A' } });
  assert.deepEqual(interpretAppLookup({ data: { error: true, message: 'not found' } }), { status: 'not-found' });
  assert.deepEqual(interpretAppLookup({ errorStatus: 404 }), { status: 'not-found' });
  assert.deepEqual(interpretAppLookup({ errorStatus: 500, message: 'HTTP 500' }), { status: 'error', message: 'HTTP 500' });
  assert.equal(interpretAppLookup({ data: 'oops' }).status, 'error');
  assert.equal(interpretAppLookup({ data: { firstName: 'A' } }).status, 'error');
  assert.equal(interpretAppLookup().status, 'error');
});

test('parseDateMs reads only unambiguous formats', () => {
  const t = Date.UTC(2021, 2, 4, 12, 34, 56);
  assert.equal(parseDateMs('2021-03-04 12:34:56 +00:00'), t);
  assert.equal(parseDateMs('2021-03-04 14:34:56 +02:00'), t);
  assert.equal(parseDateMs('2021-03-04 12:34:56 +0000'), t);
  assert.equal(parseDateMs('2021-03-04 12:34:56.789 Z'), t + 789);
  assert.equal(parseDateMs('2021-03-04T12:34:56Z'), t);
  assert.equal(parseDateMs('2021-03-04T12:34:56.000+00:00'), t);
  assert.equal(parseDateMs(t), t);
  assert.equal(parseDateMs(t / 1000), t);
  assert.equal(parseDateMs(String(t)), t);
  assert.equal(parseDateMs('2021-03-04 12:34:56'), null); // no zone: ambiguous
  assert.equal(parseDateMs('3/4/2021'), null);
  assert.equal(parseDateMs(null), null);
  assert.equal(parseDateMs(NaN), null);
});

const apiFound = (user) => ({ status: 'found', user });
const appFound = (user) => ({ status: 'found', user });

test('compareLookups: match when shared fields agree (case/format tolerant)', () => {
  const r = compareLookups(
    apiFound({ email: 'A@Example.com', userId: 'u1', signupDate: '2021-03-04 12:34:56 +00:00' }),
    appFound({ email: 'a@example.com', userId: 'u1', itblUserId: 'abc', signupDate: Date.UTC(2021, 2, 4, 12, 34, 56, 400) }),
  );
  assert.equal(r.outcome, 'match');
  assert.deepEqual(r.compared, ['email', 'userId', 'signupDate']);
  assert.deepEqual(r.mismatched, []);
});

test('compareLookups: fields only one side has are ignored', () => {
  const r = compareLookups(apiFound({ email: 'a@example.com', signupDate: 1614861296000 }),
    appFound({ email: 'a@example.com', userId: 'u1', itblUserId: 'x', signupDate: 1614861296000 }), { lookedUpBy: 'email' });
  assert.equal(r.outcome, 'match');
  assert.deepEqual(r.compared, ['email', 'signupDate']);
  assert.deepEqual(r.independent, ['signupDate']);
});

test('compareLookups: display fields (names, lastSeenDate) never count as evidence', () => {
  const r = compareLookups(apiFound({ email: 'a@example.com', firstName: 'A', lastName: 'B', lastSeenDate: 1 }),
    appFound({ email: 'a@example.com', firstName: 'Z', lastName: 'B', lastSeenDate: 1 }), { lookedUpBy: 'email' });
  assert.equal(r.outcome, 'unknown');
  assert.deepEqual(r.compared, ['email']);
});

test('compareLookups: only the looked-up identifier agreeing is "couldn’t check", not a match', () => {
  const r = compareLookups(apiFound({ email: 'a@example.com' }), appFound({ email: 'a@example.com', userId: 'u1', itblUserId: 'x' }), { lookedUpBy: 'email' });
  assert.equal(r.outcome, 'unknown');
  assert.deepEqual(r.compared, ['email']);
  assert.deepEqual(r.independent, []);
  assert.match(r.message, /no other field/);
  // By userId: the other identifier agreeing is independent evidence.
  const r2 = compareLookups(apiFound({ userId: 'u1', email: 'A@example.com' }), appFound({ userId: 'u1', email: 'a@example.com' }), { lookedUpBy: 'userId' });
  assert.equal(r2.outcome, 'match');
  assert.deepEqual(r2.independent, ['email']);
});

test('compareLookups: the profile URL id counts when it equals the key’s itblUserId', () => {
  const api = apiFound({ email: 'a@example.com', itblUserId: 'p123' });
  const app = appFound({ email: 'a@example.com' });
  const r = compareLookups(api, app, { lookedUpBy: 'email', profileId: 'p123' });
  assert.equal(r.outcome, 'match');
  assert.deepEqual(r.independent, ['profileId']);
  // A different URL id is ignored (its meaning is unconfirmed), leaving nothing independent.
  assert.equal(compareLookups(api, app, { lookedUpBy: 'email', profileId: 'other' }).outcome, 'unknown');
  // Only the app side carrying it isn't evidence about the key's record.
  assert.equal(compareLookups(apiFound({ email: 'a@example.com' }), appFound({ email: 'a@example.com', itblUserId: 'p123' }),
    { lookedUpBy: 'email', profileId: 'p123' }).outcome, 'unknown');
  // Both sides carry it: the itblUserId field itself plus the URL id.
  const both = compareLookups(api, appFound({ email: 'a@example.com', itblUserId: 'p123' }), { lookedUpBy: 'email', profileId: 'p123' });
  assert.equal(both.outcome, 'match');
  assert.deepEqual(both.independent, ['itblUserId', 'profileId']);
});

test('compareLookups: unparseable dates are skipped, not treated as a mismatch', () => {
  const r = compareLookups(apiFound({ email: 'a@example.com', userId: 'u1', signupDate: 'yesterday' }),
    appFound({ email: 'a@example.com', userId: 'u1', signupDate: 1 }), { lookedUpBy: 'email' });
  assert.equal(r.outcome, 'match');
  assert.deepEqual(r.compared, ['email', 'userId']);
});

test('compareLookups: mismatch when the same email is a different user in the key\'s project', () => {
  const r = compareLookups(
    apiFound({ email: 'a@example.com', userId: 'other', signupDate: '2019-01-01 00:00:00 +00:00' }),
    appFound({ email: 'a@example.com', userId: 'u1', signupDate: '2021-03-04T12:34:56Z' }),
  );
  assert.equal(r.outcome, 'mismatch');
  assert.deepEqual(r.mismatched, ['userId', 'signupDate']);
});

test('compareLookups: not-found only when the app sees the user and the key does not', () => {
  assert.equal(compareLookups({ status: 'not-found' }, appFound({ email: 'a@example.com' })).outcome, 'not-found');
  // App can't find it either → we can't say anything about the key.
  assert.equal(compareLookups({ status: 'not-found' }, { status: 'not-found' }).outcome, 'unknown');
  assert.equal(compareLookups(apiFound({ email: 'a@example.com' }), { status: 'not-found' }).outcome, 'unknown');
});

test('compareLookups: unknown when either lookup failed or nothing is comparable', () => {
  const app = appFound({ email: 'a@example.com' });
  const u1 = compareLookups({ status: 'error', message: 'HTTP 401' }, app);
  assert.equal(u1.outcome, 'unknown');
  assert.match(u1.message, /API lookup failed \(HTTP 401\)/);
  const u2 = compareLookups(apiFound({ email: 'a@example.com' }), { status: 'error', message: 'HTTP 500' });
  assert.equal(u2.outcome, 'unknown');
  assert.match(u2.message, /app lookup failed/);
  assert.equal(compareLookups(apiFound({ userId: 'u1' }), appFound({ email: 'a@example.com' })).outcome, 'unknown');
  assert.equal(compareLookups(undefined, undefined).outcome, 'unknown');
});

test('isDeleteSuccess checks code === Success where present', () => {
  assert.equal(isDeleteSuccess({ ok: true, status: 200, data: { code: 'Success', msg: '' } }), true);
  assert.equal(isDeleteSuccess({ ok: true, status: 200, data: null }), true);
  assert.equal(isDeleteSuccess({ ok: true, status: 200, data: { code: 'BadParams' } }), false);
  assert.equal(isDeleteSuccess({ ok: false, status: 400 }), false);
});

test('core retry policy (used for deletes) / isUncertain', () => {
  const isRetryable = (r) => DEFAULT_RETRYABLE(r.status, r);
  assert.equal(isRetryable({ ok: false, status: 0, error: { code: 'NETWORK' } }), true);
  assert.equal(isRetryable({ ok: false, status: 0, error: { code: 'TIMEOUT' } }), true);
  assert.equal(isRetryable({ ok: false, status: 0, error: { code: 'NO_KEY' } }), false);
  assert.equal(isRetryable({ ok: false, status: 0, error: { code: 'BAD_REQUEST' } }), false);
  assert.equal(isRetryable({ ok: false, status: 429 }), true);
  assert.equal(isRetryable({ ok: false, status: 503 }), true);
  assert.equal(isRetryable({ ok: false, status: 400 }), false);
  assert.equal(isRetryable({ ok: false, status: 404 }), false);
  assert.equal(isUncertain({ ok: false, status: 0, error: { code: 'TIMEOUT' } }), true);
  assert.equal(isUncertain({ ok: false, status: 0, error: { code: 'NO_KEY' } }), false);
  assert.equal(isUncertain({ ok: false, status: 500 }), false);
});

// Drive the same sendWithRetry wiring index.js uses, with a scripted transport.
async function runDelete(responses) {
  let i = 0, sawUncertain = false;
  const waits = [];
  const result = await sendWithRetry(async () => responses[Math.min(i++, responses.length - 1)], {
    backoffs: [1000, 2000, 4000],
    isSuccess: isDeleteSuccess,
    onRetry: ({ response }) => { if (isUncertain(response)) sawUncertain = true; },
    wait: async (ms) => { waits.push(ms); },
  });
  return { verdict: classifyDelete(result, { sawUncertain }), calls: i, waits };
}

const OK = { ok: true, status: 200, data: { code: 'Success', msg: 'deleted' } };
const NET = { ok: false, status: 0, error: { code: 'NETWORK', message: 'net' } };
const TIMEOUT = { ok: false, status: 0, error: { code: 'TIMEOUT', message: 't' } };

test('delete: success first time', async () => {
  const r = await runDelete([OK]);
  assert.equal(r.verdict.kind, 'deleted');
  assert.equal(r.calls, 1);
});

test('delete: no retry on 4xx, message from Iterable', async () => {
  const r = await runDelete([{ ok: false, status: 400, error: { code: 'HTTP', message: 'HTTP 400 — BadParams: nope' } }, OK]);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.verdict, { kind: 'failed', message: 'HTTP 400 — BadParams: nope' });
});

test('delete: 401 is not retried', async () => {
  const r = await runDelete([{ ok: false, status: 401, error: { code: 'HTTP', message: 'HTTP 401' } }, OK]);
  assert.equal(r.calls, 1);
  assert.equal(r.verdict.kind, 'failed');
});

test('delete: 2xx with a non-Success code is a failure, not retried', async () => {
  const r = await runDelete([{ ok: true, status: 200, data: { code: 'BadParams', msg: 'bad' } }, OK]);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.verdict, { kind: 'failed', message: 'BadParams: bad' });
});

test('delete: 429 / 5xx retried with 1s, 2s, 4s backoffs', async () => {
  const r = await runDelete([{ ok: false, status: 429 }, { ok: false, status: 502 }, OK]);
  assert.equal(r.verdict.kind, 'deleted');
  assert.deepEqual(r.waits, [1000, 2000]);
  const r2 = await runDelete([{ ok: false, status: 500, error: { code: 'HTTP', message: 'HTTP 500' } }]);
  assert.equal(r2.calls, 4);
  assert.deepEqual(r2.waits, [1000, 2000, 4000]);
  assert.deepEqual(r2.verdict, { kind: 'failed', message: 'HTTP 500' });
});

test('delete: final NETWORK/TIMEOUT is reported as unknown', async () => {
  const r = await runDelete([NET]);
  assert.equal(r.calls, 4);
  assert.equal(r.verdict.kind, 'unknown');
  assert.match(r.verdict.message, /Couldn't confirm the delete\. Reload the profile to check\./);
  assert.equal((await runDelete([{ ok: false, status: 503 }, TIMEOUT, TIMEOUT, TIMEOUT])).verdict.kind, 'unknown');
});

test('delete: an earlier uncertain attempt makes a later failure unknown too', async () => {
  // The first DELETE may have landed; the retry then sees "user not found".
  const r = await runDelete([TIMEOUT, { ok: false, status: 400, error: { code: 'HTTP', message: 'HTTP 400 — user not found' } }]);
  assert.equal(r.verdict.kind, 'unknown');
  // …but a later success is still a success.
  assert.equal((await runDelete([NET, OK])).verdict.kind, 'deleted');
});

test('delete: NO_KEY / BAD_REQUEST are not retried and are plain failures', async () => {
  const r = await runDelete([{ ok: false, status: 0, error: { code: 'NO_KEY', message: 'No API key saved' } }, OK]);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.verdict, { kind: 'failed', message: 'No API key saved' });
});

test('ellipsize', () => {
  assert.equal(ellipsize('short', 10), 'short');
  const e = ellipsize('abcdefghijklmnop', 9);
  assert.equal(e.length, 9);
  assert.ok(e.startsWith('abcd') && e.endsWith('mnop'));
});
