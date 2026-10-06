// Usage monitor: pure logic (no DOM, no chrome.*). Shared by the content script (index.js), the
// options editor (settings-ui.js), the popup and the background (toolbar badge), and unit-tested.
//
// Two undocumented, session-authenticated endpoints feed it:
//   POST /i/account/usageLimits   the contract's annual limits per metric (empty array = no limit)
//   GET  /i/account/usageV4       usage for a date range; stock metrics (users, high watermarks)
//                                 return their latest value, flow metrics (sends, events) the sum
//                                 over the range. Queried over the contract term, so a flow value
//                                 is exactly what its annual limit is compared against.
// Every date here is a PST calendar day ('YYYY-MM-DD', America/Los_Angeles), as the API uses.

import { stableHash64 } from '../../core/hash.js';

export const FEATURE_ID = 'usage-monitor';
export const LIMITS_PATH = '/i/account/usageLimits';
export const USAGE_PATH = '/i/account/usageV4';
export const BILLING_PATH = '/payments/info';

/** Sent to usageLimits. Limits on other metrics only show up when they are asked for. */
export const LIMIT_METRICS = Object.freeze([
  'TotalCustomEvents', 'JvtCount', 'TotalEmailsSent', 'InAppNotificationsSent', 'PushNotificationsSent',
  'WebPushNotificationsSent', 'MmsAttachmentsReceived', 'MmsAttachmentsSent', 'SmsSegmentsSent',
  'SmsSegmentsReceived', 'SuccessfulSmsVerifications', 'TotalUsersAllTime',
]);

const AGG_LEVELS = [
  'ByOrg', 'ByOrgBillingParty', 'ByOrgBillingPartyRecipientCountry', 'ByOrgProjectGlobalSmsExport',
  'ByOrgProjectJourney', 'ByOrgProviderBillingParty', 'ByOrgGlobalSmsExport',
];
const METRIC_GROUPS = ['Catalog', 'Events', 'Jvt', 'Messaging', 'Sms', 'Users'];

export const DEFAULT_THRESHOLDS = Object.freeze([80, 95]);
export const MAX_THRESHOLDS = 8;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed check (not a refusal) is tried again on a page load this much later. */
export const RETRY_MS = 60 * 60 * 1000;
/** How long one tab holds the check lock before another may take over. */
export const LOCK_MS = 90 * 1000;
/** Window used when the term-range query fails. */
export const FALLBACK_DAYS = 30;

// ── PST dates ─────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let pstFmt = null;

export function isDay(s) {
  return typeof s === 'string' && DAY_RE.test(s);
}

/** Today's date in America/Los_Angeles → 'YYYY-MM-DD'. */
export function pstDay(now = Date.now()) {
  pstFmt ||= new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(pstFmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a, b) {
  return dayNum(b) - dayNum(a);
}

export function addDays(s, n) {
  return new Date((dayNum(s) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'Sep 29' (adds the year when it isn't `refYear`, or always with `year: true`). */
export function formatDay(s, { refDay, year = false } = {}) {
  if (!isDay(s)) return '';
  const showYear = year || (isDay(refDay) && refDay.slice(0, 4) !== s.slice(0, 4));
  return new Date(dayNum(s) * DAY_MS).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(showYear ? { year: 'numeric' } : {}),
  });
}

export function formatTerm(term) {
  if (!term || !isDay(term.start) || !isDay(term.end)) return '';
  return `${formatDay(term.start, { year: true })} – ${formatDay(term.end, { year: true })}`;
}

// ── Numbers ───────────────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatInt(n) {
  return Number.isFinite(n) ? intFmt.format(Math.round(n)) : '—';
}

export function formatCompact(n) {
  return Number.isFinite(n) ? compactFmt.format(n) : '—';
}

/** 100.43 → '100.4%'; null → '—'. */
export function formatPercent(p) {
  if (!Number.isFinite(p)) return '—';
  return `${(Math.floor(p * 10) / 10).toFixed(1)}%`;
}

/** When a snapshot was taken, in local time: 'today 9:02 AM' or 'Oct 5, 9:02 AM'. */
export function checkedText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'never';
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return `today ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

// ── Metric names ──────────────────────────────────────────────────────────

const METRIC_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;

/** name → [label, short label for the header chip] */
const METRIC_LABELS = Object.freeze({
  TotalUsersAllTime: ['Total users', 'Users'],
  TotalCustomEvents: ['Custom events', 'Events'],
  TotalEmailsSent: ['Emails sent', 'Emails'],
  JvtCount: ['JVT', 'JVT'],
  InAppNotificationsSent: ['In-app messages sent', 'In-app'],
  PushNotificationsSent: ['Push notifications sent', 'Push'],
  WebPushNotificationsSent: ['Web push notifications sent', 'Web push'],
  SmsSegmentsSent: ['SMS segments sent', 'SMS'],
  SmsSegmentsReceived: ['SMS segments received', 'SMS in'],
  MmsAttachmentsSent: ['MMS attachments sent', 'MMS'],
  MmsAttachmentsReceived: ['MMS attachments received', 'MMS in'],
  SuccessfulSmsVerifications: ['SMS verifications', 'Verifications'],
  ActiveUsersAllTime: ['Active users', 'Active'],
  TotalUsersHighWatermark: ['High watermark', 'Watermark'],
  TotalUsersAddedInPeriod: ['Users added', 'Added'],
});

export function isMetricName(name) {
  return typeof name === 'string' && METRIC_NAME_RE.test(name);
}

/** 'SmsFooBarCount' → 'Sms foo bar count'; 'JVTCount' → 'JVT count'. */
export function decamel(name) {
  const words = String(name).replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/).filter(Boolean)
    .map((w, i) => (i > 0 && !/^[A-Z0-9]{2,}$/.test(w) ? w.toLowerCase() : w));
  return words.join(' ');
}

export function metricLabel(name) {
  return METRIC_LABELS[name]?.[0] || decamel(name);
}

export function metricShort(name) {
  return METRIC_LABELS[name]?.[1] || decamel(name).split(' ')[0];
}

/** 'FirstParty' → 'first party'. */
export function partyLabel(party) {
  return decamel(party).toLowerCase();
}

function rowLabel(metric, party) {
  return party ? `${metricLabel(metric)} (${partyLabel(party)})` : metricLabel(metric);
}

/** Stock metrics report their latest value whatever the range; everything else sums over it. */
export function isStockMetric(name) {
  return /AllTime$|HighWatermark$/.test(name);
}

export function isSmsMetric(name) {
  return /^(Sms|Mms)|Sms/.test(name);
}

const USERS = 'TotalUsersAllTime';
const SECONDARY = new Set(['TotalUsersAddedInPeriod', 'ActiveUsersAllTime', 'TotalUsersHighWatermark']);
const SMS_ORDER = ['SmsSegmentsSent', 'SmsSegmentsReceived', 'MmsAttachmentsSent', 'MmsAttachmentsReceived', 'SuccessfulSmsVerifications'];

// ── Requests ──────────────────────────────────────────────────────────────

export function limitsBody() {
  return { metricNames: [...LIMIT_METRICS] };
}

export function usagePath(start, end) {
  const q = new URLSearchParams({
    aggLevels: AGG_LEVELS.join(','), metricGroups: METRIC_GROUPS.join(','), startDatePST: start, endDatePST: end,
  });
  return `${USAGE_PATH}?${q.toString().replace(/%2C/g, ',')}`;
}

// ── Parsing ───────────────────────────────────────────────────────────────

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const shortStr = (v, max = 80) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * usageLimits response → [{ id, metric, party, limit, termStart, termEnd }]. Per metric: entries
 * whose term contains `today`, else those with the latest term end; one row per billing party
 * among them. Empty / malformed entries are skipped (empty array = no limit).
 */
export function parseLimits(data, today) {
  const map = isObj(data) ? data.metricUsageLimit : null;
  if (!isObj(map)) return [];
  const out = [];
  for (const [metric, entries] of Object.entries(map)) {
    if (!isMetricName(metric) || !Array.isArray(entries)) continue;
    const valid = entries.filter((e) => isObj(e) && num(e.annualLimit) > 0 && isDay(e.termStartDatePST) && isDay(e.termEndDatePST));
    if (!valid.length) continue;
    let pick = valid.filter((e) => e.termStartDatePST <= today && today <= e.termEndDatePST);
    if (!pick.length) {
      const latest = valid.reduce((m, e) => (e.termEndDatePST > m ? e.termEndDatePST : m), '');
      pick = valid.filter((e) => e.termEndDatePST === latest);
    }
    const seen = new Set();
    for (const e of pick) {
      const party = isObj(e.attributes) && isMetricName(e.attributes.BillingParty) ? e.attributes.BillingParty : null;
      if (seen.has(party || '')) continue;
      seen.add(party || '');
      out.push({
        id: party ? `${metric}:${party}` : metric, metric, party,
        limit: num(e.annualLimit), termStart: e.termStartDatePST, termEnd: e.termEndDatePST,
      });
    }
  }
  return out;
}

/**
 * The contract term to query: the users limit's term when it contains today, else the first
 * limit term that does, else the response's min/max term when that contains today, else null.
 */
export function contractTerm(limits, data, today) {
  const contains = (s, e) => isDay(s) && isDay(e) && s <= today && today <= e;
  const ordered = [...limits].sort((a, b) => (a.metric === USERS ? -1 : 0) - (b.metric === USERS ? -1 : 0));
  const hit = ordered.find((l) => contains(l.termStart, l.termEnd));
  if (hit) return { start: hit.termStart, end: hit.termEnd };
  if (isObj(data) && contains(data.minTermStartDatePST, data.maxTermEndDatePST)) {
    return { start: data.minTermStartDatePST, end: data.maxTermEndDatePST };
  }
  return null;
}

/** An aggregation level's rows: `{ "0": [...], "1": [...] }` (or a bare array) flattened. */
function rowsOf(group) {
  if (Array.isArray(group)) return group.filter(isObj);
  if (!isObj(group)) return [];
  return Object.values(group).flatMap((v) => (Array.isArray(v) ? v.filter(isObj) : []));
}

function countryOf(r) {
  return shortStr(r.recipientCountry) || shortStr(r.country) || shortStr(r.recipientCountryCode) || shortStr(r.countryCode);
}

/**
 * usageV4 response → {
 *   byOrg: Map metric → { value, lastAvailableDate, highWatermarkDate },
 *   byParty: Map 'metric|party' → value (summed), byProvider / byCountry: [{ metric, name, party, value }],
 *   projects: [{ id, name }], lastAvailable }
 */
export function parseUsage(data) {
  const values = isObj(data) && isObj(data.values) ? data.values : {};
  const byOrg = new Map();
  for (const r of rowsOf(values.ByOrg)) {
    const value = num(r.value);
    if (!isMetricName(r.metricName) || value == null || byOrg.has(r.metricName)) continue;
    const md = isObj(r.metadata) ? r.metadata : {};
    byOrg.set(r.metricName, {
      value,
      lastAvailableDate: isDay(md.lastAvailableDate) ? md.lastAvailableDate : null,
      highWatermarkDate: isDay(md.highWatermarkDate) ? md.highWatermarkDate : null,
    });
  }
  const byParty = new Map();
  for (const r of rowsOf(values.ByOrgBillingParty)) {
    const value = num(r.value);
    if (!isMetricName(r.metricName) || !isMetricName(r.billingParty) || value == null) continue;
    const k = `${r.metricName}|${r.billingParty}`;
    byParty.set(k, (byParty.get(k) || 0) + value);
  }
  const grouped = (rows, nameOf) => {
    const m = new Map();
    for (const r of rows) {
      const value = num(r.value);
      const name = nameOf(r);
      if (!isMetricName(r.metricName) || !name || value == null) continue;
      const party = isMetricName(r.billingParty) ? r.billingParty : null;
      const k = `${r.metricName}|${name}|${party || ''}`;
      const cur = m.get(k) || { metric: r.metricName, name, party, value: 0 };
      cur.value += value;
      m.set(k, cur);
    }
    return [...m.values()];
  };
  const byProvider = grouped(rowsOf(values.ByOrgProviderBillingParty), (r) => shortStr(r.providerName));
  const byCountry = grouped(rowsOf(values.ByOrgBillingPartyRecipientCountry), countryOf);
  const projects = [];
  if (isObj(data) && isObj(data.projects)) {
    for (const [key, p] of Object.entries(data.projects)) {
      const id = String(isObj(p) && p.id != null ? p.id : key);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
      projects.push({ id, name: (isObj(p) && shortStr(p.name, 200)) || `Project ${id}` });
    }
  }
  return {
    byOrg, byParty, byProvider, byCountry, projects,
    lastAvailable: isObj(data) && isDay(data.lastAvailableDatePST) ? data.lastAvailableDatePST : null,
  };
}

// ── Snapshot ──────────────────────────────────────────────────────────────

function daysInclusive(start, end) {
  if (!isDay(start) || !isDay(end)) return null;
  const d = daysBetween(start, end) + 1;
  return d >= 1 ? d : null;
}

/**
 * Everything the card, chip, banner, popup and badge need, as plain JSON (stored per org).
 *   limits  parseLimits(...)    usage  parseUsage(...)
 *   query   { start, end, partial } the range usageV4 was asked for; partial = the 30-day fallback
 * Rows: { id, metric, party, label, short, kind: 'stock'|'flow', limit, value, percent,
 *   unavailable (flow total for the term unknown), recent (that window's sum instead), termStart,
 *   termEnd, dataThrough, rate (per day, for projections) | null }.
 */
export function buildSnapshot({ limits, usage, query, term, today, now, host }) {
  const through = (metric) => usage.byOrg.get(metric)?.lastAvailableDate || usage.lastAvailable || null;
  const added = usage.byOrg.get('TotalUsersAddedInPeriod')?.value ?? null;
  const windowDays = daysInclusive(query.start, through(USERS) || today);

  const rows = limits.map((l) => {
    const kind = isStockMetric(l.metric) ? 'stock' : 'flow';
    const k = l.party ? `${l.metric}|${l.party}` : null;
    let value = k && usage.byParty.has(k) ? usage.byParty.get(k) : (usage.byOrg.get(l.metric)?.value ?? null);
    const termOk = !query.partial && query.start === l.termStart;
    const unavailable = kind === 'flow' && !termOk;
    const recent = unavailable ? value : null;
    if (unavailable) value = null;
    const dataThrough = through(l.metric);
    let rate = null;
    if (l.metric === USERS && added != null && windowDays) rate = added / windowDays;
    else if (kind === 'flow' && value != null) {
      const d = daysInclusive(l.termStart, dataThrough || today);
      if (d) rate = value / d;
    }
    return {
      id: l.id, metric: l.metric, party: l.party, label: rowLabel(l.metric, l.party), short: metricShort(l.metric),
      kind, limit: l.limit, value, percent: value != null ? (value / l.limit) * 100 : null,
      unavailable, recent, termStart: l.termStart, termEnd: l.termEnd, dataThrough, rate,
    };
  }).sort((a, b) => (a.metric === USERS ? -1 : 0) - (b.metric === USERS ? -1 : 0));

  const limited = new Set(limits.map((l) => l.metric));
  const unlimited = [...usage.byOrg.entries()]
    .filter(([m, v]) => v.value !== 0 && !limited.has(m) && !SECONDARY.has(m) && !isSmsMetric(m))
    .map(([m, v]) => ({ metric: m, label: metricLabel(m), value: v.value, dataThrough: v.lastAvailableDate }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const hw = usage.byOrg.get('TotalUsersHighWatermark');
  const facts = {
    usersAdded: added,
    addedDays: windowDays,
    activeUsers: usage.byOrg.get('ActiveUsersAllTime')?.value ?? null,
    highWatermark: hw?.value ?? null,
    highWatermarkDate: hw?.highWatermarkDate ?? null,
  };

  return {
    v: 1, at: now, day: today, host,
    term: term || null,
    query: { start: query.start, end: query.end, partial: !!query.partial },
    dataThrough: through(USERS) || usage.lastAvailable,
    rows, facts, unlimited,
    sms: buildSms(rows, usage),
    projects: usage.projects,
  };
}

/** Show the SMS & MMS tab? When any SMS/MMS metric has a limit or non-zero usage. */
export function smsVisible(rows, byOrg) {
  if (rows.some((r) => isSmsMetric(r.metric))) return true;
  for (const [m, v] of byOrg) if (isSmsMetric(m) && v.value !== 0) return true;
  return false;
}

function buildSms(rows, usage) {
  const visible = smsVisible(rows, usage.byOrg);
  if (!visible) return { visible: false, metrics: [], byParty: [], byProvider: [], byCountry: [] };
  const names = new Set([...rows.filter((r) => isSmsMetric(r.metric)).map((r) => r.metric),
    ...[...usage.byOrg.keys()].filter((m) => isSmsMetric(m) && usage.byOrg.get(m).value !== 0)]);
  const order = (m) => (SMS_ORDER.includes(m) ? SMS_ORDER.indexOf(m) : 99);
  const metrics = [...names].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((m) => ({
    metric: m, label: metricLabel(m), value: usage.byOrg.get(m)?.value ?? null,
    rowIds: rows.filter((r) => r.metric === m).map((r) => r.id),
  }));
  const segments = (m) => m === 'SmsSegmentsSent' || m === 'SmsSegmentsReceived';
  const sumBy = (list, keyOf, labelOf) => {
    const m = new Map();
    for (const x of list) {
      const k = keyOf(x);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + x.value);
    }
    return [...m.entries()].filter(([, v]) => v !== 0).map(([k, v]) => ({ name: labelOf(k), value: v })).sort((a, b) => b.value - a.value);
  };
  const partyRows = [...usage.byParty.entries()].map(([k, value]) => {
    const [metric, party] = k.split('|');
    return { metric, party, value };
  });
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    visible,
    metrics,
    byParty: sumBy(partyRows.filter((r) => segments(r.metric)), (r) => r.party, (p) => cap(partyLabel(p))),
    byProvider: sumBy(usage.byProvider.filter((r) => segments(r.metric)), (r) => r.name, (n) => n),
    byCountry: sumBy(usage.byCountry.filter((r) => segments(r.metric)), (r) => r.name, (n) => n),
  };
}

// ── State per row ─────────────────────────────────────────────────────────

/** Stored thresholds → sorted unique integers 1–99 (at most MAX_THRESHOLDS); 100 is implied. */
export function normalizeThresholds(v) {
  if (!Array.isArray(v)) return [...DEFAULT_THRESHOLDS];
  const out = [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 99))].sort((a, b) => a - b);
  return out.slice(0, MAX_THRESHOLDS);
}

/** Thresholds plus the fixed 100. */
export function alertLevels(thresholds) {
  return [...normalizeThresholds(thresholds), 100];
}

/** 'unknown' (no value) | 'ok' | 'warn' (past an alert threshold) | 'over' (at or over the limit). */
export function rowState(row, thresholds) {
  if (!row || !Number.isFinite(row.percent)) return 'unknown';
  if (row.percent >= 100) return 'over';
  return row.percent >= alertLevels(thresholds)[0] ? 'warn' : 'ok';
}

/** The highest alert level `percent` has reached, or null. */
export function reachedLevel(percent, thresholds) {
  if (!Number.isFinite(percent)) return null;
  const hit = alertLevels(thresholds).filter((t) => percent >= t);
  return hit.length ? hit[hit.length - 1] : null;
}

export function normalizeUnwatched(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 120) : [];
}

export function watchedRows(rows, unwatched) {
  const skip = new Set(normalizeUnwatched(unwatched));
  return (Array.isArray(rows) ? rows : []).filter((r) => !skip.has(r.id));
}

/** The watched row with the highest percent (rows without one never win), or null. */
export function worstRow(rows) {
  let best = null;
  for (const r of rows) if (Number.isFinite(r.percent) && (!best || r.percent > best.percent)) best = r;
  return best;
}

// ── Projection ────────────────────────────────────────────────────────────

/**
 * Where the row is heading at its current daily rate:
 *   { kind: 'crossed', date }                       already at/over the limit: when it got there
 *   { kind: 'reaches', threshold, date, afterTerm } the next alert level up (100 included)
 * null when there's no rate (no pace for this metric, or no value).
 */
export function projection(row, thresholds) {
  if (!row || !Number.isFinite(row.percent) || !(row.rate > 0) || !isDay(row.dataThrough)) return null;
  if (row.value >= row.limit) {
    return { kind: 'crossed', date: addDays(row.dataThrough, -Math.floor((row.value - row.limit) / row.rate)) };
  }
  const next = alertLevels(thresholds).find((t) => t > row.percent);
  if (next == null) return null;
  const days = Math.ceil(((next / 100) * row.limit - row.value) / row.rate);
  const date = addDays(row.dataThrough, Math.max(days, 0));
  return { kind: 'reaches', threshold: next, date, afterTerm: isDay(row.termEnd) && date > row.termEnd };
}

export function projectionText(p, { refDay } = {}) {
  if (!p) return '';
  if (p.kind === 'crossed') return `crossed ~${formatDay(p.date, { refDay })}`;
  if (p.afterTerm) return `stays under ${p.threshold}% this term`;
  return `reaches ${p.threshold}% ~${formatDay(p.date, { refDay })}`;
}

// ── Alerts ────────────────────────────────────────────────────────────────
//
// Stored per org (state `alerts:<orgSlot>`):
//   fired       { [rowId]: { [level]: 'YYYY-MM-DD' } }  level fired (and when, last); deleted when
//               the percent drops back under it (re-armed)
//   pending     [firing]   shown in the banner until dismissed
//   snoozeUntil ms         "Remind me tomorrow"

export function emptyAlertState() {
  return { fired: {}, pending: [], snoozeUntil: 0 };
}

export function normalizeAlertState(s) {
  const out = emptyAlertState();
  if (!isObj(s)) return out;
  if (isObj(s.fired)) {
    for (const [id, levels] of Object.entries(s.fired)) {
      if (!isObj(levels) || id === '__proto__') continue;
      const l = {};
      for (const [t, day] of Object.entries(levels)) if (isDay(day) && /^\d{1,3}$/.test(t)) l[t] = day;
      if (Object.keys(l).length) out.fired[id] = l;
    }
  }
  if (Array.isArray(s.pending)) out.pending = s.pending.filter((f) => isObj(f) && typeof f.id === 'string' && Number.isInteger(f.threshold));
  if (Number.isFinite(s.snoozeUntil)) out.snoozeUntil = s.snoozeUntil;
  return out;
}

/**
 * Run the alert rules over the watched rows of a fresh snapshot.
 * Each (row, level) fires once; it re-arms when the percent drops back under the level. While a
 * row is over 100% its 100 level fires again on each new day. One firing per row (its highest new
 * level) goes into `pending` and is returned in `firings`; a new firing clears a snooze.
 * → { state, firings: [{ id, label, short, threshold, percent, value, limit, repeat }] }
 */
export function evaluateAlerts(prev, { rows, thresholds, today }) {
  const state = normalizeAlertState(prev);
  const levels = alertLevels(thresholds);
  const firings = [];
  for (const row of rows) {
    if (!Number.isFinite(row.percent)) continue; // unknown this time: neither fire nor re-arm
    const f = { ...(state.fired[row.id] || {}) };
    let top = null;
    for (const t of levels) {
      if (row.percent >= t) {
        const last = f[t];
        const repeat = t === 100 && row.percent > 100 && !!last && last !== today;
        if (!last || repeat) {
          f[t] = today;
          top = { threshold: t, repeat };
        }
      } else {
        delete f[t];
      }
    }
    // A level removed from the settings while fired: forget it.
    for (const t of Object.keys(f)) if (!levels.includes(Number(t))) delete f[t];
    if (Object.keys(f).length) state.fired[row.id] = f; else delete state.fired[row.id];
    if (top) {
      firings.push({
        id: row.id, label: row.label, short: row.short, threshold: top.threshold,
        percent: row.percent, value: row.value, limit: row.limit, repeat: top.repeat,
      });
    }
  }
  // Pending entries whose level re-armed since are no longer news.
  state.pending = state.pending.filter((p) => state.fired[p.id]?.[p.threshold] && !firings.some((f) => f.id === p.id));
  if (firings.length) {
    state.pending.push(...firings);
    state.snoozeUntil = 0;
  }
  state.pending.sort((a, b) => b.percent - a.percent);
  return { state, firings: firings.sort((a, b) => b.percent - a.percent) };
}

export function bannerVisible(state, now) {
  const s = normalizeAlertState(state);
  return s.pending.length > 0 && now >= s.snoozeUntil;
}

export function dismissAlerts(state) {
  return { ...normalizeAlertState(state), pending: [], snoozeUntil: 0 };
}

export function snoozeAlerts(state, now) {
  return { ...normalizeAlertState(state), snoozeUntil: now + DAY_MS };
}

/** "Total users at 80%, 95% and 100%; Custom events at 80%" for what has fired, labels from rows. */
export function firedSummary(state, rows) {
  const s = normalizeAlertState(state);
  const labelOf = new Map((rows || []).map((r) => [r.id, r.label]));
  const parts = [];
  for (const [id, levels] of Object.entries(s.fired)) {
    const ts = Object.keys(levels).map(Number).sort((a, b) => a - b).map((t) => `${t}%`);
    if (!ts.length) continue;
    const list = ts.length > 1 ? `${ts.slice(0, -1).join(', ')} and ${ts[ts.length - 1]}` : ts[0];
    parts.push(`${labelOf.get(id) || decamel(id.split(':')[0])} at ${list}`);
  }
  return parts.join('; ');
}

/** Banner / notification text for the worst pending firing. */
export function alertText(firing, { more = 0, projectionLine = '' } = {}) {
  const over = firing.threshold >= 100;
  const atLimit = over && firing.value === firing.limit;
  const title = over
    ? `${firing.label}: ${atLimit ? 'at' : 'over'} your contract limit`
    : `${firing.label}: past ${firing.threshold}% of your contract limit`;
  const detail = [`${formatInt(firing.value)} of ${formatInt(firing.limit)} (${formatPercent(firing.percent)})`];
  if (projectionLine) detail.push(projectionLine);
  if (more > 0) detail.push(`${more} more limit${more === 1 ? '' : 's'} past an alert`);
  return { title, detail: detail.join(' · '), tone: over ? 'bad' : 'warn' };
}

export function notificationText(firing) {
  const over = firing.threshold >= 100;
  return {
    title: over ? `Iterable: over your ${firing.short.toLowerCase()} limit` : `Iterable: ${firing.short.toLowerCase()} at ${Math.floor(firing.percent)}% of limit`,
    message: `${firing.label} ${formatInt(firing.value)} of ${formatInt(firing.limit)}. Click to open Usage and billing.`,
  };
}

// ── Chip + badge ──────────────────────────────────────────────────────────

/** Header chip for the worst watched row, or null. mode: 'alert' (only past a threshold) | 'always'. */
export function chipModel(rows, thresholds, mode) {
  const worst = worstRow(rows);
  if (!worst) return null;
  const state = rowState(worst, thresholds);
  if (mode !== 'always' && state !== 'warn' && state !== 'over') return null;
  return {
    text: `${worst.short} ${Math.floor(worst.percent)}%`,
    tone: state === 'over' ? 'bad' : state === 'warn' ? 'warn' : 'ok',
    title: `${worst.label}: ${formatInt(worst.value)} of ${formatInt(worst.limit)} (${formatPercent(worst.percent)}). Open Usage and billing.`,
  };
}

export const BADGE_COLORS = Object.freeze({ warn: '#9a620a', over: '#c03a3a' });

/**
 * Toolbar badge over every stored org's snapshot: the worst watched percent that is past an alert
 * threshold → { text, color }, or null (clear it).
 */
export function badgeFor(snapshots, values) {
  const thresholds = normalizeThresholds(values?.thresholds);
  let worst = null;
  for (const snap of snapshots || []) {
    if (!isObj(snap) || !Array.isArray(snap.rows)) continue;
    for (const r of watchedRows(snap.rows, values?.unwatched)) {
      const st = rowState(r, thresholds);
      if ((st === 'warn' || st === 'over') && (!worst || r.percent > worst.percent)) worst = { percent: r.percent, st };
    }
  }
  if (!worst) return null;
  return { text: `${Math.min(999, Math.floor(worst.percent))}%`, color: BADGE_COLORS[worst.st] };
}

// ── Orgs and the once-a-day check ─────────────────────────────────────────
//
// An org is a host (app / app.eu) plus the sorted ids of every project usageV4 lists. Stored state
// names use a hash of that ('o' + 16 hex) so they stay restorable (RESTORE_NAME_RE). Before the
// first check of an org, a tab only knows its host and current project: its check gate is then
// keyed 'u' + hash(host|projectId) until the response says which org that is.

export function orgKey(host, projectIds) {
  const ids = [...new Set((projectIds || []).map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return `${host}|${ids.join(',')}`;
}

export function orgSlot(host, projectIds) {
  return 'o' + stableHash64(orgKey(host, projectIds));
}

export function unknownSlot(host, projectId) {
  return 'u' + stableHash64(`${host}|${projectId ?? ''}`);
}

/** The org slot (from the stored `orgs` index) that holds this host + project, or null. */
export function findOrgSlot(orgs, host, projectId) {
  if (!isObj(orgs) || projectId == null) return null;
  let best = null;
  for (const [slot, o] of Object.entries(orgs)) {
    if (!isObj(o) || o.host !== host || !Array.isArray(o.projectIds) || !o.projectIds.includes(String(projectId))) continue;
    if (!best || (o.updatedAt || 0) > (best.o.updatedAt || 0)) best = { slot, o };
  }
  return best ? best.slot : null;
}

/**
 * Should this page load check? Gate entry (state `check:<slot>`): { day, retryAt?, noAccess?,
 * lockUntil?, lockId? }. Not while another tab holds the lock; yes on a new PST day; on the same
 * day only after a failed check's retry time (a refusal waits for the next day).
 */
export function shouldCheck(entry, { today, now }) {
  if (!isObj(entry)) return true;
  if (Number.isFinite(entry.lockUntil) && entry.lockUntil > now) return false;
  if (entry.day !== today) return true;
  return Number.isFinite(entry.retryAt) && now >= entry.retryAt;
}

export function lockEntry(entry, { now, lockId }) {
  return { ...(isObj(entry) ? entry : {}), lockUntil: now + LOCK_MS, lockId };
}

export function holdsLock(entry, lockId) {
  return isObj(entry) && entry.lockId === lockId;
}

/** Gate entry after a check: ok | 'denied' (401/403: quiet until tomorrow) | 'failed' (retry in an hour). */
export function gateAfter(outcome, { today, now }) {
  if (outcome === 'denied') return { day: today, noAccess: true };
  if (outcome === 'failed') return { day: today, retryAt: now + RETRY_MS };
  return { day: today };
}

export function isDenied(err) {
  return err?.status === 401 || err?.status === 403;
}

/** The two hosts Loophole runs on; notification clicks and popup links are built only from these. */
export const APP_HOSTS = Object.freeze(['app.iterable.com', 'app.eu.iterable.com']);
