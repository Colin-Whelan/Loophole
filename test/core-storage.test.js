// Storage-backed core behaviour: settings writes (deleting keys, reset, function patches), the
// pieces behind ctx.saveSettings / ctx.api.onKeysChanged (content/context.js wires these; it
// imports theme CSS so it can't load in Node), and the background's stashed-mapper run.
// Plain Node with an in-memory chrome.storage.local: nothing here may need a DOM.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeChrome() {
  let data = {};
  const listeners = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    async get(keys) {
      if (keys == null) return clone(data);
      const out = {};
      for (const k of [].concat(keys)) if (Object.hasOwn(data, k)) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      for (const l of listeners) l(changes, 'local');
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
  return {
    raw: () => data,
    reset: () => { data = {}; listeners.clear(); },
    chrome: {
      storage: {
        local,
        onChanged: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
      },
    },
  };
}

const fake = makeFakeChrome();
globalThis.chrome = fake.chrome;

const settings = await import('../src/core/settings.js');
const { onKeysChanged } = await import('../src/core/api.js');
const keys = await import('../src/core/keys.js');
const { runStashedMappers, takeUnannounced } = await import('../src/options/importer/apply.js');
const { legacyStashKey } = await import('../src/options/importer/plan.js');
const { decodeStorage } = await import('../src/options/importer/decode.js');
const quickSearchImport = await import('../src/features/quick-search/import.js');

beforeEach(() => fake.reset());

const stored = () => fake.raw()['wb:settings'];

// ── settings.js ──────────────────────────────────────────────────────────

test('setFeatureValues: an undefined patch value deletes the key (back to the default)', async () => {
  await settings.setFeatureValues('link-params', { paramTypes: { a: 1 }, other: 'x' });
  assert.deepEqual(stored().features['link-params'].values, { paramTypes: { a: 1 }, other: 'x' });
  const s = await settings.setFeatureValues('link-params', { paramTypes: undefined });
  assert.deepEqual(stored().features['link-params'].values, { other: 'x' });
  assert.equal(Object.hasOwn(s.features['link-params'].values, 'paramTypes'), false);
});

test('resetFeatureValues: all values, or only the given keys; enabled is kept', async () => {
  await settings.setFeatureEnabled('quick-search', false);
  await settings.setFeatureValues('quick-search', { sortOrder: 'alpha', tags: [] });
  await settings.resetFeatureValues('quick-search', ['sortOrder']);
  assert.deepEqual(stored().features['quick-search'].values, { tags: [] });
  let s = await settings.load();
  assert.equal(s.features['quick-search'].values.sortOrder, 'custom'); // current default
  await settings.resetFeatureValues('quick-search');
  assert.equal(stored().features['quick-search'].values, undefined);
  s = await settings.load();
  assert.equal(s.features['quick-search'].enabled, false);
});

test('updateFeatureValues: a function patch sees the latest resolved values; null skips the write', async () => {
  await settings.setFeatureValues('quick-search', { tags: [{ id: 'a', label: 'A' }] });
  let seen = null;
  await settings.updateFeatureValues('quick-search', (latest) => {
    seen = latest;
    return { tags: [...latest.tags, { id: 'b', label: 'B' }] };
  });
  assert.equal(seen.sortOrder, 'custom');                      // defaults applied
  assert.deepEqual(stored().features['quick-search'].values.tags.map((t) => t.id), ['a', 'b']);
  const before = JSON.stringify(stored());
  let writes = 0;
  fake.chrome.storage.onChanged.addListener(() => { writes++; });
  await settings.updateFeatureValues('quick-search', () => null);
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(stored()), before);
});

// ── content ctx ──────────────────────────────────────────────────────────

// ctx.saveSettings(patch) = updateFeatureValues(meta.id, patch) → that feature's resolved values.
test('saveSettings path merges into one feature only', async () => {
  await settings.setFeatureValues('bulk-data', { batchSize: 100 });
  const save = (p) => settings.updateFeatureValues('quick-search', p).then((r) => r.features['quick-search'].values);
  const values = await save({ sortOrder: 'recent' });
  assert.equal(values.sortOrder, 'recent');
  assert.equal(stored().features['quick-search'].values.sortOrder, 'recent');
  assert.equal(stored().features['bulk-data'].values.batchSize, 100);
  const after = await save((latest) => ({ tags: [...latest.tags, { id: 'x', label: 'X' }] }));
  assert.deepEqual(after.tags.map((t) => t.id), ['x']);
});

test('onKeysChanged fires on vault writes, carries no data, and stops when the signal aborts', async () => {
  const ac = new AbortController();
  const calls = [];
  onKeysChanged((...args) => calls.push(args), ac.signal);
  await keys.setKey({ projectKey: 'us:1', apiKey: '0123456789abcdef0123456789abcdef' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], []);
  await keys.removeKey('us:1');
  assert.equal(calls.length, 2);
  ac.abort();
  await keys.setKey({ projectKey: 'us:2', apiKey: '0123456789abcdef0123456789abcdef' });
  assert.equal(calls.length, 2);
});

test('in a web page, onKeysChanged still fires while the wb:keys change record is dropped', async () => {
  const storage = await import('../src/core/storage.js');
  globalThis.location = { protocol: 'https:' };
  const seen = [];
  let fired = 0;
  try {
    storage.onChanged((changes) => seen.push(Object.keys(changes)));
    onKeysChanged(() => { fired++; });
  } finally {
    delete globalThis.location; // keys.js refuses to run in a web page, so write from "background"
  }
  await keys.setKey({ projectKey: 'us:3', apiKey: '0123456789abcdef0123456789abcdef' });
  assert.equal(fired, 1);
  assert.deepEqual(seen, [['wb:keys-rev']]);
});

// ── background: stashed mappers without a DOM ────────────────────────────

test('runStashedMappers imports a pending stash in a DOM-free context and marks it imported', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const fixture = (await import('node:fs')).readFileSync(
    new URL('./fixtures/tm/Iterable Template Quick Search.storage.json', import.meta.url), 'utf8');
  const name = 'Iterable Template Quick Search';
  await fake.chrome.storage.local.set({
    [legacyStashKey(name)]: { name, storage: decodeStorage(JSON.parse(fixture).data), savedAt: '2026-01-01T00:00:00Z', status: 'pending' },
  });
  const done = await runStashedMappers({ 'quick-search': quickSearchImport });
  assert.deepEqual(done, [{ name, featureId: 'quick-search' }]);
  assert.equal(fake.raw()[legacyStashKey(name)].status, 'imported');
  assert.deepEqual(stored().features['quick-search'].values.tags.map((t) => t.label), ['Newsletter', 'Promo']);
  assert.deepEqual(await runStashedMappers({ 'quick-search': quickSearchImport }), []); // once only
  assert.deepEqual(await takeUnannounced(), []); // the options page announced its own run
});

test('runStashedMappers passes the stashed script name to the mapper', async () => {
  const name = 'Iterable Catalog Push';
  await fake.chrome.storage.local.set({
    [legacyStashKey(name)]: { name, storage: { settings: '{"rateLimit":5,"batchSize":500}' }, savedAt: '2026-01-01T00:00:00Z', status: 'pending' },
  });
  const bulkDataImport = await import('../src/features/bulk-data/import.js');
  assert.deepEqual(await runStashedMappers({ 'bulk-data': bulkDataImport }), [{ name, featureId: 'bulk-data' }]);
  const values = stored().features['bulk-data'].values;
  assert.equal(values.catalogRateLimit, 5);
  assert.equal(values.rateLimit, undefined);
});

test('runStashedMappers resolves entries whose feature exists without a mapper as nothing-to-import', async () => {
  const name = 'Iterable Export CSV - Bulk Select';
  const other = 'Some Future Script';
  await fake.chrome.storage.local.set({
    [legacyStashKey(name)]: { name, storage: { x: 1 }, savedAt: '2026-01-01T00:00:00Z', status: 'pending' },
    [legacyStashKey(other)]: { name: other, storage: { y: 1 }, savedAt: '2026-01-01T00:00:00Z', status: 'pending' },
  });
  assert.deepEqual(await runStashedMappers({}), []);
  const e = fake.raw()[legacyStashKey(name)];
  assert.equal(e.status, 'empty');
  assert.equal(e.featureId, 'export-select');
  assert.deepEqual(e.storage, { x: 1 });
  assert.equal(fake.raw()[legacyStashKey(other)].status, 'pending');   // no feature yet: keep waiting
  assert.deepEqual(await takeUnannounced(), []);
  // A mapper arriving later still imports it.
  const mapper = { default: { scripts: [name], map: () => ({ values: { someSetting: true } }) } };
  assert.deepEqual(await runStashedMappers({ 'export-select': mapper }), [{ name, featureId: 'export-select' }]);
  assert.equal(fake.raw()[legacyStashKey(name)].status, 'imported');
});

test('background runs leave entries for the options page to announce once', async () => {
  const name = 'Iterable Template Quick Search';
  await fake.chrome.storage.local.set({
    [legacyStashKey(name)]: { name, storage: { iterableQuickSearchTags: '[{"label":"Promo"}]' }, savedAt: '2026-01-01T00:00:00Z', status: 'pending' },
  });
  await runStashedMappers({ 'quick-search': quickSearchImport }, { announced: false });
  assert.equal(fake.raw()[legacyStashKey(name)].announced, false);
  assert.deepEqual(await takeUnannounced(), [{ name, featureId: 'quick-search' }]);
  assert.equal(Object.hasOwn(fake.raw()[legacyStashKey(name)], 'announced'), false);
  assert.deepEqual(await takeUnannounced(), []);
});

// ── backup: stashed Tampermonkey settings survive a move to another browser ──

test('backup export → restore carries pending wb:legacy entries, minus keys, and their mappers then run', async () => {
  const { legacyForBackup, planBackupRestore } = await import('../src/options/importer/backup.js');
  const { FEATURES } = await import('../src/features/registry.js');
  const livePreviewImport = await import('../src/features/live-preview/import.js');
  const KEY = '0123456789abcdef0123456789abcdef';
  const lpName = 'Iterable - Live Preview Editor';
  const qsName = 'Iterable Template Quick Search';
  const config = {
    previewWidth: 60, shortcut: 'Ctrl+Shift+S', fontFamily: 'Fira Code', fontSize: 14,
    keybindings: [{ name: 'deleteLine', keys: 'Ctrl+Shift+K' }],
    snippets: [{ name: 'hi', body: 'Hi ${1:x}', shortcutKey: 'Ctrl+1' }],
    customTestData: '{"firstName":"Legacy"}', savedPayloads: [{ name: 'VIP', data: '{"tier":"vip"}' }],
    apiKeys: [{ id: '1', label: 'Main' }],
  };
  // The old browser: one pending entry (a feature it didn't have), one already imported, and a
  // key-shaped value that must not leave (belt and braces: the stash never holds one).
  await fake.chrome.storage.local.set({
    [legacyStashKey(lpName)]: { name: lpName, storage: { config: JSON.stringify(config), stray: KEY }, savedAt: '2026-09-21T00:00:00Z', status: 'pending' },
    [legacyStashKey(qsName)]: { name: qsName, storage: { iterableQuickSearchTags: '[]' }, savedAt: '2026-09-20T00:00:00Z', status: 'imported', featureId: 'quick-search', importedAt: '2026-09-20T00:00:00Z', announced: false },
    'wb:legacy:bogus': { name: 'Something else', storage: {}, status: 'pending' },
  });
  const legacy = legacyForBackup(fake.raw(), { secrets: [KEY] });
  assert.deepEqual(Object.keys(legacy).sort(), [legacyStashKey(lpName), legacyStashKey(qsName)]);
  assert.ok(!JSON.stringify(legacy).includes(KEY));
  assert.equal(legacy[legacyStashKey(qsName)].announced, undefined);
  const file = JSON.parse(JSON.stringify({ app: 'loophole', format: 1, settings: { general: {}, features: {} }, state: {}, legacy }));

  // The new browser: empty storage, restore, then the mappers.
  fake.reset();
  const plan = planBackupRestore(file, { metas: FEATURES });
  assert.equal(plan.ok, true);
  assert.equal(plan.legacy.size, 2);
  await settings.replaceRaw(plan.settings);
  await fake.chrome.storage.local.set(Object.fromEntries(plan.legacy));
  const done = await runStashedMappers({ 'live-preview': livePreviewImport, 'quick-search': quickSearchImport });
  assert.deepEqual(done, [{ name: lpName, featureId: 'live-preview' }], 'only the pending entry is imported');
  const values = stored().features['live-preview'].values;
  assert.equal(values.previewWidth, 60);
  assert.equal(values.fontFamily, 'Fira Code');
  assert.equal(values.fontSize, 14);
  assert.deepEqual(values.snippets.map((s) => s.name), ['hi']);
  assert.deepEqual(values.keybindings, [{ command: 'deleteLine', keys: 'Mod+Shift+K' }]);
  assert.equal(fake.raw()['wb:state:live-preview:testData'], '{"firstName":"Legacy"}');
  assert.equal(fake.raw()[legacyStashKey(lpName)].status, 'imported');
  assert.ok(!JSON.stringify(fake.raw()).includes(KEY));
});

test('backup restore: older files without `legacy` still restore; bad legacy entries are refused', async () => {
  const { planBackupRestore } = await import('../src/options/importer/backup.js');
  const { FEATURES } = await import('../src/features/registry.js');
  const old = planBackupRestore({ app: 'workbench-for-iterable', format: 1, settings: {}, state: {} }, { metas: FEATURES });
  assert.equal(old.ok, true);
  assert.equal(old.legacy.size, 0);
  assert.equal(old.invalidLegacy, 0);
  const KEY = 'fedcba9876543210fedcba9876543210';
  const crafted = JSON.parse(`{"app":"loophole","format":1,
    "keys":[{"projectKey":"us:1","apiKey":"${KEY}"}],
    "legacy":{
      "__proto__":{"name":"__proto__","storage":{}},
      "wb:legacy:mismatch":{"name":"Other name","storage":{}},
      "wb:legacy:x":"not an object",
      "wb:legacy:customquicklinks":{"name":"Custom Quicklinks","status":"weird","announced":false,
        "storage":{"iterableQuicklinks":"[]","note":"k=${KEY}","__proto__":{"polluted":1},"nested":{"constructor":{"x":1},"ok":1}}}
    }}`);
  const plan = planBackupRestore(crafted, { metas: FEATURES });
  assert.deepEqual([...plan.legacy.keys()], ['wb:legacy:customquicklinks']);
  assert.equal(plan.invalidLegacy, 3);
  const e = plan.legacy.get('wb:legacy:customquicklinks');
  assert.equal(e.status, 'pending');
  assert.equal(e.announced, undefined);
  assert.deepEqual(e.storage, { iterableQuicklinks: '[]', nested: { ok: 1 } });
  assert.equal(({}).polluted, undefined);
});
