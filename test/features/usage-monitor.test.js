import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.local fake for the data.js state helpers (touched at call time only).
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
      },
      async set(items) { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); },
      async remove(keys) { for (const k of [].concat(keys)) store.delete(k); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const L = await import('../../src/features/usage-monitor/logic.js');
const D = await import('../../src/features/usage-monitor/data.js');
const { default: meta } = await import('../../src/features/usage-monitor/meta.js');
const { getMeta } = await import('../../src/features/registry.js');
const { createState } = await import('../../src/core/state.js');
const { RESTORE_NAME_RE } = await import('../../src/options/importer/backup.js');
const {
  checkUsageNotify, usageNotificationUrl, senderAllowed, USAGE_NOTIFY_TITLE_MAX,
} = await import('../../src/core/api-validation.js');
const { HttpError } = await import('../../src/core/http.js');

beforeEach(() => store.clear());

// ── Synthetic fixtures (made-up numbers, ids and names; shapes as Iterable sends them) ──────

const TODAY = '2026-10-06';
const TERM = { start: '2026-04-29', end: '2027-04-28' };
const lim = (annualLimit, attributes = {}, term = TERM) => ({ annualLimit, termStartDatePST: term.start, termEndDatePST: term.end, attributes });

const LIMITS = {
  minTermStartDatePST: '2025-04-29',
  maxTermEndDatePST: '2027-04-28',
  metricUsageLimit: {
    TotalUsersAllTime: [lim(5_000_000)],
    TotalCustomEvents: [lim(1_000_000, {}, { start: '2025-04-29', end: '2026-04-28' }), lim(30_000_000)],
    TotalEmailsSent: [lim(400_000_000, { BillingParty: 'FirstParty' })],
    SmsSegmentsSent: [],
    FancyNewMetricCount: [lim(1000)],
  },
};

const usageRow = (metricName, value, metadata = { lastAvailableDate: '2026-10-05' }) => ({ metricName, value, metadata });
const USAGE = {
  values: {
    ByOrg: {
      0: [
        usageRow('TotalUsersAllTime', 5_021_733),
        usageRow('TotalUsersAddedInPeriod', 160_000),
        usageRow('ActiveUsersAllTime', 4_400_000),
        usageRow('TotalUsersHighWatermark', 5_021_733, { lastAvailableDate: '2026-10-05', highWatermarkDate: '2026-10-05' }),
        usageRow('TotalCustomEvents', 24_000_000),
        usageRow('TotalEmailsSent', 9_100_000),
        usageRow('JvtCount', 512),
        usageRow('PushNotificationsSent', 0),
        usageRow('SmsSegmentsSent', 0),
        usageRow('FancyNewMetricCount', 250),
      ],
    },
    ByOrgBillingParty: { 0: [{ metricName: 'TotalEmailsSent', value: 8_800_000, billingParty: 'FirstParty' }, { metricName: 'TotalEmailsSent', value: 300_000, billingParty: 'ThirdParty' }] },
    ByOrgProviderBillingParty: { 0: [] },
  },
  projects: { 11111: { id: 11111, name: 'Example Prod', isSandbox: false, isArchived: false }, 2222: { id: 2222, name: 'Example Dev', isSandbox: true, isArchived: false } },
  lastAvailableDatePST: '2026-10-01',
};

function snapshot({ usage = USAGE, partial = false, limits = LIMITS } = {}) {
  const parsed = L.parseLimits(limits, TODAY);
  const term = L.contractTerm(parsed, limits, TODAY);
  const query = partial ? { start: '2026-09-07', end: TODAY, partial: true } : { start: term.start, end: term.end, partial: false };
  return L.buildSnapshot({ limits: parsed, usage: L.parseUsage(usage), query, term, today: TODAY, now: 1_000, host: 'app.iterable.com' });
}
const row = (snap, id) => snap.rows.find((r) => r.id === id);

// ── Meta / registration ──────────────────────────────────────────────────

test('meta: registered, top frame, everywhere, on by default, no key, custom settings', () => {
  assert.equal(getMeta('usage-monitor'), meta);
  assert.equal(meta.frame, 'top');
  assert.ok(meta.routes.some((r) => r.test('/anything?x=1')));
  assert.equal(meta.defaultEnabled, true);
  assert.equal(meta.usesApiKey, false);
  assert.equal(meta.customSettings, true);
  assert.ok(meta.settings.every((f) => f.hidden), 'all values are owned by settings-ui.js');
  assert.deepEqual(meta.settings.find((f) => f.key === 'thresholds').default, [80, 95]);
});

// ── Dates ────────────────────────────────────────────────────────────────

test('pstDay: the calendar day in Los Angeles, not UTC', () => {
  assert.equal(L.pstDay(Date.parse('2026-10-06T06:30:00Z')), '2026-10-05'); // 23:30 PDT
  assert.equal(L.pstDay(Date.parse('2026-10-06T07:30:00Z')), '2026-10-06');
  assert.equal(L.pstDay(Date.parse('2026-01-15T07:59:00Z')), '2026-01-14'); // PST, UTC−8
  assert.equal(L.daysBetween('2026-04-29', '2026-10-05'), 159);
  assert.equal(L.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(L.formatDay('2026-09-29', { refDay: TODAY }), 'Sep 29');
  assert.equal(L.formatDay('2027-01-02', { refDay: TODAY }), 'Jan 2, 2027');
  assert.equal(L.formatTerm(TERM), 'Apr 29, 2026 – Apr 28, 2027');
});

// ── Limits ───────────────────────────────────────────────────────────────

test('parseLimits: current term, BillingParty rows, empty = no limit, unknown names kept', () => {
  const rows = L.parseLimits(LIMITS, TODAY);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ['FancyNewMetricCount', 'TotalCustomEvents', 'TotalEmailsSent:FirstParty', 'TotalUsersAllTime']);
  assert.equal(by.TotalCustomEvents.limit, 30_000_000, 'the term containing today wins over an older one');
  assert.equal(by['TotalEmailsSent:FirstParty'].party, 'FirstParty');
  assert.equal(by.TotalUsersAllTime.termStart, '2026-04-29');
});

test('parseLimits: no term contains today → the latest; several parties in one term; junk skipped', () => {
  const data = {
    metricUsageLimit: {
      TotalEmailsSent: [
        lim(1, { BillingParty: 'FirstParty' }, { start: '2024-01-01', end: '2024-12-31' }),
        lim(200, { BillingParty: 'FirstParty' }, { start: '2025-01-01', end: '2025-12-31' }),
        lim(50, { BillingParty: 'ThirdParty' }, { start: '2025-01-01', end: '2025-12-31' }),
      ],
      Bad: [{ annualLimit: 'lots' }, { annualLimit: -5, termStartDatePST: '2026-01-01', termEndDatePST: '2026-12-31' }],
      'not a name': [lim(10)],
    },
  };
  // An own __proto__ key, as JSON.parse makes it (spread copies it as a plain property).
  data.metricUsageLimit = { ...JSON.parse('{"__proto__": [{"annualLimit": 10, "termStartDatePST": "2026-01-01", "termEndDatePST": "2026-12-31"}]}'), ...data.metricUsageLimit };
  assert.ok(Object.hasOwn(data.metricUsageLimit, '__proto__'));
  const rows = L.parseLimits(data, TODAY);
  assert.deepEqual(rows.map((r) => [r.id, r.limit]), [['TotalEmailsSent:FirstParty', 200], ['TotalEmailsSent:ThirdParty', 50]]);
  assert.deepEqual(L.parseLimits(null, TODAY), []);
  assert.deepEqual(L.parseLimits({ metricUsageLimit: [] }, TODAY), []);
});

test('contractTerm: the users term, else any current term, else min/max, else null', () => {
  const rows = L.parseLimits(LIMITS, TODAY);
  assert.deepEqual(L.contractTerm(rows, LIMITS, TODAY), TERM);
  assert.deepEqual(L.contractTerm([], { minTermStartDatePST: '2026-01-01', maxTermEndDatePST: '2026-12-31' }, TODAY), { start: '2026-01-01', end: '2026-12-31' });
  assert.equal(L.contractTerm([], {}, TODAY), null);
});

test('usagePath: the term range with the aggregation levels and groups', () => {
  const p = L.usagePath('2026-04-29', '2027-04-28');
  assert.ok(p.startsWith('/i/account/usageV4?aggLevels=ByOrg,ByOrgBillingParty,'));
  assert.ok(p.includes('metricGroups=Catalog,Events,Jvt,Messaging,Sms,Users'));
  assert.ok(p.endsWith('startDatePST=2026-04-29&endDatePST=2027-04-28'));
  assert.ok(L.limitsBody().metricNames.includes('TotalUsersAllTime'));
});

// ── Snapshot rows ────────────────────────────────────────────────────────

test('buildSnapshot: values, percent, BillingParty value, unknown metric label, users first', () => {
  const snap = snapshot();
  assert.equal(snap.rows[0].metric, 'TotalUsersAllTime');
  const users = row(snap, 'TotalUsersAllTime');
  assert.equal(users.value, 5_021_733);
  assert.equal(users.kind, 'stock');
  assert.ok(Math.abs(users.percent - 100.43466) < 1e-4);
  assert.equal(users.label, 'Total users');
  assert.equal(users.short, 'Users');
  const emails = row(snap, 'TotalEmailsSent:FirstParty');
  assert.equal(emails.value, 8_800_000, 'the ByOrgBillingParty row for that party, not the ByOrg total');
  assert.equal(emails.label, 'Emails sent (first party)');
  assert.equal(emails.kind, 'flow');
  const fancy = row(snap, 'FancyNewMetricCount');
  assert.equal(fancy.label, 'Fancy new metric count');
  assert.equal(fancy.short, 'Fancy');
  assert.equal(fancy.percent, 25);
  assert.equal(snap.dataThrough, '2026-10-05');
  assert.deepEqual(snap.term, TERM);
  assert.deepEqual(snap.projects.map((p) => p.id).sort(), ['11111', '2222']);
});

test('buildSnapshot: a BillingParty limit with no party row falls back to ByOrg', () => {
  const usage = structuredClone(USAGE);
  usage.values.ByOrgBillingParty = { 0: [] };
  assert.equal(row(snapshot({ usage }), 'TotalEmailsSent:FirstParty').value, 9_100_000);
});

test('buildSnapshot: secondary facts; zero, secondary and SMS metrics stay out of "No contract limit"', () => {
  const snap = snapshot();
  assert.deepEqual(snap.facts, { usersAdded: 160_000, addedDays: 160, activeUsers: 4_400_000, highWatermark: 5_021_733, highWatermarkDate: '2026-10-05' });
  assert.deepEqual(snap.unlimited.map((u) => [u.metric, u.value]), [['JvtCount', 512]]);
  assert.equal(snap.unlimited[0].label, 'Journey events this term');
});

test('buildSnapshot: the 30-day fallback marks flow limits unavailable, stock limits still work', () => {
  const snap = snapshot({ partial: true });
  assert.equal(snap.query.partial, true);
  const events = row(snap, 'TotalCustomEvents');
  assert.equal(events.unavailable, true);
  assert.equal(events.value, null);
  assert.equal(events.percent, null);
  assert.equal(events.recent, 24_000_000);
  assert.equal(L.rowState(events, [80, 95]), 'unknown');
  const users = row(snap, 'TotalUsersAllTime');
  assert.equal(users.unavailable, false);
  assert.equal(users.value, 5_021_733);
});

test('metric labels: known names mapped, unknown ones de-camel-cased', () => {
  assert.equal(L.metricLabel('TotalCustomEvents'), 'Custom events');
  assert.equal(L.metricLabel('SmsSegmentsSent'), 'SMS segments sent');
  assert.equal(L.metricLabel('WhatsAppMessagesSent'), 'Whats app messages sent');
  assert.equal(L.decamel('JVTCount'), 'JVT count');
  assert.equal(L.partyLabel('ThirdParty'), 'third party');
});

// ── State, projection ────────────────────────────────────────────────────

test('rowState / reachedLevel: ok, warn past the lowest threshold, over at 100%', () => {
  const r = (percent) => ({ percent });
  assert.equal(L.rowState(r(79.9), [80, 95]), 'ok');
  assert.equal(L.rowState(r(80), [80, 95]), 'warn');
  assert.equal(L.rowState(r(100), [80, 95]), 'over');
  assert.equal(L.rowState(r(140), []), 'over');
  assert.equal(L.rowState(r(99), []), 'ok', 'with no thresholds only 100 alerts');
  assert.equal(L.rowState(r(null), [80]), 'unknown');
  assert.equal(L.reachedLevel(96, [80, 95]), 95);
  assert.equal(L.reachedLevel(101, [80, 95]), 100);
  assert.equal(L.reachedLevel(10, [80, 95]), null);
});

test('normalizeThresholds: 1–99 integers, sorted, unique; junk → defaults', () => {
  assert.deepEqual(L.normalizeThresholds([95, 80, 80, 100, 0, 50.5, '70']), [70, 80, 95]);
  assert.deepEqual(L.normalizeThresholds([]), []);
  assert.deepEqual(L.normalizeThresholds('x'), [80, 95]);
  assert.deepEqual(L.alertLevels([90]), [90, 100]);
});

test('projection: users crossed date from the term pace; flow reaches the next level', () => {
  const snap = snapshot();
  const users = row(snap, 'TotalUsersAllTime');
  assert.equal(users.rate, 1000); // 160,000 added over 160 days
  const p = L.projection(users, [80, 95]);
  assert.deepEqual(p, { kind: 'crossed', date: '2026-09-14', period: 'term' }); // 21,733 over at 1,000 a day
  assert.equal(L.projectionText(p, { refDay: TODAY }), 'crossed ~Sep 14');

  const events = row(snap, 'TotalCustomEvents'); // 24M of 30M = 80% after 160 days (150,000 a day)
  const q = L.projection(events, [80, 95]);
  assert.equal(q.kind, 'reaches');
  assert.equal(q.threshold, 95);
  assert.equal(q.date, L.addDays('2026-10-05', 30)); // 4.5M more at 150,000 a day
  assert.equal(q.afterTerm, false);
});

test('projection: beyond the term end, no rate, or no value → said so / null', () => {
  const r = { percent: 10, value: 10, limit: 100, rate: 0.01, dataThrough: '2026-10-05', termEnd: '2027-04-28', kind: 'flow' };
  const p = L.projection(r, [80]);
  assert.equal(p.afterTerm, true);
  assert.equal(L.projectionText(p), 'stays under 80% this term');
  assert.equal(L.projection({ ...r, rate: null }, [80]), null);
  assert.equal(L.projection({ ...r, rate: 0 }, [80]), null);
  assert.equal(L.projection({ ...r, percent: null }, [80]), null);
});

// ── Alerts ───────────────────────────────────────────────────────────────

const arow = (id, percent, limit = 1000) => ({ id, label: id, short: id, percent, value: (percent * limit) / 100, limit });
const run = (prev, rows, today = TODAY, thresholds = [80, 95]) => L.evaluateAlerts(prev, { rows, thresholds, today });

test('alerts: first check over 100% records every level but fires one alert', () => {
  const { state, firings } = run(null, [arow('Users', 100.4)]);
  assert.deepEqual(Object.keys(state.fired.Users).sort(), ['100', '80', '95']);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].threshold, 100);
  assert.equal(state.pending.length, 1);
  assert.equal(L.bannerVisible(state, 0), true);
});

test('alerts: each level fires once; a higher level fires later', () => {
  let r = run(null, [arow('E', 81)]);
  assert.equal(r.firings[0].threshold, 80);
  r = run(r.state, [arow('E', 85)], '2026-10-07');
  assert.equal(r.firings.length, 0, 'already fired');
  r = run(r.state, [arow('E', 96)], '2026-10-08');
  assert.deepEqual(r.firings.map((f) => f.threshold), [95]);
});

test('alerts: dropping back under a level re-arms it; crossing again fires again', () => {
  let r = run(null, [arow('E', 82)]);
  r = run(r.state, [arow('E', 70)], '2026-10-07');
  assert.equal(r.state.fired.E, undefined, 're-armed');
  assert.equal(r.state.pending.length, 0, 'a re-armed alert is no longer pending');
  r = run(r.state, [arow('E', 81)], '2026-10-08');
  assert.deepEqual(r.firings.map((f) => f.threshold), [80]);
});

test('alerts: while over 100% the alert repeats once a day, not twice the same day', () => {
  let r = run(null, [arow('U', 101)]);
  r = run(r.state, [arow('U', 101.2)]);
  assert.equal(r.firings.length, 0, 'same day');
  r = run(r.state, [arow('U', 101.3)], '2026-10-07');
  assert.equal(r.firings.length, 1);
  assert.equal(r.firings[0].repeat, true);
  assert.equal(r.firings[0].threshold, 100);
  // Exactly at the limit: fired once, no daily repeat.
  let s = run(null, [arow('A', 100)]);
  s = run(s.state, [arow('A', 100)], '2026-10-07');
  assert.equal(s.firings.length, 0);
});

test('alerts: unknown percent neither fires nor re-arms; removed thresholds are forgotten', () => {
  let r = run(null, [arow('E', 96)]);
  r = run(r.state, [{ id: 'E', percent: null }], '2026-10-07');
  assert.deepEqual(Object.keys(r.state.fired.E).sort(), ['80', '95']);
  r = run(r.state, [arow('E', 96)], '2026-10-08', [80]);
  assert.deepEqual(Object.keys(r.state.fired.E), ['80']);
});

test('alerts: snooze hides the banner for a day, a new firing brings it back; dismiss clears; reset = empty', () => {
  const now = 5_000;
  let r = run(null, [arow('E', 81)]);
  let st = L.snoozeAlerts(r.state, now);
  assert.equal(L.bannerVisible(st, now + 1000), false);
  assert.equal(L.bannerVisible(st, now + L.DAY_MS), true);
  r = run(st, [arow('E', 96)], '2026-10-07');
  assert.equal(r.state.snoozeUntil, 0);
  assert.equal(L.bannerVisible(r.state, now + 1000), true);
  assert.equal(r.state.pending.length, 1, 'one pending entry per row (its newest level)');
  st = L.dismissAlerts(r.state);
  assert.equal(L.bannerVisible(st, now), false);
  assert.deepEqual(Object.keys(st.fired.E).sort(), ['80', '95'], 'dismissing keeps what fired');
  // "Reset alerts" removes the stored state: everything fires again.
  const again = run(L.emptyAlertState(), [arow('E', 96)]);
  assert.deepEqual(again.firings.map((f) => f.threshold), [95]);
});

test('alerts: fired summary and text', () => {
  const r = run(null, [{ ...arow('TotalUsersAllTime', 100.4), label: 'Total users' }, { ...arow('TotalCustomEvents', 81), label: 'Custom events' }]);
  const rows = [{ id: 'TotalUsersAllTime', label: 'Total users' }, { id: 'TotalCustomEvents', label: 'Custom events' }];
  assert.equal(L.firedSummary(r.state, rows), 'Total users at 80%, 95% and 100%; Custom events at 80%');
  const t = L.alertText({ label: 'Total users', threshold: 100, value: 5_021_733, limit: 5_000_000, percent: 100.43 }, { more: 1, projectionLine: 'crossed ~Sep 14' });
  assert.equal(t.title, 'Total users: over your contract limit');
  assert.equal(t.detail, '5,021,733 of 5,000,000 (100.4%) · crossed ~Sep 14 · 1 more limit past an alert');
  assert.equal(t.tone, 'bad');
  const n = L.notificationText({ label: 'Custom events', short: 'Events', threshold: 80, value: 81, limit: 100, percent: 81.2 });
  assert.equal(n.title, 'Iterable: custom events at 81% of limit');
});

test('normalizeAlertState: junk in storage is repaired', () => {
  const s = L.normalizeAlertState({ fired: { E: { 80: 'yesterday', 95: '2026-10-01' }, X: 'no' }, pending: [null, { id: 'E', threshold: 95 }], snoozeUntil: 'x' });
  assert.deepEqual(s, { fired: { E: { 95: '2026-10-01' } }, pending: [{ id: 'E', threshold: 95 }], snoozeUntil: 0 });
});

// ── Chip, badge, watching ────────────────────────────────────────────────

test('chipModel: worst watched row; only past a threshold unless "always"', () => {
  const snap = snapshot();
  const c = L.chipModel(snap.rows, [80, 95], 'alert');
  assert.equal(c.text, 'Users 100%');
  assert.equal(c.tone, 'bad');
  const watched = L.watchedRows(snap.rows, ['TotalUsersAllTime']);
  assert.equal(L.chipModel(watched, [80, 95], 'alert').text, 'Events 80%');
  const calm = [{ id: 'a', short: 'Events', label: 'Custom events', percent: 50, value: 5, limit: 10 }];
  assert.equal(L.chipModel(calm, [80, 95], 'alert'), null);
  assert.equal(L.chipModel(calm, [80, 95], 'always').tone, 'ok');
  assert.equal(L.chipModel([], [80], 'always'), null);
});

test('badgeFor: worst watched percent past a threshold across orgs; cleared otherwise', () => {
  const a = snapshot();
  const calm = { rows: [{ id: 'x', percent: 40 }] };
  assert.deepEqual(L.badgeFor([calm, a], { thresholds: [80, 95], unwatched: [] }), { text: '100%', color: L.BADGE_COLORS.over });
  assert.deepEqual(L.badgeFor([a], { thresholds: [80, 95], unwatched: ['TotalUsersAllTime'] }), { text: '80%', color: L.BADGE_COLORS.warn });
  assert.equal(L.badgeFor([calm, null], { thresholds: [80, 95] }), null);
  assert.equal(L.badgeFor([{ rows: [{ id: 'y', percent: 4321 }] }], {}).text, '999%');
});

// ── Orgs, once-a-day gate ────────────────────────────────────────────────

test('org keys: host + sorted project ids; restorable state names', () => {
  assert.equal(L.orgKey('app.iterable.com', ['300', 20, '1000']), 'app.iterable.com|20,300,1000');
  assert.equal(L.orgSlot('app.iterable.com', ['2', '1']), L.orgSlot('app.iterable.com', ['1', '2']));
  assert.notEqual(L.orgSlot('app.iterable.com', ['1']), L.orgSlot('app.eu.iterable.com', ['1']));
  assert.notEqual(L.orgSlot('app.iterable.com', ['1']), L.orgSlot('app.iterable.com', ['1', '2']));
  for (const name of ['snap:', 'alerts:', 'check:'].map((p) => p + L.orgSlot('app.iterable.com', ['1'])).concat('check:' + L.unknownSlot('app.iterable.com', '1'), 'orgs', 'access')) {
    assert.match(name, RESTORE_NAME_RE);
  }
});

test('findOrgSlot: by host and current project, newest entry wins', () => {
  const orgs = {
    oA: { host: 'app.iterable.com', projectIds: ['1', '2'], updatedAt: 5 },
    oB: { host: 'app.eu.iterable.com', projectIds: ['1'], updatedAt: 9 },
    oC: { host: 'app.iterable.com', projectIds: ['2', '3'], updatedAt: 7 },
  };
  assert.equal(L.findOrgSlot(orgs, 'app.iterable.com', '1'), 'oA');
  assert.equal(L.findOrgSlot(orgs, 'app.iterable.com', 2), 'oC');
  assert.equal(L.findOrgSlot(orgs, 'app.eu.iterable.com', '1'), 'oB');
  assert.equal(L.findOrgSlot(orgs, 'app.iterable.com', '99'), null);
  assert.equal(L.findOrgSlot(orgs, 'app.iterable.com', null), 'oC', 'no project detected: the newest org on the host');
  assert.equal(L.findOrgSlot(orgs, 'app.getbee.io', null), null);
  assert.equal(L.findOrgSlot(null, 'app.iterable.com', '1'), null);
});

test('shouldCheck: once per PST day, not while locked, failures retry after an hour, refusals wait', () => {
  const now = 1_000_000;
  const at = { today: TODAY, now };
  assert.equal(L.shouldCheck(null, at), true);
  assert.equal(L.shouldCheck(L.gateAfter('ok', at), at), false);
  assert.equal(L.shouldCheck(L.gateAfter('ok', at), { today: '2026-10-07', now }), true);
  const failed = L.gateAfter('failed', at);
  assert.equal(L.shouldCheck(failed, { today: TODAY, now: now + 1000 }), false);
  assert.equal(L.shouldCheck(failed, { today: TODAY, now: now + L.RETRY_MS }), true);
  const denied = L.gateAfter('denied', at);
  assert.equal(denied.noAccess, true);
  assert.equal(L.shouldCheck(denied, { today: TODAY, now: now + 10 * L.RETRY_MS }), false);
  assert.equal(L.shouldCheck(denied, { today: '2026-10-07', now }), true);
  // Lock: another tab's fresh lock blocks, a stale one doesn't.
  const locked = L.lockEntry({ day: '2026-10-05' }, { now, lockId: 'a' });
  assert.equal(L.shouldCheck(locked, { today: TODAY, now: now + 1000 }), false);
  assert.equal(L.shouldCheck(locked, { today: TODAY, now: now + L.LOCK_MS + 1 }), true);
  assert.equal(L.holdsLock(locked, 'a'), true);
  assert.equal(L.holdsLock(L.lockEntry(locked, { now, lockId: 'b' }), 'a'), false, 'the later writer wins');
  assert.equal(L.isDenied(new HttpError(403)), true);
  assert.equal(L.isDenied(new HttpError(500)), false);
});

test('data: saveSnapshot keys state per org; loadForProject finds it; Check now clears the gates', async () => {
  const state = createState('usage-monitor');
  const snap = snapshot();
  const slot = await D.saveSnapshot(state, snap, { fallbackProjectId: '11111', gate: L.gateAfter('ok', { today: TODAY, now: 1 }) });
  assert.equal(slot, L.orgSlot('app.iterable.com', ['11111', '2222']));
  const found = await D.loadForProject(state, 'app.iterable.com', '2222');
  assert.equal(found.slot, slot);
  assert.equal(found.snap.rows.length, snap.rows.length);
  assert.equal((await D.loadForProject(state, 'app.eu.iterable.com', '2222')).snap, null, 'other host, other org');
  assert.deepEqual((await D.allSnapshots(state)).map((x) => x.slot), [slot]);
  await state.set('check:' + L.unknownSlot('app.iterable.com', '5'), { day: TODAY });
  await D.clearCheckGates(state);
  assert.deepEqual((await state.list()).filter((n) => n.startsWith('check:')), []);
  assert.ok(await state.get('snap:' + slot), 'snapshots stay');
});

test('data: fetchSnapshot queries the term; a failed term query falls back to 30 days', async () => {
  const calls = [];
  const http = (failTerm) => ({
    async appFetch(path, opts = {}) {
      calls.push([path, opts.method || 'GET']);
      if (path === L.LIMITS_PATH) return LIMITS;
      if (failTerm && path.includes('startDatePST=2026-04-29')) throw new HttpError(504);
      return USAGE;
    },
  });
  const ok = await D.fetchSnapshot(http(false), { today: TODAY, now: 1, host: 'app.iterable.com' });
  assert.deepEqual(calls.map((c) => c[1]), ['POST', 'GET', 'GET'], 'limits, term usage, month-to-date journey events');
  assert.ok(calls[1][0].includes('startDatePST=2026-04-29&endDatePST=2027-04-28'));
  assert.equal(ok.query.partial, false);
  calls.length = 0;
  const fb = await D.fetchSnapshot(http(true), { today: TODAY, now: 1, host: 'app.iterable.com' });
  assert.equal(calls.length, 4);
  assert.ok(calls[2][0].includes('startDatePST=2026-09-07&endDatePST=2026-10-06'));
  assert.equal(fb.query.partial, true);
  assert.equal(row(fb, 'TotalCustomEvents').unavailable, true);
  await assert.rejects(D.fetchSnapshot({ appFetch: async () => { throw new HttpError(401); } }, { today: TODAY, now: 1, host: 'app.iterable.com' }),
    (e) => L.isDenied(e));
});

// ── SMS tab ──────────────────────────────────────────────────────────────

test('SMS tab: hidden without SMS limits or usage; shown for either, with breakdowns', () => {
  assert.equal(snapshot().sms.visible, false, 'SmsSegmentsSent limit is empty and its usage is 0');
  const withLimit = structuredClone(LIMITS);
  withLimit.metricUsageLimit.SmsSegmentsSent = [lim(2_000_000)];
  assert.equal(snapshot({ limits: withLimit }).sms.visible, true);

  const usage = structuredClone(USAGE);
  usage.values.ByOrg[0].push(usageRow('SmsSegmentsReceived', 4200), usageRow('MmsAttachmentsSent', 33));
  usage.values.ByOrg[0].find((r) => r.metricName === 'SmsSegmentsSent').value = 61_000;
  usage.values.ByOrgBillingParty[0].push(
    { metricName: 'SmsSegmentsSent', value: 60_000, billingParty: 'FirstParty' },
    { metricName: 'SmsSegmentsSent', value: 1000, billingParty: 'ThirdParty' },
    { metricName: 'SmsSegmentsReceived', value: 4200, billingParty: 'FirstParty' });
  usage.values.ByOrgProviderBillingParty = { 0: [
    { metricName: 'SmsSegmentsSent', value: 50_000, providerName: 'ProviderA', billingParty: 'FirstParty' },
    { metricName: 'SmsSegmentsSent', value: 11_000, providerName: 'ProviderB', billingParty: 'FirstParty' },
    { metricName: 'SmsSegmentsSent', value: 0, providerName: 'ProviderC', billingParty: 'FirstParty' },
  ] };
  usage.values.ByOrgBillingPartyRecipientCountry = { 0: [{ metricName: 'SmsSegmentsSent', value: 61_000, recipientCountry: 'US', billingParty: 'FirstParty' }] };
  const sms = snapshot({ usage }).sms;
  assert.equal(sms.visible, true);
  assert.deepEqual(sms.metrics.map((m) => [m.metric, m.value]), [['SmsSegmentsSent', 61_000], ['SmsSegmentsReceived', 4200], ['MmsAttachmentsSent', 33]]);
  assert.deepEqual(sms.byParty, [{ name: 'First party', value: 64_200 }, { name: 'Third party', value: 1000 }]);
  assert.deepEqual(sms.byProvider, [{ name: 'ProviderA', value: 50_000 }, { name: 'ProviderB', value: 11_000 }]);
  assert.deepEqual(sms.byCountry, [{ name: 'US', value: 61_000 }]);
  assert.equal(snapshot({ usage }).unlimited.some((u) => L.isSmsMetric(u.metric)), false);
});

test('smsVisible: limit rows or non-zero usage only', () => {
  assert.equal(L.smsVisible([], new Map([['SmsSegmentsSent', { value: 0 }]])), false);
  assert.equal(L.smsVisible([], new Map([['MmsAttachmentsReceived', { value: 2 }]])), true);
  assert.equal(L.smsVisible([{ metric: 'SuccessfulSmsVerifications' }], new Map()), true);
});

// ── Background notification message ──────────────────────────────────────

test('wb:usage:notify: app content scripts only, exact fields, URL from the sender origin allowlist', () => {
  const sender = (url, frameId = 0) => ({ url, frameId, tab: { id: 3 } });
  assert.equal(senderAllowed('wb:usage:notify', 'app'), true);
  for (const k of ['extension', 'bee', 'auth']) assert.equal(senderAllowed('wb:usage:notify', k), false, k);
  const ok = checkUsageNotify({ type: 'wb:usage:notify', title: 'T\u0007itle', message: 'Body' }, sender('https://app.eu.iterable.com/campaigns'), 'app');
  assert.equal(ok.ok, true);
  assert.equal(ok.title, 'T itle');
  assert.equal(usageNotificationUrl(ok.notificationId), 'https://app.eu.iterable.com/payments/info');
  assert.equal(usageNotificationUrl(checkUsageNotify({ type: 'x', title: 'a', message: 'b' }, sender('https://app.iterable.com/'), 'app').notificationId),
    'https://app.iterable.com/payments/info');
  assert.equal(checkUsageNotify({ type: 'x', title: 'a', message: 'b', url: 'https://evil.example' }, sender('https://app.iterable.com/'), 'app').ok, false);
  assert.equal(checkUsageNotify({ type: 'x', title: 'a', message: 'b' }, sender('https://app.iterable.com/', 2), 'app').ok, false);
  assert.equal(checkUsageNotify({ type: 'x', title: 'a', message: 'b' }, sender('https://app.getbee.io/'), 'bee').ok, false);
  assert.equal(checkUsageNotify({ type: 'x', title: '', message: 'b' }, sender('https://app.iterable.com/'), 'app').ok, false);
  assert.equal(checkUsageNotify({ type: 'x', title: 'a'.repeat(500), message: 'b' }, sender('https://app.iterable.com/'), 'app').title.length, USAGE_NOTIFY_TITLE_MAX);
  for (const id of ['wb-usage:2', 'wb-usage:', 'wb-usage:01', 'other:0', null]) assert.equal(usageNotificationUrl(id), null, String(id));
});

// ── Regressions (verifier review of 92351eb) ─────────────────────────────

test('regression: projection with a tiny pace never throws and is not dated', () => {
  const limits = L.parseLimits({ metricUsageLimit: { TotalCustomEvents: [lim(50_000_000, {}, { start: '2026-01-01', end: '2026-12-31' })] } }, TODAY);
  const usage = L.parseUsage({ values: { ByOrg: { 0: [usageRow('TotalCustomEvents', 50)] } } });
  const snap = L.buildSnapshot({ limits, usage, query: { start: '2026-01-01', end: '2026-12-31', partial: false }, term: { start: '2026-01-01', end: '2026-12-31' }, today: TODAY, now: 1, host: 'app.iterable.com' });
  const r = snap.rows[0];
  assert.ok(r.rate > 0 && r.rate < 1);
  const p = L.projection(r, [80, 95]);
  assert.deepEqual(p, { kind: 'reaches', threshold: 80, date: null, afterTerm: true, period: 'term' });
  assert.equal(L.projectionText(p), 'stays under 80% this term');
  // Over the limit at an absurdly slow pace: no crossed date rather than a throw.
  assert.equal(L.projection({ percent: 200, value: 2e15, limit: 1e15, rate: 1e-6, dataThrough: '2026-10-05', termEnd: '2027-01-01' }, [80]), null);
  assert.equal(L.addDays('2026-10-05', 1e12), '');
});

test('regression: a project missing from usageV4 projects (or none detected) still finds the org and its gate', async () => {
  const state = createState('usage-monitor');
  const today = TODAY;
  const slot = await D.saveSnapshot(state, snapshot(), { fallbackProjectId: '99999', gate: L.gateAfter('ok', { today, now: 1 }) });
  assert.equal(slot, L.orgSlot('app.iterable.com', ['11111', '2222']), 'the slot still comes from the response');
  const found = await D.loadForProject(state, 'app.iterable.com', '99999');
  assert.equal(found.slot, slot);
  assert.equal(L.shouldCheck(await state.get('check:' + found.slot), { today, now: 2 }), false, 'next load does not check again');
  assert.equal((await D.loadForProject(state, 'app.iterable.com', null)).slot, slot, 'no project detected');
  // A later check from another project keeps the earlier one mapped.
  await D.saveSnapshot(state, snapshot(), { fallbackProjectId: '11111', gate: L.gateAfter('ok', { today, now: 3 }) });
  assert.equal((await D.loadForProject(state, 'app.iterable.com', '99999')).slot, slot);
});

test('regression: a party limit is 0 when the metric has party rows but none for that party', () => {
  const limits = { metricUsageLimit: { TotalEmailsSent: [lim(1000, { BillingParty: 'ThirdParty' })] } };
  const usage = structuredClone(USAGE);
  usage.values.ByOrgBillingParty = { 0: [{ metricName: 'TotalEmailsSent', value: 800, billingParty: 'FirstParty' }] };
  const r = row(snapshot({ usage, limits }), 'TotalEmailsSent:ThirdParty');
  assert.equal(r.value, 0);
  assert.equal(r.percent, 0);
  // No party breakdown for the metric at all: the org total.
  usage.values.ByOrgBillingParty = { 0: [{ metricName: 'SmsSegmentsSent', value: 5, billingParty: 'FirstParty' }] };
  assert.equal(row(snapshot({ usage, limits }), 'TotalEmailsSent:ThirdParty').value, 9_100_000);
});

test('regression: exactly at a threshold counts (no 56.99999… for 57 of 100)', () => {
  assert.equal(L.percentOf(57, 100), 57);
  assert.equal(L.percentOf(29, 100), 29);
  assert.equal(L.percentOf(58, 100), 58);
  for (const t of [29, 57, 58]) {
    const limits = { metricUsageLimit: { TotalCustomEvents: [lim(100)] } };
    const usage = { values: { ByOrg: { 0: [usageRow('TotalCustomEvents', t)] } } };
    const r = row(snapshot({ usage, limits }), 'TotalCustomEvents');
    assert.equal(L.rowState(r, [t]), 'warn', String(t));
    assert.deepEqual(run(null, [r], TODAY, [t]).firings.map((f) => f.threshold), [t]);
  }
});

test('regression: a pending alert for a row that is no longer watched (or gone) is dropped', () => {
  let r = run(null, [arow('A', 90), arow('B', 85)]);
  assert.equal(r.state.pending.length, 2);
  r = run(r.state, [arow('B', 85)]); // A unwatched since
  assert.deepEqual(r.state.pending.map((p) => p.id), ['B']);
});

test('regression: badge ignores no-access hosts and stale snapshots; popup status says why', () => {
  const now = 10 * L.DAY_MS;
  const snap = { ...snapshot(), at: now - 1000 };
  const values = { thresholds: [80, 95] };
  assert.equal(L.badgeFor([snap], values, { now, access: {} }).text, '100%');
  assert.equal(L.badgeFor([snap], values, { now, access: { 'app.iterable.com': { denied: true } } }), null);
  assert.equal(L.badgeFor([{ ...snap, at: now - L.STALE_MS - 1 }], values, { now }), null);
  assert.equal(L.snapshotStatus(snap, { now, access: { 'app.iterable.com': { denied: true } } }), 'denied');
  assert.equal(L.snapshotStatus({ ...snap, at: now - L.STALE_MS - 1 }, { now }), 'stale');
  assert.equal(L.snapshotStatus(snap, { now, access: { 'app.eu.iterable.com': { denied: true } } }), 'ok');
});

test('regression: no usage row after a good term query is "missing", not "unavailable"', () => {
  const limits = { metricUsageLimit: { PushNotificationsSent: [lim(1000)] } };
  const usage = { values: { ByOrg: { 0: [] } } };
  const r = row(snapshot({ usage, limits }), 'PushNotificationsSent');
  assert.equal(r.missing, true);
  assert.equal(r.unavailable, false);
  const fb = row(snapshot({ usage, limits, partial: true }), 'PushNotificationsSent');
  assert.equal(fb.unavailable, true);
  assert.equal(fb.missing, false);
});

test('regression: lock outlives a worst-case check; notification keys are per row, level and day', () => {
  assert.ok(L.LOCK_MS > 3 * L.REQUEST_TIMEOUT_MS);
  assert.equal(L.firingKey({ id: 'TotalUsersAllTime', threshold: 100 }, TODAY), 'TotalUsersAllTime|100|2026-10-06');
  assert.match('notified:' + L.orgSlot('app.iterable.com', ['1']), RESTORE_NAME_RE);
});

// ── No-limit section, labels, journey events default limit ──────────────

const byOrgOf = (pairs, through = '2026-10-05') => new Map(pairs.map(([m, value, d]) => [m, { value, lastAvailableDate: d || through, highWatermarkDate: null }]));

test('no-limit list: a limited metric never appears, whatever billing party its limit is for', () => {
  const limits = L.parseLimits({ metricUsageLimit: { TotalEmailsSent: [lim(400_000_000, { BillingParty: 'FirstParty' })] } }, TODAY);
  assert.equal(limits[0].id, 'TotalEmailsSent:FirstParty');
  const list = L.buildUnlimited(byOrgOf([['TotalEmailsSent', 184_000_000], ['CatalogLookup', 120]]), limits);
  assert.deepEqual(list.map((u) => u.metric), ['CatalogLookup']);
  // Same display name under another metric name (usage named differently from the limit): still out.
  const renamed = L.buildUnlimited(byOrgOf([['EmailsSent', 5], ['CatalogLookup', 120]]), [{ metric: 'TotalEmailsSent', id: 'TotalEmailsSent:FirstParty' }]);
  assert.deepEqual(renamed.map((u) => u.metric), ['CatalogLookup'], 'EmailsSent reads "Emails sent" too');
  // Through buildSnapshot as well (the card's list).
  const usage = structuredClone(USAGE);
  usage.values.ByOrgBillingParty = { 0: [] };
  assert.equal(snapshot({ usage }).unlimited.some((u) => u.metric === 'TotalEmailsSent'), false);
});

test('no-limit list: watermarks of limited metrics dropped; an equal base+watermark pair listed once', () => {
  const limits = [{ metric: 'TotalCustomEvents', id: 'TotalCustomEvents' }, { metric: 'TotalUsersAllTime', id: 'TotalUsersAllTime' }];
  const list = L.buildUnlimited(byOrgOf([
    ['TotalCustomEventsHighWatermark', 35_000_000], // base limited → out
    ['TotalUsersHighWatermark', 9_000_000], // users HWM is a card fact → out
    ['ActiveUsersHighWatermark', 9_000_000],
    ['WidgetsAllTime', 70], ['WidgetsHighWatermark', 70], // equal → only the watermark
    ['GadgetsAllTime', 10], ['GadgetsHighWatermark', 12], // different → both
  ]), limits);
  assert.deepEqual(list.map((u) => [u.metric, u.label]), [
    ['ActiveUsersHighWatermark', 'Active users, high watermark'],
    ['GadgetsAllTime', 'Gadgets all time'],
    ['GadgetsHighWatermark', 'Gadgets, high watermark'],
    ['WidgetsHighWatermark', 'Widgets, high watermark'],
  ]);
});

test('labels: flows over the term say "this term"; Journey events everywhere', () => {
  assert.equal(L.noLimitLabel('ActiveUsersAddedInPeriod'), 'Active users added this term');
  assert.equal(L.noLimitLabel('CatalogLookup'), 'Catalog lookups this term');
  assert.equal(L.noLimitLabel('SomethingNewInPeriod'), 'Something new this term');
  assert.equal(L.noLimitLabel('CatalogLookup', { partial: true }), 'Catalog lookups, last 30 days');
  assert.equal(L.noLimitLabel('TotalCustomEventsHighWatermark'), 'Custom events, high watermark');
  assert.equal(L.noLimitLabel('ActiveUsersAllTime'), 'Active users');
  assert.equal(L.metricLabel('JvtCount'), 'Journey events');
  const jvt = { id: 'JvtCount', label: 'Journey events', short: 'Journeys', threshold: 80, percent: 81, value: 1_620_000, limit: 2_000_000, period: 'month' };
  assert.equal(L.notificationText(jvt).title, 'Iterable: journey events at 81% of limit');
  assert.equal(L.alertText(jvt).title, 'Journey events: past 80% of your monthly limit');
  assert.equal(L.chipModel([{ ...jvt, id: 'JvtCount' }], [80], 'alert').text, 'Journeys 81%');
});

test('collapsed section rows: one shared date (most common), per-row dates only where different', () => {
  const sec = L.noLimitSection([
    { label: 'A', value: 1, dataThrough: '2026-10-05' },
    { label: 'B', value: 2, dataThrough: '2026-10-01' },
    { label: 'C', value: 3, dataThrough: '2026-10-05' },
    { label: 'D', value: 4, dataThrough: null },
  ]);
  assert.equal(sec.count, 4);
  assert.equal(sec.through, '2026-10-05');
  assert.deepEqual(sec.rows.map((r) => r.date), [null, '2026-10-01', null, null]);
  assert.equal(L.noLimitSection([{ label: 'X', value: 1, dataThrough: '2026-10-01' }, { label: 'Y', value: 1, dataThrough: '2026-10-05' }]).through, '2026-10-05', 'tie → the later date');
  assert.deepEqual(L.noLimitSection([]), { count: 0, through: null, rows: [] });
  assert.deepEqual(L.noLimitSection(undefined).count, 0);
});

test('journey events: default 2M monthly limit synthesized for the PST month; a real limit wins', () => {
  assert.deepEqual(L.monthBounds('2026-10-06'), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(L.monthBounds('2026-02-14'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(L.monthBounds('2026-12-31'), { start: '2026-12-01', end: '2026-12-31' });
  const all = L.withDefaultLimits(L.parseLimits(LIMITS, TODAY), TODAY);
  const jvt = all.find((l) => l.metric === 'JvtCount');
  assert.deepEqual(jvt, { id: 'JvtCount', metric: 'JvtCount', party: null, limit: 2_000_000, termStart: '2026-10-01', termEnd: '2026-10-31', period: 'month', defaultLimit: true });
  const real = { metricUsageLimit: { JvtCount: [lim(500_000)] } };
  const withReal = L.withDefaultLimits(L.parseLimits(real, TODAY), TODAY);
  assert.equal(withReal.length, 1);
  assert.equal(withReal[0].limit, 500_000);
  assert.equal(withReal[0].period, undefined, 'a real limit is a term limit');
  assert.equal(L.formatRange('2026-10-01', '2026-10-31'), 'Oct 1 – 31');
  assert.equal(L.formatPercent(0.0053), '0.01%');
  assert.equal(L.formatPercent(0.456), '0.45%');
  assert.equal(L.formatPercent(0), '0.0%');
  assert.equal(L.formatPercent(78.46), '78.4%');
  assert.ok(L.monthUsagePath('2026-10-01', '2026-10-31', ['Jvt']).endsWith('?metricGroups=Jvt&aggLevels=ByOrg&startDatePST=2026-10-01&endDatePST=2026-10-31'));
});

function jvtSnapshot({ monthValue = 106, failed = false, today = TODAY, through = '2026-10-05' } = {}) {
  const limits = L.withDefaultLimits(L.parseLimits(LIMITS, today), today);
  const { start, end } = L.monthBounds(today);
  const month = { start, end, usage: failed ? null : L.parseUsage({ values: { ByOrg: { 0: monthValue == null ? [] : [usageRow('JvtCount', monthValue, { lastAvailableDate: through })] } } }) };
  const term = L.contractTerm(L.parseLimits(LIMITS, today), LIMITS, today);
  return L.buildSnapshot({ limits, usage: L.parseUsage(USAGE), query: { ...term, partial: false }, term, today, now: 1, host: 'app.iterable.com', month });
}

test('journey events: month-to-date value (not the term sum), monthly pace, no-limit list excludes it', () => {
  const snap = jvtSnapshot();
  const r = row(snap, 'JvtCount');
  assert.equal(r.value, 106, 'the month query, not the 512 term total');
  assert.equal(r.period, 'month');
  assert.equal(r.defaultLimit, true);
  assert.equal(r.alertKey, 'JvtCount@2026-10');
  assert.ok(Math.abs(r.percent - 0.0053) < 1e-9);
  assert.equal(r.rate, 106 / 5); // Oct 1–5
  assert.equal(snap.unlimited.some((u) => u.metric === 'JvtCount'), false);
  const p = L.projection(r, [80, 95]);
  assert.equal(p.period, 'month');
  assert.equal(p.afterTerm, true);
  assert.equal(L.projectionText(p), 'stays under 80% this month');
  // A fast month: dated inside the month.
  const fast = row(jvtSnapshot({ monthValue: 1_500_000 }), 'JvtCount'); // 75% after 5 days
  const q = L.projection(fast, [80, 95]);
  assert.equal(q.afterTerm, false);
  assert.equal(L.projectionText(q, { refDay: TODAY }), 'reaches 80% ~Oct 6');
});

test('journey events: a failed month query marks only that row unavailable; no row = missing', () => {
  const snap = jvtSnapshot({ failed: true });
  const r = row(snap, 'JvtCount');
  assert.equal(r.unavailable, true);
  assert.equal(r.value, null);
  assert.equal(L.rowState(r, [80]), 'unknown');
  assert.equal(row(snap, 'TotalUsersAllTime').value, 5_021_733, 'other rows unaffected');
  assert.equal(row(jvtSnapshot({ monthValue: null }), 'JvtCount').missing, true);
});

test('journey events: last month\'s firing never suppresses a fresh crossing next month', () => {
  const oct = { ...row(jvtSnapshot({ monthValue: 1_700_000 }), 'JvtCount') }; // 85%
  let r = run(null, [oct], '2026-10-30');
  assert.deepEqual(r.firings.map((f) => f.threshold), [80]);
  assert.ok(r.state.fired['JvtCount@2026-10']);
  // November: the value is month-to-date again and already 85% on the 1st (a big send).
  const nov = { ...row(jvtSnapshot({ monthValue: 1_700_000, today: '2026-11-01', through: '2026-11-01' }), 'JvtCount') };
  assert.equal(nov.alertKey, 'JvtCount@2026-11');
  r = run(r.state, [nov], '2026-11-01');
  assert.deepEqual(r.firings.map((f) => f.threshold), [80], 'fires again in the new month');
  assert.equal(r.state.fired['JvtCount@2026-10'], undefined, 'old month entry cleaned up');
  assert.equal(L.firedSummary(r.state, [nov]), 'Journey events at 80%');
  assert.equal(r.state.pending.length, 1);
});

test('data: fetchSnapshot adds the month-to-date request only for a default limit, failure contained', async () => {
  const calls = [];
  const http = (limits, failMonth) => ({
    async appFetch(path, opts = {}) {
      calls.push(path);
      if (path === L.LIMITS_PATH) return limits;
      if (path.includes('aggLevels=ByOrg&')) {
        if (failMonth) throw new HttpError(500);
        return { values: { ByOrg: { 0: [usageRow('JvtCount', 106)] } } };
      }
      return USAGE;
    },
  });
  const ok = await D.fetchSnapshot(http(LIMITS, false), { today: TODAY, now: 1, host: 'app.iterable.com' });
  assert.ok(calls[2].includes('metricGroups=Jvt&aggLevels=ByOrg&startDatePST=2026-10-01&endDatePST=2026-10-31'));
  assert.equal(row(ok, 'JvtCount').value, 106);
  calls.length = 0;
  const bad = await D.fetchSnapshot(http(LIMITS, true), { today: TODAY, now: 1, host: 'app.iterable.com' });
  assert.equal(row(bad, 'JvtCount').unavailable, true);
  assert.equal(row(bad, 'TotalUsersAllTime').value, 5_021_733);
  calls.length = 0;
  const real = structuredClone(LIMITS);
  real.metricUsageLimit.JvtCount = [lim(500_000)];
  const withReal = await D.fetchSnapshot(http(real, false), { today: TODAY, now: 1, host: 'app.iterable.com' });
  assert.equal(calls.length, 2, 'no month request when the contract has its own limit');
  assert.equal(row(withReal, 'JvtCount').value, 512, 'a real limit compares the term total');
});
