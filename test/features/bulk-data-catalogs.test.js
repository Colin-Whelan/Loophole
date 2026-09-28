import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectIdColumn, catalogNameFromPath, isCatalogsIndexPath, areaOf, coerceCell, utf8Bytes, validateItemId, periodColumns,
  buildDocument, catalogRunItem, documentWeight, documentsMap, catalogBatchRequest, catalogItemsPath, catalogScope,
  describeCatalogScope, parseCatalogList, unwrapListResponse, exportItemToRow, exportColumns, exportCell, buildExportCsv,
  exportCsvChunks, exportFileName, createExportCollector, sweepDone,
  ITEM_ID_MAX, MAX_DOC_BYTES, MAX_CATALOG_BODY_BYTES, CATALOG_FAILURE_COLUMNS,
} from '../../src/features/bulk-data/catalog-logic.js';
import {
  clampCatalogRate, clampCatalogBatch, PACING, failuresCsv, otherCheckpointNames, otherPushCheckpointNames, checkpointName,
} from '../../src/features/bulk-data/logic.js';
import { Run } from '../../src/features/bulk-data/engine.js';
import { CATALOG_FATAL, fetchCatalogs, fetchCatalogItemsPage, sendBatch } from '../../src/features/bulk-data/requests.js';
import { parseCsvAll, rowToObject } from '../../src/core/csv.js';
import { matchRoute } from '../../src/core/router.js';
import { BODY_MAX_BYTES } from '../../src/core/api-validation.js';
import meta from '../../src/features/bulk-data/meta.js';

// Synthetic data only.

// ── Routes ────────────────────────────────────────────────────────────────

test('meta routes: the lists and catalogs indexes, never a list or catalog page', () => {
  for (const t of ['/lists', '/lists/?q=1', '/catalogs', '/catalogs/', '/catalogs?sort=name', '/catalogs/?x=1']) assert.equal(matchRoute(meta.routes, t), true, t);
  for (const t of ['/catalogs/table/Shoes', '/catalogs/Shoes', '/catalogsx', '/lists/12', '/']) assert.equal(matchRoute(meta.routes, t), false, t);
});

test('areaOf picks the tab family from the page', () => {
  assert.equal(areaOf('/catalogs'), 'catalogs');
  assert.equal(areaOf('/catalogs/table/Shoes'), 'catalogs');
  assert.equal(areaOf('/lists'), 'lists');
  assert.equal(areaOf('/catalogsx'), 'lists');
  assert.equal(areaOf(''), 'lists');
});

test('catalog names from app paths (row links)', () => {
  assert.equal(catalogNameFromPath('/catalogs/table/Verity-Codes'), 'Verity-Codes');
  assert.equal(catalogNameFromPath('/catalogs/Verity-Codes'), 'Verity-Codes');
  assert.equal(catalogNameFromPath('/catalogs/table/My%20Cat'), 'My Cat');
  assert.equal(catalogNameFromPath('/catalogs'), '');
  assert.equal(catalogNameFromPath('/catalogs/table'), '');
  assert.equal(catalogNameFromPath('/catalogs/table/settings'), '');
  assert.equal(catalogNameFromPath('/lists/3'), '');
  assert.equal(isCatalogsIndexPath('/catalogs/'), true);
  assert.equal(isCatalogsIndexPath('/catalogs/table/x'), false);
});

// ── Columns, values, limits ───────────────────────────────────────────────

test('detectIdColumn goes by confidence, not header order', () => {
  assert.equal(detectIdColumn(['sku', 'Item_ID', 'name']), 'Item_ID');
  assert.equal(detectIdColumn(['name', 'SKU']), 'SKU');
  assert.equal(detectIdColumn(['code', 'key']), 'key');
  assert.equal(detectIdColumn(['name', 'price']), null);
});

test('periodColumns flags dotted field names', () => {
  assert.deepEqual(periodColumns(['id', 'a.b', 'c', 'x.y.z']), ['a.b', 'x.y.z']);
  assert.deepEqual(periodColumns(['id']), []);
});

test('coerceCell: inference by default, raw text with forceText, empty always omitted', () => {
  assert.equal(coerceCell('12345', false), 12345);
  assert.equal(coerceCell('00123', false), '00123');
  assert.equal(coerceCell('true', false), true);
  assert.deepEqual(coerceCell('{"a":1}', false), { a: 1 });
  assert.equal(coerceCell('12345', true), '12345');
  assert.equal(coerceCell(' 7 ', true), ' 7 ');
  assert.equal(coerceCell('   ', true), undefined);
  assert.equal(coerceCell('', false), undefined);
  assert.equal(coerceCell(null, true), undefined);
});

test('utf8Bytes matches TextEncoder', () => {
  for (const s of ['abc', 'é', '€', '😀', 'a😀b€', '']) assert.equal(utf8Bytes(s), new TextEncoder().encode(s).length, s);
});

test('validateItemId: letters, digits, dashes, 255 max', () => {
  assert.equal(validateItemId('abc-123'), null);
  assert.equal(validateItemId('a'.repeat(ITEM_ID_MAX)), null);
  assert.equal(validateItemId('a'.repeat(ITEM_ID_MAX + 1)), 'id_too_long');
  assert.equal(validateItemId('a_b'), 'id_bad_chars');
  assert.equal(validateItemId('a b'), 'id_bad_chars');
  assert.equal(validateItemId('a.b'), 'id_bad_chars');
  assert.equal(validateItemId(''), 'missing_id');
});

test('buildDocument: the ID is the map key, not a field; empties omitted; types inferred', () => {
  const b = buildDocument({ sku: ' A-1 ', name: 'Shoe', price: '19.99', zip: '07030', tags: '["x"]', note: '' }, 'sku', false);
  assert.equal(b.id, 'A-1');
  assert.deepEqual(b.doc, { name: 'Shoe', price: 19.99, zip: '07030', tags: ['x'] });
  assert.equal(b.bytes, utf8Bytes(JSON.stringify(b.doc)));
  assert.deepEqual(buildDocument({ sku: 'A', n: '5' }, 'sku', true).doc, { n: '5' });
  assert.deepEqual(buildDocument({ sku: 'a b', n: '5' }, 'sku', false), { error: 'id_bad_chars', id: 'a b' });
  assert.deepEqual(buildDocument({ sku: '', n: '5' }, 'sku', false), { error: 'missing_id', id: '' });
});

test('buildDocument: 30 KB document cap (exact bytes)', () => {
  const overhead = utf8Bytes(JSON.stringify({ f: '' }));
  const fits = buildDocument({ id: 'x', f: 'a'.repeat(MAX_DOC_BYTES - overhead) }, 'id', true);
  assert.equal(fits.bytes, MAX_DOC_BYTES);
  assert.equal(fits.error, undefined);
  const over = buildDocument({ id: 'x', f: 'a'.repeat(MAX_DOC_BYTES - overhead + 1) }, 'id', true);
  assert.equal(over.error, 'doc_too_large');
  assert.equal(over.bytes, MAX_DOC_BYTES + 1);
  // Multi-byte text counts in bytes, not characters.
  assert.equal(buildDocument({ id: 'x', f: '€'.repeat(11000) }, 'id', true).error, 'doc_too_large');
});

test('catalogRunItem turns unusable rows into engine skips with a readable detail', () => {
  assert.deepEqual(catalogRunItem({ id: 'bad id', a: '1' }, 'id', false),
    { skip: { itemId: 'bad id', reason: 'id_bad_chars', detail: 'only letters, digits and dashes are allowed' } });
  const big = catalogRunItem({ id: 'x', f: 'a'.repeat(MAX_DOC_BYTES) }, 'id', true);
  assert.equal(big.skip.reason, 'doc_too_large');
  assert.match(big.skip.detail, /bytes > 30,720|bytes > 30720/);
  assert.equal(catalogRunItem({ id: 'ok', a: '1' }, 'id', false).id, 'ok');
});

// ── Payloads ──────────────────────────────────────────────────────────────

test('documentsMap collapses duplicate IDs (last row wins) and counts them', () => {
  const m = documentsMap([{ id: 'a', doc: { v: 1 } }, { id: 'b', doc: { v: 2 } }, { id: 'a', doc: { v: 3 } }, { id: 'a', doc: { v: 4 } }]);
  assert.deepEqual(m.documents, { a: { v: 4 }, b: { v: 2 } });
  assert.equal(m.collisions, 2);
  assert.equal(Object.getPrototypeOf(m.documents), Object.prototype);
  assert.equal(JSON.stringify(documentsMap([{ id: 'constructor', doc: {} }]).documents), '{"constructor":{}}');
});

test('catalogBatchRequest: path, documents, merge flag only when merging', () => {
  const items = [{ id: 'a', doc: { n: 1 } }, { id: 'a', doc: { n: 2 } }];
  const merge = catalogBatchRequest('My Cat', items, { merge: true });
  assert.equal(merge.path, '/api/catalogs/My%20Cat/items');
  assert.deepEqual(merge.body, { documents: { a: { n: 2 } }, replaceUploadedFieldsOnly: true });
  assert.equal(merge.collisions, 1);
  const over = catalogBatchRequest('Shoes', items, { merge: false });
  assert.deepEqual(over.body, { documents: { a: { n: 2 } } });
  assert.equal(catalogItemsPath('a/b'), '/api/catalogs/a%2Fb/items');
});

test('document weights keep a full batch under the background body cap', () => {
  assert.ok(MAX_CATALOG_BODY_BYTES < BODY_MAX_BYTES);
  const item = buildDocument({ id: 'abc', f: 'x' }, 'id', true);
  const body = JSON.stringify({ documents: { [item.id]: item.doc } });
  assert.ok(documentWeight(item) >= utf8Bytes(body) - '{"documents":{}}'.length);
});

// ── Checkpoint scope ─────────────────────────────────────────────────────

test('catalog scope carries catalog, mode, ID column and text mode', () => {
  assert.equal(catalogScope({ catalogName: 'Shoes', merge: true, idCol: 'sku' }), 'catalog:Shoes|merge|id:sku');
  assert.equal(catalogScope({ catalogName: 'Shoes', merge: false, idCol: 'sku', forceText: true }), 'catalog:Shoes|overwrite|id:sku|text');
  assert.equal(describeCatalogScope('catalog:Shoes|merge|id:sku'), 'Shoes, merge fields only, ID column sku');
  assert.equal(describeCatalogScope('catalog:Shoes|overwrite|id:sku|text', { idCol: 'sku' }), 'Shoes, full overwrite, ID column sku, all values as text');
});

test('other-scope checkpoints are found per family', () => {
  const file = { name: 'a.csv', size: 10, lastModified: 5 };
  const names = [
    checkpointName('catalog:Shoes|merge|id:sku', file),
    checkpointName('catalog:Shoes|overwrite|id:sku', file),
    checkpointName('push', file),
    checkpointName('catalog:Shoes|merge|id:sku', { ...file, size: 11 }),
  ];
  assert.deepEqual(otherCheckpointNames(names, file, 'catalog:Shoes|merge|id:sku', 'catalog:').map((o) => o.scope), ['catalog:Shoes|overwrite|id:sku']);
  assert.deepEqual(otherPushCheckpointNames(names, file, 'push:list1').map((o) => o.scope), ['push']);
});

// ── Catalog list & export ─────────────────────────────────────────────────

test('parseCatalogList accepts the envelope, the bare object, strings and junk', () => {
  assert.deepEqual(parseCatalogList({ code: 'Success', params: { catalogNames: [{ name: 'A' }, { name: 'B' }], totalCatalogsCount: 2 } }), { names: ['A', 'B'], total: 2 });
  assert.deepEqual(parseCatalogList({ catalogNames: ['A', '', null, { nope: 1 }] }), { names: ['A'], total: null });
  assert.deepEqual(parseCatalogList('x'), { names: [], total: null });
});

test('unwrapListResponse and exportItemToRow handle both documented and live shapes', () => {
  const live = { code: 'Success', msg: '', params: { catalogItemsWithProperties: [{ itemId: 'a', value: { n: 1 } }], totalItemsCount: 5 } };
  assert.deepEqual(unwrapListResponse(live), { items: [{ itemId: 'a', value: { n: 1 } }], total: 5 });
  assert.deepEqual(unwrapListResponse({ catalogItemsWithProperties: [], totalItemsCount: 0 }), { items: [], total: 0 });
  assert.deepEqual(unwrapListResponse(null), { items: [], total: null });
  assert.deepEqual(exportItemToRow({ itemId: 7, value: { underlying: { n: 1 } } }), { id: '7', fields: { n: 1 } });
  // A real field named "underlying" next to others survives.
  assert.deepEqual(exportItemToRow({ itemId: 'x', value: { underlying: { n: 1 }, m: 2 } }).fields, { underlying: { n: 1 }, m: 2 });
  assert.deepEqual(exportItemToRow({ itemId: 'x', value: [1] }).fields, {});
  assert.equal(exportItemToRow(null), null);
});

test('export CSV: id first, union of fields in first-seen order, nested as JSON, CSV-escaped', () => {
  const rows = [
    { id: 'a', fields: { name: 'Shoe, red', price: 10, tags: ['x', 'y'] } },
    { id: 'b', fields: { name: 'Say "hi"', color: null, meta: { k: 1 } } },
  ];
  assert.deepEqual(exportColumns(rows), ['name', 'price', 'tags', 'color', 'meta']);
  assert.equal(exportCell(null), '');
  assert.equal(exportCell(false), 'false');
  const { csv, columns } = buildExportCsv(rows);
  assert.deepEqual(columns, ['name', 'price', 'tags', 'color', 'meta']);
  assert.equal(csv, 'id,name,price,tags,color,meta\n' +
    'a,"Shoe, red",10,"[""x"",""y""]",,\n' +
    'b,"Say ""hi""",,,,"{""k"":1}"\n');
});

test('export CSV chunks join to the same text and round-trip through the upload side', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ id: 'item-' + i, fields: { n: i, zip: '0' + i + '1', obj: { i } } });
  const whole = buildExportCsv(rows).csv;
  const chunks = exportCsvChunks(rows, undefined, 7);
  assert.equal(chunks.length, 4);   // 26 lines / 7
  assert.equal(chunks.join(''), whole);
  const [header, ...data] = parseCsvAll(whole);
  assert.equal(detectIdColumn(header), 'id');
  const doc = buildDocument(rowToObject(header, data[3]), 'id', false);
  assert.deepEqual(doc, { id: 'item-3', doc: { n: 3, zip: '031', obj: { i: 3 } }, bytes: doc.bytes });
});

test('export file name is filesystem-safe', () => {
  assert.equal(exportFileName('My Cat/2', '20260101_000000'), 'catalog_My_Cat_2_20260101_000000.csv');
});

test('export collector dedupes by itemId (first copy wins) and sweeps stop on unique counts', () => {
  const c = createExportCollector();
  assert.deepEqual(c.add([{ itemId: 'a', value: { v: 1 } }, { itemId: 'constructor', value: {} }]), { added: 2, dupes: 0 });
  assert.deepEqual(c.add([{ itemId: 'a', value: { v: 2 } }, { itemId: 'b', value: {} }, null]), { added: 1, dupes: 1 });
  assert.deepEqual(c.rows.map((r) => r.id), ['a', 'constructor', 'b']);
  assert.deepEqual(c.rows[0].fields, { v: 1 });
  assert.equal(sweepDone({ pageLength: 0, pageSize: 10, unique: 0, total: 5 }), true);
  assert.equal(sweepDone({ pageLength: 9, pageSize: 10, unique: 9, total: null }), true);
  assert.equal(sweepDone({ pageLength: 10, pageSize: 10, unique: 10, total: 30 }), false);
  assert.equal(sweepDone({ pageLength: 10, pageSize: 10, unique: 30, total: 30 }), true);
  assert.equal(sweepDone({ pageLength: 10, pageSize: 10, unique: 20, total: 0 }), false);
});

test('catalog failures CSV has the userscript columns and neutralises formulas', () => {
  assert.deepEqual(CATALOG_FAILURE_COLUMNS, ['row_number', 'itemId', 'reason', 'detail']);
  assert.equal(failuresCsv([{ row_number: 2, itemId: '=cmd', reason: 'id_bad_chars', detail: '' }], CATALOG_FAILURE_COLUMNS),
    "row_number,itemId,reason,detail\n2,'=cmd,id_bad_chars,\n");
});

// ── Pacing ────────────────────────────────────────────────────────────────

test('catalog pacing: 10 req/s and 1000 items by default, capped at 100 and 1000', () => {
  assert.equal(clampCatalogRate(''), 10);
  assert.equal(clampCatalogRate('250'), 100);
  assert.equal(clampCatalogRate('0.01'), 0.1);
  assert.equal(clampCatalogBatch('x'), 1000);
  assert.equal(clampCatalogBatch('5000'), 1000);
  assert.equal(clampCatalogBatch('0'), 1000);
  assert.equal(clampCatalogBatch('7'), 7);
  assert.equal(PACING.catalogs.rateKey, 'catalogRateLimit');
  const byKey = Object.fromEntries(meta.settings.map((s) => [s.key, s]));
  assert.equal(byKey.catalogRateLimit.default, 10);
  assert.equal(byKey.catalogRateLimit.max, PACING.catalogs.maxRate);
  assert.equal(byKey.catalogBatchSize.default, 1000);
  assert.equal(byKey.catalogBatchSize.max, PACING.catalogs.maxBatch);
  assert.deepEqual([...new Set(meta.settings.map((s) => s.section))], ['Users & lists', 'Catalogs']);
});

// ── Engine with the catalog callbacks ─────────────────────────────────────

function csvBlob(lines) {
  return new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
}

function catalogRun(file, header, overrides = {}) {
  const saved = [];
  const sent = [];
  const logs = [];
  const run = new Run({
    file, header, batchSize: 3,
    buildItem: (obj) => catalogRunItem(obj, 'id', false),
    weightOf: documentWeight,
    maxBatchWeight: MAX_CATALOG_BODY_BYTES,
    idsOf: (obj) => ({ itemId: obj.id || '' }),
    sendBatch: async (items) => {
      const req = catalogBatchRequest('Shoes', items, { merge: true });
      sent.push(req.body);
      return { ok: true, status: 202, data: { code: 'Success' }, collisions: req.collisions };
    },
    onBatchOk: (res, items, r) => {
      r.stats.collisions += res.collisions || 0;
      return { success: items.length - (res.collisions || 0), fail: 0 };
    },
    checkpoints: { save: async (d) => { saved.push(d); }, clear: async () => {} },
    checkpointMeta: { projectKey: 'us:1', catalogName: 'Shoes' },
    onLog: (m, c) => logs.push([c, m]),
    ...overrides,
  });
  return { run, saved, sent, logs };
}

test('engine: bad rows are skipped with their reason, duplicates collapse and are counted', async () => {
  const file = csvBlob(['id,n', 'a,1', 'bad id,2', 'a,3', 'b,4', 'c,5']);
  const { run, sent, saved } = catalogRun(file, ['id', 'n']);
  await run.start();
  assert.equal(run.finished, true);
  assert.deepEqual(sent, [
    { documents: { a: { n: 3 } }, replaceUploadedFieldsOnly: true },
    { documents: { b: { n: 4 }, c: { n: 5 } }, replaceUploadedFieldsOnly: true },
  ]);
  assert.equal(run.stats.skipped, 1);
  assert.equal(run.stats.collisions, 1);
  assert.equal(run.stats.sentOk, 3);   // a (once), b, c
  assert.equal(run.committed, 5);
  assert.deepEqual(run.failures, [{ row_number: 2, itemId: 'bad id', reason: 'id_bad_chars', detail: 'only letters, digits and dashes are allowed' }]);
  assert.equal(saved.at(-1).stats.collisions, 1);
});

test('engine: a batch closes early at the body-size cap, and every row is still committed once', async () => {
  const lines = ['id,f'];
  for (let i = 1; i <= 7; i++) lines.push('i' + i + ',' + 'x'.repeat(100));
  const { run, sent } = catalogRun(csvBlob(lines), ['id', 'f'], { batchSize: 1000, maxBatchWeight: 250 });
  await run.start();
  assert.deepEqual(sent.map((b) => Object.keys(b.documents).length), [2, 2, 2, 1]);
  assert.equal(run.committed, 7);
  assert.equal(run.stats.rowsRead, 7);
  assert.equal(run.stats.sentOk, 7);
});

test('engine: a fatal 404 stops the run without committing that batch; collisions carry over on resume', async () => {
  const file = csvBlob(['id,n', 'a,1', 'b,2', 'c,3', 'd,4', 'e,5', 'f,6']);
  let calls = 0;
  const first = catalogRun(file, ['id', 'n'], {
    sendBatch: async (items) => {
      calls++;
      if (calls === 2) return { ok: false, status: 404, error: { code: 'HTTP', message: 'HTTP 404' }, fatal: true, data: { code: 'NotFound', msg: 'no catalog' } };
      return { ok: true, status: 202, data: {}, collisions: 1 };
    },
  });
  await first.run.start();
  assert.equal(first.run.finished, false);
  assert.equal(first.run.fatal.reason, 'http_404');
  assert.equal(first.run.committed, 3);
  const ck = first.saved.at(-1);
  assert.equal(ck.committedRows, 3);
  assert.equal(ck.stats.collisions, 1);
  const second = catalogRun(file, ['id', 'n']);
  await second.run.start(ck.committedRows, ck.stats);
  assert.equal(second.run.finished, true);
  assert.deepEqual(Object.keys(second.sent[0].documents), ['d', 'e', 'f']);
  assert.equal(second.run.stats.collisions, 1);
});

// ── Requests ──────────────────────────────────────────────────────────────

test('CATALOG_FATAL adds 400 and 404 to the core policy', () => {
  assert.equal(CATALOG_FATAL(400, {}), true);
  assert.equal(CATALOG_FATAL(404, {}), true);
  assert.equal(CATALOG_FATAL(401, {}), true);
  assert.equal(CATALOG_FATAL(0, { error: { code: 'NO_KEY' } }), true);
  assert.equal(CATALOG_FATAL(409, {}), false);
  assert.equal(CATALOG_FATAL(429, {}), false);
  assert.equal(CATALOG_FATAL(0, { error: { code: 'NETWORK' } }), false);
});

test('sendBatch with the catalog policy: 429 honours Retry-After, 404 is fatal at once', async () => {
  const waits = [];
  const run = { noteRetry() {}, log() {} };
  const responses = [{ ok: false, status: 429, retryAfterMs: 9000 }, { ok: true, status: 202, data: { code: 'Success' } }];
  const r1 = await sendBatch({ request: async () => responses.shift(), path: '/api/catalogs/x/items', body: {}, run, fatal: CATALOG_FATAL, wait: async (ms) => { waits.push(ms); } });
  assert.equal(r1.ok, true);
  assert.deepEqual(waits, [9000]);
  let n = 0;
  const r2 = await sendBatch({ request: async () => { n++; return { ok: false, status: 404 }; }, path: '/api/catalogs/x/items', body: {}, run, fatal: CATALOG_FATAL, wait: async () => {} });
  assert.equal(r2.fatal, true);
  assert.equal(n, 1);
});

test('fetchCatalogs pages until a short page and sorts the names', async () => {
  const calls = [];
  const request = async (opts) => {
    calls.push(opts);
    const page = opts.query.page;
    const names = page === 1 ? Array.from({ length: 50 }, (_, i) => ({ name: 'c' + String(i).padStart(2, '0') })) : [{ name: 'a-last' }];
    return { ok: true, status: 200, data: { code: 'Success', params: { catalogNames: names, totalCatalogsCount: 51 } } };
  };
  const r = await fetchCatalogs(request);
  assert.equal(r.ok, true);
  assert.equal(r.names.length, 51);
  assert.equal(r.names[0], 'a-last');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.query.page, c.query.pageSize]), [['GET', '/api/catalogs', 1, 50], ['GET', '/api/catalogs', 2, 50]]);
});

test('fetchCatalogItemsPage sends page/pageSize/orderBy as query and unwraps the envelope', async () => {
  let seen = null;
  const r = await fetchCatalogItemsPage({
    request: async (opts) => { seen = opts; return { ok: true, status: 200, data: { code: 'Success', params: { catalogItemsWithProperties: [{ itemId: 'a', value: {} }], totalItemsCount: 1 } } }; },
    path: '/api/catalogs/Shoes/items', page: 2, pageSize: 500, orderBy: 'name',
  });
  assert.deepEqual(seen.query, { page: 2, pageSize: 500, orderBy: 'name' });
  assert.equal(seen.method, 'GET');
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.items.length, 1);
  const bad = await fetchCatalogItemsPage({ request: async () => ({ ok: false, status: 400 }), path: '/api/catalogs/x/items', page: 1, pageSize: 10 });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});
