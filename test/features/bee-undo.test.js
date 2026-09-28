import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistory, clampLimit, looksLikeTemplateJson, onChangeJson, readLoad, makeLoadMessage,
  makeSyncChange, templateIdFrom, undoLabel, redoLabel, OWN_TAG, SNAPSHOT_MAX_CHARS, RESTORE_GRACE_MS,
  BASELINE_MAX_WIRE_CHARS, normaliseJson, makeClaimMessage, readClaim,
} from '../../src/features/bee-undo/history.js';
import meta from '../../src/features/bee-undo/meta.js';
import importer, { mapBeeUndo } from '../../src/features/bee-undo/import.js';
import { mergeValues } from '../../src/core/settings.js';
import { compileFrameMessages, encodePayload, decodePayload, FRAME_MAX_CHARS } from '../../src/core/frames.js';

const T = (n) => JSON.stringify({ page: { rows: [{ n }] } });

test('meta: id, frames, route and settings', () => {
  assert.equal(meta.id, 'bee-undo');
  assert.equal(meta.frame, 'top');
  assert.deepEqual(meta.companionFrames, ['bee']);
  assert.deepEqual(meta.legacy, ['Iterable - Auto Confirm Delete + Undo']);
  assert.ok(meta.routes.some((r) => r.test('/templates/editor?templateId=12')));
  assert.ok(!meta.routes.some((r) => r.test('/templates?folder=1')));
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f]));
  assert.equal(byKey.autoConfirmDelete.type, 'boolean');
  assert.equal(byKey.autoConfirmDelete.default, false, 'destructive auto-click must be opt-in');
  assert.equal(byKey.historyLimit.type, 'number');
  assert.deepEqual([byKey.historyLimit.min, byKey.historyLimit.max, byKey.historyLimit.default], [5, 100, 30]);
  assert.equal(byKey.undoShortcut.type, 'shortcut');
  assert.equal(byKey.undoShortcut.default, '');
  assert.equal(byKey.redoShortcut.type, 'shortcut');
  assert.equal(byKey.redoShortcut.default, '');
  assert.match(meta.description, /redo/);
  assert.match(byKey.historyLimit.help, /memory only/);
});

test('meta: settings validation falls back to defaults', () => {
  const v = mergeValues(meta, { autoConfirmDelete: 'yes', historyLimit: 500, undoShortcut: 'ctrl+z' });
  assert.equal(v.autoConfirmDelete, false);
  assert.equal(v.historyLimit, 30);
  assert.equal(v.undoShortcut, 'Ctrl+Z');
  assert.equal(mergeValues(meta, { historyLimit: 5 }).historyLimit, 5);
  assert.equal(mergeValues(meta, { undoShortcut: 'Z' }).undoShortcut, '', 'bare letters are refused');
});

test('meta: frame messages compile, with tight schemas and caps', () => {
  const specs = compileFrameMessages(meta.frameMessages, meta.id);
  assert.deepEqual([...specs.keys()].sort(), ['baseline', 'baselineTooBig', 'claim', 'redo', 'undo']);
  assert.equal(decodePayload(meta, 'claim', JSON.stringify({ nonce: 'x'.repeat(36) })).ok, true);
  assert.equal(decodePayload(meta, 'claim', JSON.stringify({ nonce: 'x'.repeat(65) })).ok, false);
  assert.ok(BASELINE_MAX_WIRE_CHARS <= FRAME_MAX_CHARS);
  const json = T(1);
  const text = encodePayload(meta, 'baseline', { json, loadedAt: 5 });
  assert.deepEqual(decodePayload(meta, 'baseline', text), { ok: true, value: { json, loadedAt: 5 } });
  assert.throws(() => encodePayload(meta, 'baseline', { json, loadedAt: 5, extra: 1 }), TypeError);
  assert.throws(() => encodePayload(meta, 'baseline', { json: 5, loadedAt: 5 }), TypeError);
  assert.throws(() => encodePayload(meta, 'baseline', { json, loadedAt: -1 }), TypeError);
  assert.equal(decodePayload(meta, 'undo', '{"x":1}').ok, false);
  assert.equal(decodePayload(meta, 'undo', '{}').ok, true);
  assert.equal(decodePayload(meta, 'redo', '{}').ok, true);
  assert.equal(decodePayload(meta, 'redo', '{"x":1}').ok, false);
  assert.equal(decodePayload(meta, 'baselineTooBig', '{"chars":1.5,"loadedAt":1}').ok, false);
  // A snapshot at the size limit, even one made mostly of quotes, fits on the wire…
  const big = `{"a":"${'\\"'.repeat((SNAPSHOT_MAX_CHARS - 8) / 2)}"}`;
  assert.equal(big.length, SNAPSHOT_MAX_CHARS);
  assert.ok(encodePayload(meta, 'baseline', { json: big, loadedAt: 1 }).length <= BASELINE_MAX_WIRE_CHARS);
  // …and one over it is refused by the schema (the bee half sends baselineTooBig instead).
  assert.throws(() => encodePayload(meta, 'baseline', { json: `${big} `, loadedAt: 1 }), TypeError);
});

test('history: baseline, record, undo and the grace period', () => {
  const h = createHistory({ limit: 30 });
  assert.equal(h.steps, 0);
  assert.equal(h.baseline(T(0), 1000), 'reset');
  assert.equal(h.steps, 0);
  assert.equal(h.record(T(1), 1100), 'recorded');
  assert.equal(h.record(T(1), 1150), 'duplicate');
  assert.equal(h.record(T(2), 1200), 'recorded');
  assert.equal(h.steps, 2);
  assert.equal(h.peekUndo(), T(1));
  assert.equal(h.commitUndo(2000), T(1));
  assert.equal(h.steps, 1);
  // BEE's own onChange after the reload is ignored during the grace period…
  assert.equal(h.record(T(1), 2000 + RESTORE_GRACE_MS - 1), 'grace');
  // …a real edit after it is recorded.
  assert.equal(h.record(T(3), 2000 + RESTORE_GRACE_MS), 'recorded');
  assert.equal(h.steps, 2);
  assert.equal(h.commitUndo(5000), T(1));
  assert.equal(h.commitUndo(5001), T(0));
  assert.equal(h.commitUndo(5002), null);
  assert.equal(h.peekUndo(), null);
});

test('redo: undo twice, redo, redo again, then nothing left', () => {
  const h = createHistory();
  h.baseline(T(0), 0);
  h.record(T(1), 10);
  h.record(T(2), 20);
  h.record(T(3), 30);
  assert.equal(h.redoSteps, 0);
  assert.equal(h.peekRedo(), null);
  assert.equal(h.commitRedo(40), null);
  assert.equal(h.commitUndo(100), T(2));
  assert.equal(h.commitUndo(101), T(1));
  assert.deepEqual([h.steps, h.redoSteps], [1, 2]);
  assert.equal(h.peekRedo(), T(2));
  assert.equal(h.commitRedo(102), T(2));
  assert.deepEqual([h.steps, h.redoSteps], [2, 1]);
  assert.equal(h.peekUndo(), T(1), 'undo after redo goes back to where the redo came from');
  assert.equal(h.commitRedo(103), T(3));
  assert.deepEqual([h.steps, h.redoSteps], [3, 0]);
  assert.equal(h.commitRedo(104), null);
  // Undo → redo → undo round-trips the same snapshots.
  assert.equal(h.commitUndo(105), T(2));
  assert.equal(h.commitRedo(106), T(3));
  assert.equal(h.commitUndo(107), T(2));
  assert.equal(h.peekRedo(), T(3));
});

test('redo: starts the grace period, so the restore itself is not a new change', () => {
  const h = createHistory();
  h.baseline(T(0), 0);
  h.record(T(1), 10);
  h.record(T(2), 20);
  h.commitUndo(1000);
  h.commitUndo(1001);
  assert.equal(h.commitRedo(5000), T(1));
  assert.equal(h.restoringUntil, 5000 + RESTORE_GRACE_MS);
  assert.equal(h.record(T(1), 5000 + RESTORE_GRACE_MS - 1), 'grace');
  assert.equal(h.redoSteps, 1, 'grace keeps redo');
  // BEE's echo of the current state after the grace period is a duplicate, not a change.
  assert.equal(h.record(T(1), 9000), 'duplicate');
  assert.equal(h.redoSteps, 1);
});

test('redo: a new change clears it', () => {
  const h = createHistory();
  h.baseline(T(0), 0);
  h.record(T(1), 10);
  h.record(T(2), 20);
  h.commitUndo(100);
  h.commitUndo(101);
  assert.equal(h.redoSteps, 2);
  const before = h.totalChars;
  assert.equal(h.record(T(9), 5000), 'recorded');
  assert.equal(h.redoSteps, 0);
  assert.equal(h.peekRedo(), null);
  assert.equal(h.totalChars, before - T(1).length - T(2).length + T(9).length);
  assert.equal(h.peekUndo(), T(0));
});

test('redo: template switch, reload and clear drop both stacks', () => {
  const setup = () => {
    const h = createHistory();
    h.baseline(T(0), 0);
    h.record(T(1), 10);
    h.record(T(2), 20);
    h.commitUndo(100);
    return h;
  };
  let h = setup();
  h.clear();
  assert.deepEqual([h.steps, h.redoSteps, h.totalChars], [0, 0, 0]);
  h = setup();
  assert.equal(h.baseline(T(50), 200), 'reset'); // another template / editor reload
  assert.deepEqual([h.steps, h.redoSteps], [0, 0]);
  assert.equal(h.totalChars, T(50).length);
  h = setup();
  h.baselineTooBig();
  assert.deepEqual([h.size, h.redoSteps], [0, 0]);
  h = setup();
  // The same load reported again (the editor half reconnected) keeps redo.
  h.baseline(T(0), 0);
  assert.deepEqual([h.steps, h.redoSteps], [1, 1]);
  assert.equal(h.commitRedo(300), T(2));
});

test('redo: the step limit counts undo and redo together', () => {
  const h = createHistory({ limit: 5 });
  h.baseline(T(0), 0);
  for (let i = 1; i <= 8; i++) h.record(T(i), i);
  assert.equal(h.steps, 5); // T(3)…T(8)
  h.commitUndo(100);
  h.commitUndo(101);
  h.commitUndo(102);
  assert.deepEqual([h.steps, h.redoSteps], [2, 3]);
  assert.equal(h.steps + h.redoSteps, 5);
  // A smaller limit drops the oldest undo steps first…
  h.setLimit(5);
  assert.deepEqual([h.steps, h.redoSteps], [2, 3]);
  const tight = createHistory({ limit: 5 });
  tight.baseline(T(0), 0);
  for (let i = 1; i <= 5; i++) tight.record(T(i), i);
  for (let i = 0; i < 5; i++) tight.commitUndo(100 + i);
  assert.deepEqual([tight.steps, tight.redoSteps], [0, 5]);
  // …and redo steps only when no undo step is left: the furthest redo goes, the next one stays.
  const mixed = createHistory({ limit: 10 });
  mixed.baseline(T(0), 0);
  for (let i = 1; i <= 10; i++) mixed.record(T(i), i);
  for (let i = 0; i < 8; i++) mixed.commitUndo(100 + i);
  assert.deepEqual([mixed.steps, mixed.redoSteps], [2, 8]);
  mixed.setLimit(7);
  assert.deepEqual([mixed.steps, mixed.redoSteps], [0, 7]);
  assert.equal(mixed.peekRedo(), T(3), 'the nearest redo is kept');
  assert.equal(mixed.size, 1);
  assert.equal(mixed.totalChars, [2, 3, 4, 5, 6, 7, 8, 9].reduce((n, i) => n + T(i).length, 0));
});

test('redo: the size cap counts both stacks; an unreadable redo target is skipped', () => {
  const s = (n) => `{"a":"${String(n).padStart(10, '0')}"}`; // 18 chars
  const h = createHistory({ maxTotalChars: 60 });
  h.baseline(s(0), 0);
  h.record(s(1), 1);
  h.record(s(2), 2);
  h.commitUndo(10);
  h.commitUndo(11);
  assert.deepEqual([h.steps, h.redoSteps], [0, 2]);
  assert.equal(h.totalChars, 54);
  assert.equal(h.record('{"b":"xxxxxxxxxx"}', 5000), 'recorded'); // clears redo: 36 chars
  assert.equal(h.totalChars, 36);
  const r = createHistory();
  r.baseline(T(0), 0);
  r.record('{broken}', 1);
  r.record(T(2), 2);
  r.commitUndo(10);
  r.commitUndo(11);
  assert.equal(r.peekRedo(), '{broken}');
  r.discardRedoTarget();
  assert.equal(r.peekRedo(), T(2));
  assert.equal(r.redoSteps, 1);
  assert.equal(r.totalChars, T(0).length + T(2).length);
  r.discardRedoTarget();
  r.discardRedoTarget(); // nothing left: no-op
  assert.equal(r.redoSteps, 0);
});

test('history: without a baseline the first change is the starting point', () => {
  const h = createHistory();
  h.record(T(1), 1);
  assert.equal(h.steps, 0);
  h.record(T(2), 2);
  assert.equal(h.steps, 1);
  assert.equal(h.peekUndo(), T(1));
});

test('history: a late baseline keeps the changes recorded after its load', () => {
  const h = createHistory();
  h.record(T(9), 50); // belongs to an older load
  h.record(T(1), 150);
  h.record(T(2), 160);
  h.baseline(T(0), 100);
  assert.equal(h.steps, 2);
  assert.equal(h.commitUndo(1000), T(1));
  assert.equal(h.commitUndo(1001), T(0));
  assert.equal(h.steps, 0);
});

test('history: a new baseline (another template) replaces everything before it', () => {
  const h = createHistory();
  h.baseline(T(0), 1);
  h.record(T(1), 2);
  h.baseline(T(100), 10);
  assert.equal(h.steps, 0);
  assert.equal(h.size, 1);
});

test('history: step limit keeps limit + 1 entries and follows setLimit', () => {
  const h = createHistory({ limit: 5 });
  h.baseline(T(0), 0);
  for (let i = 1; i <= 12; i++) h.record(T(i), i);
  assert.equal(h.steps, 5);
  assert.equal(h.peekUndo(), T(11));
  h.setLimit(100);
  assert.equal(h.limit, 100);
  h.setLimit(2); // clamped to 5
  assert.equal(h.limit, 5);
  h.setLimit(Number.NaN);
  assert.equal(h.limit, 30);
});

test('history: size caps', () => {
  const h = createHistory({ maxSnapshotChars: 20, maxTotalChars: 50 });
  const s = (n) => `{"a":"${String(n).padStart(10, '0')}"}`; // 18 chars
  h.baseline(s(0), 0);
  h.record(s(1), 1);
  h.record(s(2), 2);
  assert.equal(h.steps, 1); // 54 chars > 50 → oldest dropped
  assert.equal(h.size, 2);
  assert.ok(h.totalChars <= 50);
  // A snapshot over the per-snapshot cap clears the history (older steps no longer reach it).
  assert.equal(h.record(`{"a":"${'x'.repeat(30)}"}`, 3), 'too-big');
  assert.equal(h.steps, 0);
  assert.equal(h.size, 0);
  assert.equal(h.tooBig, true);
  h.record(s(4), 4);
  assert.equal(h.tooBig, false);
  h.record(s(5), 5);
  assert.equal(h.steps, 1);
  assert.equal(h.baseline(`{"a":"${'x'.repeat(30)}"}`, 6), 'too-big');
  assert.equal(h.size, 0);
  h.record(s(7), 7);
  h.baselineTooBig();
  assert.equal(h.size, 0);
  assert.equal(h.tooBig, true);
  h.clear();
  assert.equal(h.tooBig, false);
});

test('history: invalid input and discarding an unreadable target', () => {
  const h = createHistory();
  assert.equal(h.baseline('nope', 1), 'invalid');
  assert.equal(h.record(42, 1), 'invalid');
  assert.equal(h.record('[1]', 1), 'invalid');
  h.record(T(0), 1);
  h.record('{broken}', 2);
  h.record(T(2), 3);
  assert.equal(h.peekUndo(), '{broken}');
  h.discardUndoTarget();
  assert.equal(h.peekUndo(), T(0));
  assert.equal(h.steps, 1);
});

test('helpers: clampLimit, looksLikeTemplateJson, templateIdFrom, undoLabel', () => {
  assert.equal(clampLimit('12'), 12);
  assert.equal(clampLimit(0), 5);
  assert.equal(clampLimit(1000), 100);
  assert.equal(looksLikeTemplateJson('{}'), true);
  assert.equal(looksLikeTemplateJson(' {}'), false);
  assert.equal(templateIdFrom('?templateId=77&locale=fr'), '77');
  assert.equal(templateIdFrom(''), '');
  assert.equal(undoLabel(3), 'Undo (3)');
  assert.equal(undoLabel(-1), 'Undo (0)');
  assert.equal(redoLabel(2), 'Redo (2)');
  assert.equal(redoLabel(-1), 'Redo (0)');
});

test('BEE protocol: onChangeJson', () => {
  assert.equal(onChangeJson({ action: 'onChange', args: [T(1), {}, 0] }), T(1));
  assert.equal(onChangeJson({ action: 'onChange', args: [{}, {}] }), null);
  assert.equal(onChangeJson({ action: 'onSave', args: [T(1)] }), null);
  assert.equal(onChangeJson(makeSyncChange(T(1))), null, 'our own imitation is not recorded');
  assert.equal(onChangeJson(null), null);
  assert.equal(onChangeJson('onChange'), null);
  const hostile = { get action() { throw new Error('x'); } };
  assert.equal(onChangeJson(hostile), null);
});

test('BEE protocol: readLoad, makeLoadMessage, makeSyncChange', () => {
  const tpl = { page: {} };
  assert.deepEqual(readLoad({ action: 'load', data: { template: tpl } }), { own: false, template: tpl });
  assert.deepEqual(readLoad(makeLoadMessage(tpl)), { own: true, template: tpl });
  assert.equal(readLoad({ action: 'load', data: {} }), null);
  assert.equal(readLoad({ action: 'load' }), null);
  assert.equal(readLoad({ action: 'save', data: { template: tpl } }), null);
  assert.equal(readLoad({ action: 'load', data: { template: tpl }, [OWN_TAG]: 'yes' }).own, false);
  const sync = makeSyncChange(T(1));
  assert.equal(sync.action, 'onChange');
  assert.equal(sync.args[0], T(1));
  assert.equal(sync.args[2], 0);
  assert.equal(sync[OWN_TAG], true);
  assert.deepEqual(Object.keys(sync.args[1]).sort(), ['code', 'description', 'patches', 'value']);
});

test('import: autoConfirmDelete', () => {
  assert.deepEqual(mapBeeUndo({ autoConfirmDelete: true }).values, { autoConfirmDelete: true });
  assert.deepEqual(mapBeeUndo({ autoConfirmDelete: false }).values, { autoConfirmDelete: false });
  assert.deepEqual(mapBeeUndo({ autoConfirmDelete: 'true' }).values, { autoConfirmDelete: true });
  assert.deepEqual(mapBeeUndo({ autoConfirmDelete: 'maybe' }).values, {});
  assert.match(mapBeeUndo({ autoConfirmDelete: 'maybe' }).notes[0], /could not be read/);
  assert.deepEqual(mapBeeUndo({}).values, {});
  assert.deepEqual(mapBeeUndo(null).values, {});
  assert.deepEqual(importer.scripts, ['Iterable - Auto Confirm Delete + Undo']);
  assert.deepEqual(importer.map({ autoConfirmDelete: true }, { name: 'x' }).values, { autoConfirmDelete: true });
});

test('grace: an edit during the grace period is recorded and clears redo; only the echo is ignored', () => {
  const h = createHistory();
  h.baseline(T(0), 0);
  h.record(T(1), 10);
  h.record(T(2), 20);
  assert.equal(h.commitUndo(1000), T(1));
  assert.equal(h.redoSteps, 1);
  // BEE's echo of the load we posted: ignored, redo kept.
  assert.equal(h.record(T(1), 1001), 'grace');
  assert.equal(h.redoSteps, 1);
  // A real edit inside the grace window: recorded, and it clears redo.
  assert.equal(h.record(T(9), 1100), 'recorded');
  assert.deepEqual([h.steps, h.redoSteps], [2, 0]);
  assert.equal(h.peekUndo(), T(1));
  // A late echo of the restored snapshot, still in the window, is not a new step back.
  assert.equal(h.record(T(1), 1200), 'grace');
  assert.equal(h.steps, 2);
  // Same after a redo.
  h.commitUndo(3000);
  assert.equal(h.commitRedo(3001), T(9));
  assert.equal(h.record(T(9), 3002), 'grace');
  assert.equal(h.record(T(10), 3003), 'recorded');
  assert.deepEqual([h.steps, h.redoSteps], [3, 0]);
  // clear() forgets the restored snapshot.
  h.commitUndo(4000);
  h.clear();
  h.baseline(T(0), 4001);
  assert.equal(h.record(T(9), 4002), 'recorded');
});

test('normalised compare: whitespace and key order are not a new step', () => {
  const a = '{"page":{"rows":[{"n":1,"m":2}],"title":"x"}}';
  const b = '{ "page": { "title": "x", "rows": [ { "m": 2, "n": 1 } ] } }';
  assert.equal(normaliseJson(a), normaliseJson(b));
  assert.notEqual(normaliseJson(a), normaliseJson('{"page":{"rows":[{"m":2},{"n":1}],"title":"x"}}'), 'array order counts');
  assert.equal(normaliseJson('{not json}'), '{not json}', 'unparsable → raw text');
  assert.equal(normaliseJson(a, 5), a, 'size guard → raw text');
  const deep = `${'{"a":'.repeat(20000)}1${'}'.repeat(20000)}`;
  assert.equal(typeof normaliseJson(deep), 'string', 'too deep never throws');
  const proto = '{"__proto__":{"x":1},"b":2}';
  assert.equal(normaliseJson(proto), '{"__proto__":{"x":1},"b":2}', '__proto__ stays a plain key');

  const h = createHistory();
  h.baseline(a, 0);
  assert.equal(h.record(b, 10), 'duplicate');
  assert.equal(h.steps, 0);
  h.record(T(1), 20);
  assert.equal(h.record(T(1).replace(':', ': '), 30), 'duplicate');
  // A late echo after undo that differs only in formatting is BEE's echo (grace) …
  h.commitUndo(1000);
  assert.equal(h.record(b, 1001), 'grace');
  // … and after the grace period, a duplicate rather than a new step.
  assert.equal(h.record(b, 1000 + RESTORE_GRACE_MS + 1), 'duplicate');
  assert.deepEqual([h.steps, h.redoSteps], [0, 1]);
  // The same load reported again with different formatting changes nothing.
  assert.equal(h.baseline(b, 0), 'reset');
  assert.equal(h.redoSteps, 1);
});

test('claim: challenge message shape', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const m = makeClaimMessage(nonce);
  assert.equal(m.action, undefined, 'no action, so BEE ignores it');
  assert.equal(readClaim(m), nonce);
  assert.equal(readClaim(structuredClone(m)), nonce);
  assert.equal(readClaim({ [OWN_TAG]: 'claim', nonce: 'short' }), null);
  assert.equal(readClaim({ [OWN_TAG]: 'claim', nonce: 5 }), null);
  assert.equal(readClaim({ [OWN_TAG]: true, nonce }), null);
  assert.equal(readClaim(makeLoadMessage({})), null);
  assert.equal(readLoad(m), null);
  assert.equal(onChangeJson(m), null);
  assert.equal(readClaim(null), null);
  assert.equal(readClaim(new Proxy({}, { get() { throw new Error('x'); } })), null);
});
