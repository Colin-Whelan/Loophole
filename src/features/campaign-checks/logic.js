// Pure logic for Campaign checks (no DOM): list/subject validation, schedule time helpers and
// send-rate math. Ported from "Campaign Preview Enhancements" v1.5.0; the matching rules are the
// script's (case-insensitive substring matches).

/** "a, b ,,c" → ['a', 'b', 'c']. Arrays are accepted too (legacy shape). */
export function splitList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts.map((s) => String(s ?? '').trim()).filter(Boolean);
}

const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Seed-list check: does any send list name contain `keyword` (case-insensitive)?
 * → { tone: 'ok' | 'warn', text, match? } or null when there's no keyword to check.
 */
export function checkSeedLists(sendLists, keyword) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return null;
  const match = (sendLists || []).find((name) => lc(name).includes(lc(kw)));
  return match
    ? { tone: 'ok', text: `"${kw}" list attached`, match }
    : { tone: 'warn', text: `No "${kw}" list in the send lists` };
}

/** Rules in stored form ({ keywords, requiredLists, isGlobal }) → [{ keywords[], lists[], isGlobal }]. */
export function normalizeRules(rules) {
  const out = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r !== 'object') continue;
    const isGlobal = r.isGlobal === true;
    const keywords = isGlobal ? [] : splitList(r.keywords);
    const lists = splitList(r.requiredLists ?? r.requiredSuppressionLists);
    if (!lists.length || (!isGlobal && !keywords.length)) continue;
    out.push({ keywords, lists, isGlobal });
  }
  return out;
}

/**
 * Suppression-list check. It always has a state (the approved "Suppression check" proposal):
 *   bad   a required list is missing: "Missing: A, B"
 *   warn  nothing attached and nothing required: "No suppression list on this campaign"
 *         (only with `warnNoSuppression`; off → a neutral "No suppression lists")
 *   ok    "N suppression lists · rules met" (or "… attached" when no requirement applied)
 * Required lists come from `alwaysRequire` (comma-separated names, every campaign) and the
 * keyword rules (a rule applies when it is global or the campaign name contains one of its
 * keywords). A required list is present when some attached list name contains it (ignoring case).
 * `title` says which rule asked for which list (the chip's tooltip).
 * → { tone: 'ok' | 'warn' | 'bad' | undefined, text, missing: [], required: [{ list, reasons, met }], title }
 */
export function checkSuppression({ campaignName, attached, alwaysRequire, rules, warnNoSuppression = true } = {}) {
  const name = lc(campaignName);
  const lists = (attached || []).map((s) => String(s ?? '').trim()).filter(Boolean);
  const required = [];
  const need = (list, reason) => {
    const hit = required.find((r) => lc(r.list) === lc(list));
    if (hit) { if (!hit.reasons.includes(reason)) hit.reasons.push(reason); return; }
    const match = lists.find((a) => lc(a).includes(lc(list)));
    required.push({ list, reasons: [reason], met: !!match, match: match || null });
  };
  for (const list of splitList(alwaysRequire)) need(list, 'Always require');
  for (const rule of normalizeRules(rules)) {
    const applies = rule.isGlobal || rule.keywords.some((k) => name && name.includes(lc(k)));
    if (!applies) continue;
    const reason = rule.isGlobal ? 'Rule for all campaigns' : `Rule "${rule.keywords.join(', ')}"`;
    for (const list of rule.lists) need(list, reason);
  }
  const missing = required.filter((r) => !r.met).map((r) => r.list);
  const title = required.length
    ? required.map((r) => `${r.reasons.join(' + ')} → ${r.list}: ${r.met ? `attached (${r.match})` : 'missing'}`).join('\n')
    : 'No required suppression lists apply to this campaign.';
  const n = lists.length;
  const count = `${n} suppression list${n === 1 ? '' : 's'}`;
  let tone;
  let text;
  if (missing.length) { tone = 'bad'; text = `Missing: ${missing.join(', ')}`; }
  else if (!n) { tone = warnNoSuppression ? 'warn' : undefined; text = warnNoSuppression ? 'No suppression list on this campaign' : 'No suppression lists'; }
  else { tone = 'ok'; text = required.length ? `${count} · rules met` : `${count} attached`; }
  return { tone, text, missing, required, title };
}

// The script's list: characters that break or silently alter a subject line.
export const SUBJECT_BAD_CHARS = Object.freeze([
  { char: ' ', name: 'line separator' },
  { char: ' ', name: 'paragraph separator' },
  { char: '\n', name: 'newline' },
  { char: '\r', name: 'carriage return' },
  { char: '\t', name: 'tab' },
]);

/** → { tone: 'ok' | 'bad', text, found: [names] } */
export function checkSubject(text) {
  const s = String(text ?? '');
  const found = SUBJECT_BAD_CHARS.filter((c) => s.includes(c.char)).map((c) => c.name);
  return found.length
    ? { tone: 'bad', text: `Subject contains ${found.join(', ')}`, found }
    : { tone: 'ok', text: 'Subject line OK', found };
}

// ── Schedule ────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DDTHH:MM' in local time (the datetime-local input format). */
export function toDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 'YYYY-MM-DDTHH:MM[:SS]' → local Date, or null. Rejects impossible dates (Feb 30). */
export function parseDatetimeLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1, 6).map(Number);
  if (hh > 23 || mm > 59) return null;
  const date = new Date(y, mo - 1, d, hh, mm, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** The script's default: now + 61 minutes (so it is still ahead once the dialog is filled). */
export function defaultSendAt(now = new Date()) {
  const d = new Date(now.getTime() + 61 * 60 * 1000);
  d.setSeconds(0, 0);
  return d;
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * How far `target` is from `now`, with the script's urgency bands:
 * past → bad, under an hour → bad, under a day → warn, a day or more → ok.
 * → { tone, text, ms }
 */
export function relativeTime(target, now = new Date()) {
  const ms = target.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return { tone: 'bad', text: 'Pick a date and time', ms: NaN };
  if (ms <= 0) return { tone: 'bad', text: 'That time has already passed', ms };
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return { tone: 'bad', text: `In ${plural(mins, 'minute')}`, ms };
  const totalHours = Math.floor(ms / 3600000);
  if (totalHours < 24) {
    const m = Math.floor((ms % 3600000) / 60000);
    return { tone: 'warn', text: m ? `In ${plural(totalHours, 'hour')}, ${plural(m, 'minute')}` : `In ${plural(totalHours, 'hour')}`, ms };
  }
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return { tone: 'ok', text: hours ? `In ${plural(days, 'day')}, ${plural(hours, 'hour')}` : `In ${plural(days, 'day')}`, ms };
}

/**
 * Date → the strings Iterable's schedule dialog shows (from the script):
 * date 'MM/DD/YYYY', time 'hh:mm AM' (12-hour, zero-padded hour).
 */
export function iterableScheduleStrings(date) {
  const h24 = date.getHours();
  const h12 = h24 % 12 || 12;
  return {
    date: `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`,
    time: `${pad(h12)}:${pad(date.getMinutes())} ${h24 >= 12 ? 'PM' : 'AM'}`,
  };
}

/**
 * Month label from react-calendar's navigation ('September 2026') → { year, month } or null.
 * English month names only (Iterable's UI language); the fallback parser covers the rest.
 */
export function parseMonthLabel(label) {
  const s = String(label ?? '').trim();
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const idx = names.findIndex((n) => n.startsWith(m[1].toLowerCase()) && m[1].length >= 3);
  if (idx < 0) return null;
  return { year: Number(m[2]), month: idx };
}

/** Months to step from the shown month to the target (negative = back). */
export function monthDelta(shown, target) {
  return (target.getFullYear() - shown.year) * 12 + (target.getMonth() - shown.month);
}

// ── Send rate ───────────────────────────────────────────────────────────────

/** Per-minute rate → { perMinute, perHour, text } ('4,000/min ≈ 240,000/hour'). */
export function describeRate(perMinute) {
  const n = Math.max(0, Math.floor(Number(perMinute) || 0));
  const fmt = (v) => v.toLocaleString('en-US');
  return { perMinute: n, perHour: n * 60, text: `${fmt(n)}/min ≈ ${fmt(n * 60)}/hour` };
}

/** Whole number from a string/number, or null. '4,000' and ' 4000 ' are accepted. */
export function toWholeNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[,\s_]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.floor(Number(s));
}
