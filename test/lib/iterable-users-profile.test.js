import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateUser, updateUserBody, isUpdateSuccess, identityOf, dataFieldsFor, parseFieldInput, unsafeIntegerInJson,
  isIterableDateString, detectValueType, describeType, normalizeFieldType, lookupUserPublic, lookupUserApp, getUser,
  userFieldValue, collectUserFields, UPDATE_USER_PATH, USER_IDENTITY_FIELDS, USER_RECORD_FIELDS, interpretAppLookup,
} from '../../src/lib/iterable/users.js';
import {
  readProfileIdentity, readContactRows, userIdFromContactRows, emailFromContactRows, profileIdFromPath,
} from '../../src/lib/iterable/profile-page.js';
import { evaluateEditor, formatForEditing, pickIdentity, NEW_FIELD_NAME_RE, createNewFieldsFor, writeField, createActionLock } from '../../src/lib/iterable/field-editor.js';
import { HttpError } from '../../src/core/http.js';

// All data synthetic. No network: api/http are fakes.

function fakeApi(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : null;
  return {
    calls,
    request: async (opts) => {
      calls.push(opts);
      return list ? list[Math.min(calls.length, list.length) - 1] : responses(opts);
    },
  };
}
const SUCCESS = { ok: true, status: 200, data: { code: 'Success', msg: '', params: null } };

// ── updateUser ─────────────────────────────────────────────────────────────

test('updateUserBody: identity, dataFields and flags', () => {
  assert.deepEqual(updateUserBody({ email: ' a@example.com ', dataFields: { x: 1 } }), { email: 'a@example.com', dataFields: { x: 1 }, mergeNestedObjects: true });
  assert.deepEqual(updateUserBody({ userId: 42, dataFields: {}, mergeNestedObjects: false, createNewFields: true }),
    { userId: '42', dataFields: {}, mergeNestedObjects: false, createNewFields: true });
  assert.throws(() => updateUserBody({ email: 'a@example.com', userId: 'u', dataFields: {} }), (e) => e.code === 'INVALID');
  assert.throws(() => updateUserBody({ dataFields: {} }), (e) => e.code === 'INVALID');
  assert.throws(() => updateUserBody({ email: 'not-an-email', dataFields: {} }), (e) => e.code === 'INVALID');
  assert.throws(() => updateUserBody({ email: 'a@example.com', dataFields: [] }), (e) => e.code === 'INVALID');
  assert.throws(() => updateUserBody({ email: 'a@example.com', dataFields: null }), (e) => e.code === 'INVALID');
});

test('updateUser posts to /api/users/update and resolves Iterable\'s body on code Success', async () => {
  const api = fakeApi([SUCCESS]);
  const body = await updateUser({ api }, { projectKey: 'us:1', email: 'a@example.com', dataFields: { color: 'red' }, mergeNestedObjects: false });
  assert.deepEqual(body, SUCCESS.data);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0], {
    projectKey: 'us:1', method: 'POST', path: UPDATE_USER_PATH,
    body: { email: 'a@example.com', dataFields: { color: 'red' }, mergeNestedObjects: false },
  });
});

test('updateUser: a 2xx without code Success is a failure (not retried)', async () => {
  const api = fakeApi([{ ok: true, status: 200, data: { code: 'InvalidEmailAddressError', msg: 'Invalid email' } }]);
  await assert.rejects(updateUser({ api }, { email: 'a@example.com', dataFields: {} }), (e) =>
    e.code === 'API' && e.apiCode === 'InvalidEmailAddressError' && e.message === 'InvalidEmailAddressError: Invalid email' && !e.outcomeUnknown);
  assert.equal(api.calls.length, 1);
  const noCode = fakeApi([{ ok: true, status: 200, data: null }]);
  await assert.rejects(updateUser({ api: noCode }, { email: 'a@example.com', dataFields: {} }), (e) => e.apiCode === 'UnexpectedResponse');
  const noCode2 = fakeApi([{ ok: true, status: 200, data: { msg: 'hi' } }]);
  await assert.rejects(updateUser({ api: noCode2 }, { email: 'a@example.com', dataFields: {} }), (e) => e.apiCode === 'UnexpectedResponse');
});

test('updateUser: HTTP errors carry Iterable\'s code/msg; 401 and NO_KEY stop at once', async () => {
  const bad = fakeApi([{ ok: false, status: 400, data: { code: 'BadParams', msg: 'dataFields bad' }, error: { code: 'HTTP', message: 'HTTP 400' } }]);
  await assert.rejects(updateUser({ api: bad }, { userId: 'u1', dataFields: {} }), (e) => e.apiCode === 'BadParams' && e.status === 400 && e.message === 'dataFields bad');
  assert.equal(bad.calls.length, 1);
  const unauth = fakeApi([{ ok: false, status: 401, error: { code: 'HTTP', message: 'HTTP 401' } }]);
  await assert.rejects(updateUser({ api: unauth }, { userId: 'u1', dataFields: {} }), (e) => e.status === 401 && e.apiCode === 'HTTP');
  assert.equal(unauth.calls.length, 1);
  const nokey = fakeApi([{ ok: false, status: 0, error: { code: 'NO_KEY', message: 'No API key saved.' } }]);
  await assert.rejects(updateUser({ api: nokey }, { userId: 'u1', dataFields: {} }), (e) => e.apiCode === 'NO_KEY' && !e.outcomeUnknown && e.message === 'No API key saved.');
  assert.equal(nokey.calls.length, 1);
});

test('updateUser retries 429/5xx/NETWORK and reports an unknown outcome when retries run out', async () => {
  const flaky = fakeApi([{ ok: false, status: 503, error: { code: 'HTTP', message: 'HTTP 503' } }, SUCCESS]);
  // Backoffs of 0 ms keep the test fast.
  assert.deepEqual(await updateUser({ api: flaky }, { email: 'a@example.com', dataFields: {}, backoffs: [0, 0] }), SUCCESS.data);
  assert.equal(flaky.calls.length, 2);
  const down = fakeApi([{ ok: false, status: 0, error: { code: 'TIMEOUT', message: 'Timed out.' } }]);
  await assert.rejects(updateUser({ api: down }, { email: 'a@example.com', dataFields: {}, backoffs: [0, 0] }), (e) =>
    e.outcomeUnknown === true && e.apiCode === 'TIMEOUT' && /may or may not/.test(e.message));
  assert.equal(down.calls.length, 3);
});

test('isUpdateSuccess and identityOf', () => {
  assert.equal(isUpdateSuccess(SUCCESS), true);
  assert.equal(isUpdateSuccess({ ok: true, data: {} }), false);
  assert.equal(isUpdateSuccess({ ok: false, data: { code: 'Success' } }), false);
  assert.deepEqual(identityOf({ email: 'a@example.com' }), { kind: 'email', value: 'a@example.com' });
  assert.deepEqual(identityOf({ userId: 0 }), { kind: 'userId', value: '0' });
  assert.deepEqual(identityOf({ email: '', userId: 'u' }), { kind: 'userId', value: 'u' });
});

test('dataFieldsFor builds nested objects and refuses bad paths', () => {
  assert.deepEqual(dataFieldsFor('color', 'red'), { color: 'red' });
  assert.deepEqual(dataFieldsFor('profile.address.city', 'Oslo'), { profile: { address: { city: 'Oslo' } } });
  assert.deepEqual(dataFieldsFor('x', null), { x: null });
  for (const bad of ['', 'a..b', '.a', 'a.', '__proto__', 'a.constructor']) {
    assert.throws(() => dataFieldsFor(bad, 1), (e) => e.code === 'INVALID', bad);
  }
});

// ── Lookups ────────────────────────────────────────────────────────────────

test('lookupUserPublic: request shape, retries, interpretation, unsafe identifiers', async () => {
  const api = fakeApi([{ ok: true, status: 200, data: { user: { email: 'a@example.com', dataFields: { userId: 'u1', secret: 'x' } } } }]);
  assert.deepEqual(await lookupUserPublic({ api }, { projectKey: 'us:1', kind: 'email', value: 'a@example.com' }),
    { status: 'found', user: { email: 'a@example.com', userId: 'u1' } });
  assert.deepEqual(api.calls[0], { projectKey: 'us:1', method: 'GET', path: '/api/users/getByEmail', query: { email: 'a@example.com' } });

  const retry = fakeApi([{ ok: false, status: 500, error: { code: 'HTTP', message: 'HTTP 500' } }, { ok: true, status: 200, data: {} }]);
  assert.deepEqual(await lookupUserPublic({ api: retry }, { kind: 'userId', value: 'a/b', backoffs: [0] }), { status: 'not-found' });
  assert.equal(retry.calls[1].path, '/api/users/byUserId/a%2Fb');

  // 401 is not fatal for a lookup; it is reported as an error after the retries it gets.
  const unauth = fakeApi([{ ok: false, status: 401, error: { code: 'HTTP', message: 'HTTP 401' } }]);
  assert.deepEqual(await lookupUserPublic({ api: unauth }, { kind: 'userId', value: 'u', backoffs: [0] }), { status: 'error', message: 'HTTP 401' });

  const never = fakeApi(() => { throw new Error('must not be called'); });
  assert.equal((await lookupUserPublic({ api: never }, { kind: 'userId', value: '..' })).status, 'error');
  assert.equal(never.calls.length, 0);
});

test('lookupUserApp: data, miss, HTTP error, abort', async () => {
  const http = { appFetch: async (path) => ({ path, email: 'a@example.com', itblUserId: 'i1' }) };
  assert.deepEqual(await lookupUserApp({ http }, { kind: 'email', value: 'a+b@example.com' }), { status: 'found', user: { email: 'a@example.com', itblUserId: 'i1' } });
  const miss = { appFetch: async () => ({ error: 'nope' }) };
  assert.deepEqual(await lookupUserApp({ http: miss }, { kind: 'userId', value: 'u' }), { status: 'not-found' });
  const e404 = { appFetch: async () => { throw new HttpError(404, 'HTTP 404'); } };
  assert.deepEqual(await lookupUserApp({ http: e404 }, { kind: 'userId', value: 'u' }), { status: 'not-found' });
  const e500 = { appFetch: async () => { throw new HttpError(500, 'HTTP 500 for GET x'); } };
  assert.deepEqual(await lookupUserApp({ http: e500 }, { kind: 'userId', value: 'u' }), { status: 'error', message: 'HTTP 500 for GET x' });
  const abort = { appFetch: async () => { throw new DOMException('Aborted', 'AbortError'); } };
  await assert.rejects(lookupUserApp({ http: abort }, { kind: 'userId', value: 'u' }), (e) => e.name === 'AbortError');
});

test('getUser returns the full record; userFieldValue reads top level then dataFields paths', async () => {
  const user = { email: 'a@example.com', userId: 'u1', dataFields: { color: 'red', profile: { city: 'Oslo' }, 'dotted.name': 1 } };
  const api = fakeApi([{ ok: true, status: 200, data: { user } }]);
  assert.deepEqual(await getUser({ api }, { userId: 'u1' }), { status: 'found', user });
  assert.equal(api.calls[0].path, '/api/users/byUserId/u1');
  assert.deepEqual(await getUser({ api: fakeApi([{ ok: true, status: 200, data: {} }]) }, { email: 'a@example.com' }), { status: 'not-found' });
  await assert.rejects(getUser({ api }, {}), (e) => e.code === 'INVALID');
  assert.equal(userFieldValue(user, 'email'), 'a@example.com');
  assert.equal(userFieldValue(user, 'color'), 'red');
  assert.equal(userFieldValue(user, 'profile.city'), 'Oslo');
  assert.equal(userFieldValue(user, 'profile.zip'), undefined);
  assert.equal(userFieldValue(user, 'missing'), undefined);
  assert.deepEqual(collectUserFields({ dataFields: { signupDate: '2024-01-01' }, email: '' }), { signupDate: '2024-01-01' });
});

test('collectUserFields carries firstName / lastName / lastSeenDate from either level', () => {
  assert.deepEqual(
    collectUserFields({ email: 'a@example.com', dataFields: { firstName: 'Ada', lastName: 'Lovelace', lastSeenDate: '2025-02-03 04:05:06 +00:00' } }),
    { email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace', lastSeenDate: '2025-02-03 04:05:06 +00:00' });
  assert.deepEqual(collectUserFields({ firstName: 'Top', dataFields: { firstName: 'Nested' } }), { firstName: 'Top' });
  assert.deepEqual(USER_IDENTITY_FIELDS, ['email', 'userId', 'itblUserId', 'signupDate']);
  for (const f of USER_IDENTITY_FIELDS) assert.ok(USER_RECORD_FIELDS.includes(f));
});

test('interpretAppLookup keeps display fields on a found user', () => {
  const r = interpretAppLookup({ data: { email: 'a@example.com', itblUserId: 'it1', dataFields: { firstName: 'Ada', lastSeenDate: 1700000000000 } } });
  assert.equal(r.status, 'found');
  assert.equal(r.user.firstName, 'Ada');
  assert.equal(r.user.lastSeenDate, 1700000000000);
});

// ── parseFieldInput ────────────────────────────────────────────────────────

const P = (text, type) => parseFieldInput(text, type);
const okv = (r) => { assert.equal(r.ok, true, r.error); return r.value; };

test('parseFieldInput auto-detects like the Live Preview pusher', () => {
  const cases = [
    ['42', 42, 'long'], ['-7', -7, 'long'], ['3.14', 3.14, 'double'], ['1e3', 1000, 'long'],
    ['true', true, 'boolean'], ['FALSE', false, 'boolean'], ['"42"', '42', 'string'], ['hello world', 'hello world', 'string'],
    ['{"a":1}', { a: 1 }, 'object'], ['[1,2]', [1, 2], 'array'], ['null', null, 'null'],
    ['2024-05-01', '2024-05-01', 'date'], ['2024-05-01 13:45:00 +00:00', '2024-05-01 13:45:00 +00:00', 'date'],
    ['2024-05-01T13:45:00.123Z', '2024-05-01T13:45:00.123Z', 'date'], ['2024-02-30', '2024-02-30', 'string'],
    ['{not json', '{not json', 'string'], ['  padded  ', 'padded', 'string'], ['', '', 'string'],
  ];
  for (const [text, value, type] of cases) {
    const r = P(text);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.value, value, text);
    assert.equal(r.type, type, text);
  }
  assert.equal(P('[1,2]').itemType, 'long');
  assert.equal(P('[1,2.5]').itemType, 'double');
  assert.equal(P('[1,"a"]').itemType, 'mixed');
  assert.equal(P('[]').itemType, 'empty');
  assert.equal(P('[{"id":1}]').itemType, 'object');
});

test('parseFieldInput is big-int safe', () => {
  assert.equal(okv(P('9007199254740991')), 9007199254740991);
  assert.equal(okv(P('-9007199254740991')), -9007199254740991);
  for (const text of ['9007199254740993', '-9007199254740993', '{"id": 12345678901234567890}', '[1, 99999999999999999999]']) {
    const r = P(text);
    assert.equal(r.ok, false, text);
    assert.match(r.error, /too large/, text);
  }
  assert.equal(P('9007199254740993', 'long').ok, false);
  assert.equal(P('9007199254740993', 'double').ok, false);
  assert.equal(P('9007199254740993', 'date').ok, false);
  // Inside a JSON string it's just text.
  assert.deepEqual(okv(P('{"id": "12345678901234567890"}')), { id: '12345678901234567890' });
  assert.equal(okv(P('12345678901234567890', 'string')), '12345678901234567890');
  assert.equal(unsafeIntegerInJson('{"a":"9999999999999999999\\"","b":1.5e30}'), null);
  assert.equal(unsafeIntegerInJson('[-9007199254740992]'), '-9007199254740992');
});

test('parseFieldInput with a known field type (matrix)', () => {
  // string
  assert.equal(okv(P('hello', 'string')), 'hello');
  assert.equal(okv(P('"quoted"', 'string')), 'quoted');
  assert.equal(okv(P('42', 'string')), '42');
  assert.equal(okv(P('true', 'string')), 'true');
  assert.equal(okv(P('', 'string')), '');
  assert.deepEqual(okv(P('["a","b"]', 'string')), ['a', 'b']);
  assert.equal(P('["a",1]', 'string').ok, false);
  assert.equal(okv(P('[not json', 'string')), '[not json');
  // long
  assert.equal(okv(P('42', 'long')), 42);
  assert.equal(P('4.2', 'long').ok, false);
  assert.equal(P('abc', 'long').ok, false);
  assert.equal(P('', 'long').ok, false);
  assert.deepEqual(okv(P('[1,2]', 'long')), [1, 2]);
  assert.equal(P('[1,2.5]', 'long').ok, false);
  assert.equal(P('["1"]', 'long').ok, false);
  // double / number
  assert.equal(okv(P('4.2', 'double')), 4.2);
  assert.equal(okv(P('4', 'double')), 4);
  assert.equal(P('4', 'double').type, 'double');
  assert.equal(P('four', 'double').ok, false);
  assert.equal(P('4', 'number').type, 'long');
  assert.equal(P('4.5', 'number').type, 'double');
  // boolean
  assert.equal(okv(P('True', 'boolean')), true);
  assert.equal(okv(P('false', 'bool')), false);
  assert.equal(P('yes', 'boolean').ok, false);
  assert.deepEqual(okv(P('[true,false]', 'boolean')), [true, false]);
  // date
  assert.equal(okv(P('2024-05-01', 'date')), '2024-05-01');
  assert.equal(okv(P('2024-05-01 13:45:00', 'date')), '2024-05-01 13:45:00');
  assert.equal(okv(P('1714571100000', 'date')), 1714571100000);
  assert.equal(P('May 1st', 'date').ok, false);
  assert.equal(P('2024-13-01', 'date').ok, false);
  assert.equal(P('2024-05-01 25:00:00', 'date').ok, false);
  // object / geo_location
  assert.deepEqual(okv(P('{"a":{"b":1}}', 'object')), { a: { b: 1 } });
  assert.equal(P('[1]', 'object').ok, false);
  assert.equal(P('"x"', 'object').ok, false);
  assert.equal(P('{bad', 'object').ok, false);
  assert.deepEqual(okv(P('{"lat":1,"lon":2}', 'geo_location')), { lat: 1, lon: 2 });
  // nested (arrays of objects)
  assert.deepEqual(okv(P('[{"id":1}]', 'nested')), [{ id: 1 }]);
  assert.deepEqual(okv(P('[]', 'nested (array)')), []);
  assert.equal(P('{"id":1}', 'nested').ok, false);
  // null clears any type
  for (const t of ['string', 'long', 'boolean', 'date', 'object', 'nested']) assert.equal(P('null', t).type, 'null', t);
  // unknown type → auto
  assert.equal(P('42', 'weird').type, 'long');
});

test('type helpers', () => {
  assert.equal(normalizeFieldType('Long'), 'long');
  assert.equal(normalizeFieldType('nested (array)'), 'nested');
  assert.equal(normalizeFieldType(''), null);
  assert.equal(describeType({ type: 'array', itemType: 'long' }), 'array of long');
  assert.equal(describeType({ type: 'array', itemType: 'empty' }), 'empty array');
  assert.equal(describeType({ type: 'date' }), 'date');
  assert.deepEqual(detectValueType(1.5), { type: 'double' });
  assert.equal(isIterableDateString('2024-02-29'), true);
  assert.equal(isIterableDateString('2023-02-29'), false);
  assert.equal(isIterableDateString('2024-05-01T10:00'), false);   // no zone: ambiguous
  assert.equal(isIterableDateString('2024-05-01T10:00Z'), true);
});

// ── Profile page readers ───────────────────────────────────────────────────

// Minimal DOM stand-in: elements with textContent, getAttribute, querySelector(All) for the few
// selectors readContactRows uses.
function el(tag, { attrs = {}, text = '', children = [] } = {}) {
  const node = {
    tag, attrs, children,
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(node);
      return out;
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
  };
  return node;
}
function matches(n, sel) {
  if (sel === 'li') return n.tag === 'li';
  if (sel === 'span[title]') return n.tag === 'span' && 'title' in n.attrs;
  const m = /^\[data-test="(.+)"\]$/.exec(sel);
  return !!m && n.attrs['data-test'] === m[1];
}

test('readProfileIdentity reads email, userId and the profile id', () => {
  const doc = el('body', { children: [
    el('div', { attrs: { 'data-test': 'contact-details-list' }, children: [
      el('li', { children: [el('span', { attrs: { title: 'id@example.com' }, text: 'User ID: id@example.com' })] }),
      el('li', { children: [el('span', { attrs: { title: 'person@example.com' }, text: 'person@exam…' })] }),
    ] }),
  ] });
  assert.deepEqual(readProfileIdentity({ root: doc, pathname: '/users/profiles/abc123/fields' }),
    { email: 'person@example.com', userId: 'id@example.com', profileId: 'abc123' });
});

test('readProfileIdentity: header fallback, nothing rendered, DOM errors', () => {
  const header = el('body', { children: [el('div', { attrs: { 'data-test': 'page-header-content' }, children: [
    el('li', { text: 'b@example.com' }),
  ] })] });
  assert.deepEqual(readProfileIdentity({ root: header, pathname: '/users/profiles/x' }), { email: 'b@example.com', userId: null, profileId: 'x' });
  assert.deepEqual(readProfileIdentity({ root: el('body'), pathname: '/campaigns' }), { email: null, userId: null, profileId: '' });
  let seen = null;
  const broken = { querySelector() { throw new Error('boom'); } };
  assert.deepEqual(readProfileIdentity({ root: broken, pathname: '/users/profiles/p', onError: (e) => { seen = e.message; } }),
    { email: null, userId: null, profileId: 'p' });
  assert.equal(seen, 'boom');
  assert.deepEqual(readContactRows(el('body')), []);
});

test('pure row parsers', () => {
  assert.equal(userIdFromContactRows([{ text: 'Name' }, { text: 'User ID: 007' }]), '007');
  assert.equal(userIdFromContactRows([]), null);
  assert.equal(emailFromContactRows([{ text: 'x@example.com', titles: [] }]), 'x@example.com');
  assert.equal(profileIdFromPath('/users/profiles/abc/event/history'), 'abc');
});

// ── Field editor (pure parts; the DOM is checked in a real browser) ────────

const FIELDS = [{ name: 'score', type: 'long' }, { name: 'tags', type: 'string' }, { name: 'prefs', type: 'object' }];

test('evaluateEditor: known fields use their type, new fields are auto-detected', () => {
  let s = evaluateEditor({ fieldName: 'score', text: '12', fields: FIELDS });
  assert.equal(s.known.type, 'long');
  assert.equal(s.canSave, true);
  assert.equal(s.parsed.value, 12);
  s = evaluateEditor({ fieldName: 'score', text: '1.5', fields: FIELDS });
  assert.equal(s.canSave, false);
  assert.match(s.parsed.error, /whole number/);
  s = evaluateEditor({ fieldName: 'newThing', text: '1.5', fields: FIELDS });
  assert.equal(s.known, null);
  assert.equal(s.parsed.type, 'double');
  assert.equal(s.canSave, true);
  s = evaluateEditor({ fieldName: 'bad name', text: '1', fields: FIELDS });
  assert.equal(s.canSave, false);
  assert.ok(s.nameError);
  s = evaluateEditor({ fieldName: '', text: '1', fields: FIELDS });
  assert.equal(s.canSave, false);
  s = evaluateEditor({ fieldName: 'tags', text: '   ', fields: FIELDS });
  assert.equal(s.canSave, false);
  assert.match(s.hint, /empty string/);
  s = evaluateEditor({ fieldName: 'tags', text: '""', fields: FIELDS });
  assert.equal(s.canSave, true);
  assert.equal(s.parsed.value, '');
  // Known fields with unusual names are accepted as they are.
  s = evaluateEditor({ fieldName: 'odd-name', text: 'x', fields: [{ name: 'odd-name', type: 'string' }] });
  assert.equal(s.canSave, true);
  assert.ok(NEW_FIELD_NAME_RE.test('profile.city'));
  assert.ok(!NEW_FIELD_NAME_RE.test('1abc'));
});

test('formatForEditing / pickIdentity', () => {
  assert.equal(formatForEditing({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(formatForEditing('text'), 'text');
  assert.equal(formatForEditing(5), '5');
  assert.equal(formatForEditing(null), 'null');
  assert.equal(formatForEditing(undefined), '');
  assert.deepEqual(pickIdentity({ email: 'a@example.com', userId: 'u1' }), { userId: 'u1' });
  assert.deepEqual(pickIdentity({ email: 'a@example.com' }), { email: 'a@example.com' });
  assert.equal(pickIdentity({}), null);
});

// ── updateUser: sticky outcomeUnknown ──────────────────────────────────────

test('updateUser: an earlier no-response attempt keeps outcomeUnknown on a later definite failure', async () => {
  const api = fakeApi([
    { ok: false, status: 0, error: { code: 'TIMEOUT', message: 'Timed out.' } },
    { ok: false, status: 400, data: { code: 'BadParams', msg: 'dataFields bad' }, error: { code: 'HTTP', message: 'HTTP 400' } },
  ]);
  await assert.rejects(updateUser({ api }, { email: 'a@example.com', dataFields: {}, backoffs: [0, 0] }), (e) =>
    e.outcomeUnknown === true && e.apiCode === 'BadParams' && e.status === 400 && /may or may not/.test(e.message));
  assert.equal(api.calls.length, 2);
  const api2 = fakeApi([
    { ok: false, status: 0, error: { code: 'NETWORK', message: 'Network error.' } },
    { ok: true, status: 200, data: { code: 'InvalidEmailAddressError', msg: 'Invalid email' } },
  ]);
  await assert.rejects(updateUser({ api: api2 }, { email: 'a@example.com', dataFields: {}, backoffs: [0, 0] }), (e) =>
    e.outcomeUnknown === true && e.apiCode === 'InvalidEmailAddressError');
  // Without an uncertain attempt a definite failure stays definite.
  const api3 = fakeApi([{ ok: false, status: 503, error: { code: 'HTTP', message: 'HTTP 503' } }, { ok: false, status: 400, error: { code: 'HTTP', message: 'HTTP 400' } }]);
  await assert.rejects(updateUser({ api: api3 }, { email: 'a@example.com', dataFields: {}, backoffs: [0, 0] }), (e) => e.outcomeUnknown === false);
});

// ── field editor: guarded writes, createNewFields, the action lock ─────────

test('createNewFieldsFor: true always, "new" only for fields not in the list, else not sent', () => {
  const fields = [{ name: 'color', type: 'string' }];
  assert.equal(createNewFieldsFor(true, 'color', fields), true);
  assert.equal(createNewFieldsFor('new', 'color', fields), undefined);
  assert.equal(createNewFieldsFor('new', 'brandNew', fields), true);
  assert.equal(createNewFieldsFor('new', 'anything', []), true);
  assert.equal(createNewFieldsFor(undefined, 'brandNew', fields), undefined);
  assert.equal(createNewFieldsFor(false, 'brandNew', fields), undefined);
});

test('writeField: beforeSave refusal sends nothing; otherwise one update with createNewFields', async () => {
  const api = fakeApi([SUCCESS]);
  const seen = [];
  await assert.rejects(writeField({ api }, {
    projectKey: 'us:1', who: { userId: 'u1' }, field: 'color', value: 'red',
    beforeSave: async (w) => { seen.push(w); return 'The project changed.'; },
  }), (e) => e.code === 'INVALID' && e.message === 'The project changed.');
  assert.equal(api.calls.length, 0);
  assert.deepEqual(seen, [{ field: 'color', value: 'red', dataFields: { color: 'red' } }]);
  // A throwing beforeSave refuses too.
  await assert.rejects(writeField({ api }, { projectKey: 'us:1', who: { userId: 'u1' }, field: 'c', value: 1, beforeSave: () => { throw new Error('nope'); } }),
    (e) => e.code === 'INVALID' && e.message === 'nope');
  assert.equal(api.calls.length, 0);

  const res = await writeField({ api }, {
    projectKey: 'us:1', who: { userId: 'u1' }, field: 'profile.city', value: 'Oslo', mergeNestedObjects: true,
    createNewFields: 'new', fields: [{ name: 'color' }], beforeSave: async () => null,
  });
  assert.deepEqual(res, SUCCESS.data);
  assert.deepEqual(api.calls[0], {
    projectKey: 'us:1', method: 'POST', path: UPDATE_USER_PATH,
    body: { userId: 'u1', dataFields: { profile: { city: 'Oslo' } }, mergeNestedObjects: true, createNewFields: true },
  });
  await writeField({ api }, { projectKey: 'us:1', who: { userId: 'u1' }, field: 'color', value: null, createNewFields: 'new', fields: [{ name: 'color' }] });
  assert.equal('createNewFields' in api.calls[1].body, false);
});

test('createActionLock: one run at a time, busy while running, errors become the result', async () => {
  const changes = [];
  const lock = createActionLock(() => changes.push(lock.busy));
  let release;
  const p = lock.run(() => new Promise((r) => { release = r; }));
  assert.equal(lock.busy, true);
  assert.equal(await lock.run(async () => 'second'), undefined, 'ignored while busy');
  release('done');
  assert.equal(await p, 'done');
  assert.equal(lock.busy, false);
  assert.deepEqual(changes, [true, false]);

  await lock.run(async () => { throw Object.assign(new Error('Timed out.'), { outcomeUnknown: true }); });
  assert.deepEqual(lock.result, { tone: 'warn', message: 'Timed out.' });
  await lock.run(async () => { throw new Error('Bad'); });
  assert.deepEqual(lock.result, { tone: 'bad', message: 'Bad' });
  await lock.run(async () => { throw new DOMException('x', 'AbortError'); });
  assert.equal(lock.result, null);
  lock.setResult(null, 'Clearing…');
  assert.deepEqual(lock.result, { tone: null, message: 'Clearing…' });
});
