import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldComboItems, searchValues, summaryText } from '../../src/features/field-explorer/values.js';
import meta from '../../src/features/field-explorer/meta.js';

test('fieldComboItems maps getUserFields() shape to combobox items', () => {
  const fields = [{ name: 'email', type: 'string', sources: ['mappings'] }, { name: 'age', type: 'long', sources: ['userMappings'] }];
  assert.deepEqual(fieldComboItems(fields), [
    { value: 'email', label: 'email', hint: 'string' },
    { value: 'age', label: 'age', hint: 'long' },
  ]);
});

test('fieldComboItems tolerates a missing type and empty/nullish input', () => {
  assert.deepEqual(fieldComboItems([{ name: 'x', type: '' }]), [{ value: 'x', label: 'x', hint: undefined }]);
  assert.deepEqual(fieldComboItems(null), []);
  assert.deepEqual(fieldComboItems(undefined), []);
});

test('searchValues: empty query returns everything up to the cap', () => {
  const values = ['a', 'b', 'c'];
  const r = searchValues(values, '', 2);
  assert.deepEqual(r.shown, ['a', 'b']);
  assert.equal(r.matchCount, 3);
  assert.equal(r.truncated, true);
});

test('searchValues: case-insensitive substring match', () => {
  const values = ['Alpha', 'beta', 'gamma', 'ALPHABET'];
  const r = searchValues(values, 'alpha', 10);
  assert.deepEqual(r.shown, ['Alpha', 'ALPHABET']);
  assert.equal(r.matchCount, 2);
  assert.equal(r.truncated, false);
});

test('searchValues: not truncated when matches fit exactly at the cap', () => {
  const r = searchValues(['a', 'b'], '', 2);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.shown, ['a', 'b']);
});

test('searchValues: cap <= 0 or non-integer falls back to no cap', () => {
  const values = ['a', 'b', 'c'];
  assert.deepEqual(searchValues(values, '', 0).shown, values);
  assert.deepEqual(searchValues(values, '', -5).shown, values);
  assert.deepEqual(searchValues(values, '', NaN).shown, values);
});

test('summaryText: all values shown, no truncation note', () => {
  assert.equal(summaryText(3, 3), '3 values');
  assert.equal(summaryText(1, 1), '1 value');
});

test('summaryText: filtered subset shown', () => {
  assert.equal(summaryText(2, 10), '2 / 10 shown');
});

test('summaryText: notes an API-truncated result only when everything is shown', () => {
  assert.equal(summaryText(3, 3, { apiTruncated: true }), '3 values (API returned the maximum — there may be more)');
  assert.equal(summaryText(2, 10, { apiTruncated: true }), '2 / 10 shown');
});

test('meta: id is stable and route matches /segmentation', () => {
  assert.equal(meta.id, 'field-explorer');
  assert.ok(meta.routes.some((r) => r.test('/segmentation')));
  assert.ok(meta.routes.some((r) => r.test('/segmentation/123')));
  assert.ok(!meta.routes.some((r) => r.test('/users/profiles/1')));
});

test('meta: maxRendered setting has a sane numeric default', () => {
  const s = meta.settings.find((x) => x.key === 'maxRendered');
  assert.ok(s);
  assert.equal(s.type, 'number');
  assert.equal(s.default, 2000);
});

test('mount: one dialog at a time; unmount closes it and aborts its fetches', async () => {
  const { mount } = await import('../../src/features/field-explorer/index.js');
  const { linkSignal } = await import('../../src/core/dom.js');
  const el = () => ({ style: {}, textContent: '', append() {}, focus() {} });
  const dialogs = [];
  const fetchSignals = [];
  const ac = new AbortController();
  let onOpen = null;
  let combo = null;
  const ctx = {
    signal: ac.signal,
    settings: {},
    log: { warn() {}, info() {}, debug() {} },
    project: { current: () => ({ key: 'us:1' }) },
    // Never settles on its own: only an abort ends it (the "stuck on Fetching…" case).
    http: {
      appFetch: (_p, o = {}) => {
        fetchSignals.push(o.signal);
        return new Promise((_, rej) => o.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
      },
    },
    dom: { h: () => el(), clear() {}, linkSignal },
    ui: {
      floatingBar: () => ({ el: el(), show() {}, destroy() {} }),
      button: () => el(), mark: () => el(), combobox: (o) => { combo = o; return el(); }, input: () => el(),
      copyButton: () => el(), field: () => el(), filterItems: () => [],
      dialog: () => {
        let resolve;
        const d = { closed: new Promise((r) => { resolve = r; }), open: true };
        d.close = (v) => { if (!d.open) return; d.open = false; resolve(v); };
        dialogs.push(d);
        return d;
      },
    },
    onAction: (id, cb) => { if (id === 'open') onOpen = cb; return () => {}; },
    onSettings: () => () => {},
  };
  const cleanup = mount(ctx);
  onOpen();
  onOpen();
  assert.equal(dialogs.length, 1, 'a second open while one is showing does nothing');
  combo.onSelect({ value: 'favoriteColor' });   // starts "Fetching all values…"
  await new Promise((r) => setTimeout(r, 0));
  const s = fetchSignals.find(Boolean);          // fieldFacets got the dialog's own signal
  assert.ok(s && !s.aborted);
  assert.notEqual(s, ac.signal);

  ac.abort();              // unmount (SPA navigation)
  cleanup();
  assert.equal(dialogs[0].open, false, 'the dialog closes on unmount');
  assert.equal(s.aborted, true, 'its fetches are aborted');
  onOpen();
  assert.equal(dialogs.length, 1, 'no new dialog after unmount');
});

test('mount: closing the dialog aborts its fetches and allows reopening', async () => {
  const { mount } = await import('../../src/features/field-explorer/index.js');
  const { linkSignal } = await import('../../src/core/dom.js');
  const el = () => ({ style: {}, textContent: '', append() {}, focus() {} });
  const dialogs = [];
  const fetchSignals = [];
  let onOpen = null;
  let combo = null;
  mount({
    signal: new AbortController().signal, settings: {}, log: { warn() {} },
    project: { current: () => ({ key: 'us:2' }) },
    http: { appFetch: (_p, o = {}) => { fetchSignals.push(o.signal); return new Promise(() => {}); } },
    dom: { h: () => el(), clear() {}, linkSignal },
    ui: {
      floatingBar: () => ({ el: el(), show() {}, destroy() {} }),
      button: () => el(), mark: () => el(), combobox: (o) => { combo = o; return el(); }, input: () => el(),
      copyButton: () => el(), field: () => el(), filterItems: () => [],
      dialog: () => {
        let resolve;
        const d = { closed: new Promise((r) => { resolve = r; }), close: (v) => resolve(v) };
        dialogs.push(d);
        return d;
      },
    },
    onAction: (id, cb) => { if (id === 'open') onOpen = cb; return () => {}; },
    onSettings: () => () => {},
  });
  onOpen();
  combo.onSelect({ value: 'city' });
  await new Promise((r) => setTimeout(r, 0));
  const sigs = fetchSignals.filter(Boolean);
  assert.equal(sigs.length, 1);
  dialogs[0].close('close');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sigs[0].aborted);
  onOpen();
  assert.equal(dialogs.length, 2);
});
