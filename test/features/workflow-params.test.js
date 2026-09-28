import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLinksSection, findFieldByLabel, planRows, applyToLinks, summarize, isChecked, SELECTORS,
} from '../../src/features/workflow-params/links.js';
import { normalizeLinkParams, configToValues, legacyShortcut, DEFAULT_LINK_PARAMS } from '../../src/features/workflow-params/config.js';
import { matchesShortcut } from '../../src/core/shortcut.js';
import importer, { mapWorkflowParams } from '../../src/features/workflow-params/import.js';
import meta from '../../src/features/workflow-params/meta.js';
import { decodeStorage } from '../../src/options/importer/decode.js';
import { mergeValues, isValidValue } from '../../src/core/settings.js';

// ── A tiny DOM: just enough for links.js (simple compound selectors, no combinators) ──────────

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentElement = null;
    this.value = attrs.value ?? '';
    this.onclick = null;
    for (const k of kids) this.append(k);
  }
  append(...kids) {
    for (const k of kids) {
      if (k instanceof El) k.parentElement = this;
      this.childNodes.push(k);
    }
  }
  get children() { return this.childNodes.filter((c) => c instanceof El); }
  get textContent() { return this.childNodes.map((c) => (c instanceof El ? c.textContent : String(c))).join(''); }
  get nextElementSibling() {
    const sibs = this.parentElement?.children || [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  click() { this.onclick?.(this); }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel) {
    const alts = sel.split(',').map((s) => parseCompound(s.trim()));
    return [...this.descendants()].filter((el) => alts.some((m) => m(el)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function parseCompound(s) {
  const m = /^([a-z0-9]*)(.*)$/i.exec(s);
  const tag = m[1].toUpperCase();
  const tests = [];
  const re = /#([\w-]+)|\[([\w-]+)(\^?=)"([^"]*)"\]/g;
  let t;
  while ((t = re.exec(m[2]))) {
    const [, id, name, op, val] = t;
    if (id) tests.push((el) => el.getAttribute('id') === id);
    else {
      tests.push((el) => { const a = el.getAttribute(name); return a != null && (op === '=' ? a === val : a.startsWith(val)); });
    }
  }
  return (el) => (!tag || el.tagName === tag) && tests.every((f) => f(el));
}

const el = (tag, attrs, ...kids) => new El(tag, attrs || {}, kids.flat());
const doc = (...kids) => el('html', null, el('body', null, ...kids));

/** A checkbox that flips aria-checked on click, running `onChange(checked)`. */
function checkbox(checked, onChange) {
  const c = el('div', { 'data-test': 'interactive-checkbox', 'aria-checked': String(checked) });
  c.onclick = () => { const v = !isChecked(c); c.setAttribute('aria-checked', v); onChange?.(v); };
  return c;
}

let rowSeq = 0;
function paramRow(key = '', value = '') {
  const n = rowSeq++;
  return el('div', null,
    el('input', { id: `link-parameter-key-${n}`, value: key }),
    el('input', { id: `link-parameter-value-${n}`, value }));
}

/** Details-panel fixture close to Iterable's: header, then sibling form fields. */
function panel({ ga = false, campaign = '', lp = false, rows = [], withAdd = true } = {}) {
  const gaField = el('div', { 'data-test': 'google-analytics-form-section' }, el('label', null, 'Google analytics'));
  const gaBox = checkbox(ga, (on) => {
    if (on) gaField.append(el('input', { id: 'google-analytics-input', value: campaign }));
    else gaField.childNodes = gaField.childNodes.filter((c) => !(c instanceof El && c.getAttribute('id') === 'google-analytics-input'));
  });
  gaField.append(gaBox);
  if (ga) gaField.append(el('input', { id: 'google-analytics-input', value: campaign }));

  const lpField = el('div', { 'data-test': 'form-field' }, el('label', null, 'Link parameters'));
  const rowsBox = el('div');
  const lpBox = checkbox(lp, (on) => { if (on && !rowsBox.children.length) rowsBox.append(paramRow()); });
  lpField.append(lpBox, rowsBox);
  for (const [k, v] of rows) rowsBox.append(paramRow(k, v));
  if (withAdd) {
    const add = el('button', { 'data-test': 'medium-ghost-success-button' }, el('span', null, '+ '), 'Add link parameter');
    add.onclick = () => rowsBox.append(paramRow());
    lpField.append(add);
  }
  const section = el('div', null,
    el('div', null, 'Content'),
    el('div', null, 'Links'),
    gaField,
    lpField);
  return { root: doc(el('div', null, el('span', null, 'Links')), section), gaField, lpField };
}

const setValue = (input, v) => { input.value = v; input.sets = (input.sets || 0) + 1; };
const rowValues = (field) => {
  const keys = field.querySelectorAll(SELECTORS.linkParamKey);
  const vals = field.querySelectorAll(SELECTORS.linkParamValue);
  return keys.map((k, i) => [k.value, vals[i].value]);
};
const CFG = {
  enableGA: true, gaCampaign: '{{lower campaignName}}', enableLinkParams: true,
  linkParams: [{ key: 'utm_source', value: 'iterable' }, { key: 'utm_medium', value: 'email' }],
};

// ── Discovery ────────────────────────────────────────────────────────────────

test('findLinksSection: exact leaf "Links" whose parent has a label', () => {
  const { root } = panel();
  const header = findLinksSection(root);
  assert.ok(header);
  assert.equal(header.textContent, 'Links');
  // The decoy <span>Links</span> has no label beside it; the header's parent does.
  assert.equal(header.tagName, 'DIV');
  assert.equal(findLinksSection(doc(el('div', null, el('div', null, 'Links'), el('p', null, 'no label')))), null);
  assert.equal(findLinksSection(doc(el('div', null, el('div', null, 'Links ', el('b', null, 'x')), el('label', null, 'L')))), null);
  assert.equal(findLinksSection(doc(el('div', null, el('div', null, 'Linkss'), el('label', null, 'L')))), null);
});

test('findFieldByLabel: sibling walk, then document-wide fallback', () => {
  const { root, gaField, lpField } = panel();
  const header = findLinksSection(root);
  assert.equal(findFieldByLabel(root, header, 'Google analytics'), gaField);
  assert.equal(findFieldByLabel(root, header, 'link parameters'), lpField);
  assert.equal(findFieldByLabel(root, header, 'Nope'), null);
  assert.equal(findFieldByLabel(root, null, 'Google analytics'), null);

  // Field nested elsewhere (template editor layout): found via [data-test="form-field"].
  const far = el('div', { 'data-test': 'form-field' }, el('label', null, 'Link parameters'));
  const root2 = doc(el('div', null, el('div', null, 'Links'), el('label', null, 'x')), el('section', null, far));
  assert.equal(findFieldByLabel(root2, findLinksSection(root2), 'Link parameters'), far);
});

// ── Row planning ─────────────────────────────────────────────────────────────

test('planRows: reuse matching keys, then blank rows, then add', () => {
  const p = (...keys) => keys.map((key) => ({ key, value: 'v' }));
  assert.deepEqual(planRows([], p('a', 'b')), { assign: [0, 1], add: 2 });
  assert.deepEqual(planRows([''], p('a', 'b')), { assign: [0, 1], add: 1 });
  assert.deepEqual(planRows(['b', 'a'], p('a', 'b')), { assign: [1, 0], add: 0 });
  assert.deepEqual(planRows(['x', '', 'a'], p('a', 'b', 'c')), { assign: [2, 1, 3], add: 1 });
  assert.deepEqual(planRows([' a '], p('a')), { assign: [0], add: 0 });
  // Duplicate keys each get their own row, and a second run maps them to the same two rows.
  assert.deepEqual(planRows([], p('a', 'a')), { assign: [0, 1], add: 2 });
  assert.deepEqual(planRows(['a', 'a'], p('a', 'a')), { assign: [0, 1], add: 0 });
  assert.deepEqual(planRows(['x'], []), { assign: [], add: 0 });
});

// ── Applying ─────────────────────────────────────────────────────────────────

test('applyToLinks: ticks both boxes, fills campaign and rows (reusing the default blank row)', async () => {
  const { root, gaField, lpField } = panel();
  const report = await applyToLinks(root, CFG, { setValue });
  assert.equal(report.section, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.errors, []);
  assert.equal(isChecked(gaField.querySelector(SELECTORS.checkbox)), true);
  assert.equal(gaField.querySelector(SELECTORS.gaInput).value, '{{lower campaignName}}');
  assert.deepEqual(rowValues(lpField), [['utm_source', 'iterable'], ['utm_medium', 'email']]);
  assert.deepEqual(report.filled, ['GA campaign', '2 link parameters (1 row added)']);
  assert.equal(summarize(report).tone, 'ok');
});

test('applyToLinks is idempotent: a second run adds no rows and sets nothing', async () => {
  const { root, lpField } = panel();
  await applyToLinks(root, CFG, { setValue });
  const inputs = lpField.querySelectorAll('input');
  const report = await applyToLinks(root, CFG, { setValue });
  assert.equal(lpField.querySelectorAll('input').length, inputs.length);
  assert.deepEqual(report.filled, []);
  assert.deepEqual(report.unchanged, ['GA campaign', '2 link parameters']);
  assert.match(summarize(report).message, /^Already set: GA campaign, 2 link parameters\.$/);
});

test('applyToLinks keeps unrelated rows and updates matching ones in place', async () => {
  const { root, lpField } = panel({ lp: true, rows: [['utm_content', 'hero'], ['utm_medium', 'sms']] });
  await applyToLinks(root, CFG, { setValue });
  assert.deepEqual(rowValues(lpField), [['utm_content', 'hero'], ['utm_medium', 'email'], ['utm_source', 'iterable']]);
});

test('applyToLinks: disabled options untick the boxes', async () => {
  const { root, gaField, lpField } = panel({ ga: true, campaign: 'x', lp: true, rows: [['a', 'b']] });
  const report = await applyToLinks(root, { ...CFG, enableGA: false, enableLinkParams: false }, { setValue });
  assert.equal(isChecked(gaField.querySelector(SELECTORS.checkbox)), false);
  assert.equal(isChecked(lpField.querySelector(SELECTORS.checkbox)), false);
  assert.deepEqual(report.filled, ['Google Analytics turned off', 'link parameters turned off']);
});

test('applyToLinks reports missing fields and a missing add button', async () => {
  assert.equal((await applyToLinks(doc(el('div', null, 'nothing')), CFG, { setValue })).section, false);
  assert.equal(summarize({ section: false }).tone, 'warn');

  const onlyHeader = doc(el('div', null, el('div', null, 'Links'), el('label', null, 'Something else')));
  const r1 = await applyToLinks(onlyHeader, CFG, { setValue });
  assert.deepEqual(r1.missing, ['Google analytics field', 'Link parameters field']);
  assert.equal(summarize(r1).tone, 'warn');

  const { root } = panel({ lp: true, rows: [['x', 'y']], withAdd: false });
  const r2 = await applyToLinks(root, CFG, { setValue });
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0], /Add link parameter/);
  assert.equal(summarize(r2).tone, 'bad');
});

test('applyToLinks stops on abort', async () => {
  const { root } = panel();
  const ac = new AbortController();
  const p = applyToLinks(root, CFG, { setValue, signal: ac.signal });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

// ── Shortcut (legacy formats → core `shortcut` field) ────────────────────────

test('legacyShortcut: Ctrl / Control / Mod mean the primary modifier', () => {
  assert.equal(legacyShortcut('Ctrl+Shift+L'), 'Mod+Shift+L');
  assert.equal(legacyShortcut(' control - shift - l '), 'Mod+Shift+L');
  assert.equal(legacyShortcut('mod+shift+l'), 'Mod+Shift+L');
  assert.equal(legacyShortcut('Cmd+Alt+1'), 'Alt+Meta+1');
  assert.equal(legacyShortcut('Mod+Shift+L'), 'Mod+Shift+L');
  assert.equal(legacyShortcut(''), '');
  assert.equal(legacyShortcut('  '), '');
  assert.equal(legacyShortcut('Shift+L'), undefined);   // would fire while typing
  assert.equal(legacyShortcut('Ctrl+A+B'), undefined);
  assert.equal(legacyShortcut(null), undefined);
  assert.equal(legacyShortcut(42), undefined);
  // The mapped value fires on Ctrl+Shift+L on Windows/Linux and ⌘⇧L on a Mac, as before.
  const ev = (o) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: 'L', code: 'KeyL', ...o });
  assert.equal(matchesShortcut(legacyShortcut('Ctrl+Shift+L'), ev({ ctrlKey: true, shiftKey: true }), { mac: false }), true);
  assert.equal(matchesShortcut(legacyShortcut('Ctrl+Shift+L'), ev({ metaKey: true, shiftKey: true }), { mac: true }), true);
});

// ── Settings + import ────────────────────────────────────────────────────────

test('meta defaults are valid and generic', () => {
  for (const f of meta.settings) assert.ok(isValidValue(f, f.default), f.key);
  const v = mergeValues(meta, {});
  assert.deepEqual(DEFAULT_LINK_PARAMS, []);
  assert.deepEqual(v.linkParams, []);   // Iterable's GA option may add source/medium itself
  assert.equal(v.gaCampaign, '{{lower campaignName}}');
  assert.equal(meta.settings.find((f) => f.key === 'shortcut').type, 'shortcut');
  assert.equal(v.shortcut, 'Mod+Shift+L');
});

test('applyToLinks: no parameters configured leaves the Link parameters box alone', async () => {
  const { root, lpField } = panel();
  const report = await applyToLinks(root, { ...CFG, linkParams: [] }, { setValue });
  assert.equal(isChecked(lpField.querySelector(SELECTORS.checkbox)), false);
  assert.deepEqual(report.filled, ['GA campaign']);
  assert.deepEqual(report.unchanged, ['link parameters (none configured)']);
});

test('normalizeLinkParams / configToValues', () => {
  assert.deepEqual(normalizeLinkParams([{ key: ' a ', value: 1 }, { key: '', value: 'x' }, null, 'k', { key: 'b' }]),
    [{ key: 'a', value: '1' }, { key: 'b', value: '' }]);
  assert.deepEqual(normalizeLinkParams('nope'), []);
  assert.deepEqual(configToValues({ enableGA: 'false', gaCampaign: 5, extra: 1 }), { values: { enableGA: false }, dropped: 0 });
  assert.deepEqual(configToValues(null), { values: {}, dropped: 0 });
  assert.deepEqual(configToValues([1]), { values: {}, dropped: 0 });
});

const SCRIPT_CFG = {
  enableGA: false,
  gaCampaign: '{{campaignName}}',
  enableLinkParams: true,
  linkParams: [{ key: 'utm_source', value: 'newsletter' }, { key: 'utm_id', value: '{{now format="yyyyMMdd"}}' }, { key: '  ', value: 'x' }],
  future: { anything: true },
};

test('import: JSON string (decoded Tampermonkey storage) and parsed object give the same values', () => {
  assert.deepEqual(importer.scripts, ['Iterable Workflow - Add Google Tracking Params']);
  const decoded = decodeStorage({ iterableLinkParamsConfig: 's' + JSON.stringify(SCRIPT_CFG) });
  const fromString = mapWorkflowParams(decoded);
  const fromObject = importer.map({ iterableLinkParamsConfig: SCRIPT_CFG });
  const expected = {
    enableGA: false,
    gaCampaign: '{{campaignName}}',
    enableLinkParams: true,
    linkParams: [{ key: 'utm_source', value: 'newsletter' }, { key: 'utm_id', value: '{{now format="yyyyMMdd"}}' }],
    shortcut: 'Mod+Shift+L',   // the script's fixed Ctrl/Cmd+Shift+L
  };
  assert.deepEqual(fromString.values, expected);
  assert.deepEqual(fromObject.values, expected);
  assert.ok(fromString.notes.some((n) => /Skipped 1 link parameter row/.test(n)));
  // Imported values survive schema validation unchanged.
  assert.deepEqual(mergeValues(meta, fromString.values).linkParams, expected.linkParams);
});

test('import: a stored plain "Ctrl+Shift+L" (earlier format) becomes Mod+Shift+L; other shortcuts kept', () => {
  assert.equal(mapWorkflowParams({ iterableLinkParamsConfig: { enableGA: true, shortcut: 'Ctrl+Shift+L' } }).values.shortcut, 'Mod+Shift+L');
  assert.equal(mapWorkflowParams({ iterableLinkParamsConfig: { enableGA: true, shortcut: 'Alt+K' } }).values.shortcut, 'Alt+K');
  assert.equal(mapWorkflowParams({ iterableLinkParamsConfig: { enableGA: true, shortcut: '' } }).values.shortcut, '');
  // Unreadable → the default mapping, never an invalid value.
  const v = mapWorkflowParams({ iterableLinkParamsConfig: { enableGA: true, shortcut: 'Shift+' } }).values;
  assert.equal(v.shortcut, 'Mod+Shift+L');
  assert.equal(mergeValues(meta, v).shortcut, 'Mod+Shift+L');
});

test('import: missing, empty and unreadable storage never throw', () => {
  for (const s of [undefined, null, {}, { iterableLinkParamsConfig: '' }, 'str']) {
    assert.deepEqual(mapWorkflowParams(s).values, {});
  }
  const none = mapWorkflowParams({});
  assert.equal(none.notes.length, 1);
  assert.match(none.notes[0], /utm_source=iterable/);
  assert.match(none.notes[0], /utm_id=\{\{now format="yyyyMMdd"\}\}/);
  assert.match(none.notes[0], /aren.t carried over/);
  const bad = mapWorkflowParams({ iterableLinkParamsConfig: '{not json' });
  assert.deepEqual(bad.values, {});
  assert.match(bad.notes[0], /could not be read/);
  assert.deepEqual(mapWorkflowParams({ iterableLinkParamsConfig: '[1,2]' }).values, {});
  const junk = mapWorkflowParams({ iterableLinkParamsConfig: { linkParams: 'x', enableGA: 3 } });
  assert.deepEqual(junk.values, {});
  assert.ok(junk.notes.some((n) => /No recognised settings/.test(n)));
});
