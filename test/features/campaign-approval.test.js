import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignIdFromPath, templateIdFromHref, parseFrom, pickField, parseSchedule, scheduleRelative,
  normalizeDetails, htmlCheck, aggregateChecks, cardRows, summaryText, wrapText, layoutCard,
  emailCsp, doctypeString, compactCss, COMPACT_STYLE_ID, formatBytes, chipColors, CARD_COLORS,
  compactRelative, scheduleText, timeColor,
} from '../../src/features/campaign-checks/approval-logic.js';
import { checkSeedLists, checkSuppression } from '../../src/features/campaign-checks/logic.js';
import { checkCaptureRequest, isPngDataUrl, captureErrorCode, senderAllowed } from '../../src/core/api-validation.js';
import { createRouter } from '../../src/core/router.js';
import { MSG, CAPTURE_COMMAND } from '../../src/core/messages.js';
import manifest from '../../src/manifest.base.json' with { type: 'json' };

// ── Field extraction ─────────────────────────────────────────────────────────

const f = (text, links = []) => ({ text, rawText: text, links });

const RAW = {
  pathname: '/campaigns/4412871',
  header: '  Fall Launch · Email 1 (EN) ',
  fields: {
    subject: f('Your fall reading list is here'),
    preheaderText: f('Plus free shipping'),
    fromName: f('Northwind Books'),
    fromEmail: f('news@northwind.example'),
    replyToEmail: f('help@northwind.example'),
    sendLists: f('Fall Launch · Engaged 90d, Seed · Marketing QA', ['Fall Launch · Engaged 90d', 'Seed · Marketing QA']),
    suppressionLists: f('Global Unsubscribes', ['Global Unsubscribes']),
    scheduleStartTime: f('Not launched'),
    messageType: f('Marketing, Promotional'),
    sendRateLimit: f('4,000 per minute'),
  },
  labeled: [{ label: 'Template', text: 'Fall Launch Hero v3', links: [] }, { label: 'Last edited', text: 'Sep 22, 2026', links: [] }],
  templateHrefs: ['/templates/editor?templateId=998877&locale=en'],
  email: { chars: 42_000, fingerprint: '1a2b3c4d' },
};

test('campaign id and template id from URLs', () => {
  assert.equal(campaignIdFromPath('/campaigns/4412871'), '4412871');
  assert.equal(campaignIdFromPath('/campaigns/4412871?view=Summary'), '4412871');
  assert.equal(campaignIdFromPath('/campaigns/4412871/edit'), '4412871');
  assert.equal(campaignIdFromPath('/campaigns/templates'), null);
  assert.equal(campaignIdFromPath(undefined), null);
  assert.equal(templateIdFromHref('/templates/editor?templateId=12&x=1'), '12');
  assert.equal(templateIdFromHref('https://app.iterable.com/templates/34'), '34');
  assert.equal(templateIdFromHref('/templates/editor/56?locale=en'), '56');
  assert.equal(templateIdFromHref('/lists/7'), null);
});

test('parseFrom splits name and address', () => {
  assert.deepEqual(parseFrom('Northwind Books <news@northwind.example>'), { name: 'Northwind Books', email: 'news@northwind.example' });
  assert.deepEqual(parseFrom('"Quoted" <a@b.co>'), { name: 'Quoted', email: 'a@b.co' });
  assert.deepEqual(parseFrom(' a@b.co '), { name: null, email: 'a@b.co' });
  assert.deepEqual(parseFrom('Just a name'), { name: 'Just a name', email: null });
  assert.deepEqual(parseFrom(''), { name: null, email: null });
});

test('pickField: candidate data-test names first, then labelled rows', () => {
  assert.equal(pickField(RAW, 'preheader').source, 'form-readonly-field-preheaderText');
  assert.equal(pickField({ fields: { preheader: f('A') } }, 'preheader').text, 'A');
  const byLabel = pickField({ fields: {}, labeled: [{ label: 'Preheader text', text: ' B  c ', links: [] }] }, 'preheader');
  assert.deepEqual([byLabel.text, byLabel.source], ['B c', 'label:Preheader text']);
  assert.equal(pickField({ fields: { subject: f('   ') } }, 'subject'), null); // empty → not found
  assert.equal(pickField({}, 'nope'), null);
});

test('normalizeDetails: every field, lists, template id from the Content step link', () => {
  const d = normalizeDetails(RAW);
  assert.equal(d.campaignName, 'Fall Launch · Email 1 (EN)');
  assert.equal(d.campaignId, '4412871');
  assert.equal(d.status, 'Not launched'); // derived from the schedule field
  assert.equal(d.subject, 'Your fall reading list is here');
  assert.equal(d.preheader, 'Plus free shipping');
  assert.deepEqual([d.fromName, d.fromEmail, d.replyTo], ['Northwind Books', 'news@northwind.example', 'help@northwind.example']);
  assert.deepEqual(d.sendLists, ['Fall Launch · Engaged 90d', 'Seed · Marketing QA']);
  assert.deepEqual(d.suppressionLists, ['Global Unsubscribes']);
  assert.equal(d.schedule.notLaunched, true);
  assert.deepEqual([d.templateName, d.templateId, d.templateEdited], ['Fall Launch Hero v3', '998877', 'Sep 22, 2026']);
  assert.deepEqual([d.messageType, d.sendRate], ['Marketing, Promotional', '4,000 per minute']);
  assert.deepEqual(d.email, { chars: 42000, fingerprint: '1a2b3c4d' });
});

test('normalizeDetails: missing fields are null; a combined "From" is split; text lists; status badge wins', () => {
  const d = normalizeDetails({
    pathname: '/campaigns/5', header: '', statusText: 'Scheduled',
    fields: { from: f('Acme <hi@acme.test>'), suppressionLists: f('None'), sendLists: f('A, B') },
  });
  assert.equal(d.campaignName, null);
  assert.equal(d.status, 'Scheduled');
  assert.deepEqual([d.fromName, d.fromEmail], ['Acme', 'hi@acme.test']);
  assert.deepEqual(d.sendLists, ['A', 'B']);
  assert.deepEqual(d.suppressionLists, []);
  for (const k of ['subject', 'preheader', 'replyTo', 'schedule', 'templateName', 'templateId', 'messageType', 'sendRate', 'email']) assert.equal(d[k], null, k);
  // a fromEmail field that holds "Name <addr>"
  const e = normalizeDetails({ fields: { fromEmail: f('Shop <s@x.io>') } });
  assert.deepEqual([e.fromName, e.fromEmail], ['Shop', 's@x.io']);
  assert.deepEqual(normalizeDetails().sendLists, []);
});

test('parseSchedule / scheduleRelative', () => {
  const now = new Date(2026, 8, 25, 10, 0);
  const a = parseSchedule('Tue Sep 29, 2026 10:00 AM EDT');
  assert.equal(a.notLaunched, false);
  assert.equal(a.date.getDate(), 29);
  assert.equal(a.date.getHours(), 10);
  assert.equal(scheduleRelative(a.date, now).text, 'in 4 d');
  assert.deepEqual([a.planned, a.time, a.period], ['Tue Sep 29, 2026 10:00 AM EDT', '10:00 AM', 'AM']);
  const b = parseSchedule('Not launched · scheduled for Sep 25, 2026 at 3:30 PM');
  assert.equal(b.notLaunched, true);
  assert.equal(b.date.getHours(), 15);
  assert.equal(scheduleRelative(b.date, now).tone, 'warn');
  assert.equal(parseSchedule('09/30/2026 08:15 AM').date.getMonth(), 8);
  assert.ok(parseSchedule('2026-09-27T12:00:00Z').date instanceof Date);
  assert.equal(parseSchedule('Not launched').date, null);
  assert.equal(parseSchedule('whenever').date, null);
  assert.equal(scheduleRelative(new Date(2026, 8, 22, 10, 0), now).text, '3 d ago');
  assert.equal(scheduleRelative(new Date(2026, 8, 25, 7, 0), now).text, '3 h ago');
  assert.equal(scheduleRelative(null, now), null);
  assert.equal(b.period, 'PM');
  assert.equal(b.planned, 'Sep 25, 2026 at 3:30 PM');
});

test('parseSchedule: planned times without a year, zones, compact relative times', () => {
  const now = new Date(2026, 9, 2, 7, 0); // Fri Oct 2, 2026 07:00
  const p = parseSchedule('Tue Oct 6, 10:00 AM EDT', now);
  assert.equal(p.planned, 'Tue Oct 6, 10:00 AM EDT');
  assert.deepEqual([p.date.getFullYear(), p.date.getMonth(), p.date.getDate(), p.date.getHours()], [2026, 9, 6, 10]);
  assert.equal(scheduleRelative(p.date, now).text, 'in 4 d 3 h');
  const pm = parseSchedule('Oct 2, 9:45 PM', now);
  assert.deepEqual([pm.time, pm.period, pm.date.getHours(), pm.date.getMinutes()], ['9:45 PM', 'PM', 21, 45]);
  assert.equal(compactRelative(pm.date, now), 'in 14 h 45 min');
  // Already long past this year → next year.
  const jan = parseSchedule('Jan 5, 8:00 AM', now);
  assert.equal(jan.date.getFullYear(), 2027);
  // The zone must be upper case: "and" is not a zone.
  assert.equal(parseSchedule('Oct 6, 10:00 AM and more', now).planned, 'Oct 6, 10:00 AM');
  assert.equal(parseSchedule('Not launched', now).planned, null);
  assert.equal(parseSchedule('Not launched', now).period, null);
  assert.equal(compactRelative(new Date(now.getTime() + 12 * 60000), now), 'in 12 min');
  assert.equal(compactRelative(new Date(now.getTime() + 20000), now), 'now');
  assert.equal(compactRelative(new Date(now.getTime() - 2 * 86400000), now), '2 d ago');
});

test('normalizeDetails: "Not launched" + a planned time from the field hints or a planned field', () => {
  const now = new Date(2026, 9, 2, 7, 0);
  const viaHint = normalizeDetails({ fields: { scheduleStartTime: { text: 'Not launched', links: [], hints: ['Not launched', 'Tue Oct 6, 10:00 AM EDT'] } } }, { now });
  assert.equal(viaHint.schedule.notLaunched, true);
  assert.equal(viaHint.schedule.planned, 'Tue Oct 6, 10:00 AM EDT');
  const rows = cardRows(viaHint, { now });
  const sched = rows.find((r) => r.key === 'schedule');
  assert.equal(sched.value, 'Not launched · planned Tue Oct 6, 10:00 AM EDT');
  assert.deepEqual(sched.time, { text: '10:00 AM', period: 'AM' });
  assert.equal(sched.chip.text, 'in 4 d 3 h');
  const viaField = normalizeDetails({ fields: { scheduleStartTime: f('Not launched'), scheduledTime: f('Oct 6, 2026 3:15 PM') } }, { now });
  assert.equal(viaField.schedule.period, 'PM');
  assert.equal(scheduleText(viaField.schedule), 'Not launched · planned Oct 6, 2026 3:15 PM');
  // Text copy: the period spelled out (the colour is lost in text).
  const text = summaryText(viaHint, aggregateChecks({}), { checkedAt: now });
  assert.ok(text.split('\n').includes('Schedule: Not launched · planned Tue Oct 6, 10:00 AM EDT (AM, in 4 d 3 h)'), text);
  assert.equal(timeColor('AM'), '#1d7f4a');
  assert.equal(timeColor('PM'), '#c03a3a');
  assert.equal(timeColor(null), null);
});

test('layoutCard: the send time is drawn in its own colour (AM green, PM red, bold)', () => {
  const now = new Date(2026, 9, 2, 7, 0);
  const d = normalizeDetails({ fields: { scheduleStartTime: f('Not launched · planned Oct 6, 2026 3:15 PM EDT') } }, { now });
  const rows = cardRows(d, { now });
  const lay = layoutCard({ title: 'T', meta: '', rows, checks: [], stamp: '', footer: '' }, { measure: (s) => String(s).length * 7 });
  const t = lay.ops.find((o) => o.t === 'text' && o.text === '3:15 PM');
  assert.ok(t, 'time drawn as its own run');
  assert.equal(t.color, '#c03a3a');
  assert.match(t.font, /^700 /);
});

// ── Checks ───────────────────────────────────────────────────────────────────

const scan = (counts, extra = {}) => ({ total: 10, passed: 8, counts: { error: 0, warning: 0, info: 0, ...counts }, errors: [], ...extra });

test('htmlCheck follows the scanner’s tones', () => {
  assert.equal(htmlCheck(null), null);
  assert.deepEqual([htmlCheck(scan({ error: 1, warning: 2 })).label, htmlCheck(scan({ error: 1 })).tone], ['HTML: 1 error', 'bad']);
  assert.deepEqual([htmlCheck(scan({ warning: 2 })).label, htmlCheck(scan({ warning: 2 })).tone], ['HTML: 2 warnings', 'warn']);
  assert.equal(htmlCheck(scan({ info: 3 })).label, 'HTML: 3 notes');
  assert.deepEqual([htmlCheck(scan({})).label, htmlCheck(scan({})).tone], ['HTML: no issues', 'ok']);
  assert.equal(htmlCheck(scan({}, { errors: ['x'] })).tone, 'warn');
  assert.equal(htmlCheck(scan({}, { total: 0 })).label, 'HTML: rules off');
});

test('aggregateChecks: fixed order, skips missing checks, worst tone', () => {
  const seed = checkSeedLists(['Seed QA'], 'Seed');
  const suppression = checkSuppression({ attached: [], warnNoSuppression: true });
  const agg = aggregateChecks({ seed, suppression, subject: { tone: 'ok', text: 'Subject line OK' }, html: htmlCheck(scan({ error: 2 })) });
  assert.deepEqual(agg.items.map((i) => [i.id, i.tone]), [['seed', 'ok'], ['suppression', 'warn'], ['subject', 'ok'], ['html', 'bad']]);
  assert.equal(agg.worst, 'bad');
  assert.equal(aggregateChecks({ seed }).worst, 'ok');
  assert.deepEqual(aggregateChecks({}), { items: [], worst: null });
});

// ── Rows + text ──────────────────────────────────────────────────────────────

test('cardRows: fixed rows, chips beside lists and schedule, "—" handled by renderers', () => {
  const d = normalizeDetails(RAW);
  const seed = checkSeedLists(d.sendLists, 'Seed');
  const suppression = checkSuppression({ attached: d.suppressionLists, alwaysRequire: 'Global Unsubscribes' });
  const rows = cardRows(d, { seed, suppression });
  assert.deepEqual(rows.map((r) => r.key), ['subject', 'preheader', 'from', 'replyTo', 'sendLists', 'suppressionLists', 'schedule', 'template', 'typeRate', 'email']);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.from.value, 'Northwind Books <news@northwind.example>');
  assert.deepEqual(by.sendLists.chip, { text: 'Seed list', tone: 'ok', title: seed.text });
  assert.equal(by.suppressionLists.chip.text, '1 suppression list · rules met');
  assert.match(by.suppressionLists.chip.title, /Always require → Global Unsubscribes: attached/);
  assert.equal(by.template.value, 'Fall Launch Hero v3 · id 998877 · edited Sep 22, 2026');
  assert.equal(by.typeRate.value, 'Marketing, Promotional · 4,000 per minute');
  assert.equal(by.email.value, 'fingerprint 1a2b3c4d · 41.0 KB');
  const empty = cardRows(normalizeDetails({}));
  assert.equal(empty.find((r) => r.key === 'subject').value, null);
  assert.match(empty.find((r) => r.key === 'email').value, /Not on the page/);
  assert.equal(empty.find((r) => r.key === 'sendLists').chip, null);
});

test('summaryText: Slack-friendly lines with checks and the stamp', () => {
  const d = normalizeDetails({ ...RAW, fields: { ...RAW.fields, scheduleStartTime: f('Tue Sep 29, 2026 10:00 AM EDT') } });
  const seed = checkSeedLists(d.sendLists, 'Seed');
  const suppression = checkSuppression({ attached: d.suppressionLists });
  const checks = aggregateChecks({ seed, suppression, subject: { tone: 'ok', text: '' }, html: htmlCheck(scan({ warning: 2 })) });
  const text = summaryText(d, checks, { seed, suppression, checkedAt: new Date(2026, 8, 25, 10, 42) });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Fall Launch · Email 1 (EN) (campaign 4412871)');
  assert.ok(lines.includes('Subject: Your fall reading list is here'));
  assert.ok(lines.includes('Send lists: Fall Launch · Engaged 90d, Seed · Marketing QA  [Seed list]'));
  assert.ok(lines.includes('Suppressions: Global Unsubscribes  [1 suppression list attached]'));
  assert.ok(lines.includes('Schedule: Tue Sep 29, 2026 10:00 AM EDT (AM, in 3 d 23 h)'), text);
  assert.ok(lines.includes('Checks: Seed list OK · Suppressions OK · Subject OK · HTML: 2 warnings'));
  assert.equal(lines.at(-1), 'Checked Sep 25, 2026, 10:42 AM with Loophole for Iterable');
  const bare = summaryText(normalizeDetails({}), aggregateChecks({}), { checkedAt: new Date(2026, 0, 1) }).split('\n');
  assert.equal(bare[0], 'Campaign');
  assert.ok(bare.includes('Preheader: —'));
  assert.ok(bare.includes('Send lists: none'));
  assert.ok(!bare.some((l) => l.startsWith('Checks:')));
});

// ── Card layout ──────────────────────────────────────────────────────────────

const mono7 = (s) => String(s).length * 7; // fake measure: 7px per character

test('wrapText: greedy words, long words broken, never empty', () => {
  assert.deepEqual(wrapText('aa bb cc dd', 35, mono7), ['aa bb', 'cc dd']);
  assert.deepEqual(wrapText('abcdefghij', 28, mono7), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('', 50, mono7), ['']);
  assert.deepEqual(wrapText('  one  ', 50, mono7), ['one']);
  assert.deepEqual(wrapText('x verylongword y', 42, mono7), ['x', 'verylo', 'ngword', 'y']);
});

function cardModel(overrides = {}) {
  const d = normalizeDetails(RAW);
  const seed = checkSeedLists(d.sendLists, 'Seed');
  const suppression = checkSuppression({ attached: d.suppressionLists, alwaysRequire: 'Recent purchasers' });
  return {
    title: d.campaignName, meta: 'Campaign 4412871 · Not launched',
    rows: cardRows(d, { seed, suppression }),
    checks: aggregateChecks({ seed, suppression }).items,
    stamp: 'checked Sep 25, 2026, 10:42 AM', footer: 'Checked with Loophole for Iterable · Sep 25, 2026, 10:42 AM',
    ...overrides,
  };
}

test('layoutCard: every op inside the card, chip colours by state, footer last', () => {
  const measure = (s) => mono7(s);
  const { width, height, ops } = layoutCard(cardModel(), { measure, width: 560 });
  assert.equal(width, 560);
  assert.ok(height > 300 && height < 1200, `height ${height}`);
  for (const op of ops) {
    if (op.t === 'text') {
      assert.ok(op.x >= 0 && op.x + measure(op.text) <= width + 0.5, `text overflows: ${op.text}`);
      assert.ok(op.y >= 0 && op.y < height, op.text);
    }
    if (op.t === 'rect') assert.ok(op.x >= 0 && op.x + op.w <= width + 0.5 && op.y + op.h <= height, JSON.stringify(op));
  }
  const texts = ops.filter((o) => o.t === 'text').map((o) => o.text);
  assert.ok(texts.includes('Subject'));
  assert.ok(texts.includes('Missing: Recent purchasers'));
  assert.equal(texts.at(-1), 'Checked with Loophole for Iterable · Sep 25, 2026, 10:42 AM');
  const missing = ops.find((o) => o.t === 'text' && o.text === 'Missing: Recent purchasers');
  assert.equal(missing.color, CARD_COLORS.bad);
  const seedChip = ops.find((o) => o.t === 'text' && o.text === 'Seed list' && o.color === CARD_COLORS.ok);
  assert.ok(seedChip);
  assert.equal(ops.filter((o) => o.t === 'mark').length, 1);
  // light theme only
  assert.equal(chipColors('warn').bg, CARD_COLORS.warnSoft);
  assert.equal(chipColors(undefined).fg, CARD_COLORS.neutral);
});

test('layoutCard wraps long values and grows; nothing leaves the card', () => {
  const measure = (s) => mono7(s);
  const short = layoutCard(cardModel(), { measure });
  const longRows = cardModel().rows.map((r) => (r.key === 'subject' ? { ...r, value: 'word '.repeat(80) } : r));
  const long = layoutCard(cardModel({ rows: longRows, title: 'T'.repeat(200) }), { measure });
  assert.ok(long.height > short.height + 100);
  for (const op of long.ops.filter((o) => o.t === 'text')) assert.ok(op.x + measure(op.text) <= long.width + 0.5, op.text);
  const listRows = cardModel().rows.map((r) => (r.key === 'sendLists' ? { ...r, lists: Array.from({ length: 30 }, (_, i) => `List number ${i}`) } : r));
  const many = layoutCard(cardModel({ rows: listRows }), { measure });
  for (const op of many.ops.filter((o) => o.t === 'rect')) assert.ok(op.x + op.w <= many.width + 0.5, JSON.stringify(op));
  const none = layoutCard(cardModel({ rows: cardModel().rows.map((r) => (r.lists ? { ...r, lists: [] } : r)) }), { measure });
  assert.ok(none.ops.some((o) => o.t === 'text' && o.text === 'None'));
});

// ── Preview CSP / doctype / compact CSS ─────────────────────────────────────

test('emailCsp: offline by default, remote images only when asked, scripts never', () => {
  const off = emailCsp();
  assert.match(off, /default-src 'none'/);
  assert.match(off, /img-src data:(;|$)/);
  assert.doesNotMatch(off, /https:/);
  const on = emailCsp({ remote: true });
  assert.match(on, /img-src https: data:/);
  assert.match(on, /font-src https: data:/);
  for (const c of [off, on]) {
    assert.match(c, /script-src 'none'/);
    assert.match(c, /form-action 'none'/);
    assert.match(c, /base-uri 'none'/);
    assert.match(c, /frame-src 'none'/);
  }
});

test('doctypeString rebuilds the email’s doctype', () => {
  assert.equal(doctypeString({ name: 'html', publicId: '', systemId: '' }), '<!DOCTYPE html>');
  assert.equal(doctypeString({ name: 'html', publicId: '-//W3C//DTD XHTML 1.0 Transitional//EN', systemId: 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd' }),
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">');
  assert.equal(doctypeString({ name: 'html', publicId: '', systemId: 'about:legacy-compat' }), '<!DOCTYPE html SYSTEM "about:legacy-compat">');
  assert.equal(doctypeString(null), '');
});

test('compactCss: data-test hooks only, no generated class names, no DOM moves', () => {
  const css = compactCss();
  assert.equal(COMPACT_STYLE_ID, 'wb-cc-compact');
  assert.match(css, /:has\(> \[data-test="optimize-section"\]\)\{display:flex !important; flex-direction:column !important\}/);
  assert.match(css, /\[data-test="sending-information-section"\]\{order:-2 !important\}/);
  assert.match(css, /:has\(\[data-test="form-readonly-field-scheduleStartTime"\]\):not\(\[data-test="sending-information-section"\]\)\{order:-1 !important\}/);
  assert.match(css, /\[data-test="form-field"\]\{margin-block:2px !important/);
  // every selector is built from data-test attributes (no .class selectors)
  assert.doesNotMatch(css, /(^|[\s>,{}])\.[a-zA-Z]/);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

// ── Capture messages ─────────────────────────────────────────────────────────

const appSender = { id: 'ext', url: 'https://app.iterable.com/campaigns/1', origin: 'https://app.iterable.com', frameId: 0, tab: { id: 7, windowId: 3 } };

test('checkCaptureRequest: only the app top frame, only its own tab, no extra fields', () => {
  assert.deepEqual(checkCaptureRequest({ type: MSG.CAPTURE_TAB }, appSender, 'app'), { ok: true, tabId: 7, windowId: 3 });
  const bad = (msg, sender, kind) => checkCaptureRequest(msg, sender, kind);
  assert.equal(bad({ type: MSG.CAPTURE_TAB }, appSender, 'bee').code, 'BAD_REQUEST');
  assert.equal(bad({ type: MSG.CAPTURE_TAB }, appSender, 'extension').ok, false);
  assert.equal(bad({ type: MSG.CAPTURE_TAB, tabId: 99 }, appSender, 'app').ok, false); // can't pick a tab
  assert.equal(bad({ type: MSG.CAPTURE_TAB, rect: {} }, appSender, 'app').ok, false);
  assert.equal(bad({ type: MSG.CAPTURE_TAB }, { ...appSender, frameId: 2 }, 'app').ok, false);
  assert.equal(bad({ type: MSG.CAPTURE_TAB }, { ...appSender, tab: undefined }, 'app').ok, false);
  assert.equal(bad({ type: MSG.CAPTURE_TAB }, { ...appSender, tab: { id: -1, windowId: 3 } }, 'app').ok, false);
  assert.equal(bad(null, appSender, 'app').ok, false);
});

test('capture policy, result guard and error codes', () => {
  assert.equal(senderAllowed(MSG.CAPTURE_TAB, 'app'), true);
  for (const k of ['bee', 'auth', 'extension']) assert.equal(senderAllowed(MSG.CAPTURE_TAB, k), false, k);
  assert.equal(isPngDataUrl('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isPngDataUrl('data:image/jpeg;base64,xx'), false);
  assert.equal(isPngDataUrl('data:image/png;base64,'), false);
  assert.equal(isPngDataUrl(42), false);
  assert.equal(captureErrorCode("Either the '<all_urls>' or 'activeTab' permission is required."), 'NO_GRANT'); // Chrome 154
  assert.equal(captureErrorCode('Missing activeTab permission'), 'NO_GRANT'); // Firefox 156
  assert.equal(captureErrorCode('Tabs cannot be edited right now'), 'FAILED');
});

test('manifest: activeTab (no install warning) and the capture command', () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(!manifest.permissions.includes('tabs'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  const cmd = manifest.commands[CAPTURE_COMMAND];
  assert.equal(cmd.description, 'Copy approval screenshot');
  // Not Alt+Shift+S: Firefox (Windows) treats it as Alt+S and opens its History menu. Alt+Shift+K
  // isn't a Firefox menu access key (F E V S B T H) nor a Chrome default; MacCtrl on a Mac.
  assert.equal(cmd.suggested_key.default, 'Alt+Shift+K');
  assert.equal(cmd.suggested_key.mac, 'MacCtrl+Shift+K');
  assert.ok(!/^Alt\+Shift\+[FEVSBTH]$/.test(cmd.suggested_key.default));
});

test('router.requestAction passes the payload and returns the handler’s result', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const prevWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = prevWindow; });
  t.mock.method(console, 'debug', () => {});
  const meta = { id: 'demo', frame: 'top', routes: [/^\//], defaultEnabled: true, settings: [] };
  let seen = null;
  const router = createRouter({
    frame: 'top', metas: [meta],
    impls: { demo: { mount(ctx) { ctx.onAction('echo', (p) => { seen = p; return Promise.resolve({ got: p?.n }); }); } } },
    makeCtx: (m, base) => base,
    loadSettings: async () => ({ general: {}, features: { demo: { enabled: true, values: {} } } }),
    subscribeSettings: () => () => {},
    getLocation: () => ({ pathname: '/campaigns/1', search: '', href: 'https://app.iterable.com/campaigns/1' }),
  });
  await router.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await router.requestAction('demo', 'echo', { n: 3 }), { got: 3 });
  assert.deepEqual(seen, { n: 3 });
  assert.equal(router.requestAction('demo', 'nope'), undefined);
  assert.equal(router.requestAction('other', 'echo'), undefined);
  router.unmountAll?.();
});
