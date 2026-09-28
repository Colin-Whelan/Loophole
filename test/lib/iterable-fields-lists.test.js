import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUserFields, clearUserFieldsCache, parseMappings, mergeFieldLists, isMappingsShape, fieldFacets, fieldFacetsBody, findField,
  MAPPINGS_PATH, USER_MAPPINGS_PATH, FIELD_FACETS_PATH, MAX_FACET_SIZE,
} from '../../src/lib/iterable/fields.js';
import { fetchLists, createList, deleteList, listSize, isIterableSuccess } from '../../src/lib/iterable/lists.js';
import { HttpError } from '../../src/core/http.js';

// All data synthetic. No network.

function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    appFetch: async (path, opts = {}) => {
      calls.push({ path, ...opts });
      const r = routes[path];
      if (typeof r === 'function') return r(opts);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

beforeEach(() => clearUserFieldsCache());

test('parseMappings accepts the known array shape and tolerated envelopes', () => {
  assert.deepEqual(parseMappings([{ fieldName: 'a', fieldType: 'string' }, { fieldName: '', fieldType: 'x' }, null, { fieldName: 'b' }]),
    [{ name: 'a', type: 'string' }, { name: 'b', type: '' }]);
  assert.deepEqual(parseMappings({ mappings: [{ fieldName: 'a', fieldType: 'long' }] }), [{ name: 'a', type: 'long' }]);
  assert.deepEqual(parseMappings({ fields: { a: 'date', b: { type: 'object' } } }), [{ name: 'a', type: 'date' }, { name: 'b', type: 'object' }]);
  assert.deepEqual(parseMappings(null), []);
  assert.deepEqual(parseMappings('<html>'), []);
});

test('mergeFieldLists: first source sets the type, sources are recorded, sorted by name', () => {
  const merged = mergeFieldLists([
    { source: 'mappings', fields: [{ name: 'zeta', type: 'long' }, { name: 'Alpha', type: '' }] },
    { source: 'userMappings', fields: [{ name: 'zeta', type: 'double' }, { name: 'Alpha', type: 'string' }, { name: 'beta', type: 'boolean' }] },
  ]);
  assert.deepEqual(merged, [
    { name: 'Alpha', type: 'string', sources: ['mappings', 'userMappings'] },
    { name: 'beta', type: 'boolean', sources: ['userMappings'] },
    { name: 'zeta', type: 'long', sources: ['mappings', 'userMappings'] },
  ]);
});

test('getUserFields merges both endpoints and caches per project with a TTL', async () => {
  const http = fakeHttp({
    [MAPPINGS_PATH]: [{ fieldName: 'email', fieldType: 'string' }, { fieldName: 'score', fieldType: 'long' }],
    [USER_MAPPINGS_PATH]: [{ fieldName: 'score', fieldType: 'double' }, { fieldName: 'shoppingCartItems', fieldType: 'nested' }],
  });
  let t = 1000;
  const now = () => t;
  const f1 = await getUserFields({ http, projectKey: 'us:1' }, { now });
  assert.deepEqual(f1.map((f) => [f.name, f.type]), [['email', 'string'], ['score', 'long'], ['shoppingCartItems', 'nested']]);
  assert.deepEqual(findField(f1, 'score').sources, ['mappings', 'userMappings']);
  assert.ok(Object.isFrozen(f1) && Object.isFrozen(f1[0]));
  assert.equal(http.calls.length, 2);

  assert.equal(await getUserFields({ http, projectKey: 'us:1' }, { now }), f1);   // cached
  assert.equal(http.calls.length, 2);
  await getUserFields({ http, projectKey: 'us:2' }, { now });                     // other project
  assert.equal(http.calls.length, 4);
  t += 11 * 60 * 1000;                                                            // expired
  await getUserFields({ http, projectKey: 'us:1' }, { now });
  assert.equal(http.calls.length, 6);
  await getUserFields({ http, projectKey: 'us:1' }, { now, force: true });        // forced
  assert.equal(http.calls.length, 8);
});

test('getUserFields: project tracker key, shared in-flight request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const http = fakeHttp({
    [MAPPINGS_PATH]: async () => { await gate; return [{ fieldName: 'a', fieldType: 'string' }]; },
    [USER_MAPPINGS_PATH]: [],
  });
  const project = { current: () => ({ key: 'eu:5' }) };
  const p1 = getUserFields({ http, project });
  const p2 = getUserFields({ http, projectKey: 'eu:5' });
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b);
  assert.equal(http.calls.length, 2);
});

test('getUserFields: one endpoint failing is tolerated, both failing throws', async () => {
  const half = fakeHttp({ [MAPPINGS_PATH]: new HttpError(500, 'x'), [USER_MAPPINGS_PATH]: [{ fieldName: 'a', fieldType: 'string' }] });
  assert.deepEqual((await getUserFields({ http: half, projectKey: 'p' })).map((f) => f.name), ['a']);
  const none = fakeHttp({ [MAPPINGS_PATH]: new HttpError(401, 'x'), [USER_MAPPINGS_PATH]: new HttpError(401, 'x') });
  await assert.rejects(getUserFields({ http: none, projectKey: 'q' }), (e) => e.code === 'HTTP' && e.status === 401);
  // A failure isn't cached.
  const ok = fakeHttp({ [MAPPINGS_PATH]: [{ fieldName: 'b', fieldType: 'long' }], [USER_MAPPINGS_PATH]: [] });
  assert.equal((await getUserFields({ http: ok, projectKey: 'q' }))[0].name, 'b');
});

test('getUserFields: an aborted caller stops waiting without cancelling the shared load', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const http = fakeHttp({ [MAPPINGS_PATH]: async () => { await gate; return [{ fieldName: 'a', fieldType: 'string' }]; }, [USER_MAPPINGS_PATH]: [] });
  const ac = new AbortController();
  const aborted = getUserFields({ http, projectKey: 'z' }, { signal: ac.signal });
  const other = getUserFields({ http, projectKey: 'z' });
  ac.abort();
  await assert.rejects(aborted, (e) => e.name === 'AbortError');
  release();
  assert.equal((await other)[0].name, 'a');
});

test('fieldFacets posts the explorer\'s body and flags truncation', async () => {
  const http = fakeHttp({ [FIELD_FACETS_PATH]: { terms: ['red', 'blue', { term: 'green' }, null] } });
  const r = await fieldFacets({ http }, { field: 'color', search: 'b', limit: 3 });
  assert.deepEqual(r, { values: ['red', 'blue', 'green'], truncated: true });
  assert.equal(http.calls[0].method, 'POST');
  assert.deepEqual(http.calls[0].body, { dataType: 'user', field: 'color', searchPrefix: 'b', size: 3 });
  const all = fakeHttp({ [FIELD_FACETS_PATH]: { terms: ['x'] } });
  assert.deepEqual(await fieldFacets({ http: all }, { field: 'f' }), { values: ['x'], truncated: false });
  assert.deepEqual(all.calls[0].body, { dataType: 'user', field: 'f', searchPrefix: '', size: MAX_FACET_SIZE });
  assert.deepEqual(await fieldFacets({ http: fakeHttp({ [FIELD_FACETS_PATH]: {} }) }, { field: 'f' }), { values: [], truncated: false });
  assert.equal(fieldFacetsBody({ field: 'f', limit: 10 ** 9 }).size, MAX_FACET_SIZE);
  await assert.rejects(fieldFacets({ http }, {}), (e) => e.code === 'INVALID');
  await assert.rejects(fieldFacets({ http: fakeHttp({ [FIELD_FACETS_PATH]: { terms: 'x' } }) }, { field: 'f' }), (e) => e.code === 'BAD_RESPONSE');
  await assert.rejects(fieldFacets({ http: fakeHttp({ [FIELD_FACETS_PATH]: new HttpError(500, 'x') }) }, { field: 'f' }), (e) => e.code === 'HTTP' && e.status === 500);
});

// ── Lists (moved from bulk-data; bulk-data's own tests cover the wrappers) ──

function fakeApi(responder) {
  const calls = [];
  return { calls, request: async (opts) => { calls.push(opts); return responder(opts, calls.length); } };
}

test('lists: fetch / create / delete / size bind the project and read the responses', async () => {
  const api = fakeApi((o) => {
    if (o.method === 'GET' && o.path === '/api/lists') return { ok: true, status: 200, data: { lists: [{ id: 1, name: 'A' }] } };
    if (o.method === 'POST') return { ok: true, status: 200, data: { listId: 9 } };
    if (o.method === 'DELETE') return { ok: true, status: 200, data: { code: 'Success' } };
    return { ok: true, status: 200, data: ' 12 ' };
  });
  assert.deepEqual((await fetchLists({ api }, { projectKey: 'us:1' })).lists, [{ id: 1, name: 'A' }]);
  assert.equal((await createList({ api }, { projectKey: 'us:1', name: 'N' })).listId, 9);
  assert.equal((await deleteList({ api }, { projectKey: 'us:1', listId: 'a/b' })).ok, true);
  assert.equal((await listSize({ api }, { projectKey: 'us:1', listId: 5 })).size, 12);
  assert.ok(api.calls.every((c) => c.projectKey === 'us:1'));
  assert.equal(api.calls[2].path, '/api/lists/a%2Fb');
  assert.deepEqual(api.calls[1].body, { name: 'N' });
});

test('lists: createList is not retried on an unknown outcome', async () => {
  const api = fakeApi(() => ({ ok: false, status: 0, error: { code: 'NETWORK', message: 'x' } }));
  const r = await createList({ api }, { projectKey: 'p', name: 'N' });
  assert.equal(r.ok, false);
  assert.equal(api.calls.length, 1);
});

test('isIterableSuccess', () => {
  assert.equal(isIterableSuccess({ ok: true, data: { code: 'Success' } }), true);
  assert.equal(isIterableSuccess({ ok: true, data: { code: 'BadParams' } }), false);
  assert.equal(isIterableSuccess({ ok: true, data: null }), true);
  assert.equal(isIterableSuccess({ ok: false }), false);
});

test('getUserFields: unrecognised response shapes are failures, never a cached empty list', async () => {
  assert.equal(isMappingsShape('<html>login</html>'), false);
  assert.equal(isMappingsShape({ error: { message: 'x' }, status: 500 }), false);
  assert.equal(isMappingsShape({}), false);
  assert.equal(isMappingsShape([]), true);
  assert.equal(isMappingsShape({ mappings: [] }), true);
  assert.equal(isMappingsShape({ a: 'string', b: { type: 'long' } }), true);
  const html = fakeHttp({ [MAPPINGS_PATH]: '<html>', [USER_MAPPINGS_PATH]: '<html>' });
  await assert.rejects(getUserFields({ http: html, projectKey: 'shape' }), (e) => e.code === 'BAD_RESPONSE');
  const good = fakeHttp({ [MAPPINGS_PATH]: [{ fieldName: 'a', fieldType: 'string' }], [USER_MAPPINGS_PATH]: '<html>' });
  assert.deepEqual((await getUserFields({ http: good, projectKey: 'shape' })).map((f) => f.name), ['a']);
});

test('getUserFields: without a project key nothing is cached (no cross-project sharing)', async () => {
  const http = fakeHttp({ [MAPPINGS_PATH]: [{ fieldName: 'a', fieldType: 'string' }], [USER_MAPPINGS_PATH]: [] });
  await getUserFields({ http });
  await getUserFields({ http, project: { current: () => null } });
  assert.equal(http.calls.length, 4);
});
