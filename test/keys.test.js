// Key vault (src/core/keys.js) and the pure projectKey / maskKey helpers.
// Runs in plain Node: chrome.storage.local is replaced by an in-memory fake.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProjectKey, makeProjectKey, legacyProjectKey, maskKey, validateApiKey, cleanName,
} from '../src/core/api-validation.js';

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local
// ---------------------------------------------------------------------------

function makeFakeLocal({ getDelayMs = 0, setDelayMs = 0, jitter = false } = {}) {
  let data = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, jitter ? Math.random() * ms : ms));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    raw: () => data,
    reset: (d = {}) => { data = clone(d); },
    async get(keys) {
      // Snapshot first, deliver later: a concurrent writer can commit in between (a real race).
      const out = {};
      for (const k of [].concat(keys)) if (Object.hasOwn(data, k)) out[k] = clone(data[k]);
      if (getDelayMs) await wait(getDelayMs);
      return out;
    },
    async set(obj) {
      if (setDelayMs) await wait(setDelayMs);
      for (const [k, v] of Object.entries(obj)) data[k] = clone(v);
    },
  };
}

let local = makeFakeLocal();
globalThis.chrome = { storage: { local } };
function useStorage(l) { local = l; globalThis.chrome.storage.local = l; }

const keys = await import('../src/core/keys.js');

const KEY_A = '0123456789abcdef0123456789abcdef';
const KEY_B = 'fedcba9876543210fedcba9876543210';
const KEY_C = 'aaaabbbbccccddddeeeeffff00001111';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseProjectKey / makeProjectKey', () => {
  test('parses id and name forms', () => {
    assert.deepEqual(parseProjectKey('us:18244'), { dataCenter: 'us', id: '18244' });
    assert.deepEqual(parseProjectKey('eu:7'), { dataCenter: 'eu', id: '7' });
    assert.deepEqual(parseProjectKey('us:name:Foo Bar'), { dataCenter: 'us', name: 'Foo Bar' });
    assert.deepEqual(parseProjectKey('eu:name:a:b'), { dataCenter: 'eu', name: 'a:b' });
  });

  test('rejects malformed keys', () => {
    for (const bad of [
      undefined, null, 18244, '', '18244', 'name:Foo', 'US:1', 'xx:1', 'us:', 'us 1', ' us:1', 'us:1 ',
      'us:1/2', 'us:../x', 'us:name:', 'us:name: Foo', 'us:name:Foo ', 'us:name:a\nb', 'us:name:a\u202Eb',
      'us:' + '1'.repeat(65), 'us:name:' + 'x'.repeat(201), 'us:__proto__x:1',
    ]) {
      assert.equal(parseProjectKey(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('makeProjectKey prefers id, round-trips through parse', () => {
    assert.equal(makeProjectKey({ dataCenter: 'us', id: 18244, name: 'Prod' }), 'us:18244');
    assert.equal(makeProjectKey({ dataCenter: 'eu', name: '  Prod EU ' }), 'eu:name:Prod EU');
    assert.equal(makeProjectKey({ dataCenter: 'ap', id: 1 }), null);
    assert.equal(makeProjectKey({ dataCenter: 'us' }), null);
    assert.equal(makeProjectKey({ dataCenter: 'us', id: '1/2' }), null);
    for (const pk of ['us:18244', 'eu:name:Prod EU']) {
      const p = parseProjectKey(pk);
      assert.equal(makeProjectKey(p), pk);
    }
  });

  test('legacyProjectKey maps userscript keys', () => {
    assert.equal(legacyProjectKey('18244'), 'us:18244');
    assert.equal(legacyProjectKey(18244), 'us:18244');
    assert.equal(legacyProjectKey('name:Foo'), 'us:name:Foo');
    assert.equal(legacyProjectKey('us:18244'), 'us:18244');
    assert.equal(legacyProjectKey('eu:name:Foo'), 'eu:name:Foo');
    assert.equal(legacyProjectKey('name:'), null);
    assert.equal(legacyProjectKey('a b'), null);
    assert.equal(legacyProjectKey(-1), null);
    assert.equal(legacyProjectKey(1.5), null);
    assert.equal(legacyProjectKey({}), null);
  });

  test('cleanName', () => {
    assert.equal(cleanName('  x  '), 'x');
    assert.equal(cleanName(''), null);
    assert.equal(cleanName('', { allowEmpty: true }), '');
    assert.equal(cleanName('a\u0007b'), null);
    assert.equal(cleanName('x'.repeat(201)), null);
  });
});

describe('maskKey / validateApiKey', () => {
  test('masks first 4 + \u2026 + last 4', () => {
    assert.equal(maskKey(KEY_A), '0123\u2026cdef');
  });
  test('short or odd input is fully masked and never echoed', () => {
    assert.equal(maskKey('abc'), '\u2022'.repeat(8));
    assert.equal(maskKey('0123456789abcdefghi'), '\u2022'.repeat(8)); // 19 chars
    assert.equal(maskKey(''), '');
    assert.equal(maskKey(null), '');
    assert.equal(maskKey(12345678901234567890), '');
  });
  test('accepts plausible keys, trims', () => {
    assert.deepEqual(validateApiKey(`  ${KEY_A}\n`), { ok: true, value: KEY_A });
    assert.equal(validateApiKey('A'.repeat(16) + '-_.~+/=').ok, true);
  });
  test('rejects whitespace, controls, quotes, non-ASCII, absurd lengths', () => {
    for (const bad of [
      '', '   ', 'short', KEY_A.slice(0, 15), 'a'.repeat(513), `${KEY_A.slice(0, 16)} ${KEY_A.slice(16)}`,
      `${KEY_A}\r\nX-Evil: 1`, `"${KEY_A}"`, `Api-Key: ${KEY_A}`, `${KEY_A}\u0000`, `${KEY_A}\u00E9`, 42, null,
    ]) {
      const r = validateApiKey(bad);
      assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
      if (typeof bad === 'string' && bad.length >= 8) assert.ok(!r.message.includes(bad.trim().slice(0, 8)));
    }
  });
});

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

describe('key vault', () => {
  beforeEach(async () => {
    await keys._settled();
    useStorage(makeFakeLocal());
    delete globalThis.location;
  });

  test('setKey \u2192 listProjects/getStatus never expose the raw key; getRawKey does', async () => {
    const view = await keys.setKey({ projectKey: 'us:18244', name: 'Prod', dataCenter: 'us', apiKey: `  ${KEY_A} ` });
    assert.equal(view.masked, '0123\u2026cdef');
    assert.equal(view.hasKey, true);
    const list = await keys.listProjects();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(),
      ['dataCenter', 'hasKey', 'lastTest', 'masked', 'name', 'projectKey', 'savedAt']);
    assert.equal(list[0].name, 'Prod');
    assert.equal(list[0].dataCenter, 'us');
    assert.ok(!JSON.stringify(list).includes(KEY_A));
    const status = await keys.getStatus('us:18244');
    assert.ok(!JSON.stringify(status).includes(KEY_A));
    assert.equal(status.hasKey, true);
    assert.equal(await keys.getRawKey('us:18244'), KEY_A);
    assert.equal(await keys.getRawKey('us:99'), null);
    assert.equal(await keys.getRawKey('garbage'), null);

    const stored = local.raw()['wb:keys'];
    assert.equal(stored.version, 1);
    assert.equal(stored.projects['us:18244'].apiKey, KEY_A);
    assert.equal(stored.projects['us:18244'].lastTest, null);
    assert.match(stored.projects['us:18244'].savedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('every vault write bumps wb:keys-rev, a bare number with no key material; no-ops do not', async () => {
    assert.equal(local.raw()['wb:keys-rev'], undefined);
    await keys.setKey({ projectKey: 'us:1', name: 'Prod', apiKey: KEY_A });
    const r1 = local.raw()['wb:keys-rev'];
    assert.equal(typeof r1, 'number');
    assert.ok(Number.isInteger(r1));
    await keys.setKey({ projectKey: 'us:1', name: 'Prod', apiKey: KEY_A }); // same key, same name: no write
    assert.equal(local.raw()['wb:keys-rev'], r1);
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_B });
    const r2 = local.raw()['wb:keys-rev'];
    assert.ok(r2 > r1, 'rev increases even within the same millisecond');
    await keys.recordTest('us:1', { ok: true, status: 200 });
    await keys.removeKey('us:1');
    const r4 = local.raw()['wb:keys-rev'];
    assert.ok(r4 > r2);
    assert.ok(Number.isSafeInteger(r4)); // a clock-derived counter: nothing else fits in it
    assert.deepEqual(Object.keys(local.raw()).sort(), ['wb:keys', 'wb:keys-rev']);
  });

  test('setKey validation errors carry codes and never echo the key', async () => {
    const cases = [
      [{ projectKey: 'bad', apiKey: KEY_A }, 'INVALID_PROJECT_KEY'],
      [{ projectKey: 'us:1', dataCenter: 'eu', apiKey: KEY_A }, 'INVALID_DATA_CENTER'],
      [{ projectKey: 'us:1', dataCenter: 'ap', apiKey: KEY_A }, 'INVALID_DATA_CENTER'],
      [{ projectKey: 'us:1', apiKey: `${KEY_A} extra` }, 'INVALID_API_KEY'],
      [{ projectKey: 'us:1', apiKey: `${KEY_A}\nX: y` }, 'INVALID_API_KEY'],
      [{ projectKey: 'us:1', apiKey: 'x'.repeat(10_000) }, 'INVALID_API_KEY'],
      [{ projectKey: 'us:1', apiKey: KEY_A, name: 'a\u0000b' }, 'INVALID_NAME'],
    ];
    for (const [args, code] of cases) {
      await assert.rejects(keys.setKey(args), (e) => {
        assert.equal(e.name, 'KeyVaultError');
        assert.equal(e.code, code);
        assert.ok(!e.message.includes(KEY_A.slice(0, 12)), 'message must not echo key');
        return true;
      });
    }
    assert.equal(local.raw()['wb:keys'], undefined, 'nothing written on validation failure');
  });

  test('default names, rename, remove', async () => {
    await keys.setKey({ projectKey: 'eu:5', apiKey: KEY_A });
    await keys.setKey({ projectKey: 'us:name:Staging', apiKey: KEY_B });
    let list = await keys.listProjects();
    assert.deepEqual(list.map((p) => [p.projectKey, p.name, p.dataCenter]),
      [['eu:5', 'Project 5', 'eu'], ['us:name:Staging', 'Staging', 'us']]);

    await keys.renameProject('eu:5', '  EU prod ');
    list = await keys.listProjects();
    assert.equal(list.find((p) => p.projectKey === 'eu:5').name, 'EU prod');
    await assert.rejects(keys.renameProject('eu:6', 'x'), { code: 'NOT_FOUND' });
    await assert.rejects(keys.renameProject('eu:5', ''), { code: 'INVALID_NAME' });

    // Saving the same key again without a name keeps the name
    await keys.setKey({ projectKey: 'eu:5', apiKey: KEY_A });
    assert.equal((await keys.getStatus('eu:5')).name, 'EU prod');

    assert.equal(await keys.removeKey('eu:5'), true);
    assert.equal(await keys.removeKey('eu:5'), false);
    assert.equal(await keys.getRawKey('eu:5'), null);
    assert.equal((await keys.listProjects()).length, 1);
  });

  test('recordTest; replacing the key resets lastTest; stale results are dropped', async () => {
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_A });
    const use1 = await keys.getKeyForUse('us:1');
    assert.equal(await keys.recordTest('us:1', { ok: true, status: 200, savedAt: use1.savedAt }), true);
    let st = await keys.getStatus('us:1');
    assert.equal(st.lastTest.ok, true);
    assert.equal(st.lastTest.status, 200);

    // Same key re-saved: keeps test + savedAt
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_A });
    assert.equal((await keys.getStatus('us:1')).lastTest.ok, true);

    // Different key: untested again
    await new Promise((r) => setTimeout(r, 5)); // make savedAt differ
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_B });
    st = await keys.getStatus('us:1');
    assert.equal(st.lastTest, null);

    // A test that started against the old key must not stamp the new one
    assert.equal(await keys.recordTest('us:1', { ok: false, status: 401, savedAt: use1.savedAt }), false);
    assert.equal((await keys.getStatus('us:1')).lastTest, null);
    assert.equal(await keys.recordTest('us:404', { ok: true, status: 200 }), false);
    await keys.recordTest('us:1', { ok: false, status: 'x' });
    assert.equal((await keys.getStatus('us:1')).lastTest.status, 0);
  });

  test('importKeys: add / keep / replace / unchanged / invalid, legacy keys accepted', async () => {
    await keys.setKey({ projectKey: 'us:1', name: 'One', apiKey: KEY_A });
    await keys.setKey({ projectKey: 'us:2', name: 'Two', apiKey: KEY_B });

    const list = [
      { projectKey: '1', name: 'One (old)', apiKey: KEY_C },       // legacy id, conflict
      { projectKey: 'us:2', apiKey: KEY_B },                       // same key → unchanged
      { projectKey: 'name:Foo', name: 'Foo', apiKey: KEY_C },      // legacy name → added
      { projectKey: 'eu:9', dataCenter: 'us', apiKey: KEY_C },     // dc mismatch → invalid
      { projectKey: 'us:3', apiKey: 'nope nope nope nope' },       // bad key → invalid
      { projectKey: '../x', apiKey: KEY_C },                       // bad pk → invalid
      null,
    ];
    const r1 = await keys.importKeys(list, { onConflict: 'keep' });
    assert.equal(r1.added, 1);
    assert.equal(r1.kept, 1);
    assert.equal(r1.replaced, 0);
    assert.equal(r1.unchanged, 1);
    assert.deepEqual(r1.conflicts, [{ projectKey: 'us:1', name: 'One' }]);
    assert.deepEqual(r1.invalid.map((i) => i.index), [3, 4, 5, 6]);
    assert.ok(!JSON.stringify(r1).includes(KEY_C.slice(0, 12)));
    assert.equal(await keys.getRawKey('us:1'), KEY_A);
    assert.equal(await keys.getRawKey('us:name:Foo'), KEY_C);

    const r2 = await keys.importKeys([{ projectKey: 'us:1', apiKey: KEY_C }], { onConflict: 'replace' });
    assert.equal(r2.replaced, 1);
    assert.deepEqual(r2.conflicts, [{ projectKey: 'us:1', name: 'One' }]);
    assert.equal(await keys.getRawKey('us:1'), KEY_C);
    assert.equal((await keys.getStatus('us:1')).name, 'One');

    await assert.rejects(keys.importKeys('nope'), { code: 'INVALID_IMPORT' });
    await assert.rejects(keys.importKeys([], { onConflict: 'merge' }), { code: 'INVALID_IMPORT' });
  });

  test('refuses to modify a vault from a newer version or in an unknown shape', async () => {
    const future = { version: 2, projects: { 'us:1': { apiKey: KEY_A, dataCenter: 'us' } } };
    local.reset({ 'wb:keys': future });
    assert.deepEqual(await keys.listProjects(), []);
    await assert.rejects(keys.setKey({ projectKey: 'us:2', apiKey: KEY_B }), { code: 'UNSUPPORTED_VAULT' });
    await assert.rejects(keys.removeKey('us:1'), { code: 'UNSUPPORTED_VAULT' });
    assert.deepEqual(local.raw()['wb:keys'], future);

    local.reset({ 'wb:keys': 'garbage' });
    await assert.rejects(keys.setKey({ projectKey: 'us:2', apiKey: KEY_B }), { code: 'UNSUPPORTED_VAULT' });
    assert.equal(local.raw()['wb:keys'], 'garbage');
  });

  test('tampered entries are never served', async () => {
    local.reset({
      'wb:keys': {
        version: 1,
        projects: {
          'us:1': { name: 'dc mismatch', dataCenter: 'eu', apiKey: KEY_A },
          'us:2': { name: 'header injection', dataCenter: 'us', apiKey: `${KEY_A}\r\nX-Evil: 1` },
          'us:3': { name: 'untrimmed', dataCenter: 'us', apiKey: ` ${KEY_A}` },
          'not a key': { name: 'bad pk', dataCenter: 'us', apiKey: KEY_A },
          'us:4': { name: 'fine', dataCenter: 'us', apiKey: KEY_B },
        },
      },
    });
    for (const pk of ['us:1', 'us:2', 'us:3', 'not a key']) {
      assert.equal(await keys.getRawKey(pk), null, pk);
      assert.equal(await keys.getKeyForUse(pk), null, pk);
    }
    assert.equal(await keys.getRawKey('us:4'), KEY_B);
    const list = await keys.listProjects();
    // Sorted by name: 'dc mismatch', 'fine', 'header injection', 'untrimmed'
    assert.deepEqual(list.map((p) => [p.projectKey, p.hasKey]),
      [['us:1', false], ['us:4', true], ['us:2', false], ['us:3', false]]);
    assert.equal(list.filter((p) => p.hasKey).length, 1);
    assert.ok(!list.some((p) => p.projectKey === 'not a key'));
    assert.ok(!JSON.stringify(list).includes(KEY_A.slice(0, 12)));

    // Writes preserve entries they don't touch (no silent data loss)
    await keys.setKey({ projectKey: 'us:5', apiKey: KEY_C });
    assert.ok(Object.hasOwn(local.raw()['wb:keys'].projects, 'not a key'));
  });

  test('refuses to run in a web page context', async () => {
    globalThis.location = { protocol: 'https:' };
    try {
      await assert.rejects(keys.getRawKey('us:1'), { code: 'FORBIDDEN_CONTEXT' });
      await assert.rejects(keys.listProjects(), { code: 'FORBIDDEN_CONTEXT' });
    } finally {
      delete globalThis.location;
    }
    globalThis.location = { protocol: 'chrome-extension:' };
    try {
      assert.deepEqual(await keys.listProjects(), []);
    } finally {
      delete globalThis.location;
    }
  });

  test('no-op writes are skipped', async () => {
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_A });
    let sets = 0;
    const orig = local.set;
    local.set = async (o) => { sets++; return orig.call(local, o); };
    await keys.removeKey('us:999');
    await keys.setKey({ projectKey: 'us:1', apiKey: KEY_A });
    assert.equal(sets, 0);
    local.set = orig;
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('write serialization', () => {
  beforeEach(async () => { await keys._settled(); });

  test('many concurrent writes in one context all land', async () => {
    useStorage(makeFakeLocal({ getDelayMs: 4, setDelayMs: 4, jitter: true }));
    const ops = [];
    for (let i = 0; i < 25; i++) ops.push(keys.setKey({ projectKey: `us:${i}`, apiKey: KEY_A }));
    ops.push(keys.renameProject('us:0', 'renamed').catch(() => 'raced-before-create'));
    await Promise.all(ops);
    const list = await keys.listProjects();
    assert.equal(list.length, 25);
  });

  test('harness sanity: two contexts WITHOUT a shared lock do lose updates', async () => {
    useStorage(makeFakeLocal({ getDelayMs: 5 }));
    // Two independent read-modify-write cycles with no lock, both reading the empty vault.
    const rmw = async (pk) => {
      const got = await local.get('wb:keys');
      const v = got['wb:keys'] || { version: 1, projects: {} };
      v.projects[pk] = { name: pk, dataCenter: 'us', apiKey: KEY_A, savedAt: 'x', lastTest: null };
      await local.set({ 'wb:keys': v });
    };
    await Promise.all([rmw('us:1'), rmw('us:2')]);
    assert.equal(Object.keys(local.raw()['wb:keys'].projects).length, 1, 'expected a lost update');
  });

  test('two separate module instances (popup + options tab) are serialized by the Web Lock', async (t) => {
    if (!globalThis.navigator?.locks) { t.skip('navigator.locks not available in this Node'); return; }
    useStorage(makeFakeLocal({ getDelayMs: 3, setDelayMs: 3, jitter: true }));
    // A second instance has its own in-module promise chain, like a second extension page.
    const other = await import('../src/core/keys.js?context=options-tab');
    assert.notEqual(other.setKey, keys.setKey);
    const ops = [];
    for (let i = 0; i < 20; i++) {
      ops.push(keys.setKey({ projectKey: `us:${i}`, apiKey: KEY_A }));
      ops.push(other.setKey({ projectKey: `eu:${i}`, apiKey: KEY_B }));
    }
    await Promise.all(ops);
    const list = await keys.listProjects();
    assert.equal(list.length, 40);
    assert.equal(list.filter((p) => p.dataCenter === 'eu').length, 20);
  });
});
