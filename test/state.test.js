import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.local fake (the modules only touch it at call time).
const store = new Map();
const getCalls = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        getCalls.push(keys);
        if (keys === null) return Object.fromEntries(store);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
      },
      async set(items) { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); },
      async remove(keys) { for (const k of [].concat(keys)) store.delete(k); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const { createState, writeStateEntries, parseStateKey, projectSlot, getMigrated } = await import('../src/core/state.js');
const { RESTORE_NAME_RE } = await import('../src/options/importer/backup.js');
const { stableHash64 } = await import('../src/core/hash.js');

beforeEach(() => { store.clear(); getCalls.length = 0; });

test('state set/get/remove/list are namespaced and indexed', async () => {
  const s = createState('bulk-data');
  await s.set('checkpoint:a.csv', { row: 10 });
  await s.set('recent', ['x']);
  assert.deepEqual(await s.get('checkpoint:a.csv'), { row: 10 });
  assert.equal(await s.get('missing', 'fallback'), 'fallback');
  assert.ok(store.has('wb:state:bulk-data:recent'));
  assert.deepEqual(await s.list(), ['checkpoint:a.csv', 'recent']);
  await s.remove('recent');
  assert.deepEqual(await s.list(), ['checkpoint:a.csv']);
  assert.deepEqual(await createState('other').list(), []);
});

test('list() never reads all of storage (the key vault must stay out of content scripts)', async () => {
  store.set('wb:keys', { projects: { 'us:1': { apiKey: 'secret' } } });
  const s = createState('quick-search');
  await s.set('tags', []);
  await s.list();
  assert.ok(getCalls.every((k) => k !== null), 'no get(null)');
  assert.ok(getCalls.every((k) => !String(k).includes('wb:keys')));
});

test('rapid concurrent sets keep every name in the index', async () => {
  const s = createState('f');
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.set('n' + i, i)));
  assert.equal((await s.list()).length, 20);
});

test('writeStateEntries writes values and indexes them', async () => {
  await writeStateEntries({ 'quick-search': { tags: [1], collapsed: false }, empty: {} });
  assert.deepEqual(await createState('quick-search').list(), ['collapsed', 'tags']);
  assert.equal(store.get('wb:state:quick-search:collapsed'), false);
  assert.equal(store.has('wb:state-index:empty'), false);
});

test('parseStateKey splits on the first colon after the feature id', () => {
  assert.deepEqual(parseStateKey('wb:state:bulk-data:checkpoint:a.csv'), { featureId: 'bulk-data', name: 'checkpoint:a.csv' });
  assert.equal(parseStateKey('wb:settings'), null);
  assert.equal(parseStateKey('wb:state:nocolon'), null);
});

test('stableHash64: 64-bit FNV-1a over UTF-8 (known vectors)', () => {
  assert.equal(stableHash64(''), 'cbf29ce484222325');
  assert.equal(stableHash64('a'), 'af63dc4c8601ec8c');
  assert.equal(stableHash64('foobar'), '85944171f73967e8');
  assert.notEqual(stableHash64('é'), stableHash64('e'));
});

test('projectSlot: short, stable, restore-safe for any project key', () => {
  for (const pk of ['us:18244', 'eu:1', 'us:name:My Project', 'us:name:Ünïcode / "quotes"', 'us:name:' + 'x'.repeat(500)]) {
    const slot = projectSlot(pk);
    assert.match(slot, /^p[0-9a-f]{16}$/);
    assert.equal(slot, projectSlot(pk));
    assert.match('cache:' + slot, RESTORE_NAME_RE);
  }
  assert.notEqual(projectSlot('us:1'), projectSlot('eu:1'));
  assert.notEqual(projectSlot('us:name:My Project'), projectSlot('us:name:My_Project'));
  assert.equal(projectSlot(''), '');
  assert.equal(projectSlot(null), '');
});

test('getMigrated: reads the new name, else moves the first old value found', async () => {
  const s = createState('snippets');
  assert.equal(await getMigrated(s, 'cache:new', ['cache:old'], 'fb'), 'fb');
  await s.set('cache:old', { n: 1 });
  await s.set('cache:older', { n: 0 });
  assert.deepEqual(await getMigrated(s, 'cache:new', ['cache:old', 'cache:older']), { n: 1 });
  assert.deepEqual(await s.get('cache:new'), { n: 1 });
  assert.equal(await s.get('cache:old'), undefined);
  assert.equal(await s.get('cache:older'), undefined);
  assert.deepEqual(await s.list(), ['cache:new']);
  // Present under the new name: old names aren't consulted.
  await s.set('cache:old', { n: 2 });
  assert.deepEqual(await getMigrated(s, 'cache:new', ['cache:old']), { n: 1 });
  // null is a value (image library stores null for "root").
  await s.set('lastFolder:x', null);
  assert.equal(await getMigrated(s, 'lastFolder:p1', ['lastFolder:x'], undefined), null);
  assert.equal(await s.get('lastFolder:p1', 'missing'), null);
});

test('getMigrated: a failed move still returns the value', async () => {
  const fake = {
    data: { old: 7 },
    async get(n, fb) { return Object.hasOwn(this.data, n) ? this.data[n] : fb; },
    async set() { throw new Error('quota'); },
    async remove() {},
  };
  assert.equal(await getMigrated(fake, 'new', ['old']), 7);
  assert.equal(fake.data.old, 7);
});
