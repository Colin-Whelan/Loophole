import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCatalogs, fetchCatalogItemsPage, uploadCatalogItems, catalogItemsPath, CATALOG_FATAL, CATALOG_LIST_PAGE_SIZE,
} from '../../src/lib/iterable/catalogs.js';

// Synthetic data only; api is a fake wb:api client.
function fakeApi(fn) {
  const calls = [];
  return { calls, request: async (opts) => { calls.push(opts); return fn(opts, calls.length); } };
}

test('fetchCatalogs pages GET /api/catalogs with the project key and sorts names', async () => {
  const full = Array.from({ length: CATALOG_LIST_PAGE_SIZE }, (_, i) => ({ name: 'c' + String(i).padStart(2, '0') }));
  const api = fakeApi((o) => ({ ok: true, status: 200, data: { code: 'Success', params: { catalogNames: o.query.page === 1 ? full : [{ name: 'Alpha' }] } } }));
  const r = await fetchCatalogs({ api }, { projectKey: 'us:1' });
  assert.equal(r.ok, true);
  assert.equal(r.names.length, CATALOG_LIST_PAGE_SIZE + 1);
  assert.equal(r.names[0], 'Alpha');
  assert.deepEqual(api.calls.map((c) => [c.method, c.path, c.query.page, c.projectKey]), [['GET', '/api/catalogs', 1, 'us:1'], ['GET', '/api/catalogs', 2, 'us:1']]);
});

test('fetchCatalogItemsPage unwraps the envelope; failures come back as the retry result', async () => {
  const api = fakeApi(() => ({ ok: true, status: 200, data: { code: 'Success', params: { catalogItemsWithProperties: [{ itemId: 'a' }], totalItemsCount: 7 } } }));
  const r = await fetchCatalogItemsPage({ api }, { projectKey: 'us:1', catalogName: 'My Shoes', page: 2, pageSize: 10, orderBy: 'itemId' });
  assert.deepEqual([r.ok, r.items, r.total], [true, [{ itemId: 'a' }], 7]);
  assert.equal(api.calls[0].path, '/api/catalogs/My%20Shoes/items');
  assert.deepEqual(api.calls[0].query, { page: 2, pageSize: 10, orderBy: 'itemId' });
  const bad = await fetchCatalogItemsPage({ api: fakeApi(() => ({ ok: false, status: 400 })) }, { catalogName: 'x', page: 1, pageSize: 1 });
  assert.equal(bad.ok, false);
});

test('uploadCatalogItems posts the body and stops on 404 (CATALOG_FATAL)', async () => {
  const ok = fakeApi(() => ({ ok: true, status: 200, data: { code: 'Success' } }));
  const body = { documents: { a: { x: 1 } }, replaceUploadedFieldsOnly: true };
  assert.equal((await uploadCatalogItems({ api: ok }, { projectKey: 'us:1', catalogName: 'Shoes', body })).ok, true);
  assert.deepEqual(ok.calls[0], { method: 'POST', path: catalogItemsPath('Shoes'), body, timeoutMs: 120000, projectKey: 'us:1' });
  const missing = fakeApi(() => ({ ok: false, status: 404 }));
  const r = await uploadCatalogItems({ api: missing }, { catalogName: 'Nope', body, wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(missing.calls.length, 1);
  assert.equal(CATALOG_FATAL(404, {}), true);
});
