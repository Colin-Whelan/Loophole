import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOrReplaceParam, getParam, normalizeParamTypes, resolveParamTypes, normalizeColor, normalizeTerms,
  splitTerms, isValidParamName, addRecent, normalizeRecents, defaultParamTypes, DEFAULT_PARAM_TYPES, MAX_RECENTS,
  paramUnsupportedReason, buildLibrary, MAX_TERM_LENGTH,
} from '../../src/features/link-params/library.js';
import importer from '../../src/features/link-params/import.js';
import meta from '../../src/features/link-params/meta.js';

// ── URL add/replace ──────────────────────────────────────────────────────

test('adds a param to a bare URL and to one with a query', () => {
  assert.equal(addOrReplaceParam('https://shop.example.com/fall', 'utm_term', 'hero'),
    'https://shop.example.com/fall?utm_term=hero');
  assert.equal(addOrReplaceParam('https://shop.example.com/fall?utm_source=iterable', 'utm_term', 'hero'),
    'https://shop.example.com/fall?utm_source=iterable&utm_term=hero');
  assert.equal(addOrReplaceParam('https://example.com', 'utm_term', 'hero'), 'https://example.com?utm_term=hero');
  assert.equal(addOrReplaceParam('https://example.com/?', 'a', 'b'), 'https://example.com/?a=b');
  assert.equal(addOrReplaceParam('https://example.com/?x=1&', 'a', 'b'), 'https://example.com/?x=1&a=b');
});

test('replaces an existing param in place and drops duplicates', () => {
  assert.equal(addOrReplaceParam('https://e.com/p?utm_term=old&x=1', 'utm_term', 'new'), 'https://e.com/p?utm_term=new&x=1');
  assert.equal(addOrReplaceParam('https://e.com/p?a=1&utm_term=x&b=2&utm_term=y', 'utm_term', 'z'), 'https://e.com/p?a=1&utm_term=z&b=2');
  // A param whose name merely ends with the target is left alone.
  assert.equal(addOrReplaceParam('https://e.com/?xutm_term=1', 'utm_term', 'v'), 'https://e.com/?xutm_term=1&utm_term=v');
  // A valueless param counts as present.
  assert.equal(addOrReplaceParam('https://e.com/?utm_term&a=1', 'utm_term', 'v'), 'https://e.com/?utm_term=v&a=1');
});

test('keeps other params byte for byte (no re-encoding)', () => {
  const url = 'https://e.com/s?q=a+b&list=1,2,3&enc=%20x&utm_term=old';
  assert.equal(addOrReplaceParam(url, 'utm_term', 'new'), 'https://e.com/s?q=a+b&list=1,2,3&enc=%20x&utm_term=new');
});

test('fragments stay at the end', () => {
  assert.equal(addOrReplaceParam('https://e.com/p#top', 'utm_term', 'hero'), 'https://e.com/p?utm_term=hero#top');
  assert.equal(addOrReplaceParam('https://e.com/p?a=1#sec?x=2', 'utm_term', 'hero'), 'https://e.com/p?a=1&utm_term=hero#sec?x=2');
  assert.equal(addOrReplaceParam('https://e.com/p?utm_term=a#f', 'utm_term', 'b'), 'https://e.com/p?utm_term=b#f');
});

test('Handlebars in the URL survive untouched', () => {
  assert.equal(addOrReplaceParam('https://e.com/p?d={{now format="yyyyMMdd"}}', 'utm_term', 'hero'),
    'https://e.com/p?d={{now format="yyyyMMdd"}}&utm_term=hero');
  assert.equal(addOrReplaceParam('{{link}}', 'utm_term', 'hero'), '{{link}}?utm_term=hero');
  assert.equal(addOrReplaceParam('{{link}}?a=1', 'utm_term', 'hero'), '{{link}}?a=1&utm_term=hero');
  assert.equal(addOrReplaceParam('https://e.com/{{#if vip}}vip{{else}}all{{/if}}', 'utm_term', 'x'),
    'https://e.com/{{#if vip}}vip{{else}}all{{/if}}?utm_term=x');
  assert.equal(addOrReplaceParam('https://e.com/p?{{#if a}}k=1&{{/if}}z=2', 'utm_term', 'x'),
    'https://e.com/p?{{#if a}}k=1&{{/if}}z=2&utm_term=x');
  assert.equal(addOrReplaceParam('https://{{domain}}/p?utm_term={{old}}', 'utm_term', 'x'), 'https://{{domain}}/p?utm_term=x');
  assert.equal(addOrReplaceParam('https://e.com/p?x={{{raw}}}', 'utm_term', 'y'), 'https://e.com/p?x={{{raw}}}&utm_term=y');
});

test('Handlebars in the value are written raw; other characters are encoded', () => {
  assert.equal(addOrReplaceParam('https://e.com/p', 'utm_id', '{{now format="yyyyMMdd"}}'),
    'https://e.com/p?utm_id={{now format="yyyyMMdd"}}');
  assert.equal(addOrReplaceParam('https://e.com/p', 'utm_id', 'spring_{{campaignId}}'), 'https://e.com/p?utm_id=spring_{{campaignId}}');
  assert.equal(addOrReplaceParam('https://e.com/p', 'utm_term', 'a b&c#d'), 'https://e.com/p?utm_term=a%20b%26c%23d');
});

test('URLs without a scheme keep having none', () => {
  assert.equal(addOrReplaceParam('shop.example.com/fall', 'utm_term', 'hero'), 'shop.example.com/fall?utm_term=hero');
  assert.equal(addOrReplaceParam('example.com?utm_term=a', 'utm_term', 'b'), 'example.com?utm_term=b');
  assert.equal(addOrReplaceParam('/relative/path', 'utm_term', 'b'), '/relative/path?utm_term=b');
});

test('unparseable input uses the string fallback', () => {
  assert.equal(addOrReplaceParam('http://exa mple.com/p?utm_term=a', 'utm_term', 'b'), 'http://exa mple.com/p?utm_term=b');
  assert.equal(addOrReplaceParam('http://exa mple.com/p#f', 'utm_term', 'b'), 'http://exa mple.com/p?utm_term=b#f');
  assert.equal(addOrReplaceParam('http://exa mple.com/p?x=1', 'utm_term', 'b'), 'http://exa mple.com/p?x=1&utm_term=b');
});

test('mailto:, tel:, sms: and #anchor links get no params', () => {
  assert.equal(paramUnsupportedReason('mailto:a@example.com?subject=Hi'), 'mailto');
  assert.equal(paramUnsupportedReason('  MAILTO:a@example.com'), 'mailto');
  assert.equal(paramUnsupportedReason('tel:+15551234567'), 'tel');
  assert.equal(paramUnsupportedReason('sms:+15551234567?body=hi'), 'sms');
  assert.equal(paramUnsupportedReason('#section-2'), 'anchor');
  assert.equal(paramUnsupportedReason('https://e.com/p#section-2'), null);
  assert.equal(paramUnsupportedReason('https://e.com/mailto:x'), null);
  assert.equal(paramUnsupportedReason('{{unsubscribeUrl}}'), null);
  assert.equal(paramUnsupportedReason(''), null);
  assert.equal(paramUnsupportedReason(undefined), null);
  for (const url of ['mailto:a@example.com?subject=Hi', 'tel:+15551234567', 'sms:+15551234567', '#top']) {
    assert.equal(addOrReplaceParam(url, 'utm_term', 'x'), url);
  }
});

test('terms longer than the cap are dropped on import and refused by the editor', () => {
  const long = 'x'.repeat(MAX_TERM_LENGTH + 1);
  const ok = 'y'.repeat(MAX_TERM_LENGTH);
  assert.deepEqual(normalizeTerms([long, ok, 'a']), [ok, 'a']);
  const r = normalizeParamTypes({ utm_term: { categories: [{ name: 'C', color: '#000000', terms: [long, 'a'] }] } });
  assert.deepEqual(r.paramTypes.utm_term.categories[0].terms, ['a']);
  assert.ok(r.notes.some((n) => /longer than 200/.test(n)));
  const b = buildLibrary([{ key: 'utm_term', label: '', categories: [{ name: 'C', color: '#000000', terms: [long] }] }]);
  assert.ok(b.errors && b.errors.some((e) => /longer than 200/.test(e)));
});

test('other schemes and empty input', () => {
  assert.equal(addOrReplaceParam('ftp://files.example.com/a', 'utm_term', 'x'), 'ftp://files.example.com/a?utm_term=x');
  assert.equal(addOrReplaceParam('', 'utm_term', 'x'), '');
  assert.equal(addOrReplaceParam('  https://e.com/p  ', 'a', 'b'), 'https://e.com/p?a=b');
});

test('getParam reads decoded values and Handlebars', () => {
  assert.equal(getParam('https://e.com/?utm_term=hero&x=1', 'utm_term'), 'hero');
  assert.equal(getParam('https://e.com/?a=b%20c', 'a'), 'b c');
  assert.equal(getParam('https://e.com/?utm_id={{now format="yyyyMMdd"}}#x', 'utm_id'), '{{now format="yyyyMMdd"}}');
  assert.equal(getParam('https://e.com/#?utm_term=x', 'utm_term'), null);
  assert.equal(getParam('https://e.com/', 'utm_term'), null);
  const url = addOrReplaceParam('https://e.com/', 'utm_term', 'a b&c');
  assert.equal(getParam(url, 'utm_term'), 'a b&c');
});

// ── Library normalisation ────────────────────────────────────────────────

test('defaults are generic, valid and survive normalisation unchanged', () => {
  const { paramTypes, notes } = normalizeParamTypes(DEFAULT_PARAM_TYPES);
  assert.deepEqual(paramTypes, defaultParamTypes());
  assert.deepEqual(notes, []);
  assert.deepEqual(Object.keys(paramTypes), ['utm_term', 'utm_content', 'utm_id']);
  assert.deepEqual(paramTypes.utm_term.categories[0].terms, ['hero', 'header', 'footer', 'body_cta']);
  // defaultParamTypes() hands out copies.
  defaultParamTypes().utm_term.categories.length = 0;
  assert.equal(DEFAULT_PARAM_TYPES.utm_term.categories.length, 2);
});

test('normalisation cleans colours, names, terms and drops unknown fields', () => {
  const { paramTypes, notes } = normalizeParamTypes({
    ' utm_term ': {
      label: '  ', extra: 1,
      categories: [
        { name: ' Placement ', color: '#ABC', terms: [' hero ', 'hero', '', 42, null, { x: 1 }], icon: 'x' },
        { color: 'red', terms: 'a, b ,, c' },
        'junk',
        null,
      ],
    },
    'bad name': { categories: [] },
    'x&y': { categories: [] },
    utm_id: null,
    utm_content: [{ name: 'Array form', color: '112233', terms: ['v'] }],
  });
  assert.deepEqual(paramTypes, {
    utm_term: {
      label: 'utm_term',
      categories: [
        { name: 'Placement', color: '#aabbcc', terms: ['hero', '42'] },
        { name: 'Untitled', color: '#8b9a98', terms: ['a', 'b', 'c'] },
      ],
    },
    utm_content: { label: 'utm_content', categories: [{ name: 'Array form', color: '#112233', terms: ['v'] }] },
  });
  assert.equal(notes.length, 3);
});

test('normalisation accepts JSON strings, double-encoded strings and { paramTypes } wrappers', () => {
  const lib = { utm_term: { label: 'Term', categories: [{ name: 'A', color: '#000000', terms: ['x'] }] } };
  const want = { utm_term: { label: 'Term', categories: [{ name: 'A', color: '#000000', terms: ['x'] }] } };
  assert.deepEqual(normalizeParamTypes(JSON.stringify(lib)).paramTypes, want);
  assert.deepEqual(normalizeParamTypes(JSON.stringify(JSON.stringify(lib))).paramTypes, want);
  assert.deepEqual(normalizeParamTypes({ paramTypes: lib }).paramTypes, want);
  assert.deepEqual(normalizeParamTypes({ paramTypes: JSON.stringify(lib) }).paramTypes, want);
  // A parameter literally called "paramTypes" is not mistaken for a wrapper.
  assert.deepEqual(Object.keys(normalizeParamTypes({ paramTypes: { categories: [] } }).paramTypes), ['paramTypes']);
});

test('normalisation never throws and reports nothing usable as null', () => {
  for (const bad of [undefined, null, '', '   ', 'not json', '[1,2]', 42, true, [], {}, { 'a b': {} }, '{"x":']) {
    const r = normalizeParamTypes(bad);
    assert.equal(r.paramTypes, null, String(bad));
    assert.ok(r.notes.length >= 1);
  }
});

test('resolveParamTypes falls back to defaults for unset, null or invalid values', () => {
  assert.deepEqual(resolveParamTypes({}), defaultParamTypes());
  assert.deepEqual(resolveParamTypes(undefined), defaultParamTypes());
  assert.deepEqual(resolveParamTypes({ paramTypes: null }), defaultParamTypes());
  assert.deepEqual(resolveParamTypes({ paramTypes: 'garbage' }), defaultParamTypes());
  const mine = { utm_x: { label: 'utm_x', categories: [] } };
  assert.deepEqual(resolveParamTypes({ paramTypes: mine }), mine);
});

test('small helpers', () => {
  assert.equal(normalizeColor('#FFF'), '#ffffff');
  assert.equal(normalizeColor('0d8a7e'), '#0d8a7e');
  assert.equal(normalizeColor('rgb(1,2,3)'), '#8b9a98');
  assert.equal(normalizeColor('#12345'), '#8b9a98');
  assert.equal(normalizeColor(undefined, '#000000'), '#000000');
  assert.deepEqual(normalizeTerms('a, b, a'), ['a', 'b']);
  assert.deepEqual(splitTerms('hero, {{#if a}}x,y{{/if}} , footer,'), ['hero', '{{#if a}}x,y{{/if}}', 'footer']);
  assert.deepEqual(splitTerms('{{default x "a,b"}}, c'), ['{{default x "a,b"}}', 'c']);
  assert.equal(isValidParamName('utm_term'), true);
  assert.equal(isValidParamName('utm term'), false);
  assert.equal(isValidParamName(''), false);
  assert.equal(isValidParamName('a=b'), false);
});

test('recents: most recent first, de-duplicated, capped', () => {
  let list = [];
  for (let i = 0; i < 15; i++) list = addRecent(list, `t${i}`);
  assert.equal(list.length, MAX_RECENTS);
  assert.equal(list[0], 't14');
  list = addRecent(list, 't10');
  assert.equal(list[0], 't10');
  assert.equal(list.filter((t) => t === 't10').length, 1);
  assert.deepEqual(addRecent(undefined, 'x'), ['x']);
  assert.deepEqual(normalizeRecents({ utm_term: ['a', 'a', 3, ''], bad: 'x', empty: [] }), { utm_term: ['a', '3'] });
  assert.deepEqual(normalizeRecents(null), {});
  assert.deepEqual(normalizeRecents(['x']), {});
});

// ── Import mapping ───────────────────────────────────────────────────────

test('meta and importer agree on the legacy script name', () => {
  assert.equal(meta.id, 'link-params');
  assert.equal(meta.frame, 'bee');
  assert.deepEqual(importer.scripts, meta.legacy);
});

test('import maps a decoded JSON-string paramTypes value', () => {
  const stored = JSON.stringify({
    utm_term: {
      label: 'utm_term',
      categories: [
        { name: 'General', color: '#2d6a4f', terms: ['promo', 'contest'] },
        { name: 'Placement', color: '#1d3557', terms: ['hero', 'footer'] },
      ],
    },
    utm_id: { label: 'utm_id', categories: [{ name: 'Campaigns', color: '#9d4edd', terms: ['spring_sale'] }] },
  });
  const r = importer.map({ paramTypes: stored });
  assert.deepEqual(Object.keys(r.values.paramTypes), ['utm_term', 'utm_id']);
  assert.deepEqual(r.values.paramTypes.utm_term.categories[1], { name: 'Placement', color: '#1d3557', terms: ['hero', 'footer'] });
  assert.match(r.notes[0], /2 parameters.*3 categories, 5 terms/);
  assert.equal(r.keys, undefined);
});

test('import accepts an already-parsed object and tolerates junk', () => {
  const r = importer.map({
    paramTypes: { utm_term: { categories: [{ name: 'A', color: 'nope', terms: ['x'], weird: true }] }, 'bad key': {} },
    somethingElse: 'ignored',
  });
  assert.deepEqual(r.values, { paramTypes: { utm_term: { label: 'utm_term', categories: [{ name: 'A', color: '#8b9a98', terms: ['x'] }] } } });
  assert.ok(r.notes.some((n) => n.includes('bad key')));
});

test('import with nothing stored or unusable data returns no values', () => {
  for (const storage of [{}, null, undefined, { paramTypes: '' }, { paramTypes: 'garbage' }, { paramTypes: '{}' }]) {
    const r = importer.map(storage);
    assert.deepEqual(r.values, {});
    assert.ok(r.notes.length >= 1);
  }
});
