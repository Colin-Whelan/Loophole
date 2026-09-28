import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_IDS, CATEGORIES, visibleText, byteLength } from '../../src/features/email-scanner/rules.js';
import {
  scanHtml, summarize, groupIssues, ruleSettings, enabledKey, isRuleOn, severityChip, formatAgo,
} from '../../src/features/email-scanner/scan.js';
import importer, { mapEmailScanner } from '../../src/features/email-scanner/import.js';
import meta from '../../src/features/email-scanner/meta.js';
import { decodeStorage } from '../../src/options/importer/decode.js';
import { mergeValues, isValidValue } from '../../src/core/settings.js';
import { groupSections } from '../../src/core/schema.js';
import fs from 'node:fs';

const rule = (id) => RULES.find((r) => r.id === id);
const run = (id, html) => rule(id).run(html);

// A clean, well-formed email that passes every rule.
const WORDS = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
const CLEAN = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hi</title></head><body>
<div class="preheader" style="display:none">Our autumn range is here</div>
<table><tr><td style="padding-top:10px; color:#333333">
<img src="https://cdn.example.com/hero.jpg" alt="Hero" width="600" height="300">
<p>Hello {{firstName}}, ${WORDS}</p>
<a href="https://example.com/shop">Shop the autumn range</a>
{% if vip %}VIP{% endif %}
<a href="{{unsubscribeUrl}}">Unsubscribe</a>
</td></tr></table></body></html>`;

// ── Rule set shape ───────────────────────────────────────────────────────────

test('every rule has the documented shape and a unique id', () => {
  assert.equal(RULES.length, 20); // the script's 19 + checkMissingPreheader
  assert.equal(new Set(RULE_IDS).size, RULES.length);
  for (const r of RULES) {
    assert.match(r.id, /^check[A-Z]\w+$/);
    assert.ok(CATEGORIES.includes(r.category), r.id);
    assert.ok(r.label && r.description, r.id);
    assert.ok(!/&[a-z]+;/.test(r.description), `${r.id}: plain-text description`);
    assert.ok(['error', 'warning', 'info'].includes(r.severity), r.id);
    assert.equal(typeof r.defaultOn, 'boolean');
    assert.equal(typeof r.run, 'function');
  }
});

test('the clean email passes every rule, including the default-off ones', () => {
  for (const r of RULES) assert.deepEqual(r.run(CLEAN), [], r.id);
  const all = Object.fromEntries(RULE_IDS.map((id) => [id, true]));
  const res = scanHtml(CLEAN, all);
  assert.equal(res.total, 20);
  assert.equal(res.passed, 20);
});

test('every rule copes with empty and junk input', () => {
  for (const r of RULES) {
    for (const input of ['', '<', '{{', '%%%', '<img src="%E0%A4%A">']) {
      assert.ok(Array.isArray(r.run(input)), `${r.id} on ${JSON.stringify(input)}`);
    }
  }
});

// ── Structure / HTML ─────────────────────────────────────────────────────────

test('checkAltTextQuotes', () => {
  const bad = '<img src="https://x/a/b%20c.png" alt="Say " hi"="" width="1">';
  const [i] = run('checkAltTextQuotes', `<img src="x/first.png" alt="ok">${bad}`);
  assert.equal(i.severity, 'error');
  assert.match(i.message, /Image #2 \(b c\.png\)/);
  assert.match(i.snippet, /^alt="Say "/);
  assert.deepEqual(run('checkAltTextQuotes', '<img src="x" alt="Say &quot;hi&quot;">'), []);
});

test('checkMissingAltText', () => {
  const issues = run('checkMissingAltText', '<img src="a/one.png"><img src="a/two.png" alt=""><IMG SRC="x">');
  assert.equal(issues.length, 2);
  assert.match(issues[0].message, /Image #1 \(one\.png\)/);
  assert.equal(issues[0].snippet, '<img src="a/one.png">');
  assert.match(issues[1].message, /Image #3 \(Unknown\)/);
  assert.deepEqual(run('checkMissingAltText', '<img src="a" alt="x"><img alt = "">'), []);
  // A malformed %-escape in the file name no longer breaks the rule.
  assert.match(run('checkMissingAltText', '<img src="a/100%.png">')[0].message, /100%\.png/);
});

test('checkEmptyLinks', () => {
  const issues = run('checkEmptyLinks', '<a name="top">x</a><a href="">y</a><a href=" # ">z</a><a href="https://e.com">ok</a>');
  assert.deepEqual(issues.map((i) => i.message), [
    'Link has no href attribute', 'Link has a placeholder href=""', 'Link has a placeholder href=" # "',
  ]);
  assert.ok(issues.every((i) => i.snippet.startsWith('<a ')));
  // Single-quoted hrefs are read (the script reported them as missing).
  assert.deepEqual(run('checkEmptyLinks', "<a href='https://e.com'>ok</a>"), []);
  assert.equal(run('checkEmptyLinks', "<a href='#'>x</a>").length, 1);
});

test('checkDeprecatedTags', () => {
  const issues = run('checkDeprecatedTags', '<marquee>a</marquee><MARQUEE>b</MARQUEE><blink>c</blink>');
  assert.deepEqual(issues.map((i) => i.message), [
    'Found 2 <marquee> tags: deprecated and may not render',
    'Found 1 <blink> tag: deprecated and may not render',
  ]);
  assert.deepEqual(run('checkDeprecatedTags', '<font>a</font><center>b</center><blinker>'), []);
});

test('checkOutlookCSSIssues', () => {
  const msgs = (html) => run('checkOutlookCSSIssues', html).map((i) => i.message);
  assert.deepEqual(msgs('<td style="padding: 10px 20px 10px 20px">'), ['Found 1 instance(s) of padding shorthand (4-value)']);
  assert.deepEqual(msgs('<td style="margin:0 auto 0 0; x">'), []); // "auto" is not a length
  assert.deepEqual(msgs('<td style="margin:0 0 0 0">'), ['Found 1 instance(s) of margin shorthand (4-value)']);
  // FIX: 2-value shorthands and long numbers were reported by the script's digit-counting regex.
  assert.deepEqual(msgs('<td style="padding:10px 20px">'), []);
  assert.deepEqual(msgs('<td style="padding:1000px">'), []);
  assert.deepEqual(msgs('<div style="background: #fff url(a.png)">'), ['Found 1 instance(s) of CSS background images']);
  assert.deepEqual(msgs('<div style="display:flex">'), ['Found 1 instance(s) of flexbox']);
  assert.deepEqual(msgs('<div style="display:grid">'), ['Found 1 instance(s) of CSS grid']);
  assert.deepEqual(msgs('<a style="border-radius:4px">'), ['Found 1 instance(s) of border-radius']);
  assert.deepEqual(msgs('<table style="max-width:600px"><td style="max-width:1px">'), ['Found 2 instance(s) of max-width']);
  assert.deepEqual(msgs('<td style="padding-top:10px; width:600px">'), []);
});

// ── Accessibility ────────────────────────────────────────────────────────────

test('checkMissingLangAttribute', () => {
  assert.equal(run('checkMissingLangAttribute', '<html><body>').length, 1);
  assert.deepEqual(run('checkMissingLangAttribute', '<html lang="fr">'), []);
  assert.deepEqual(run('checkMissingLangAttribute', '<body>no html tag</body>'), []);
});

test('checkLinkAccessibility', () => {
  const issues = run('checkLinkAccessibility', '<a href="x"><b>Click here</b></a><a href="y">Read more</a><a href="z">Read our fall guide</a>');
  assert.deepEqual(issues.map((i) => i.message), ['Link with generic text: "Click here"', 'Link with generic text: "Read more"']);
});

test('checkColorContrast', () => {
  assert.match(run('checkColorContrast', '<p style="color:#fff">a</p><p style="color: #EEEEEE">b</p>')[0].message, /Found 2/);
  assert.deepEqual(run('checkColorContrast', '<p style="color:#333">a</p>'), []);
  // FIX: background-color / border-color are not text colours.
  assert.deepEqual(run('checkColorContrast', '<td style="background-color:#ffffff; border-color:#eee">'), []);
});

// ── Deliverability ───────────────────────────────────────────────────────────

test('checkImageToTextRatio', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  assert.equal(run('checkImageToTextRatio', `<img src="a"><p>${words(10)}</p>`)[0].severity, 'warning');
  assert.equal(run('checkImageToTextRatio', `<img src="a"><p>${words(100)}</p>`)[0].severity, 'info');
  assert.deepEqual(run('checkImageToTextRatio', `<img src="a"><p>${words(150)}</p>`), []);
  assert.deepEqual(run('checkImageToTextRatio', '<p>short, no images</p>'), []);
  // style/script/comments don't count as text
  const hidden = `<img src="a"><style>${words(200)}</style><!-- ${words(200)} -->`;
  assert.match(run('checkImageToTextRatio', hidden)[0].message, /only ~0 words/);
});

test('checkMissingUnsubscribe', () => {
  assert.equal(run('checkMissingUnsubscribe', '<p>Hello</p>').length, 1);
  for (const ok of ['<a href="x">Unsubscribe</a>', 'opt-out here', 'Manage preferences', '<a href="{{ unsubscribeUrl }}">x</a>']) {
    assert.deepEqual(run('checkMissingUnsubscribe', ok), [], ok);
  }
});

test('checkExcessiveFormatting', () => {
  const [bang] = run('checkExcessiveFormatting', '<p>Wow!! Really!!!</p>');
  assert.match(bang.message, /2 instance/);
  const [caps] = run('checkExcessiveFormatting', '<p>BIG HUGE SALE TODAY ONLY NOW</p>');
  assert.match(caps.message, /6 ALL CAPS words: BIG, HUGE, SALE, TODAY, ONLY…/);
  assert.deepEqual(run('checkExcessiveFormatting', '<p>Read the FAQ, HTML, CSS, API and PDF guides!</p>'), []);
  assert.deepEqual(run('checkExcessiveFormatting', '<style>.A{}</style><p class="BIG HUGE SALE NOW">x</p>'), []);
});

test('checkSpammyWords', () => {
  const [i] = run('checkSpammyWords', '<p>Act NOW, this is urgent. 100% free!</p>');
  assert.match(i.message, /3 potential spam trigger phrase\(s\): act now, 100% free, urgent/);
  assert.deepEqual(run('checkSpammyWords', '<p>Winners of last year</p>'), []); // \bwinner\b
});

test('checkMissingPreheader', () => {
  assert.equal(run('checkMissingPreheader', '<html><body><table><tr><td>Hi</td></tr></table></body></html>').length, 1);
  assert.deepEqual(run('checkMissingPreheader', '<body><span class="preheader"></span>'), []);
  assert.deepEqual(run('checkMissingPreheader', '<body><div id="previewText">x</div>'), []);
  assert.deepEqual(run('checkMissingPreheader',
    '<body><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Big news inside</div><p>Hi</p>'), []);
  assert.deepEqual(run('checkMissingPreheader', '<body><span style="opacity:0; font-size:0">Preview</span>'), []);
  // A hidden element without text isn't a preheader; opacity:0.5 isn't hidden.
  assert.equal(run('checkMissingPreheader', '<body><div style="display:none"> &nbsp; </div>').length, 1);
  assert.equal(run('checkMissingPreheader', '<body><div style="opacity:0.5">Faded</div>').length, 1);
});

// ── Best Practices ───────────────────────────────────────────────────────────

test('checkMissingImageDimensions', () => {
  const html = '<img src="a" width="1" height="1"><img src="b" style="width:10px;height:5px"><img src="c" width="3"><img src="d">';
  assert.match(run('checkMissingImageDimensions', html)[0].message, /^2 image\(s\)/);
  assert.deepEqual(run('checkMissingImageDimensions', '<img src="a" width="1" height="1">'), []);
});

test('checkMissingDoctype', () => {
  assert.equal(run('checkMissingDoctype', '<html></html>').length, 1);
  assert.deepEqual(run('checkMissingDoctype', '\n  <!doctype html><html>'), []);
});

test('checkMissingViewportMeta', () => {
  assert.equal(run('checkMissingViewportMeta', '<head></head>').length, 1);
  assert.deepEqual(run('checkMissingViewportMeta', "<meta content='x' name='viewport'>"), []);
});

test('checkBrokenHandlebars', () => {
  assert.deepEqual(run('checkBrokenHandlebars', 'Hi {{firstName}} {{{raw}}} {{#if a}}x{{/if}} {% if b %}y{% endif %}'), []);
  const issues = run('checkBrokenHandlebars', 'Hi {{firstName}}, here is the latest on your account: {{points balance is ready {{ok}}. {% if x %} and {% endif');
  assert.deepEqual(issues.map((i) => i.message), ['Unclosed Handlebars {{ tag', 'Unclosed Jinja {% tag']);
  // FIX: the snippet points at the unclosed tag, not the first opener.
  assert.match(issues[0].snippet, /\{\{points balance/);
  assert.ok(!issues[0].snippet.includes('{{firstName'));
  assert.match(issues[1].snippet, /\{% endif$/);
  assert.equal(run('checkBrokenHandlebars', 'end {{oops').length, 1);
  assert.equal(run('checkBrokenHandlebars', 'text\n{{ a\nb').at(0).snippet, 'text {{ a b');
});

test('checkMissingCharset', () => {
  assert.equal(run('checkMissingCharset', '<head></head>').length, 1);
  assert.deepEqual(run('checkMissingCharset', '<meta charset="utf-8">'), []);
  assert.deepEqual(run('checkMissingCharset', '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">'), []);
});

test('checkLargeHtmlSize', () => {
  assert.deepEqual(run('checkLargeHtmlSize', 'x'.repeat(80 * 1024)), []);
  assert.equal(run('checkLargeHtmlSize', 'x'.repeat(81 * 1024))[0].severity, 'info');
  const [big] = run('checkLargeHtmlSize', 'x'.repeat(103 * 1024));
  assert.equal(big.severity, 'warning');
  assert.match(big.message, /~103 KB/);
  // bytes, not characters
  assert.equal(byteLength('é'), 2);
  assert.equal(run('checkLargeHtmlSize', 'é'.repeat(52 * 1024))[0].severity, 'warning');
});

test('checkTrackingPixels', () => {
  const px = '<img src="p" width="1" height="1">';
  assert.deepEqual(run('checkTrackingPixels', px + px), []);
  assert.match(run('checkTrackingPixels', px + px + '<img src="q" style="display:none">')[0].message, /Found 3/);
  assert.deepEqual(run('checkTrackingPixels', '<img width="100" height="100"><img width="10" height="1"><img width="1" height="12">'), []);
});

test('visibleText strips markup, styles and entities', () => {
  assert.equal(visibleText('<style>p{}</style><p>Hi&nbsp;<b>there</b></p><!-- x --><script>1</script>'), 'Hi there');
});

// ── Engine and banner text ───────────────────────────────────────────────────

const DEFAULTS = Object.fromEntries(RULES.map((r) => [r.id, r.defaultOn]));

test('scanHtml runs only enabled rules and counts severities', () => {
  const html = '<html><body><img src="a/x.png"><a href="#">x</a>{{oops</body></html>';
  const res = scanHtml(html, DEFAULTS);
  assert.equal(res.total, RULES.filter((r) => r.defaultOn).length);
  assert.ok(res.issues.every((i) => rule(i.ruleId).defaultOn));
  assert.equal(res.counts.error, 1);
  assert.ok(res.counts.warning >= 3);
  assert.equal(res.passed, res.results.filter((r) => !r.issues.length).length);
  const only = scanHtml(html, { ...Object.fromEntries(RULE_IDS.map((id) => [id, false])), checkBrokenHandlebars: true });
  assert.equal(only.total, 1);
  assert.deepEqual(only.issues.map((i) => i.ruleId), ['checkBrokenHandlebars']);
  assert.equal(only.issues[0].category, 'Best Practices');
});

test('scanHtml: a throwing rule is counted as failed, not fatal', () => {
  const rules = [
    { id: 'a', category: 'X', label: 'A', severity: 'info', defaultOn: true, run: () => { throw new Error('boom'); } },
    { id: 'b', category: 'X', label: 'B', severity: 'warning', defaultOn: true, run: () => [{ message: 'm', snippet: '', extra: 1 }] },
    { id: 'c', category: 'X', label: 'C', severity: 'info', defaultOn: true, run: () => null },
  ];
  const res = scanHtml('x', {}, rules);
  assert.deepEqual(res.errors, ['a']);
  assert.equal(res.total, 3);
  assert.equal(res.passed, 1);
  assert.deepEqual(res.issues, [{ ruleId: 'b', category: 'X', severity: 'warning', message: 'm' }]);
});

test('summarize: tones, titles and the passed line', () => {
  const clean = summarize(scanHtml(CLEAN, DEFAULTS));
  assert.equal(clean.tone, 'ok');
  assert.equal(clean.title, 'HTML check: no issues');
  const n = RULES.filter((r) => r.defaultOn).length;
  assert.equal(clean.detail, `${n} of ${n} rules passed`);

  const warn = summarize(scanHtml(CLEAN.replace('lang="en"', ''), DEFAULTS));
  assert.deepEqual([warn.tone, warn.title, warn.detail], ['warn', 'HTML check: 1 issue', `${n - 1} of ${n} rules passed`]);

  const bad = summarize(scanHtml(CLEAN.replace('{{firstName}}', '{{firstName').replace('lang="en"', ''), DEFAULTS));
  assert.deepEqual([bad.tone, bad.title], ['bad', 'HTML check: 2 issues']);

  const off = summarize(scanHtml(CLEAN, Object.fromEntries(RULE_IDS.map((id) => [id, false]))));
  assert.equal(off.tone, 'off');
});

test('groupIssues: category order, most severe first, empty groups dropped', () => {
  const issues = [
    { ruleId: 'x', category: 'Best Practices', severity: 'info', message: '1' },
    { ruleId: 'y', category: 'Structure / HTML', severity: 'warning', message: '2' },
    { ruleId: 'z', category: 'Best Practices', severity: 'error', message: '3' },
    { ruleId: 'w', category: 'Best Practices', severity: 'info', message: '4' },
  ];
  const g = groupIssues(issues);
  assert.deepEqual(g.map((x) => x.category), ['Structure / HTML', 'Best Practices']);
  assert.deepEqual(g[1].issues.map((i) => i.message), ['3', '1', '4']);
});

test('severityChip, formatAgo, enabledKey, isRuleOn', () => {
  assert.deepEqual(severityChip('error'), { label: 'Error', tone: 'bad' });
  assert.deepEqual(severityChip('warning'), { label: 'Warn', tone: 'warn' });
  assert.equal(severityChip('info').label, 'Info');
  assert.equal(formatAgo(4200), '4s ago');
  assert.equal(formatAgo(-5), '0s ago');
  assert.equal(formatAgo(125000), '2m ago');
  assert.equal(formatAgo(2 * 3600e3), '2h ago');
  assert.notEqual(enabledKey(DEFAULTS), enabledKey({ ...DEFAULTS, checkSpammyWords: true }));
  assert.equal(isRuleOn({ checkSpammyWords: 'yes' }, rule('checkSpammyWords')), false);
  assert.equal(isRuleOn({}, rule('checkMissingDoctype')), true);
});

// ── meta.settings ────────────────────────────────────────────────────────────

test('meta: one boolean per rule, sectioned by category, defaults from defaultOn', () => {
  assert.equal(meta.id, 'email-scanner');
  assert.deepEqual(meta.settings, ruleSettings());
  assert.deepEqual(meta.settings.map((f) => f.key), RULE_IDS);
  for (const f of meta.settings) {
    assert.equal(f.type, 'boolean');
    assert.equal(f.default, rule(f.key).defaultOn);
    assert.equal(f.section, rule(f.key).category);
    assert.ok(isValidValue(f, f.default));
  }
  const sections = groupSections(meta.settings);
  assert.deepEqual(sections.map((s) => s.title), CATEGORIES);
  assert.equal(rule('checkMissingPreheader').category, 'Deliverability');
  assert.ok(meta.routes.some((re) => re.test('/campaigns/123?view=summary')));
  assert.deepEqual(meta.actions.map((a) => a.id), ['rescan']);
});

// ── import.js ────────────────────────────────────────────────────────────────

test('import: rule booleans from the JSON string, unknown ids skipped', () => {
  const json = JSON.stringify({ checkSpammyWords: true, checkMissingDoctype: false, notARule: true, checkLargeHtmlSize: 'nope' });
  const r = mapEmailScanner({ emailScannerSettings: json });
  assert.deepEqual(r.values, { checkSpammyWords: true, checkMissingDoctype: false });
  assert.match(r.notes.join(' '), /2 rule settings \(1 switched off\)/);
  assert.match(r.notes.join(' '), /Skipped 2/);
  const merged = mergeValues(meta, r.values);
  assert.equal(merged.checkSpammyWords, true);
  assert.equal(merged.checkMissingDoctype, false);
  assert.equal(merged.checkMissingAltText, true);
});

test('import: parsed objects, "true"/"false" strings, old aliases', () => {
  const r = mapEmailScanner({ emailScannerSettings: { checkMissingAlt: false, checkUnsubscribe: 'false', checkTrackingPixels: 'true' } });
  assert.deepEqual(r.values, { checkMissingAltText: false, checkMissingUnsubscribe: false, checkTrackingPixels: true });
  // the current id wins over an alias
  const both = mapEmailScanner({ emailScannerSettings: { checkMissingAlt: false, checkMissingAltText: true } });
  assert.deepEqual(both.values, { checkMissingAltText: true });
});

test('import: missing, empty, junk and hostile input never throw', () => {
  for (const storage of [undefined, null, 'x', {}, { emailScannerSettings: '' }, { emailScannerSettings: '{bad json' },
    { emailScannerSettings: '[1,2]' }, { emailScannerSettings: 42 }, { emailScannerSettings: '{"__proto__":{"x":1},"constructor":true}' }]) {
    const r = mapEmailScanner(storage);
    assert.deepEqual(r.values, {}, JSON.stringify(storage));
    assert.ok(r.notes.length);
  }
  assert.equal(Object.prototype.x, undefined);
});

test('import: the Tampermonkey fixture', () => {
  assert.deepEqual(importer.scripts, meta.legacy);
  const url = new URL('../fixtures/tm/Iterable Email HTML Scanner.storage.json', import.meta.url);
  const { data } = JSON.parse(fs.readFileSync(url, 'utf8'));
  const r = importer.map(decodeStorage(data));
  assert.deepEqual(r.values, {
    checkAltTextQuotes: true, checkMissingAltText: false, checkMissingPreheader: true,
    checkBrokenHandlebars: false, checkMissingUnsubscribe: true,
  });
});
