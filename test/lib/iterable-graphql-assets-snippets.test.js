import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appGraphql, GRAPHQL_PATH } from '../../src/lib/iterable/graphql.js';
import { GraphqlError, IterableError } from '../../src/lib/iterable/errors.js';
import {
  fetchAssetFolder, createAssetFolder, uploadImage, assetFolderVariables, normalizeAssetFolder, validateFolderName,
  stripDataUrlPrefix, uploadBody, FETCH_ALL_LIMIT, UPLOAD_PATH,
} from '../../src/lib/iterable/assets.js';
import { fetchSnippets } from '../../src/lib/iterable/snippets.js';
import { HttpError } from '../../src/core/http.js';

// All data synthetic. No network: http is a fake recording calls.

function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    appFetch: async (path, opts = {}) => {
      calls.push({ path, ...opts });
      return handler(path, opts, calls.length);
    },
  };
}

// ── GraphQL ────────────────────────────────────────────────────────────────

test('appGraphql posts operationName/query/variables to /graphql and returns data', async () => {
  const http = fakeHttp(() => ({ data: { hello: 1 } }));
  const ac = new AbortController();
  const data = await appGraphql({ http }, { operationName: 'Op', query: 'query Op { hello }', variables: { a: 1 }, signal: ac.signal });
  assert.deepEqual(data, { hello: 1 });
  assert.equal(http.calls[0].path, GRAPHQL_PATH);
  assert.equal(http.calls[0].method, 'POST');
  assert.deepEqual(http.calls[0].body, { operationName: 'Op', variables: { a: 1 }, query: 'query Op { hello }' });
  assert.equal(http.calls[0].signal, ac.signal);
});

test('appGraphql surfaces GraphQL errors as GraphqlError (with partial data)', async () => {
  const http = fakeHttp(() => ({ errors: [{ message: 'Folder not found', path: ['assetFolder'] }], data: { assetFolder: null } }));
  await assert.rejects(appGraphql({ http }, { operationName: 'Op', query: 'q' }), (err) => {
    assert.ok(err instanceof GraphqlError);
    assert.ok(err instanceof IterableError);
    assert.equal(err.code, 'GRAPHQL');
    assert.equal(err.message, 'Folder not found');
    assert.equal(err.errors.length, 1);
    assert.deepEqual(err.data, { assetFolder: null });
    assert.equal(err.operationName, 'Op');
    return true;
  });
});

test('appGraphql: an empty errors array is not an error', async () => {
  const http = fakeHttp(() => ({ errors: [], data: { x: 1 } }));
  assert.deepEqual(await appGraphql({ http }, { query: 'q' }), { x: 1 });
});

test('appGraphql: a 4xx carrying a GraphQL error document is a GraphqlError with that status', async () => {
  const http = fakeHttp(() => { throw new HttpError(400, 'HTTP 400', { errors: [{ message: 'Variable $folderId bad' }] }); });
  await assert.rejects(appGraphql({ http }, { query: 'q' }), (err) => err instanceof GraphqlError && err.status === 400 && /folderId/.test(err.message));
});

test('appGraphql: plain HTTP errors, network errors, bad bodies and aborts', async () => {
  await assert.rejects(appGraphql({ http: fakeHttp(() => { throw new HttpError(403, 'x', null); }) }, { query: 'q' }),
    (err) => err instanceof IterableError && !(err instanceof GraphqlError) && err.code === 'HTTP' && err.status === 403 && /signed in/.test(err.message));
  await assert.rejects(appGraphql({ http: fakeHttp(() => { throw new TypeError('Failed to fetch'); }) }, { query: 'q' }),
    (err) => err.code === 'NETWORK' && err.status === 0);
  await assert.rejects(appGraphql({ http: fakeHttp(() => '<html>login</html>') }, { query: 'q' }), (err) => err.code === 'BAD_RESPONSE');
  await assert.rejects(appGraphql({ http: fakeHttp(() => ({})) }, { query: 'q' }), (err) => err.code === 'BAD_RESPONSE');
  const abort = new DOMException('Aborted', 'AbortError');
  await assert.rejects(appGraphql({ http: fakeHttp(() => { throw abort; }) }, { query: 'q' }), (err) => err === abort);
  await assert.rejects(appGraphql({ http: fakeHttp(() => ({ data: {} })) }, {}), (err) => err.code === 'INVALID');
});

// ── Assets ─────────────────────────────────────────────────────────────────

// Shaped like FetchAssetFolderQuery's response in the Image Path Selector.
const FOLDER_RESPONSE = {
  data: {
    assetFolder: {
      info: { count: 3, limit: 9999, offset: 0, page: 0, __typename: 'PaginationInfo' },
      name: 'Spring',
      id: 42,
      content: [
        { __typename: 'AssetSubfolder', id: 43, name: 'Heroes' },
        {
          __typename: 'ImageAsset', id: 9001, projectId: 1, assetName: 'banner.png', altText: 'A banner', assetType: 'Image',
          createdAt: '2024-01-02T03:04:05Z', updatedAt: '2024-02-03T04:05:06Z', url: 'https://cdn.example.com/banner.png',
          size: 12345, height: 300, width: 600, mimeType: 'PNG',
        },
        { __typename: 'ImageAsset', id: '9002', assetName: 'logo.svg', url: 'https://cdn.example.com/logo.svg', size: '99', height: null, width: null, mimeType: 'SVG' },
      ],
      ancestors: [{ id: 1, name: '__root__', __typename: 'AssetFolder' }, { id: 7, name: 'Campaigns', __typename: 'AssetFolder' }],
      __typename: 'AssetFolder',
    },
  },
};

test('assetFolderVariables: defaults are the script\'s request', () => {
  assert.deepEqual(assetFolderVariables({ folderId: 42 }), {
    folderId: 42, recursive: false, pagination: { offset: 0, limit: FETCH_ALL_LIMIT }, search: '',
    assetFilterInfo: { createdByUserId: null, updatedByUserId: null, mimeType: ['PNG', 'JPEG', 'GIF', 'WEBP', 'SVG'], size: null },
    sort: { sortBy: 'UpdatedAt', sortDirection: 'Descending' },
  });
  // Root: no mime filter, as in the script.
  const root = assetFolderVariables({});
  assert.equal(root.folderId, null);
  assert.equal(root.assetFilterInfo.mimeType, null);
  // Explicit paging, filters and sort.
  const v = assetFolderVariables({ folderId: 5, page: 3, perPage: 30, mimeTypes: null, sortBy: 'Name', sortDirection: 'Ascending', search: 'x' });
  assert.deepEqual(v.pagination, { offset: 60, limit: 30 });
  assert.equal(v.assetFilterInfo.mimeType, null);
  assert.deepEqual(v.sort, { sortBy: 'Name', sortDirection: 'Ascending' });
  assert.equal(v.search, 'x');
  // Unknown sort values fall back.
  assert.deepEqual(assetFolderVariables({ sortBy: 'Bogus', sortDirection: 'Up' }).sort, { sortBy: 'UpdatedAt', sortDirection: 'Descending' });
});

test('fetchAssetFolder normalises folder, breadcrumbs, subfolders and images', async () => {
  const http = fakeHttp(() => FOLDER_RESPONSE);
  const r = await fetchAssetFolder({ http }, { folderId: 42 });
  assert.equal(http.calls[0].body.operationName, 'FetchAssetFolderQuery');
  assert.match(http.calls[0].body.query, /assetFolder\(/);
  assert.equal(http.calls[0].body.variables.folderId, 42);
  assert.deepEqual(r.folder, { id: 42, name: 'Spring', isRoot: false });
  assert.deepEqual(r.ancestors, [{ id: 7, name: 'Campaigns' }]);
  assert.deepEqual(r.subfolders, [{ id: 43, name: 'Heroes' }]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.images[0], {
    id: 9001, name: 'banner.png', url: 'https://cdn.example.com/banner.png', thumbnailUrl: 'https://cdn.example.com/banner.png',
    width: 600, height: 300, size: 12345, mimeType: 'PNG', createdAt: '2024-01-02T03:04:05Z', updatedAt: '2024-02-03T04:05:06Z', altText: 'A banner',
  });
  assert.equal(r.images[1].size, 99);
  assert.equal(r.images[1].width, null);
  assert.equal(r.images[1].createdAt, null);
});

test('normalizeAssetFolder: root folder, missing info, junk content', () => {
  const r = normalizeAssetFolder({ id: 1, name: '__root__', content: [null, { __typename: 'Other' }], ancestors: null });
  assert.deepEqual(r.folder, { id: 1, name: '', isRoot: true });
  assert.equal(r.total, 0);
  assert.equal(r.info, null);
  assert.throws(() => normalizeAssetFolder(null), (e) => e.code === 'BAD_RESPONSE');
});

test('validateFolderName follows the script\'s rules', () => {
  assert.deepEqual(validateFolderName('  Spring 2024 '), { valid: true, name: 'Spring 2024' });
  assert.equal(validateFolderName('   ').valid, false);
  assert.equal(validateFolderName('x'.repeat(101)).valid, false);
  assert.equal(validateFolderName('x'.repeat(100)).valid, true);
  for (const bad of ['a"b', "a'b", 'a\\b', 'a/b', 'a,b']) assert.equal(validateFolderName(bad).valid, false, bad);
});

test('createAssetFolder validates first and sends the CreateAssetFolder mutation', async () => {
  const http = fakeHttp(() => ({ data: { createAssetFolder: 77 } }));
  assert.deepEqual(await createAssetFolder({ http }, { parentId: 42, name: ' New ' }), { id: 77, name: 'New' });
  assert.equal(http.calls[0].body.operationName, 'CreateAssetFolder');
  assert.deepEqual(http.calls[0].body.variables, { name: 'New', locationId: 42 });
  await assert.rejects(createAssetFolder({ http }, { name: 'a/b' }), (e) => e.code === 'INVALID' && /cannot contain/.test(e.message));
  assert.equal(http.calls.length, 1);
  const root = fakeHttp(() => ({ data: { createAssetFolder: 1 } }));
  await createAssetFolder({ http: root }, { name: 'Top' });
  assert.equal(root.calls[0].body.variables.locationId, null);
});

test('uploadImage posts the script\'s body to /i/assetManager/images', async () => {
  const http = fakeHttp(() => ({ id: 1 }));
  const res = await uploadImage({ http }, { folderId: 42, name: 'a.png', base64: 'data:image/png;base64,QUJD', width: 10, height: 20, altText: '  alt ' });
  assert.deepEqual(res, { id: 1 });
  assert.equal(http.calls[0].path, UPLOAD_PATH);
  assert.equal(http.calls[0].method, 'POST');
  assert.deepEqual(http.calls[0].body, { assetName: 'a.png', height: 20, width: 10, source: 'QUJD', destinationFolderId: 42, altText: 'alt' });
  // assetName overrides the file name; blank alt text is left out.
  await uploadImage({ http }, { folderId: null, name: 'a.png', base64: 'QUJD', width: 1, height: 1, assetName: 'renamed.png', altText: ' ' });
  assert.deepEqual(http.calls[1].body, { assetName: 'renamed.png', height: 1, width: 1, source: 'QUJD', destinationFolderId: null });
  await assert.rejects(uploadImage({ http }, { name: 'a.png', base64: 'QUJD' }), (e) => e.code === 'INVALID');
  await assert.rejects(uploadImage({ http }, { file: { type: 'application/pdf', name: 'x.pdf' } }), (e) => e.code === 'INVALID');
  const failing = fakeHttp(() => { throw new HttpError(413, 'HTTP 413', 'too big'); });
  await assert.rejects(uploadImage({ http: failing }, { name: 'a.png', base64: 'QUJD', width: 1, height: 1 }), (e) => e.code === 'HTTP' && e.status === 413);
});

test('stripDataUrlPrefix / uploadBody', () => {
  assert.equal(stripDataUrlPrefix('data:image/svg+xml;base64,PHN2Zz4='), 'PHN2Zz4=');
  assert.equal(stripDataUrlPrefix('QUJD'), 'QUJD');
  assert.throws(() => uploadBody({ name: '', base64: 'x', width: 1, height: 1 }), (e) => e.code === 'INVALID');
});

// ── Snippets ───────────────────────────────────────────────────────────────

const snippet = (i) => ({ id: i, name: `s${i}`, content: 'x', description: '', positionalParameters: [], updatedAt: '2024-01-01' });
function snippetPage(results, count) {
  return { data: { fetchSnippets: { paginationInfo: { count, offset: 0, limit: 999 }, results } } };
}

test('fetchSnippets: one short page is complete', async () => {
  const http = fakeHttp(() => snippetPage([snippet(1), snippet(2)], 2));
  const r = await fetchSnippets({ http });
  assert.equal(r.snippets.length, 2);
  assert.equal(r.total, 2);
  assert.equal(r.complete, true);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].body.operationName, 'FetchSnippets');
  assert.deepEqual(http.calls[0].body.variables, { pagination: { limit: 999, offset: 0 }, search: null, sort: { sortBy: 'UpdatedAt', sortDirection: 'Descending' } });
});

test('fetchSnippets pages past a full page using offset', async () => {
  const http = fakeHttp((path, opts) => {
    const { offset } = opts.body.variables.pagination;
    return offset === 0 ? snippetPage([snippet(1), snippet(2)], 3) : snippetPage([snippet(3)], 3);
  });
  const r = await fetchSnippets({ http }, { pageSize: 2 });
  assert.deepEqual(r.snippets.map((s) => s.id), [1, 2, 3]);
  assert.equal(r.complete, true);
  assert.deepEqual(http.calls.map((c) => c.body.variables.pagination.offset), [0, 2]);
});

test('fetchSnippets stops (incomplete) when the API ignores offset, and at maxPages', async () => {
  const same = fakeHttp(() => snippetPage([snippet(1), snippet(2)], undefined));
  const r = await fetchSnippets({ http: same }, { pageSize: 2 });
  assert.equal(r.snippets.length, 2);
  assert.equal(r.complete, false);
  assert.equal(same.calls.length, 2);

  let n = 0;
  const endless = fakeHttp(() => snippetPage([snippet(++n), snippet(++n)], 1000));
  const r2 = await fetchSnippets({ http: endless }, { pageSize: 2, maxPages: 3 });
  assert.equal(r2.snippets.length, 6);
  assert.equal(r2.complete, false);
});

test('fetchSnippets: total reached on a full page is complete; bad shapes throw', async () => {
  const http = fakeHttp(() => snippetPage([snippet(1), snippet(2)], 2));
  const r = await fetchSnippets({ http }, { pageSize: 2 });
  assert.equal(r.complete, true);
  assert.equal(http.calls.length, 1);
  await assert.rejects(fetchSnippets({ http: fakeHttp(() => ({ data: { fetchSnippets: null } })) }), (e) => e.code === 'BAD_RESPONSE');
});
