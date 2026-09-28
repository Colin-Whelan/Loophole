import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitList, checkSeedLists, normalizeRules, checkSuppression, checkSubject, toDatetimeLocal,
  parseDatetimeLocal, defaultSendAt, relativeTime, iterableScheduleStrings, parseMonthLabel, monthDelta,
  planCalendarNavigation, selectDayTile, exceedsScheduleLimit, SCHEDULE_MAX_DAYS_AHEAD,
  describeRate, toWholeNumber, scheduleFillDecision,
} from '../../src/features/campaign-checks/logic.js';
import importer, { mapCampaignChecks } from '../../src/features/campaign-checks/import.js';
import meta from '../../src/features/campaign-checks/meta.js';
import { mergeValues, isValidValue, defaultValues } from '../../src/core/settings.js';
import { groupSections, validateObjectList } from '../../src/core/schema.js';
import { decodeStorage } from '../../src/options/importer/decode.js';

// ── Lists ────────────────────────────────────────────────────────────────────

test('splitList trims, drops empties, takes arrays', () => {
  assert.deepEqual(splitList(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(['x ', '', ' y']), ['x', 'y']);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(''), []);
});

test('seed check: case-insensitive substring, warn when missing, null without keyword', () => {
  assert.equal(checkSeedLists(['Fall promo', 'QA seed list'], 'Seed').tone, 'ok');
  assert.equal(checkSeedLists(['Fall promo', 'QA seed list'], 'Seed').match, 'QA seed list');
  const miss = checkSeedLists(['Fall promo'], 'Seed');
  assert.equal(miss.tone, 'warn');
  assert.match(miss.text, /No "Seed" list/);
  assert.equal(checkSeedLists([], '  '), null);
  assert.equal(checkSeedLists(null, 'Seed').tone, 'warn');
});

const RULES = [
  { keywords: 'mother, mom', requiredLists: 'Mothers Day opt-out', isGlobal: false },
  { keywords: 'survey', requiredLists: 'Survey opt-outs, Research opt-outs', isGlobal: false },
  { keywords: '', requiredLists: 'Daily exclusions', isGlobal: true },
];

test('normalizeRules skips incomplete rules and ignores keywords on global ones', () => {
  const r = normalizeRules([...RULES, { keywords: '', requiredLists: 'X', isGlobal: false },
    { keywords: 'a', requiredLists: '', isGlobal: false }, null, 'junk',
    { keywords: 'ignored', requiredLists: 'G', isGlobal: true }]);
  assert.equal(r.length, 4);
  assert.deepEqual(r[3], { keywords: [], lists: ['G'], isGlobal: true });
  // legacy field name accepted
  assert.deepEqual(normalizeRules([{ keywords: ['a'], requiredSuppressionLists: ['L'] }])[0].lists, ['L']);
});

const supp = (campaignName, attached, rules, extra = {}) => checkSuppression({ campaignName, attached, rules, ...extra });

test('suppression check: keyword rules, global rules, substring list matches', () => {
  const ok = supp('Mom appreciation email', ['Mothers Day opt-out (2026)', 'Daily Exclusions list'], RULES);
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.text, '2 suppression lists · rules met');
  assert.equal(ok.required.length, 2);

  const bad = supp('Customer SURVEY wave 2', ['Survey opt-outs'], RULES);
  assert.equal(bad.tone, 'bad');
  assert.deepEqual(bad.missing, ['Research opt-outs', 'Daily exclusions']);
  assert.equal(bad.text, 'Missing: Research opt-outs, Daily exclusions');

  const one = supp('Weekly', [], RULES);
  assert.equal(one.text, 'Missing: Daily exclusions');
});

test('suppression check always has a state: ok / warn / neutral without rules', () => {
  const none = supp('Weekly', [], []);
  assert.equal(none.tone, 'warn');
  assert.equal(none.text, 'No suppression list on this campaign');
  const off = supp('Weekly', [], [], { warnNoSuppression: false });
  assert.equal(off.tone, undefined);
  assert.equal(off.text, 'No suppression lists');
  const any = supp('Weekly', ['Anything'], []);
  assert.equal(any.tone, 'ok');
  assert.equal(any.text, '1 suppression list attached');
  assert.equal(supp('', ['A', 'B'], RULES.slice(0, 2)).text, '2 suppression lists attached');
});

test('suppression check: "Always require" lists, reasons in the tooltip', () => {
  const r = supp('Mom promo', ['Global Unsubscribes (all)'], RULES.slice(0, 1), { alwaysRequire: 'global unsubscribes, Mothers Day opt-out' });
  assert.equal(r.tone, 'bad');
  assert.deepEqual(r.missing, ['Mothers Day opt-out']);
  const md = r.required.find((x) => x.list === 'Mothers Day opt-out');
  assert.deepEqual(md.reasons, ['Always require', 'Rule "mother, mom"']);
  assert.match(r.title, /Always require → global unsubscribes: attached \(Global Unsubscribes \(all\)\)/);
  assert.match(r.title, /Always require \+ Rule "mother, mom" → Mothers Day opt-out: missing/);
  const good = supp('Weekly', ['Global Unsubscribes'], [], { alwaysRequire: 'Global Unsubscribes' });
  assert.equal(good.text, '1 suppression list · rules met');
  assert.match(supp('Weekly', ['x'], []).title, /No required suppression lists/);
  // a required list with nothing attached is "missing", not "no list"
  assert.equal(supp('Weekly', [], [], { alwaysRequire: 'G' }).text, 'Missing: G');
});

test('suppression check lists a missing list once even if two rules require it', () => {
  const r = supp('mom survey', [], [
    { keywords: 'mom', requiredLists: 'Shared', isGlobal: false },
    { keywords: 'survey', requiredLists: 'shared', isGlobal: false },
  ]);
  assert.deepEqual(r.missing, ['Shared']);
  assert.equal(r.required[0].reasons.length, 2);
});

test('subject check flags the script’s characters', () => {
  assert.equal(checkSubject('Hello {{firstName}}').tone, 'ok');
  const r = checkSubject('Hi\tthere now\n');
  assert.equal(r.tone, 'bad');
  assert.deepEqual(r.found, ['line separator', 'newline', 'tab']);
  assert.equal(checkSubject(undefined).tone, 'ok');
});

// ── Schedule ─────────────────────────────────────────────────────────────────

test('datetime-local round trip and validation', () => {
  const d = new Date(2026, 8, 29, 9, 5);
  assert.equal(toDatetimeLocal(d), '2026-09-29T09:05');
  assert.equal(parseDatetimeLocal('2026-09-29T09:05').getTime(), d.getTime());
  assert.equal(parseDatetimeLocal('2026-09-29T09:05:30').getTime(), d.getTime());
  assert.equal(parseDatetimeLocal('2026-02-30T09:05'), null);
  assert.equal(parseDatetimeLocal('2026-09-29T24:00'), null);
  assert.equal(parseDatetimeLocal(''), null);
  assert.equal(parseDatetimeLocal('09/29/2026'), null);
});

test('defaultSendAt is now + 61 minutes, whole minute', () => {
  const now = new Date(2026, 8, 25, 10, 0, 42, 500);
  const d = defaultSendAt(now);
  assert.equal(d.getHours(), 11);
  assert.equal(d.getMinutes(), 1);
  assert.equal(d.getSeconds(), 0);
});

test('relativeTime bands (past / <1h bad, <24h warn, else ok)', () => {
  const now = new Date(2026, 8, 25, 10, 0);
  const at = (mins) => new Date(now.getTime() + mins * 60000);
  assert.deepEqual([relativeTime(at(-1), now).tone, relativeTime(at(-1), now).text], ['bad', 'That time has already passed']);
  assert.equal(relativeTime(at(0), now).tone, 'bad');
  assert.deepEqual([relativeTime(at(1), now).tone, relativeTime(at(1), now).text], ['bad', 'In 1 minute']);
  assert.equal(relativeTime(at(59), now).text, 'In 59 minutes');
  assert.deepEqual([relativeTime(at(60), now).tone, relativeTime(at(60), now).text], ['warn', 'In 1 hour']);
  assert.equal(relativeTime(at(61), now).text, 'In 1 hour, 1 minute');
  assert.equal(relativeTime(at(23 * 60 + 59), now).text, 'In 23 hours, 59 minutes');
  assert.deepEqual([relativeTime(at(24 * 60), now).tone, relativeTime(at(24 * 60), now).text], ['ok', 'In 1 day']);
  assert.equal(relativeTime(at(4 * 1440 + 20 * 60), now).text, 'In 4 days, 20 hours');
  assert.equal(relativeTime(new Date(NaN), now).tone, 'bad');
});

test('iterableScheduleStrings matches the script’s MM/DD/YYYY and hh:mm AM', () => {
  assert.deepEqual(iterableScheduleStrings(new Date(2026, 8, 29, 9, 5)), { date: '09/29/2026', time: '09:05 AM' });
  assert.deepEqual(iterableScheduleStrings(new Date(2026, 0, 1, 0, 0)), { date: '01/01/2026', time: '12:00 AM' });
  assert.deepEqual(iterableScheduleStrings(new Date(2026, 11, 31, 12, 30)), { date: '12/31/2026', time: '12:30 PM' });
  assert.deepEqual(iterableScheduleStrings(new Date(2026, 11, 31, 23, 59)), { date: '12/31/2026', time: '11:59 PM' });
});

test('calendar month label parsing and month deltas', () => {
  assert.deepEqual(parseMonthLabel('September 2026'), { year: 2026, month: 8 });
  assert.deepEqual(parseMonthLabel(' may 2027 '), { year: 2027, month: 4 });
  assert.deepEqual(parseMonthLabel('Sep 2026'), { year: 2026, month: 8 });
  assert.equal(parseMonthLabel('2026'), null);
  assert.equal(parseMonthLabel('Foo 2026'), null);
  assert.equal(monthDelta({ year: 2026, month: 8 }, new Date(2027, 1, 3)), 5);
  assert.equal(monthDelta({ year: 2026, month: 8 }, new Date(2026, 6, 3)), -2);
  assert.equal(monthDelta({ year: 2026, month: 8 }, new Date(2026, 8, 30)), 0);
});

test('planCalendarNavigation: steps and direction, including month and year turnover', () => {
  // Same month: nothing to click.
  assert.deepEqual(planCalendarNavigation({ year: 2026, month: 8 }, new Date(2026, 8, 15)), { steps: 0, direction: null, complete: true });
  // Oct 30 shown → Nov 3 target: one next click.
  assert.deepEqual(planCalendarNavigation({ year: 2026, month: 9 }, new Date(2026, 10, 3)), { steps: 1, direction: 'next', complete: true });
  // Dec shown → Jan target (year turnover): one next click.
  assert.deepEqual(planCalendarNavigation({ year: 2026, month: 11 }, new Date(2027, 0, 5)), { steps: 1, direction: 'next', complete: true });
  // Jan shown → Dec of the previous year: one prev click.
  assert.deepEqual(planCalendarNavigation({ year: 2027, month: 0 }, new Date(2026, 11, 20)), { steps: 1, direction: 'prev', complete: true });
  // Several months back.
  assert.deepEqual(planCalendarNavigation({ year: 2026, month: 8 }, new Date(2026, 5, 1)), { steps: 3, direction: 'prev', complete: true });
  // Beyond the cap: capped steps, complete: false so the caller stops rather than spinning.
  const far = planCalendarNavigation({ year: 2026, month: 8 }, new Date(2028, 0, 1), { maxSteps: 12 });
  assert.equal(far.complete, false);
  assert.equal(far.steps, 12);
  assert.equal(far.direction, 'next');
});

test('selectDayTile: exact aria-label date wins over a same-numbered neighbouring-month tile; disabled tiles are skipped', () => {
  const tiles = [
    { ariaLabel: '09/30/2026', day: 30, neighboring: true, disabled: false }, // previous month's "30"
    { ariaLabel: '10/01/2026', day: 1, neighboring: false, disabled: false },
    { ariaLabel: '10/03/2026', day: 3, neighboring: false, disabled: false },
    { ariaLabel: '10/09/2026', day: 9, neighboring: false, disabled: true }, // beyond Iterable's window
  ];
  assert.equal(selectDayTile(tiles, '10/03/2026', 3), 2);
  // No aria-label match: falls back to day number, excluding the neighbouring-month tile.
  assert.equal(selectDayTile(tiles.map((t) => ({ ...t, ariaLabel: '' })), '', 3), 2);
  // A disabled tile is never selected, even by day-number fallback.
  assert.equal(selectDayTile(tiles.map((t) => ({ ...t, ariaLabel: '' })), '', 9), -1);
  // No aria-label match and no tile with that day number either.
  assert.equal(selectDayTile(tiles, '11/15/2026', 15), -1);
  assert.equal(selectDayTile([], '10/03/2026', 3), -1);
});

test('exceedsScheduleLimit: Iterable’s 21-day scheduling window', () => {
  const now = new Date(2026, 8, 1, 12, 0);
  assert.equal(exceedsScheduleLimit(new Date(2026, 8, 20, 12, 0), now), false);
  assert.equal(exceedsScheduleLimit(new Date(2026, 8, 22, 12, 1), now), true);
  assert.equal(SCHEDULE_MAX_DAYS_AHEAD, 21);
});

test('scheduleFillDecision: already open → fill directly, no click', () => {
  const d = scheduleFillDecision({ dialogOpen: true, notLaunched: true, scheduleButtonFound: true });
  assert.equal(d.action, 'fill');
  // Even a launched campaign or a missing button don't matter once the dialog is already open.
  assert.equal(scheduleFillDecision({ dialogOpen: true, notLaunched: false, scheduleButtonFound: false }).action, 'fill');
});

test('scheduleFillDecision: not open, not launched, button present → open it', () => {
  const d = scheduleFillDecision({ dialogOpen: false, notLaunched: true, scheduleButtonFound: true });
  assert.equal(d.action, 'open');
});

test('scheduleFillDecision: already scheduled/launched → refuse, never click', () => {
  const d = scheduleFillDecision({ dialogOpen: false, notLaunched: false, scheduleButtonFound: true });
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, 'already-scheduled');
});

test('scheduleFillDecision: not launched but no schedule button found → refuse', () => {
  const d = scheduleFillDecision({ dialogOpen: false, notLaunched: true, scheduleButtonFound: false });
  assert.equal(d.action, 'refuse');
  assert.equal(d.reason, 'no-button');
});

// ── Send rate ────────────────────────────────────────────────────────────────

test('describeRate and toWholeNumber', () => {
  assert.equal(describeRate(4000).text, '4,000/min ≈ 240,000/hour');
  assert.equal(describeRate('x').perMinute, 0);
  assert.equal(toWholeNumber('4,000'), 4000);
  assert.equal(toWholeNumber(' 2500 '), 2500);
  assert.equal(toWholeNumber(12.7), 12);
  assert.equal(toWholeNumber('12abc'), null);
  assert.equal(toWholeNumber(''), null);
  assert.equal(toWholeNumber(null), null);
  assert.equal(toWholeNumber(Infinity), null);
});

// ── Meta / settings ──────────────────────────────────────────────────────────

test('meta: sections, defaults validate, generic defaults', () => {
  assert.equal(meta.id, 'campaign-checks');
  assert.deepEqual(groupSections(meta.settings).map((g) => g.title), ['Lists', 'Approval', 'Schedule', 'Send rate']);
  const defs = defaultValues(meta);
  for (const f of meta.settings) assert.ok(isValidValue(f, defs[f.key]), f.key);
  assert.equal(defs.seedListKeyword, 'Seed');
  assert.equal(defs.customRateLimit, 4000);
  assert.deepEqual(defs.campaignRules, []);
  // Approval additions are opt-in, apart from the view's header button, the no-list warning and
  // remote images in the preview (the owner's call after live testing; still no scripts / links).
  assert.equal(defs.approvalView, true);
  assert.equal(defs.approvalShortcut, '');
  assert.equal(defs.remoteImagesDefault, true);
  for (const k of ['openApprovalAutomatically', 'showCardOnPage', 'compactLayout']) assert.equal(defs[k], false, k);
  assert.equal(defs.alwaysRequireSuppression, '');
  assert.equal(defs.warnNoSuppression, true);
  // popup actions: the view, and the popup-handled capture, both only on a campaign's own page
  assert.deepEqual(meta.actions.map((a) => a.id), ['approval', 'approval-screenshot']);
  for (const a of meta.actions) {
    assert.ok(a.routes.some((r) => r.test('/campaigns/123?view=Summary')), a.id);
    assert.ok(!a.routes.some((r) => r.test('/campaigns/templates')), a.id);
  }
});

test('campaignRules objectList: form validation and storage repair', () => {
  const field = meta.settings.find((f) => f.key === 'campaignRules');
  const res = validateObjectList(field, [
    { keywords: '', requiredLists: 'A', isGlobal: true },
    { keywords: '', requiredLists: 'B', isGlobal: false },
    { keywords: 'x', requiredLists: '', isGlobal: false },
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.itemErrors.map((e) => [e.index, e.key]), [[1, 'keywords'], [2, 'requiredLists']]);
  const merged = mergeValues(meta, { campaignRules: [{ keywords: 'a', requiredLists: 'L' }, 7] });
  assert.deepEqual(merged.campaignRules, [{ keywords: 'a', requiredLists: 'L', isGlobal: false }]);
  assert.equal(mergeValues(meta, { customRateLimit: 0 }).customRateLimit, 4000);
});

// ── Import ───────────────────────────────────────────────────────────────────

const LEGACY = {
  seedListCheck: true,
  seedListKeyword: 'QA Seeds',
  suppressListCheck: 'true',
  campaignRules: [
    { keywords: ['holiday', 'xmas'], requiredSuppressionLists: ['Holiday opt-out'], isGlobal: false },
    { keywords: [], requiredSuppressionLists: ['Global exclusions', 'Bounced'], isGlobal: true },
    { keywords: [], requiredSuppressionLists: ['Orphan'], isGlobal: false },
    'junk',
  ],
  customRateLimit: '2500',
  rateLimitsByMessageType: { Marketing: 3000 },
  htmlScan: { enabled: true, iframeSelector: 'x' },
};

test('import maps campaignConfig (JSON string) to settings, with notes', () => {
  const { values, notes } = mapCampaignChecks({ campaignConfig: JSON.stringify(LEGACY) });
  assert.deepEqual(values, {
    seedListCheck: true,
    seedListKeyword: 'QA Seeds',
    suppressListCheck: true,
    campaignRules: [
      { keywords: 'holiday, xmas', requiredLists: 'Holiday opt-out', isGlobal: false },
      { keywords: '', requiredLists: 'Global exclusions, Bounced', isGlobal: true },
    ],
    customRateLimit: 2500,
  });
  const text = notes.join('\n');
  assert.match(text, /2 suppression rules/);
  assert.match(text, /Skipped 2/);
  assert.match(text, /rate limits were not imported/);
  assert.match(text, /Email HTML check/);
  // Mapped values pass the schema.
  const merged = mergeValues(meta, values);
  for (const [k, v] of Object.entries(values)) assert.deepEqual(merged[k], v, k);
});

test('import accepts a parsed object and Tampermonkey-tagged storage', () => {
  assert.equal(mapCampaignChecks({ campaignConfig: LEGACY }).values.customRateLimit, 2500);
  const decoded = decodeStorage({ campaignConfig: 's' + JSON.stringify({ seedListCheck: false }) }, { tagged: true });
  assert.deepEqual(mapCampaignChecks(decoded).values, { seedListCheck: false });
  assert.equal(importer.scripts[0], 'Campaign Preview Enhancements');
  assert.equal(importer.map, mapCampaignChecks);
});

test('import never throws on junk and explains', () => {
  for (const input of [undefined, null, 'x', 5, {}, { campaignConfig: '' }, { campaignConfig: '{bad' },
    { campaignConfig: '[1,2]' }, { campaignConfig: { campaignRules: 'nope' } },
    { campaignConfig: { campaignRules: [{ keywords: 5, requiredSuppressionLists: {} }] } },
    { campaignConfig: { customRateLimit: -3 } }, { campaignConfig: { customRateLimit: 'lots' } },
    { campaignConfig: { seedListKeyword: 42, seedListCheck: 'maybe' } }]) {
    const r = mapCampaignChecks(input);
    assert.equal(typeof r.values, 'object');
    assert.ok(Array.isArray(r.notes));
  }
  assert.match(mapCampaignChecks({}).notes[0], /No saved settings/);
  assert.match(mapCampaignChecks({ campaignConfig: '{bad' }).notes[0], /could not be read/);
  assert.deepEqual(mapCampaignChecks({ campaignConfig: { customRateLimit: 999999 } }).values, {});
  assert.deepEqual(mapCampaignChecks({ campaignConfig: { campaignRules: 'nope' } }).values, {});
});

test('import falls back to a separately stored customRateLimit', () => {
  assert.deepEqual(mapCampaignChecks({ customRateLimit: 3000 }).values, { customRateLimit: 3000 });
  assert.deepEqual(mapCampaignChecks({ campaignConfig: '{}', customRateLimit: '1,200' }).values, { customRateLimit: 1200 });
});
