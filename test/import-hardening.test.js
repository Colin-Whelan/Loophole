// Untrusted-input hardening for the options page importers: Loophole backup restore (prototype
// pollution, key opt-in, checkpoints), Tampermonkey decoding / key extraction / stash scrubbing,
// zip limits, and the bee-frame embedding check.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8 } from 'fflate';

// Minimal chrome.storage.local fake (modules touch it at call time only).
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
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

const { planBackupRestore, sanitizeBackupSettings, CHECKPOINT_PREFIX } = await import('../src/options/importer/backup.js');
const { writeStateEntries, parseStateKey } = await import('../src/core/state.js');
const settings = await import('../src/core/settings.js');
const { FEATURES } = await import('../src/features/registry.js');
const { CKPT_PREFIX } = await import('../src/features/bulk-data/logic.js');
const { BACKUP_APP, isBackupApp } = await import('../src/options/importer/sources.js');
const { decodeStorage, decodeStorageReport } = await import('../src/options/importer/decode.js');
const {
  readInputs, missingStorage, zipEntryCount, inspectZip, admitLooseFiles, IMPORT_LIMITS, isTampermonkeyJson, ZIP64_REFUSED, ZIP_NOT_VALID,
} = await import('../src/options/importer/sources.js');
const { extractLegacyKeys, stripLegacyKeys } = await import('../src/options/importer/legacy-keys.js');
const { planScripts } = await import('../src/options/importer/plan.js');
const { safeJsonCopy } = await import('../src/options/importer/safe-json.js');
const { isEmbeddedByIterable } = await import('../src/core/api-validation.js');

const K1 = '0123456789abcdef0123456789abcdef';
const K2 = 'fedcba9876543210fedcba9876543210';
const K3 = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';

/** Nothing on Object.prototype that a crafted file could have put there. */
function assertPrototypeClean() {
  for (const name of ['value', 'polluted', 'x', 'apiKey', 'isAdmin', 'enabled']) {
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, name), false, `Object.prototype.${name} was polluted`);
    assert.equal(({})[name], undefined, `({}).${name} is inherited`);
  }
  // The symptom from the review: input({ value = '' }) defaults picked up a polluted `value`.
  const { value = '' } = {};
  assert.equal(value, '');
}

beforeEach(() => store.clear());
after(assertPrototypeClean);

// ── Backup restore (item: prototype pollution) ───────────────────────────

const craftedBackup = () => JSON.parse(`{
  "app": "loophole", "format": 1, "exportedAt": "2026-01-01T00:00:00.000Z",
  "settings": {
    "general": { "theme": "dark", "debug": "yes", "__proto__": { "polluted": 1 } },
    "features": {
      "__proto__": { "enabled": true, "values": { "polluted": 1 } },
      "constructor": { "enabled": false },
      "quick-search": { "enabled": false, "values": { "a": 1, "__proto__": { "polluted": 1 }, "n": { "__proto__": { "x": 1 }, "ok": true } } },
      "not-a-feature": { "enabled": true }
    }
  },
  "state": {
    "wb:state:__proto__:value": "sk_attacker_key_0123456789abcdef",
    "wb:state:__proto__:polluted": true,
    "wb:state:quick-search:__proto__": { "polluted": 1 },
    "wb:state:constructor:prototype": { "polluted": 1 },
    "wb:state:quick-search:constructor": 1,
    "wb:state:quick-search:collapsed": true,
    "wb:state:quick-search:weird name with spaces": 1,
    "wb:state:bulk-data:ckpt:push:a.csv|10|1700000000000": { "row": 5 },
    "wb:state:bulk-data:ui": { "tab": "lists" },
    "wb:state:link-params:recents": { "__proto__": { "polluted": 1 }, "utm_source": ["x"] },
    "wb:state:unknown-feature:x": 1,
    "wb:state:Bad_Id:x": 1
  },
  "keys": [
    { "projectKey": "us:18244", "name": "Prod", "dataCenter": "us", "apiKey": "${K1}" },
    { "projectKey": "bad key!", "apiKey": "${K2}" },
    { "projectKey": "eu:7", "dataCenter": "us", "apiKey": "${K2}" },
    { "projectKey": "us:18244", "name": "Dup", "apiKey": "${K2}" },
    { "projectKey": "18245", "name": "Legacy id", "apiKey": "${K3}" },
    { "projectKey": "us:1", "apiKey": "short" },
    "junk"
  ]
}`);

describe('planBackupRestore', () => {
  test('a crafted backup cannot pollute Object.prototype, and restoring it writes only sane keys', async () => {
    const backup = craftedBackup();
    assert.ok(Object.hasOwn(backup.state, 'wb:state:__proto__:value'), 'JSON.parse keeps __proto__ as an own key');
    const plan = planBackupRestore(backup, { metas: FEATURES });
    assert.equal(plan.ok, true);
    assertPrototypeClean();

    assert.ok(plan.state instanceof Map);
    assert.deepEqual([...plan.state.keys()].sort(), ['bulk-data', 'link-params', 'quick-search']);
    assert.deepEqual([...plan.state.get('quick-search').keys()], ['collapsed']);
    assert.deepEqual([...plan.state.get('bulk-data').keys()], ['ui']);
    assert.deepEqual(plan.state.get('link-params').get('recents'), { utm_source: ['x'] });
    assert.equal(plan.stateCount, 3);
    assert.equal(plan.skipped.checkpoints, 1);
    assert.equal(plan.skipped.unknownFeature, 1);
    assert.ok(plan.skipped.invalid >= 6);

    // Apply it the way sections/import.js does.
    await settings.replaceRaw(plan.settings);
    await writeStateEntries(plan.state);
    assertPrototypeClean();
    const keysWritten = [...store.keys()].sort();
    assert.ok(keysWritten.every((k) => !/__proto__|constructor|prototype/.test(k)), keysWritten.join(', '));
    assert.ok(!keysWritten.some((k) => k.includes(':ckpt:')), 'checkpoints are never restored');
    assert.equal(store.get('wb:state:quick-search:collapsed'), true);
    const raw = store.get('wb:settings');
    assert.deepEqual(Object.keys(raw.features), ['quick-search']);
    assert.deepEqual(raw.features['quick-search'], { enabled: false, values: { a: 1, n: { ok: true } } });
    assert.deepEqual(raw.general, { theme: 'dark' });
    const resolved = await settings.load();
    assert.equal(resolved.features['quick-search'].enabled, false);
    assertPrototypeClean();
  });

  test('the code this replaced would have polluted (guards the regression test itself)', () => {
    const backup = JSON.parse('{"state": {"wb:state:__proto__:value": "sk_attacker_key_0123456789abcdef"}}');
    const stateByFeature = {};
    try {
      for (const [k, v] of Object.entries(backup.state)) {
        const rest = k.slice('wb:state:'.length);
        const i = rest.indexOf(':');
        (stateByFeature[rest.slice(0, i)] ||= {})[rest.slice(i + 1)] = v;
      }
      assert.equal(({}).value, 'sk_attacker_key_0123456789abcdef', 'the old pattern pollutes');
    } finally {
      delete Object.prototype.value;
      delete Object.prototype.polluted;
    }
    assertPrototypeClean();
  });

  test('keys are validated, deduplicated per project and masked for the preview', () => {
    const plan = planBackupRestore(craftedBackup(), { metas: FEATURES });
    assert.deepEqual(plan.keys.map((k) => [k.projectKey, k.apiKey, k.masked]), [
      ['us:18244', K1, '0123\u2026cdef'],
      ['us:18245', K3, 'aaaa\u2026bbbb'],
    ]);
    assert.equal(plan.keys[0].name, 'Prod');
    assert.equal(plan.invalidKeys, 5);
  });

  test('rejects anything that is not a Loophole backup', () => {
    for (const b of [null, [], {}, { app: 'loophole', format: 2 }, { app: 'workbench-for-iterable', format: 2 },
      { app: 'x', format: 1 }, { app: 'Loophole', format: 1 }]) {
      assert.equal(planBackupRestore(b, { metas: FEATURES }).ok, false);
    }
  });

  test('accepts current backups and ones made before the rename (workbench-for-iterable)', () => {
    assert.equal(BACKUP_APP, 'loophole');
    for (const app of ['loophole', 'workbench-for-iterable']) {
      const plan = planBackupRestore({ app, format: 1, settings: { general: { theme: 'dark' } } }, { metas: FEATURES });
      assert.equal(plan.ok, true, app);
      assert.equal(plan.settings.general.theme, 'dark');
      assert.equal(isBackupApp(app), true);
    }
    assert.equal(isBackupApp('workbench'), false);
  });

  test('checkpoint prefix matches bulk-data', () => {
    assert.equal(CHECKPOINT_PREFIX, CKPT_PREFIX);
  });

  test('sanitizeBackupSettings keeps only registered features and valid general values', () => {
    const out = sanitizeBackupSettings({ general: { theme: 'neon', debug: true }, features: { 'delete-user': { enabled: 'no', values: [] } } }, FEATURES);
    assert.deepEqual(out, { version: 1, general: { debug: true }, features: {} });
    assert.deepEqual(sanitizeBackupSettings(null, FEATURES), { version: 1, general: {}, features: {} });
  });
});

describe('state sink', () => {
  test('parseStateKey rejects __proto__ / constructor / prototype and bad feature ids', () => {
    for (const k of ['wb:state:__proto__:x', 'wb:state:x:__proto__', 'wb:state:constructor:prototype', 'wb:state:a:prototype',
      'wb:state:Quick:x', 'wb:state:a b:x', 'wb:state:a:', 'wb:state:a:\u0000x']) {
      assert.equal(parseStateKey(k), null, k);
    }
    assert.deepEqual(parseStateKey('wb:state:bulk-data:ckpt:push:a b.csv|1|2'), { featureId: 'bulk-data', name: 'ckpt:push:a b.csv|1|2' });
  });

  test('writeStateEntries skips invalid ids and names, from objects or Maps', async () => {
    const entries = JSON.parse('{"__proto__": {"x": 1}, "quick-search": {"__proto__": 1, "ok": 2}}');
    const res = await writeStateEntries(entries);
    assert.deepEqual(res, { written: 1, skipped: 2 });
    await writeStateEntries(new Map([['constructor', new Map([['a', 1]])], ['link-params', new Map([['recents', 3]])]]));
    assert.deepEqual([...store.keys()].filter((k) => k.startsWith('wb:state:')).sort(),
      ['wb:state:link-params:recents', 'wb:state:quick-search:ok']);
    assertPrototypeClean();
  });

  test('safeJsonCopy drops dangerous keys at every depth and non-JSON values', () => {
    const v = JSON.parse('{"a":{"__proto__":{"x":1},"constructor":{"prototype":{"x":1}},"b":[1,{"__proto__":2}]},"n":1}');
    assert.deepEqual(safeJsonCopy(v), { a: { b: [1, {}] }, n: 1 });
    assert.equal(safeJsonCopy(() => 1), undefined);
    assert.deepEqual(safeJsonCopy([NaN, undefined, 'x']), [null, null, 'x']);
    assert.equal(safeJsonCopy(new Date()), undefined);
  });
});

// ── Tampermonkey decoding (item 8) ───────────────────────────────────────

describe('decoding', () => {
  const store8 = {
    legacy_api_key: 's' + K1,
    api_keys_by_project: 'o' + JSON.stringify({ 18244: { name: 'Prod', apiKey: K2 } }),
    broken: 'o{not json',
    settings: 's{"rateLimit":4}',
  };

  test('one malformed value is reported and skipped; the rest still decode', () => {
    const r = decodeStorageReport(store8);
    assert.equal(r.tagged, true);
    assert.deepEqual(r.failed, ['broken']);
    assert.equal(r.values.legacy_api_key, K1, 'tag stripped');
    assert.deepEqual(r.values.api_keys_by_project, { 18244: { name: 'Prod', apiKey: K2 } });
    assert.equal('broken' in r.values, false);
    // A known Tampermonkey export: untagged strings are failures, not raw values.
    assert.deepEqual(decodeStorageReport({ a: 'sx', b: 'plain' }, { tagged: true }).failed, ['b']);
    // Hand-made dumps are still left alone.
    assert.deepEqual(decodeStorage({ note: 'secret', other: 'plain text' }), { note: 'secret', other: 'plain text' });
  });

  test('readInputs notes the failure; keys import untagged, api_keys_by_project survives', () => {
    const file = strToU8(JSON.stringify({ ts: 1, data: store8 }));
    const r = readInputs([{ path: 'Iterable User Push.storage.json', bytes: file }]);
    const s = r.scripts[0];
    assert.equal(s.storage.legacy_api_key, K1);
    assert.match(s.notes.join(' '), /couldn’t be decoded: “broken”/);
    const keys = extractLegacyKeys(r.scripts);
    assert.deepEqual(keys.assigned.map((a) => [a.projectKey, a.apiKey]), [['us:18244', K2]]);
    assert.deepEqual(keys.unassigned.map((u) => u.apiKey), [K1]);
    const items = planScripts(r.scripts, { importers: {}, metas: FEATURES });
    assert.match(items[0].notes.join(' '), /broken/);
  });

  test('a key that still carries a type tag is never offered', () => {
    const res = extractLegacyKeys([{ name: 'Raw', storage: { legacy_api_key: 's' + K1, config: { apiKey: 'o' + K2 } } }]);
    assert.deepEqual(res.unassigned, []);
    assert.equal(res.skipped, 2);
  });

  test('forbidden GM names are dropped while decoding', () => {
    const r = decodeStorageReport(JSON.parse('{"__proto__":"o{\\"polluted\\":1}","a":"sx"}'));
    assert.deepEqual(Object.keys(r.values), ['a']);
    assert.equal(Object.getPrototypeOf(r.values), Object.prototype);
    assertPrototypeClean();
  });
});

// ── Legacy stash (item 7) ────────────────────────────────────────────────

describe('stripLegacyKeys', () => {
  test('secret-looking names are dropped at the top level and at every depth', () => {
    const out = stripLegacyKeys({
      apiKey: K1, token: 'abc', secretKey: 'x', password: 'p', iterableApiKey: K2, authToken: 't',
      theme: 'dark',
      nested: JSON.stringify({ deep: { api_key: K3, bearer: 'b', keep: 1, list: [{ accessToken: 'z', label: 'L' }] } }),
    });
    assert.deepEqual(Object.keys(out).sort(), ['nested', 'theme']);
    assert.deepEqual(JSON.parse(out.nested), { deep: { keep: 1, list: [{ label: 'L' }] } });
  });

  test('any string equal to or containing an extracted key is dropped, wherever it is', () => {
    const out = stripLegacyKeys({
      note: `my key is ${K1}`,
      copy: K1,
      list: [K1, 'keep me'],
      cfg: { header: `Api-Key: ${K1}`, other: 'fine' },
    }, { secrets: [K1] });
    assert.deepEqual(out, { list: ['keep me'], cfg: { other: 'fine' } });
  });

  test('32-hex strings under key-ish names are dropped; ordinary key/value pairs stay', () => {
    const out = stripLegacyKeys({
      key: K2, projectKey: K3, monkeyKey: 'not hex',
      params: [{ key: 'utm_source', value: 'newsletter' }],
      auth: K1,
    });
    assert.deepEqual(out, { monkeyKey: 'not hex', params: [{ key: 'utm_source', value: 'newsletter' }] });
  });

  test('a 32-hex string is dropped anywhere, whatever its container is called', () => {
    const out = stripLegacyKeys({
      projectKeys: { 18244: K1, 18245: 'label' },
      keys: [K2, 'keep'],
      iterable: JSON.stringify({ keys: { prod: K3, name: 'Prod' } }),
      deep: { a: [{ b: [` ${K1.toUpperCase()} `] }] },
      quoted: JSON.stringify(K2),
      twice: JSON.stringify(JSON.stringify({ x: K3, y: 1 })),
      note: 'fine',
      notHex: 'g123456789abcdef0123456789abcdef',
      tooLong: `${K1}0`,
    });
    assert.deepEqual(out, {
      projectKeys: { 18245: 'label' },
      keys: ['keep'],
      iterable: JSON.stringify({ keys: { name: 'Prod' } }),
      deep: { a: [{ b: [] }] },
      twice: JSON.stringify(JSON.stringify({ y: 1 })),
      note: 'fine',
      notHex: 'g123456789abcdef0123456789abcdef',
      tooLong: `${K1}0`,
    });
    for (const k of [K2, K3]) assert.ok(!JSON.stringify(out).toLowerCase().includes(k));
  });

  test('a field whose name is a key is dropped, at the top level and nested', () => {
    const out = stripLegacyKeys({
      [K1]: { label: 'Prod' },
      byKey: JSON.stringify({ [K2.toUpperCase()]: 'Staging', other: 1 }),
      [`prefix ${K3} suffix`]: 'kept: not a key name, and K3 was not extracted',
    });
    assert.deepEqual(out, {
      byKey: JSON.stringify({ other: 1 }),
      [`prefix ${K3} suffix`]: 'kept: not a key name, and K3 was not extracted',
    });
    // Once K3 is a known secret, a name containing it goes too.
    assert.deepEqual(stripLegacyKeys({ [`prefix ${K3} suffix`]: 1, ok: 2 }, { secrets: [K3] }), { ok: 2 });
  });

  test('extracted secrets are compared case-insensitively', () => {
    const out = stripLegacyKeys({
      header: `Api-Key: ${K1.toUpperCase()}`,
      mixed: `x-${K1.slice(0, 16).toUpperCase()}${K1.slice(16)}-y`,
      other: 'fine',
    }, { secrets: [K1] });
    assert.deepEqual(out, { other: 'fine' });
    // Secrets given upper-case still match lower-case copies.
    assert.deepEqual(stripLegacyKeys({ h: `k=${K2}` }, { secrets: [K2.toUpperCase()] }), {});
  });

  test('JSON-encoded configs holding an extracted key keep their other settings at the same encoding depth', () => {
    const cfg = { apiKey2: 'x', header: `Api-Key: ${K1}`, copy: K1.toUpperCase(), theme: 'dark', n: 3 };
    const once = JSON.stringify(cfg);
    const twice = JSON.stringify(once);
    const thrice = JSON.stringify(twice);
    const out = stripLegacyKeys({ once, twice, thrice, plain: 'fine' }, { secrets: [K1] });
    const want = { theme: 'dark', n: 3 };
    assert.deepEqual(JSON.parse(out.once), want);
    assert.deepEqual(JSON.parse(JSON.parse(out.twice)), want);
    assert.equal(typeof JSON.parse(out.twice), 'string');
    assert.deepEqual(JSON.parse(JSON.parse(JSON.parse(out.thrice))), want);
    assert.equal(out.plain, 'fine');
    assert.ok(!JSON.stringify(out).toLowerCase().includes(K1));
    // A double-encoded string that is only the key (either case) goes whole.
    assert.deepEqual(stripLegacyKeys({ q: JSON.stringify(JSON.stringify(K1.toUpperCase())), r: JSON.stringify(`k ${K1}`) }, { secrets: [K1] }), {});
    // Unchanged double-encoded text is kept byte for byte.
    const clean = JSON.stringify(JSON.stringify({ a: 1 }));
    assert.equal(stripLegacyKeys({ clean }, { secrets: [K1] }).clean, clean);
  });

  test('JSON text wrapped deeper than the unwrap limit is dropped (it could hide a key)', () => {
    let deep = JSON.stringify({ x: K2, y: 1 });
    for (let i = 0; i < 6; i++) deep = JSON.stringify(deep);
    const out = stripLegacyKeys({ deep, ok: 1 });
    assert.deepEqual(out, { ok: 1 });
  });

  test('pre-1.1 User Push settings.apiKey is picked up as an unassigned key and stripped', () => {
    const storage = { settings: JSON.stringify({ apiKey: K3, rateLimit: 4 }) };
    const { unassigned } = extractLegacyKeys([{ name: 'Iterable User Push', storage }]);
    assert.deepEqual(unassigned.map((u) => u.apiKey), [K3]);
    assert.deepEqual(JSON.parse(stripLegacyKeys(storage).settings), { rateLimit: 4 });
  });

  test('planScripts passes the extracted keys to the stash scrubber', () => {
    const scripts = [{ name: 'Iterable Unported Tool', normName: 'unportedtool', storage: { note: `saved ${K2}`, x: 1, cfg: { k: K2 } } }];
    const items = planScripts(scripts, { importers: {}, metas: FEATURES, secrets: [K2] });
    assert.equal(items[0].status, 'stash');
    assert.ok(!JSON.stringify(items[0].stash).includes(K2));
    assert.deepEqual(items[0].stash, { x: 1, cfg: {} });
  });
});

// ── Importer edge cases (item 11) and zip limits (item 5) ────────────────

describe('readInputs edge cases', () => {
  const opts = strToU8(JSON.stringify({ meta: { name: 'Iterable Delete User' } }));

  test('a malformed .storage.json is reported as unreadable, not as "no storage"', () => {
    const r = readInputs([
      { path: 'Iterable Delete User.options.json', bytes: opts },
      { path: 'Iterable Delete User.storage.json', bytes: strToU8('{ "ts": 1, "data": {') },
    ]);
    assert.deepEqual(r.unreadable.map((u) => u.path), ['Iterable Delete User.storage.json']);
    assert.equal(missingStorage(r), false);
    const bad = readInputs([{ path: 'broken.json', bytes: strToU8('{nope') }]);
    assert.deepEqual(bad.unreadable.map((u) => u.path), ['broken.json']);
  });

  test('two files whose names normalise the same keep both stores (and both sets of keys)', () => {
    const a = strToU8(JSON.stringify({ ts: 1, data: { api_keys_by_project: 'o' + JSON.stringify({ 1: { apiKey: K1 } }) } }));
    const b = strToU8(JSON.stringify({ ts: 1, data: { api_keys_by_project: 'o' + JSON.stringify({ 2: { apiKey: K2 } }) } }));
    const same = strToU8(JSON.stringify({ ts: 1, data: { api_keys_by_project: 'o' + JSON.stringify({ 1: { apiKey: K1 } }) } }));
    const r = readInputs([
      { path: 'Iterable User Push.storage.json', bytes: a },
      { path: 'User Push.storage.json', bytes: b },
      { path: 'copy/Iterable User Push.storage.json', bytes: same },
    ]);
    assert.equal(r.scripts.length, 2);
    assert.equal(r.scripts.filter((s) => s.duplicate).length, 1);
    assert.ok(r.scripts.every((s) => s.notes.some((n) => /Another file/.test(n))));
    const keys = extractLegacyKeys(r.scripts);
    assert.deepEqual(keys.assigned.map((k) => k.projectKey).sort(), ['us:1', 'us:2']);
  });

  test('a TM JSON export with one nameless script skips only that item', () => {
    const json = { scripts: [{ storage: { ts: 1, data: { x: 'sy' } } }, { name: 'Iterable Delete User', storage: { ts: 1, data: { a: 'sb' } } }] };
    assert.equal(isTampermonkeyJson(json), true);
    const r = readInputs([{ path: 'tm.json', bytes: strToU8(JSON.stringify(json)) }]);
    assert.deepEqual(r.scripts.map((s) => [s.name, s.storage]), [['Iterable Delete User', { a: 'b' }]]);
    assert.match(r.skipped[0].reason, /1 script has no name/);
  });

  test('zips: other entries are summarised; unreadable entries keep their "zip ›" path', () => {
    const zip = zipSync({
      'Tool.storage.json': strToU8(JSON.stringify({ ts: 1, data: { v: 'sx' } })),
      'bad.storage.json': strToU8('{ "ts": 1, "data": {'),
      'broken.json': strToU8('{nope'),
      'readme.txt': strToU8('hi'),
      'img/photo.png': new Uint8Array(4),
      'img/': new Uint8Array(0),
    });
    const r = readInputs([{ path: 'export.zip', bytes: zip }]);
    assert.deepEqual(r.scripts.filter((s) => s.storage).map((s) => [s.name, s.sources]), [['Tool', ['export.zip › Tool.storage.json']]]);
    assert.deepEqual(r.unreadable.map((u) => u.path).sort(), ['export.zip › bad.storage.json', 'export.zip › broken.json']);
    assert.deepEqual(r.notes, ['Skipped 2 other files in export.zip (only .json, .js and .zip files are read).']);

    const nested = readInputs([{ path: 'outer.zip', bytes: zipSync({ 'inner.zip': zipSync({ 'x.storage.json': strToU8('{') }) }) }]);
    assert.deepEqual(nested.unreadable.map((u) => u.path), ['outer.zip › inner.zip › x.storage.json']);
  });

  test('loose files: per-file and total budgets, checked from sizes before reading', () => {
    const limits = { ...IMPORT_LIMITS, maxFileBytes: 10, maxLooseTotalBytes: 20 };
    const r = admitLooseFiles([
      { path: 'a.json', size: 8 }, { path: 'huge.json', size: 11 }, { path: 'b.json', size: 8 },
      { path: 'c.json', size: 8 }, { path: 'd.json', size: 4 }, { path: 'e.json', size: 1 },
    ], limits);
    assert.deepEqual(r.accepted.map((f) => f.path), ['a.json', 'b.json', 'd.json']);
    assert.deepEqual(r.skipped.map((s) => s.path), ['huge.json']);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /^Skipped 2 files \(c\.json, e\.json\): together the files add up to more than/);

    // readInputs applies the same budget to what it is given.
    const store = (n) => strToU8(JSON.stringify({ ts: 1, data: { v: `s${'x'.repeat(n)}` } }));
    const inputs = [{ path: 'A.storage.json', bytes: store(10) }, { path: 'B.storage.json', bytes: store(10) }];
    const size = inputs[0].bytes.length;
    const rr = readInputs(inputs, { ...IMPORT_LIMITS, maxLooseTotalBytes: size + 1 });
    assert.deepEqual(rr.scripts.map((s) => s.name), ['A']);
    assert.match(rr.notes[0], /Skipped 1 file \(B\.storage\.json\)/);
    assert.equal(admitLooseFiles([{ path: 'x', size: 1 }]).notes.length, 0);
  });

  test('zips: only .json/.js/.zip entries are inflated, oversized entries and budgets are reported', () => {
    const big = new Uint8Array(5000); // compresses to almost nothing
    const zip = zipSync({
      'a.storage.json': strToU8(JSON.stringify({ ts: 1, data: { v: 'sx' } })),
      'huge.json': big,
      'photo.png': new Uint8Array(10),
      'b.storage.json': strToU8(JSON.stringify({ ts: 1, data: { v: 'sy' } })),
    });
    const limits = { ...IMPORT_LIMITS, maxFileBytes: 1000, maxTotalBytes: 1e6 };
    const r = readInputs([{ path: 'export.zip', bytes: zip }], limits);
    assert.deepEqual(r.scripts.map((s) => s.name).sort(), ['a', 'b']);
    assert.deepEqual(r.skipped.map((s) => s.path), ['export.zip › huge.json']);
    assert.match(r.skipped[0].reason, /larger than/);
    assert.ok(r.ignored.includes('export.zip › photo.png'));

    const tight = readInputs([{ path: 'export.zip', bytes: zip }], { ...limits, maxTotalBytes: 40 });
    assert.equal(tight.scripts.length, 1);
    assert.ok(tight.skipped.some((s) => /unpack to more than/.test(s.reason)));
  });

  test('zips: entry-count cap (checked before fflate walks the directory) and nesting depth', () => {
    const files = {};
    for (let i = 0; i < 8; i++) files[`s${i}.storage.json`] = strToU8('{"ts":1,"data":{}}');
    const zip = zipSync(files);
    assert.equal(zipEntryCount(zip), 8);
    const r = readInputs([{ path: 'many.zip', bytes: zip }], { ...IMPORT_LIMITS, maxZipEntries: 5 });
    assert.equal(r.scripts.length, 0);
    assert.match(r.skipped[0].reason, /more than 5 entries/);

    // A forged end-of-central-directory count is refused without iterating.
    const forged = zip.slice();
    const eocd = forged.length - 22;
    forged[eocd + 8] = 0xff; forged[eocd + 9] = 0xff;
    assert.equal(zipEntryCount(forged), 0xffff);
    assert.match(readInputs([{ path: 'forged.zip', bytes: forged }]).skipped[0].reason, /entries/);

    const inner = zipSync({ 'x.storage.json': strToU8('{"ts":1,"data":{"a":"sb"}}') });
    const lvl2 = zipSync({ 'inner.zip': inner });
    const lvl3 = zipSync({ 'lvl2.zip': lvl2 });
    assert.equal(readInputs([{ path: 'l2.zip', bytes: lvl2 }]).scripts.length, 1);
    const deep = readInputs([{ path: 'l3.zip', bytes: lvl3 }]);
    assert.equal(deep.scripts.length, 0);
    assert.match(deep.skipped[0].reason, /nested/);

    assert.equal(zipEntryCount(strToU8('not a zip at all, definitely not')), null);
    assert.equal(readInputs([{ path: 'x.zip', bytes: strToU8('not a zip at all, definitely not') }]).unreadable.length, 1);
  });

  // ── zip64 (fflate trusts a zip64 count, even one read past the end of the buffer) ──

  const le32 = (b, i, v) => { b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff; };
  const rd32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const smallZip = () => zipSync({ 'Tool.storage.json': strToU8('{"ts":1,"data":{"a":"sb"}}') });

  /** A real zip plus a zip64 EOCD record and locator (fully in bounds) claiming 16.7M entries. */
  function zip64InBounds() {
    const base = smallZip();
    const eocd = base.length - 22;
    const out = new Uint8Array(base.length + 56 + 20);
    out.set(base.subarray(0, eocd), 0);
    const ze = eocd;
    le32(out, ze, 0x06064B50);
    le32(out, ze + 32, 0x00FFFFFF);          // entry count (low 32 bits)
    le32(out, ze + 48, rd32(base, eocd + 16)); // central directory offset
    const loc = ze + 56;
    le32(out, loc, 0x07064B50);
    le32(out, loc + 8, ze);                  // where the zip64 record is
    le32(out, loc + 16, 1);
    out.set(base.subarray(eocd), loc + 20);
    return out;
  }

  /**
   * The verifier's forge: the zip64 record the locator points to overlaps the locator and runs past
   * the end of the buffer, so part of its count is read out of bounds (as 0) → ~4.2M iterations.
   */
  function zip64Straddling() {
    const L = 0x0006064b + 35;
    const d = new Uint8Array(L);
    d.set([0x50, 0x4b, 0x01, 0x02]); d[28] = 1; d[46] = 0x61;
    const e = L - 22;
    d.set([0x50, 0x4b, 0x06, 0x07], e - 20);
    d[L - 35] = 0x50;
    d.set([0x4b, 0x06, 0x06, 0x00], L - 34);
    d.set([0x50, 0x4b, 0x05, 0x06], e); d[e + 8] = 1; d[e + 10] = 1;
    d[L - 3] = 0xff; d[L - 2] = 0xff; d[L - 1] = 0x3f;
    return d;
  }

  /** A locator pointing far past the end of the buffer. */
  function zip64FarOut() {
    const z = zip64InBounds();
    le32(z, z.length - 22 - 20 + 8, 0xFFFFFF00);
    return z;
  }

  const spyUnzip = () => {
    const calls = [];
    const unzip = (bytes, opts) => { calls.push(bytes.length); return unzipSync(bytes, opts); };
    return { calls, unzip };
  };

  test('zip64: refused before fflate sees it, whether the record is in bounds or not', () => {
    const cases = { 'in-bounds.zip': zip64InBounds(), 'straddling.zip': zip64Straddling(), 'far-out.zip': zip64FarOut() };
    // The straddling forge is the one the old check let through: its record isn't fully in bounds.
    const s = cases['straddling.zip'];
    assert.ok(rd32(s, s.length - 22 - 12) + 36 > s.length, 'the forged zip64 record runs past the end of the buffer');
    assert.ok(rd32(cases['far-out.zip'], cases['far-out.zip'].length - 22 - 12) > cases['far-out.zip'].length);
    for (const [path, bytes] of Object.entries(cases)) {
      assert.deepEqual(inspectZip(bytes), { error: ZIP64_REFUSED }, path);
      assert.equal(zipEntryCount(bytes), null, path);
      const { calls, unzip } = spyUnzip();
      const t0 = Date.now();
      const r = readInputs([{ path, bytes }], IMPORT_LIMITS, { unzip });
      assert.ok(Date.now() - t0 < 1000, `${path} returned promptly`);
      assert.equal(calls.length, 0, `fflate was never called for ${path}`);
      assert.deepEqual(r.unreadable, [{ path, reason: ZIP64_REFUSED }]);
      assert.equal(r.scripts.length, 0);
    }
    assert.match(ZIP64_REFUSED, /format Loophole doesn’t read \(zip64\)/);
  });

  test('zip64: nested inside an ordinary zip, each inner zip is refused without fflate', () => {
    const outer = zipSync({
      'a.zip': zip64InBounds(), 'b.zip': zip64Straddling(), 'c.zip': zip64FarOut(),
      'Tool.storage.json': strToU8('{"ts":1,"data":{"a":"sb"}}'),
    }, { level: 9 });
    const { calls, unzip } = spyUnzip();
    const t0 = Date.now();
    const r = readInputs([{ path: 'outer.zip', bytes: outer }], IMPORT_LIMITS, { unzip });
    assert.ok(Date.now() - t0 < 2000, 'returned promptly');
    assert.deepEqual(calls, [outer.length], 'fflate only opened the outer zip');
    assert.deepEqual(r.unreadable.map((u) => [u.path, u.reason]).sort(), [
      ['outer.zip › a.zip', ZIP64_REFUSED], ['outer.zip › b.zip', ZIP64_REFUSED], ['outer.zip › c.zip', ZIP64_REFUSED],
    ]);
    assert.deepEqual(r.scripts.map((sc) => [sc.name, sc.storage]), [['Tool', { a: 'b' }]]);
  });

  test('zips without an end-of-central-directory record are unreadable and never reach fflate', () => {
    const zip = smallZip();
    for (const bytes of [zip.slice(0, zip.length - 22), zip.slice(0, 10), new Uint8Array(0)]) {
      assert.deepEqual(inspectZip(bytes), { error: ZIP_NOT_VALID });
      const { calls, unzip } = spyUnzip();
      const r = readInputs([{ path: 'x.zip', bytes }], IMPORT_LIMITS, { unzip });
      assert.equal(calls.length, 0);
      assert.deepEqual(r.unreadable, [{ path: 'x.zip', reason: ZIP_NOT_VALID }]);
    }
    // An ordinary zip still opens (once), with its 16-bit count checked.
    assert.deepEqual(inspectZip(zip), { count: 1 });
    const { calls, unzip } = spyUnzip();
    assert.equal(readInputs([{ path: 'ok.zip', bytes: zip }], IMPORT_LIMITS, { unzip }).scripts.length, 1);
    assert.equal(calls.length, 1);
  });

  test('top-level files over the size limit are reported', () => {
    const r = readInputs([{ path: 'big.json', bytes: new Uint8Array(20) }], { ...IMPORT_LIMITS, maxFileBytes: 10 });
    assert.deepEqual(r.skipped.map((s) => s.path), ['big.json']);
  });
});

// ── BEE frames (item 4) ──────────────────────────────────────────────────

describe('isEmbeddedByIterable', () => {
  test('ancestorOrigins: the top must be an Iterable app origin, every hop app or BEE', () => {
    const ok = (ancestorOrigins, isTop = false) => isEmbeddedByIterable({ ancestorOrigins, referrer: '', isTop });
    assert.equal(ok(['https://app.iterable.com']), true);
    assert.equal(ok(['https://app.getbee.io', 'https://app.eu.iterable.com']), true);
    assert.equal(ok([]), false);
    assert.equal(ok(['https://app.iterable.com'], true), false, 'a top-level frame never starts');
    assert.equal(ok(['https://evil.example']), false);
    assert.equal(ok(['https://app.iterable.com', 'https://evil.example']), false, 'Iterable framed by another site');
    assert.equal(ok(['https://evil.example', 'https://app.iterable.com']), false);
    assert.equal(ok(['null']), false);
    assert.equal(ok(['https://app.iterable.com.evil.example']), false);
  });

  test('referrer fallback when ancestorOrigins is unavailable; fails closed', () => {
    const ok = (referrer, isTop = false) => isEmbeddedByIterable({ ancestorOrigins: null, referrer, isTop });
    assert.equal(ok('https://app.iterable.com/templates/editor?id=1'), true);
    assert.equal(ok('https://app.eu.iterable.com/'), true);
    assert.equal(ok(''), false);
    assert.equal(ok('https://app.getbee.io/'), false);
    assert.equal(ok('https://evil.example/?https://app.iterable.com'), false);
    assert.equal(ok('not a url'), false);
    assert.equal(ok(undefined), false);
    assert.equal(isEmbeddedByIterable({ ancestorOrigins: null, referrer: 'https://app.iterable.com/', isTop: undefined }), false);
  });
});
