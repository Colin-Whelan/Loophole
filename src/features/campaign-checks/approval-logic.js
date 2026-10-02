// Pure logic for the campaign approval view (no DOM): turning what the campaign page shows into
// one details record, the checks row, the plain-text summary, the card rows shared by the DOM
// card / text / PNG, the card's canvas layout (measure function injected), the preview document's
// CSP and the compact-page CSS. Unit-tested in test/features/campaign-approval.test.js.

import { relativeTime } from './logic.js';

// ── Page fields ─────────────────────────────────────────────────────────────

/**
 * `[data-test="form-readonly-field-<name>"]` names to try for each detail, then a label pattern
 * for Iterable's `[data-test="form-field"]` rows. Only recipients, sendLists, suppressionLists, subject,
 * scheduleStartTime, sendRateLimit and messageType are proven (the userscript); every other name
 * is a guess from Iterable's template API field names (live checklist).
 */
export const FIELD_CANDIDATES = Object.freeze({
  subject: { names: ['subject'], label: /^subject( line)?$/i },
  preheader: { names: ['preheaderText', 'preheader', 'preHeaderText', 'preheader_text'], label: /^pre-?header/i },
  fromName: { names: ['fromName', 'senderName'], label: /^(from|sender) name$/i },
  fromEmail: { names: ['fromEmail', 'fromAddress', 'senderEmail', 'fromEmailAddress'], label: /^(from|sender) (email|address)/i },
  from: { names: ['from', 'sender'], label: /^(from|sender)$/i },
  replyTo: { names: ['replyToEmail', 'replyTo', 'replyToAddress', 'replyToEmailAddress'], label: /^reply[- ]?to/i },
  // Audience size as Iterable estimates it ("422 recipients (est.)").
  recipients: { names: ['recipients'], label: /^recipients$/i },
  schedule: { names: ['scheduleStartTime'], label: /^(launch|send|schedule)(d)?( time| at| date)?$/i },
  // The planned launch time when the schedule field only says "Not launched" (guesses; live checklist).
  planned: { names: ['scheduledTime', 'scheduledAt', 'scheduleTime', 'plannedStartTime', 'startTime', 'launchTime', 'sendAt'], label: /^(planned|scheduled)( (send|launch))?( time| for| at| date)?$|^(launch|send) (time|date)$/i },
  messageType: { names: ['messageType', 'messageTypeId'], label: /^message type$/i },
  sendRate: { names: ['sendRateLimit'], label: /^(send )?rate limit$/i },
  templateName: { names: ['templateName', 'template'], label: /^template( name)?$/i },
  templateId: { names: ['templateId'], label: /^template id$/i },
  templateEdited: { names: ['templateUpdatedAt', 'updatedAt', 'lastUpdated', 'lastModified'], label: /^(last )?(edited|updated|modified|saved)/i },
  status: { names: ['campaignState', 'campaignStatus', 'status', 'state'], label: /^(campaign )?(status|state)$/i },
});

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** `/campaigns/4412871?view=Summary` → '4412871', else null. */
export function campaignIdFromPath(pathname) {
  const m = /^\/campaigns\/(\d+)(?:[/?#]|$)/.exec(String(pathname ?? ''));
  return m ? m[1] : null;
}

/** A template id from a link in the Content step (`?templateId=12`, `/templates/12`, `/templates/editor/12`). */
export function templateIdFromHref(href) {
  const s = String(href ?? '');
  const m = /[?&]templateId=(\d+)/i.exec(s) || /\/templates\/(?:editor\/|[a-z-]+\/)?(\d+)(?:[/?#]|$)/i.exec(s);
  return m ? m[1] : null;
}

/** 'Name <a@b.c>' / 'a@b.c' / 'Name' → { name, email }. */
export function parseFrom(text) {
  const s = clean(text);
  if (!s) return { name: null, email: null };
  const m = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(s);
  if (m) return { name: clean(m[1].replace(/^"|"$/g, '')) || null, email: m[2] };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: null, email: s };
  return { name: s, email: null };
}

/** Lists from a readonly field: link texts if any, else the text split on commas. */
function listOf(field) {
  if (!field) return [];
  const links = (field.links || []).map(clean).filter(Boolean);
  if (links.length) return links;
  const t = clean(field.text);
  if (!t || /^(none|—|-|n\/a)$/i.test(t)) return [];
  return t.split(',').map(clean).filter(Boolean);
}

/**
 * Pick one detail: the first candidate readonly field with text, else the first labelled
 * form row whose label matches. → { text, links, source } | null
 */
export function pickField(raw, key) {
  const c = FIELD_CANDIDATES[key];
  if (!c) return null;
  for (const name of c.names) {
    const f = raw.fields?.[name];
    if (f && (clean(f.text) || f.links?.length)) return { text: clean(f.text), links: f.links || [], source: `form-readonly-field-${name}` };
  }
  for (const row of raw.labeled || []) {
    if (c.label.test(clean(row.label)) && (clean(row.text) || row.links?.length)) {
      return { text: clean(row.text), links: row.links || [], source: `label:${clean(row.label)}` };
    }
  }
  return null;
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const WEEKDAY = '(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,? )?';
const TZ = '( [A-Za-z]{2,5}(?:[+-]\\d{1,2})?)?';

/**
 * A schedule text → { text, notLaunched, date, planned, time, period }:
 *   date     best-effort parse ('Tue Sep 29, 2026 10:00 AM EDT', 'Tue Oct 6, 10:00 AM EDT' (no
 *            year: the next such date from `now`), '09/29/2026 10:00 AM', ISO) or null. Time
 *            zone abbreviations are dropped, so it is in the browser's zone (only used for "in 4 d").
 *   planned  the date / time as the page shows it ('Tue Oct 6, 10:00 AM EDT'), or null
 *   time     '10:00 AM' when the text shows a 12-hour time, else null; period 'AM' | 'PM' | null
 */
export function parseSchedule(text, now = new Date()) {
  const s = clean(text);
  const notLaunched = /not (yet )?launched/i.test(s);
  let date = null;
  let planned = null;
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  const named = new RegExp(`\\b(${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}(,? (at )?\\d{1,2}:\\d{2}( ?[ap]\\.?m\\.?)?)?`, 'i').exec(s);
  const us = /\b\d{1,2}\/\d{1,2}\/\d{4}(,? \d{1,2}:\d{2}( ?[ap]m)?)?/i.exec(s);
  const candidate = iso?.[0] || named?.[0]?.replace(/,? at /i, ' ').replace(/\./g, '') || us?.[0];
  if (candidate) {
    const t = Date.parse(candidate.replace(/,(?= \d{1,2}:)/, ''));
    if (Number.isFinite(t)) date = new Date(t);
  }
  const shown = new RegExp(`\\b${WEEKDAY}(${MONTHS})[a-z]*\\.? (\\d{1,2})(?:,? (\\d{4}))?,? (?:at )?(\\d{1,2}):(\\d{2}) ?([ap])\\.?m\\.?${TZ}`, 'i').exec(s);
  if (!date && shown && !shown[3]) {
    // No year on the page: this year's date, or next year's when that is more than a day past.
    const month = MONTHS.split('|').indexOf(shown[1].slice(0, 3).toLowerCase());
    let h = Number(shown[4]) % 12;
    if (shown[6].toLowerCase() === 'p') h += 12;
    const d = new Date(now.getFullYear(), month, Number(shown[2]), h, Number(shown[5]));
    if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
    if (Number.isFinite(d.getTime()) && d.getMonth() === month) date = d;
  }
  if (shown) {
    planned = shown[0];
    // The zone must be an upper-case abbreviation (EDT, UTC+2), not the next word ("and").
    if (shown[7] && shown[7] !== shown[7].toUpperCase()) planned = planned.slice(0, -shown[7].length);
    planned = planned.trim();
  }
  else if (candidate) planned = (iso?.[0] || named?.[0] || us?.[0]).trim();
  const tm = /\b(\d{1,2}:\d{2}) ?([ap])\.?m\.?(?![a-z])/i.exec(s);
  const period = tm ? (tm[2].toLowerCase() === 'a' ? 'AM' : 'PM') : null;
  return { text: s, notLaunched, date, planned, time: tm ? tm[0] : null, period };
}

/** "in 4 d 3 h" / "in 3 h 20 min" / "in 12 min" / "2 d ago" (compact, for the schedule chip). */
export function compactRelative(date, now = new Date()) {
  const ms = date.getTime() - now.getTime();
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 1) return 'now';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts = d ? [`${d} d`, h && `${h} h`] : h ? [`${h} h`, m && `${m} min`] : [`${m} min`];
  const t = parts.filter(Boolean).join(' ');
  return ms > 0 ? `in ${t}` : `${t} ago`;
}

/** { text: 'in 4 d 3 h' | '3 h ago', tone, future } for a schedule date, or null. */
export function scheduleRelative(date, now = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const ms = date.getTime() - now.getTime();
  if (ms > 0) {
    const r = relativeTime(date, now);
    return { text: compactRelative(date, now), tone: r.tone === 'ok' ? 'accent' : r.tone, future: true };
  }
  return { text: compactRelative(date, now), tone: undefined, future: false };
}

/**
 * The schedule row's text: the field's own text, plus "planned <time>" when the field only says
 * "Not launched" and the planned time was found elsewhere (another field, a title / tooltip, or
 * Loophole's own Schedule preview tool — `sched.source === 'loophole'`, labelled as such since it
 * isn't Iterable's own record of the campaign).
 */
export function scheduleText(sched) {
  if (!sched?.text) return null;
  if (sched.planned && !sched.text.includes(sched.planned)) {
    const label = sched.source === 'loophole' ? ' (planned in Loophole)' : '';
    return `${sched.text} · planned ${sched.planned}${label}`;
  }
  return sched.text;
}

/**
 * A Date → the pieces `sched.planned` / `sched.time` / `sched.period` need, for a time planned
 * with Loophole's own Schedule preview tool (no year: same convention as a page-shown planned
 * time without one). E.g. 'Tue Sep 29, 10:15 PM'.
 */
export function formatPlannedDate(date) {
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const h24 = date.getHours();
  const h12 = h24 % 12 || 12;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const mm = String(date.getMinutes()).padStart(2, '0');
  const time = `${h12}:${mm} ${period}`;
  return { planned: `${weekday} ${day}, ${time}`, time, period };
}

/**
 * What the page shows → one details record. `raw`:
 *   { pathname, header, statusText?, fields: { [name]: { text, links } },
 *     labeled: [{ label, text, links }], templateHrefs: [href], email: { chars, fingerprint } | null }
 * Missing values are null (rendered as "—").
 */
export function normalizeDetails(raw = {}, { now = new Date(), ourPlanned = null } = {}) {
  const val = (key) => pickField(raw, key)?.text || null;
  let fromName = val('fromName');
  let fromEmail = val('fromEmail');
  if (fromEmail && /</.test(fromEmail)) { const p = parseFrom(fromEmail); fromEmail = p.email; fromName ||= p.name; }
  if (!fromName || !fromEmail) {
    const both = parseFrom(val('from'));
    fromName ||= both.name;
    fromEmail ||= both.email;
  }
  let sched = parseSchedule(val('schedule'), now);
  if (!sched.planned) {
    // "Not launched" only: look for the planned time in a planned-time field or the schedule
    // field's hints (title / aria-label / <time datetime> / inner spans, read by approval.js).
    const hints = [val('planned'), ...(raw.fields?.scheduleStartTime?.hints || [])];
    for (const h of hints) {
      const p = h ? parseSchedule(h, now) : null;
      if (p?.planned) { sched = { ...sched, date: sched.date || p.date, planned: p.planned, time: p.time, period: p.period }; break; }
    }
  }
  if (!sched.planned && sched.notLaunched && ourPlanned instanceof Date && Number.isFinite(ourPlanned.getTime())) {
    // Iterable itself has nothing scheduled: fall back to the time planned with Loophole's own
    // Schedule preview tool (index.js persists it per campaign; owner feedback §critical field).
    const p = formatPlannedDate(ourPlanned);
    sched = { ...sched, date: sched.date || ourPlanned, planned: p.planned, time: p.time, period: p.period, source: 'loophole' };
  }
  let templateId = val('templateId');
  if (!templateId) {
    for (const href of raw.templateHrefs || []) { templateId = templateIdFromHref(href); if (templateId) break; }
  }
  let status = clean(raw.statusText) || val('status');
  if (!status && sched.notLaunched) status = 'Not launched';
  return {
    campaignName: clean(raw.header) || null,
    campaignId: campaignIdFromPath(raw.pathname),
    status: status || null,
    subject: val('subject'),
    preheader: val('preheader'),
    fromName: fromName || null,
    fromEmail: fromEmail || null,
    replyTo: val('replyTo'),
    recipients: val('recipients'),
    sendLists: listOf(raw.fields?.sendLists),
    suppressionLists: listOf(raw.fields?.suppressionLists),
    schedule: sched.text ? sched : null,
    templateName: val('templateName'),
    templateId: templateId || null,
    templateEdited: val('templateEdited'),
    messageType: val('messageType'),
    sendRate: val('sendRate'),
    email: raw.email && raw.email.chars ? { chars: raw.email.chars, fingerprint: raw.email.fingerprint || null } : null,
    // Subject text as the page has it (the check looks for line breaks and tabs, which clean() removes).
    subjectRaw: raw.fields?.subject?.rawText ?? null,
  };
}

// ── Checks row ──────────────────────────────────────────────────────────────

const TONE_RANK = { bad: 3, warn: 2, ok: 1 };

/**
 * The HTML scan's result (email-scanner scanHtml) → a chip, or null when there was no email.
 * Uses the scanner's own tone rule: errors → bad, anything else found → warn.
 */
export function htmlCheck(result) {
  if (!result) return null;
  if (!result.total) return { id: 'html', label: 'HTML: rules off', tone: undefined, title: 'Every Email HTML check rule is switched off.' };
  const { error = 0, warning = 0, info = 0 } = result.counts || {};
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (error) return { id: 'html', label: `HTML: ${plural(error, 'error')}`, tone: 'bad', title: `${plural(error, 'error')}, ${plural(warning, 'warning')}, ${info} info` };
  if (warning) return { id: 'html', label: `HTML: ${plural(warning, 'warning')}`, tone: 'warn', title: `${plural(warning, 'warning')}, ${info} info` };
  if (info) return { id: 'html', label: `HTML: ${plural(info, 'note')}`, tone: 'warn', title: `${info} info` };
  return { id: 'html', label: 'HTML: no issues', tone: result.errors?.length ? 'warn' : 'ok', title: `${result.passed} of ${result.total} rules passed` };
}

/**
 * The checks row: [{ id, label, tone, title }] in a fixed order (audience, seed list, suppression,
 * subject, HTML), skipping checks that are off or had nothing to look at, plus `worst`.
 */
export function aggregateChecks({ audience, seed, suppression, subject, html } = {}) {
  const items = [];
  if (audience) items.push({ id: 'audience', label: 'Audience', tone: audience.tone, title: audience.text });
  if (seed) items.push({ id: 'seed', label: 'Seed list', tone: seed.tone, title: seed.text });
  if (suppression) items.push({ id: 'suppression', label: 'Suppressions', tone: suppression.tone, title: suppression.text });
  if (subject) items.push({ id: 'subject', label: 'Subject', tone: subject.tone, title: subject.text });
  if (html) items.push(html);
  let worst = null;
  for (const i of items) if ((TONE_RANK[i.tone] || 0) > (TONE_RANK[worst] || 0)) worst = i.tone;
  return { items, worst };
}

// ── Card rows (DOM card, text, PNG) ─────────────────────────────────────────

export const DASH = '—';

/** Human size: 41.2 KB. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fromText(d) {
  if (d.fromName && d.fromEmail) return `${d.fromName} <${d.fromEmail}>`;
  return d.fromName || d.fromEmail || null;
}

export function templateText(d) {
  const parts = [d.templateName, d.templateId && `id ${d.templateId}`, d.templateEdited && `edited ${d.templateEdited.replace(/^(last )?(edited|updated|modified|saved)\s*/i, '')}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The card's rows, shared by the DOM card, the text summary and the PNG:
 * [{ key, label, value: string | null, lists?: string[], chip?: { text, tone, title }, strong? }]
 * `results` = the individual check results ({ audience, seed, suppression }) shown beside their rows.
 */
export function cardRows(d, { audience = null, seed = null, suppression = null, now = new Date() } = {}) {
  const rel = d.schedule?.date ? scheduleRelative(d.schedule.date, now) : null;
  const typeRate = [d.messageType, d.sendRate].filter(Boolean).join(' · ') || null;
  return [
    { key: 'subject', label: 'Subject', value: d.subject, strong: true },
    { key: 'preheader', label: 'Preheader', value: d.preheader },
    { key: 'from', label: 'From', value: fromText(d) },
    { key: 'replyTo', label: 'Reply-to', value: d.replyTo },
    // The chip only when something's off: the value already shows the count.
    { key: 'recipients', label: 'Audience', value: d.recipients, chip: audience && audience.tone !== 'ok' ? { text: audience.text, tone: audience.tone, title: audience.text } : null },
    { key: 'sendLists', label: 'Send lists', value: null, lists: d.sendLists, chip: seed && { text: seed.tone === 'ok' ? 'Seed list' : 'No seed list', tone: seed.tone, title: seed.text } },
    { key: 'suppressionLists', label: 'Suppressions', value: null, lists: d.suppressionLists, chip: suppression && { text: suppression.text, tone: suppression.tone, title: suppression.title } },
    {
      key: 'schedule', label: 'Schedule', value: scheduleText(d.schedule), chip: rel && { text: rel.text, tone: rel.tone },
      // The send time, coloured by the renderers (AM green, PM red, bold); the text adds (AM) / (PM).
      time: d.schedule?.time ? { text: d.schedule.time, period: d.schedule.period } : null,
    },
    { key: 'template', label: 'Template', value: templateText(d) },
    { key: 'typeRate', label: 'Type · rate', value: typeRate },
    { key: 'email', label: 'Email HTML', value: d.email ? `fingerprint ${d.email.fingerprint || DASH} · ${formatBytes(d.email.chars)}` : 'Not on the page (open the campaign’s summary)' },
  ];
}

/** "Sep 25, 2026, 10:42 AM" in en-US (fixed so text/PNG read the same everywhere). */
export function formatStamp(date) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  } catch { return date.toISOString(); }
}

export function titleLine(d) {
  const bits = [d.campaignId && `campaign ${d.campaignId}`, d.status].filter(Boolean);
  return `${d.campaignName || 'Campaign'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** Plain-text summary for Slack / email. */
export function summaryText(d, checks, { audience = null, seed = null, suppression = null, checkedAt = new Date(), now = checkedAt } = {}) {
  const lines = [titleLine(d)];
  for (const row of cardRows(d, { audience, seed, suppression, now })) {
    let v = row.lists ? (row.lists.length ? row.lists.join(', ') : 'none') : (row.value ?? DASH);
    if (row.key === 'schedule') {
      const extra = [row.time?.period, row.chip?.text].filter(Boolean);
      if (extra.length) v += ` (${extra.join(', ')})`;
    } else if (row.chip) v += `  [${row.chip.text}]`;
    lines.push(`${row.label}: ${v}`);
  }
  const items = checks?.items || [];
  if (items.length) {
    const word = (t) => (t === 'ok' ? 'OK' : t === 'bad' ? 'FAIL' : t === 'warn' ? 'check' : 'info');
    lines.push(`Checks: ${items.map((i) => (i.id === 'html' ? i.label : `${i.label} ${word(i.tone)}`)).join(' · ')}`);
  }
  lines.push(`Checked ${formatStamp(checkedAt)} with Loophole for Iterable`);
  return lines.join('\n');
}

// ── Card PNG layout ─────────────────────────────────────────────────────────

/**
 * Greedy word wrap. `measure(text) → px`. Words wider than `maxWidth` are broken by character.
 * Always returns at least one line.
 */
export function wrapText(text, maxWidth, measure) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushLong = (word) => {
    let part = '';
    for (const ch of word) {
      if (part && measure(part + ch) > maxWidth) { lines.push(part); part = ch; } else part += ch;
    }
    return part;
  };
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (measure(next) <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = measure(w) <= maxWidth ? w : pushLong(w);
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

// Light card colours (the mockup's panel; the image is always light so it pastes anywhere).
export const CARD_COLORS = Object.freeze({
  surface: '#ffffff', raised: '#f3f7f6', line: '#d3dfdd', ink: '#16201f', muted: '#5a6a68', faint: '#8b9a98',
  accent: '#0d8a7e', accentStrong: '#0a6d64', accentSoft: '#e2f3f0',
  ok: '#1d7f4a', okSoft: '#e1f3e8', warn: '#9a620a', warnSoft: '#fbf0dc', bad: '#c03a3a', badSoft: '#fbe6e4',
  neutral: '#5a6a68', neutralSoft: '#e9efee',
});

export const CARD_FONTS = Object.freeze({
  sans: '"WB Plex Sans", "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"WB Plex Mono", "IBM Plex Mono", ui-monospace, Consolas, monospace',
});

const font = (weight, size, family = CARD_FONTS.sans) => `${weight} ${size}px ${family}`;

/** Colour for a send time on the card: AM green, PM red; null for anything else. */
export function timeColor(period) {
  if (period === 'AM') return CARD_COLORS.ok;
  if (period === 'PM') return CARD_COLORS.bad;
  return null;
}

export function chipColors(tone) {
  const c = CARD_COLORS;
  if (tone === 'ok') return { fg: c.ok, bg: c.okSoft };
  if (tone === 'warn') return { fg: c.warn, bg: c.warnSoft };
  if (tone === 'bad') return { fg: c.bad, bg: c.badSoft };
  if (tone === 'accent') return { fg: c.accentStrong, bg: c.accentSoft };
  return { fg: c.neutral, bg: c.neutralSoft };
}

/**
 * Lay the card out for a canvas. `measure(text, font) → width in px` (CSS pixels).
 * → { width, height, ops: [op] } with ops:
 *   { t: 'rect', x, y, w, h, r, fill?, stroke? }   { t: 'text', x, y, text, font, color }  (y = top)
 *   { t: 'dot', x, y, r, color }                    { t: 'mark', x, y, size }
 *   { t: 'line', x1, y1, x2, y2, color }
 */
export function layoutCard({ title, meta, rows, checks, stamp, footer }, { measure, width = 560 } = {}) {
  const c = CARD_COLORS;
  const PAD = 16;
  const LABEL_W = 104;
  const GAP = 14;
  const valueX = PAD + LABEL_W + GAP;
  const valueW = width - valueX - PAD;
  const ops = [];
  const text = (x, y, s, f, color) => ops.push({ t: 'text', x, y, text: s, font: f, color });
  let y = 0;

  // Header band: mark, campaign name (wrapped), meta line.
  const headFont = font(700, 15);
  const titleLines = wrapText(title || 'Campaign', width - PAD * 2 - 34, (s) => measure(s, headFont));
  const metaFont = font(400, 11.5, CARD_FONTS.mono);
  const metaLines = meta ? wrapText(meta, width - PAD * 2 - 34, (s) => measure(s, metaFont)) : [];
  const headH = 14 + titleLines.length * 20 + metaLines.length * 16 + 12;
  ops.push({ t: 'rect', x: 0, y: 0, w: width, h: headH, r: 0, fill: c.raised });
  ops.push({ t: 'mark', x: PAD, y: 14, size: 24 });
  let hy = 14;
  for (const l of titleLines) { text(PAD + 34, hy, l, headFont, c.ink); hy += 20; }
  for (const l of metaLines) { text(PAD + 34, hy + 1, l, metaFont, c.muted); hy += 16; }
  ops.push({ t: 'line', x1: 0, y1: headH, x2: width, y2: headH, color: c.line });
  y = headH + 12;

  // Chips and list pills flow inside the value column.
  const chipFont = font(500, 11);
  const pillFont = font(400, 12);
  const flow = (items, x0, maxW, y0) => {
    let x = x0;
    let yy = y0;
    let rowH = 0;
    for (const it of items) {
      const isChip = it.kind === 'chip';
      const f = isChip ? chipFont : pillFont;
      const h = isChip ? 20 : 22;
      const padX = isChip ? 8 : 7;
      const dotW = isChip ? 11 : 0;
      const avail = maxW - padX * 2 - dotW;
      const lines = wrapText(it.text, avail, (s) => measure(s, f));
      const label = lines.length > 1 ? lines : [lines[0]];
      const textW = Math.max(...label.map((l) => measure(l, f)));
      const w = Math.min(maxW, Math.ceil(textW + padX * 2 + dotW));
      const hh = h + (label.length - 1) * 15;
      if (x > x0 && x + w > x0 + maxW) { x = x0; yy += rowH + 5; rowH = 0; }
      if (isChip) {
        const col = chipColors(it.tone);
        ops.push({ t: 'rect', x, y: yy, w, h: hh, r: Math.min(10, hh / 2), fill: col.bg });
        ops.push({ t: 'dot', x: x + padX + 3, y: yy + 10, r: 3, color: col.fg });
        label.forEach((l, i) => text(x + padX + dotW, yy + 4 + i * 15, l, chipFont, col.fg));
      } else {
        ops.push({ t: 'rect', x, y: yy, w, h: hh, r: 4, fill: c.raised, stroke: c.line });
        label.forEach((l, i) => text(x + padX, yy + 4 + i * 15, l, pillFont, c.ink));
      }
      x += w + 5;
      rowH = Math.max(rowH, hh);
    }
    return yy + rowH;
  };

  const labelFont = font(400, 12);
  for (const row of rows) {
    text(PAD, y + 2, row.label, labelFont, c.muted);
    let bottom = y + 18;
    if (row.lists) {
      const items = row.lists.length ? row.lists.map((s) => ({ kind: 'pill', text: s })) : [];
      if (!row.lists.length) {
        text(valueX, y + 1, 'None', font(400, 13), c.faint);
        bottom = y + 19;
        if (row.chip) bottom = Math.max(bottom, flow([{ kind: 'chip', ...row.chip }], valueX + measure('None', font(400, 13)) + 8, valueW - measure('None', font(400, 13)) - 8, y));
      } else {
        if (row.chip) items.push({ kind: 'chip', ...row.chip });
        bottom = flow(items, valueX, valueW, y);
      }
    } else {
      const f = row.strong ? font(600, 14) : font(400, 13);
      const lh = row.strong ? 19 : 18;
      const lines = wrapText(row.value ?? DASH, valueW, (s) => measure(s, f));
      const tf = font(700, 13);
      const tcol = timeColor(row.time?.period);
      lines.forEach((l, i) => {
        const ly = y + 1 + i * lh;
        const at = row.time && tcol ? l.indexOf(row.time.text) : -1;
        if (at < 0) { text(valueX, ly, l, f, row.value == null ? c.faint : c.ink); return; }
        // Prefix, the time in its colour (bold), suffix.
        const pre = l.slice(0, at);
        const post = l.slice(at + row.time.text.length);
        let x = valueX;
        if (pre) { text(x, ly, pre, f, c.ink); x += measure(pre, f); }
        text(x, ly, row.time.text, tf, tcol);
        x += measure(row.time.text, tf);
        if (post) text(x, ly, post, f, c.ink);
      });
      bottom = y + lines.length * lh;
      if (row.chip) {
        const last = lines[lines.length - 1];
        const lastW = measure(last, f);
        const chipW = measure(row.chip.text, chipFont) + 27;
        if (lastW + 8 + chipW <= valueW) bottom = Math.max(bottom, flow([{ kind: 'chip', ...row.chip }], valueX + lastW + 8, valueW - lastW - 8, y + (lines.length - 1) * lh - 1));
        else bottom = flow([{ kind: 'chip', ...row.chip }], valueX, valueW, bottom + 4);
      }
    }
    y = bottom + 9;
  }

  // Checks band.
  y += 3;
  ops.push({ t: 'line', x1: 0, y1: y, x2: width, y2: y, color: c.line });
  const bandTop = y;
  const stampFont = font(400, 11, CARD_FONTS.mono);
  const stampW = stamp ? measure(stamp, stampFont) + 12 : 0;
  const chipsBottom = checks?.length
    ? flow(checks.map((ch) => ({ kind: 'chip', text: ch.label, tone: ch.tone })), PAD, width - PAD * 2 - stampW, y + 10)
    : y + 10 + 20;
  const bandH = chipsBottom - bandTop + 10;
  ops.splice(ops.findIndex((o) => o.t === 'line' && o.y1 === bandTop), 0, { t: 'rect', x: 0, y: bandTop, w: width, h: bandH, r: 0, fill: c.raised });
  if (stamp) text(width - PAD - measure(stamp, stampFont), bandTop + 14, stamp, stampFont, c.faint);
  y = bandTop + bandH;
  ops.push({ t: 'line', x1: 0, y1: y, x2: width, y2: y, color: c.line });

  // Footer.
  const footFont = font(400, 10.5, CARD_FONTS.mono);
  const footLines = wrapText(footer || '', width - PAD * 2, (s) => measure(s, footFont));
  y += 8;
  for (const l of footLines) { text(PAD, y, l, footFont, c.faint); y += 14; }
  y += 8;
  return { width, height: Math.ceil(y), ops };
}

// ── Preview document ────────────────────────────────────────────────────────

/**
 * CSP for the email preview (the snippets preview's approach): nothing leaves the browser unless
 * `remote` ("Load remote images") is on, which adds https: images, stylesheets and fonts.
 * Scripts, plugins, forms, frames and <base> URLs stay blocked either way.
 */
export function emailCsp({ remote = false } = {}) {
  return [
    "default-src 'none'",
    remote ? 'img-src https: data:' : 'img-src data:',
    remote ? "style-src 'unsafe-inline' https:" : "style-src 'unsafe-inline'",
    remote ? 'font-src https: data:' : 'font-src data:',
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** '<!DOCTYPE html PUBLIC "…" "…">' for a parsed document's doctype, or ''. */
export function doctypeString(dt) {
  if (!dt || !dt.name) return '';
  let s = `<!DOCTYPE ${dt.name}`;
  if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
  if (dt.systemId) s += `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"`;
  return s + '>';
}

// ── Compact page (option A) ─────────────────────────────────────────────────

export const COMPACT_STYLE_ID = 'wb-cc-compact';

/**
 * The compact-page stylesheet: only Iterable's data-test hooks, no generated class names and
 * no DOM moves. The section container (the parent of the Optimize section) becomes a flex column;
 * Sending information moves to the top, then the section holding the schedule field (found with
 * :has(), since that section's own data-test isn't known), and form rows get tighter.
 */
export function compactCss() {
  const box = ':has(> [data-test="optimize-section"])';
  return [
    `${box}{display:flex !important; flex-direction:column !important}`,
    `${box} > [data-test="sending-information-section"]{order:-2 !important}`,
    `${box} > :has([data-test="form-readonly-field-scheduleStartTime"]):not([data-test="sending-information-section"]){order:-1 !important}`,
    `${box} [data-test="form-field"]{margin-block:2px !important; padding-block:2px !important}`,
  ].join('\n');
}
