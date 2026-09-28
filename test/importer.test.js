import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

import { decodeTmValue, decodeStorage, asJson } from '../src/options/importer/decode.js';
import { normalizeScriptName, sameScript, userScriptName, fileStem } from '../src/options/importer/names.js';
import { readInputs, missingStorage, isTampermonkeyJson } from '../src/options/importer/sources.js';
import { extractLegacyKeys, stripLegacyKeys } from '../src/options/importer/legacy-keys.js';
import { planScripts, findImporter, legacyStashKey } from '../src/options/importer/plan.js';
import { FEATURES } from '../src/features/registry.js';
import emailScannerImport from '../src/features/email-scanner/import.js';
import bulkDataImport from '../src/features/bulk-data/import.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const K1 = '0123456789abcdef0123456789abcdef';
const K2 = 'fedcba9876543210fedcba9876543210';
const K3 = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const K4 = '1111111111111111222222222222222f';

function dirInputs(dir, prefix = '') {
  return readdirSync(path.join(FIX, dir)).map((name) => ({
    path: prefix + name,
    bytes: new Uint8Array(readFileSync(path.join(FIX, dir, name))),
  }));
}

// ── decode ───────────────────────────────────────────────────────────────

test('decodeTmValue handles every Tampermonkey type tag', () => {
  assert.equal(decodeTmValue('sHello'), 'Hello');
  assert.equal(decodeTmValue('s'), '');
  assert.equal(decodeTmValue('bfalse'), false);
  assert.equal(decodeTmValue('btrue'), true);
  assert.equal(decodeTmValue('n42.5'), 42.5);
  assert.deepEqual(decodeTmValue('o{"a":[1,2]}'), { a: [1, 2] });
  assert.equal(decodeTmValue('u'), undefined);
});

test('decodeTmValue returns raw values for unknown tags and non-strings', () => {
  assert.equal(decodeTmValue('xyz'), 'xyz');
  assert.equal(decodeTmValue('bmaybe'), 'bmaybe');
  assert.equal(decodeTmValue('nabc'), 'nabc');
  assert.equal(decodeTmValue('o{broken'), 'o{broken');
  assert.equal(decodeTmValue(''), '');
  assert.equal(decodeTmValue(5), 5);
  assert.deepEqual(decodeTmValue({ a: 1 }), { a: 1 });
});

test('decodeStorage decodes tagged stores and leaves untagged ones alone', () => {
  assert.deepEqual(decodeStorage({ a: 'sx', b: 'btrue', c: 'u' }), { a: 'x', b: true });
  assert.deepEqual(decodeStorage({ note: 'secret', other: 'plain text' }), { note: 'secret', other: 'plain text' });
  assert.deepEqual(decodeStorage({}), {});
  assert.deepEqual(decodeStorage(null), {});
});

test('asJson parses JSON-looking strings only', () => {
  assert.deepEqual(asJson('{"a":1}'), { a: 1 });
  assert.deepEqual(asJson(' [1] '), [1]);
  assert.equal(asJson('"quoted"'), 'quoted');
  assert.equal(asJson('plain'), 'plain');
  assert.equal(asJson('{not json'), '{not json');
  assert.deepEqual(asJson({ a: 1 }), { a: 1 });
});

// ── names ────────────────────────────────────────────────────────────────

test('normalizeScriptName folds case, punctuation and the Iterable prefix', () => {
  assert.equal(normalizeScriptName('Iterable - Link Param Helper'), 'linkparamhelper');
  assert.equal(normalizeScriptName('Iterable Delete User'), 'deleteuser');
  assert.equal(normalizeScriptName('iterable: delete-user'), 'deleteuser');
  assert.equal(normalizeScriptName('ITERABLE—Delete User'), 'deleteuser');
  assert.equal(normalizeScriptName('Delete User'), 'deleteuser');
  assert.equal(normalizeScriptName('Custom Quicklinks'), 'customquicklinks');
  assert.equal(normalizeScriptName('IterableHelper'), 'iterablehelper'); // not a prefix
  assert.equal(normalizeScriptName('Iterable'), 'iterable');
  assert.equal(normalizeScriptName('Café Tool'), 'cafetool');
  assert.ok(sameScript('Iterable - Live Preview Editor', 'Live preview editor'));
  assert.ok(!sameScript('Iterable User Push', 'Iterable Catalog Push'));
});

test('userScriptName and fileStem', () => {
  assert.equal(userScriptName('// ==UserScript==\n// @name   My Script \n// ==/UserScript==\n'), 'My Script');
  assert.equal(userScriptName('no header'), null);
  assert.equal(fileStem('a/b/Iterable Delete User.storage.json'), 'Iterable Delete User');
  assert.equal(fileStem('X.options.json'), 'X');
  assert.equal(fileStem('X.user.js'), 'X');
});

// ── sources ──────────────────────────────────────────────────────────────

test('loose Tampermonkey files: names from options.json, values decoded', () => {
  const r = readInputs(dirInputs('tm'));
  assert.equal(r.sawTampermonkey, true);
  assert.equal(missingStorage(r), false);
  const names = r.scripts.map((s) => s.name);
  assert.ok(names.includes('Iterable - Link Param Helper'));
  assert.ok(names.includes('Iterable Snippet Viewer'));
  const qs = r.scripts.find((s) => s.name === 'Iterable Template Quick Search');
  assert.equal(qs.storage.iterableQuickSearchCollapsed, false);
  assert.equal(typeof qs.storage.iterableQuickSearchTags, 'string');
  assert.equal(asJson(qs.storage.iterableQuickSearchTags)[1].color, '#b4621a');
  assert.deepEqual(r.scripts.find((s) => s.name === 'Iterable Snippet Viewer').storage, {});
});

test('a zip export (built here with fflate) reads the same as loose files, folders included', () => {
  const files = {};
  for (const f of dirInputs('tm')) files[`export/${f.path}`] = f.bytes;
  files['export/Iterable Delete User.user.js'] = strToU8('// ==UserScript==\n// @name Iterable Delete User\n// ==/UserScript==\n');
  const zip = zipSync(files);
  const fromZip = readInputs([{ path: 'tampermonkey-backup.zip', bytes: zip }]);
  const loose = readInputs(dirInputs('tm'));
  assert.deepEqual(fromZip.scripts.map((s) => [s.name, s.storage]), loose.scripts.map((s) => [s.name, s.storage]));
  // Detected by magic bytes even without a .zip name.
  assert.equal(readInputs([{ path: 'download', bytes: zip }]).scripts.length, loose.scripts.length);
});

test('options-only export is reported as missing storage', () => {
  const r = readInputs(dirInputs('tm-nostorage'));
  assert.equal(r.scripts.length, 2);
  assert.equal(missingStorage(r), true);
  const zipped = readInputs([{ path: 'x.zip', bytes: zipSync(Object.fromEntries(dirInputs('tm-nostorage').map((f) => [f.path, f.bytes]))) }]);
  assert.equal(missingStorage(zipped), true);
});

test('Tampermonkey single-file JSON export is detected by shape', () => {
  const bytes = new Uint8Array(readFileSync(path.join(FIX, 'tm-single-export.json')));
  const r = readInputs([{ path: 'tampermonkey-export.json', bytes }]);
  assert.equal(r.scripts.length, 2);
  const qs = r.scripts.find((s) => s.name === 'Iterable Template Quick Search');
  assert.equal(asJson(qs.storage.iterableQuickSearchTags)[0].label, 'Solo');
  assert.equal(r.scripts.find((s) => s.name === 'Custom Quicklinks').storage, null);
  assert.equal(isTampermonkeyJson({ scripts: [] }), false);
  assert.equal(isTampermonkeyJson({ scripts: [{ nope: 1 }] }), false);
});

test('Workbench backups are separated out; unknown files are ignored', () => {
  const backup = strToU8(JSON.stringify({ app: 'workbench-for-iterable', format: 1, settings: {} }));
  const r = readInputs([
    { path: 'workbench-backup.json', bytes: backup },
    { path: 'notes.txt', bytes: strToU8('hello') },
    { path: 'random.json', bytes: strToU8('{"x":1}') },
  ]);
  assert.equal(r.backups.length, 1);
  assert.equal(r.scripts.length, 0);
  assert.deepEqual(r.ignored.sort(), ['notes.txt', 'random.json']);
});

// ── legacy keys ──────────────────────────────────────────────────────────

test('extractLegacyKeys handles all formats, dedupes, and matches spaces by name', () => {
  const { scripts } = readInputs(dirInputs('tm'));
  const { assigned, unassigned } = extractLegacyKeys(scripts, { knownProjects: [{ projectKey: 'eu:555', name: 'Sandbox' }] });

  const byPk = Object.fromEntries(assigned.map((a) => [a.projectKey, a]));
  assert.equal(byPk['us:18244'].apiKey, K1);
  assert.deepEqual(byPk['us:18244'].sources.sort(), ['Iterable Delete User', 'Iterable Profile Editor', 'Iterable User Push']);
  assert.equal(byPk['us:name:Example Staging'].apiKey, K2);
  // Profile Editor's "Sandbox" space holds the same key as Example Staging: one key, one project.
  assert.equal(byPk['eu:555'], undefined);
  assert.ok(byPk['us:name:Example Staging'].sources.includes('Iterable Profile Editor'));
  assert.equal(assigned.filter((a) => a.apiKey === K2).length, 1);

  // K1 is assigned, so Live Preview's copy of it isn't listed again; K3 and K4 need a project.
  const loose = unassigned.map((u) => u.apiKey).sort();
  assert.deepEqual(loose, [K4, K3].sort());
  assert.ok(unassigned.every((u) => u.id && u.label));
  assert.ok(unassigned.find((u) => u.apiKey === K3).label.includes('Staging'));
});

test('Profile Editor spaces match known projects by name (case-insensitive)', () => {
  const res = extractLegacyKeys([{ name: 'Iterable Profile Editor', storage: { iterable_spaces: JSON.stringify([{ name: 'sandbox', apiKey: K3 }]) } }],
    { knownProjects: [{ projectKey: 'eu:555', name: 'Sandbox' }] });
  assert.deepEqual(res.assigned.map((a) => [a.projectKey, a.apiKey]), [['eu:555', K3]]);
});

test('extractLegacyKeys accepts parsed values and skips junk', () => {
  const res = extractLegacyKeys([{
    name: 'Hand made',
    storage: {
      api_keys_by_project: { 42: { name: 'P', apiKey: K1 }, 'bad key!': { apiKey: K2 }, 43: { apiKey: 'short' } },
      iterable_spaces: [{ name: 'New Space', apiKey: K3 }],
      config: { apiKey: K4 },
    },
  }]);
  assert.deepEqual(res.assigned.map((a) => a.projectKey).sort(), ['us:42', 'us:name:New Space']);
  assert.deepEqual(res.unassigned.map((u) => u.apiKey), [K4]);
  assert.equal(res.skipped, 2);
});

test('stripLegacyKeys removes every key but keeps the value form', () => {
  const { scripts } = readInputs(dirInputs('tm'));
  const lp = scripts.find((s) => s.name === 'Iterable - Live Preview Editor');
  const stripped = stripLegacyKeys(lp.storage);
  assert.equal(typeof stripped.config, 'string');
  const cfg = JSON.parse(stripped.config);
  assert.ok(cfg.apiKeys.every((k) => !('key' in k)));
  assert.equal(cfg.snippets[0].name, 'Greeting');
  const all = JSON.stringify(scripts.map((s) => stripLegacyKeys(s.storage)));
  for (const k of [K1, K2, K3, K4]) assert.ok(!all.includes(k), 'no key survives stripping');
  const up = stripLegacyKeys(scripts.find((s) => s.name === 'Iterable User Push').storage);
  assert.deepEqual(Object.keys(up).sort(), ['settings', 'ui_collapsed']);
});

// ── plan ─────────────────────────────────────────────────────────────────

test('planScripts: import via mapper, stash, nothing-to-import', () => {
  const { scripts } = readInputs(dirInputs('tm'));
  const importers = {
    'quick-search': {
      default: {
        scripts: ['Iterable Template Quick Search'],
        map: (storage) => ({ values: {}, state: { tags: asJson(storage.iterableQuickSearchTags) }, notes: ['2 tags'] }),
      },
    },
    'email-scanner': { default: emailScannerImport },
  };
  const keySources = new Set(['Iterable Delete User', 'Iterable User Push', 'Iterable Profile Editor', 'Iterable - Live Preview Editor']);
  const items = planScripts(scripts, { importers, metas: FEATURES, keySources });
  const by = Object.fromEntries(items.map((i) => [i.script.name, i]));

  assert.equal(by['Iterable Template Quick Search'].status, 'import');
  assert.equal(by['Iterable Template Quick Search'].featureId, 'quick-search');
  assert.deepEqual(by['Iterable Template Quick Search'].notes, ['2 tags']);
  assert.equal(by['Iterable - Link Param Helper'].status, 'stash');
  assert.equal(by['Iterable - Link Param Helper'].feature.id, 'link-params');
  assert.equal(by['Iterable Email HTML Scanner'].status, 'import');
  assert.equal(by['Iterable Email HTML Scanner'].featureId, 'email-scanner');
  assert.equal(by['Iterable Email HTML Scanner'].feature.id, 'email-scanner');
  assert.equal(by['Iterable Email HTML Scanner'].result.values.checkMissingAltText, false);
  assert.equal(by['Iterable - Live Preview Editor'].status, 'stash');
  assert.ok(!JSON.stringify(by['Iterable - Live Preview Editor'].stash).includes(K3));
  assert.equal(by['Iterable Snippet Viewer'].status, 'empty');
  assert.equal(by['Iterable Delete User'].status, 'empty'); // only keys
  assert.match(by['Iterable Delete User'].message, /API keys/);
});

test('planScripts passes the legacy script name to mappers', () => {
  const seen = [];
  const importers = { 'bulk-data': { default: { scripts: ['Iterable User Push', 'Iterable Catalog Push'], map: (st, ctx) => { seen.push(ctx); return {}; } } } };
  planScripts([{ name: 'Iterable Catalog Push', normName: 'catalogpush', storage: { settings: '{}' } }], { importers, metas: FEATURES });
  assert.deepEqual(seen, [{ name: 'Iterable Catalog Push' }]);
});

test('bulk-data mapper picks User Push vs Catalog Push by the name planScripts passes', () => {
  const importers = { 'bulk-data': { default: bulkDataImport } };
  const storage = { settings: '{"rateLimit":5,"batchSize":500}' };  // ambiguous by data alone
  const [cat] = planScripts([{ name: 'Iterable Catalog Push', normName: 'catalogpush', storage }], { importers, metas: FEATURES });
  assert.deepEqual(cat.result.values, { catalogRateLimit: 5, catalogBatchSize: 500 });
  const [usr] = planScripts([{ name: 'Iterable User Push', normName: 'userpush', storage }], { importers, metas: FEATURES });
  assert.deepEqual(usr.result.values, { rateLimit: 5, batchSize: 500 });
});

test('a throwing mapper is reported, not fatal', () => {
  const items = planScripts([{ name: 'Iterable Delete User', normName: 'deleteuser', storage: { x: 1 } }], {
    importers: { 'delete-user': { default: { scripts: ['Delete User'], map: () => { throw new Error('bad shape'); } } } },
    metas: FEATURES,
  });
  assert.equal(items[0].status, 'error');
  assert.match(items[0].message, /bad shape/);
});

test('findImporter and stash keys use normalised names', () => {
  const importers = { a: { default: { scripts: ['Iterable - Link Param Helper'], map: () => ({}) } } };
  assert.equal(findImporter('link param helper', importers).featureId, 'a');
  assert.equal(findImporter('Something else', importers), null);
  assert.equal(legacyStashKey('Iterable - Live Preview Editor'), 'wb:legacy:liveprevieweditor');
});
