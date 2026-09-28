// Scan engine and banner text. Pure (no DOM), shared by index.js and the Node tests.

import { RULES, CATEGORIES } from './rules.js';

export const SEVERITIES = Object.freeze(['error', 'warning', 'info']);
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** Settings fields for meta.js: one boolean per rule, grouped by the script's categories. */
export function ruleSettings(rules = RULES) {
  return rules.map((r) => ({
    key: r.id, type: 'boolean', label: r.label, help: r.description, default: r.defaultOn, section: r.category,
  }));
}

/** Is rule `id` on? Missing or non-boolean values fall back to the rule's default. */
export function isRuleOn(settings, rule) {
  const v = settings?.[rule.id];
  return typeof v === 'boolean' ? v : rule.defaultOn;
}

/** Key of the enabled rule set, so a settings change forces a rescan of unchanged HTML. */
export function enabledKey(settings, rules = RULES) {
  return rules.map((r) => (isRuleOn(settings, r) ? '1' : '0')).join('');
}

function normalizeIssue(issue, rule) {
  const severity = SEVERITIES.includes(issue?.severity) ? issue.severity : rule.severity;
  const out = { severity, message: String(issue?.message ?? rule.label) };
  if (typeof issue?.snippet === 'string' && issue.snippet) out.snippet = issue.snippet;
  if (typeof issue?.note === 'string' && issue.note) out.note = issue.note;
  return out;
}

/**
 * Run every enabled rule on `html`. A rule that throws counts as failed with no issues listed
 * (the script logged and skipped it); `errors` lists those rule ids.
 * → { total, passed, issues: [{ ruleId, category, severity, message, snippet?, note? }],
 *     results: [{ rule, issues }], counts: { error, warning, info }, errors: [ruleId] }
 */
export function scanHtml(html, settings, rules = RULES) {
  const results = [];
  const errors = [];
  for (const rule of rules) {
    if (!isRuleOn(settings, rule)) continue;
    let issues;
    try {
      const raw = rule.run(String(html ?? ''));
      issues = Array.isArray(raw) ? raw.map((i) => normalizeIssue(i, rule)) : [];
    } catch {
      errors.push(rule.id);
      issues = [];
    }
    results.push({ rule, issues });
  }
  const issues = results.flatMap(({ rule, issues: list }) =>
    list.map((i) => ({ ruleId: rule.id, category: rule.category, ...i })));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const passed = results.filter((r) => r.issues.length === 0 && !errors.includes(r.rule.id)).length;
  return { total: results.length, passed, issues, results, counts, errors };
}

/** Issues grouped by category (the script's order), most severe first within a group. */
export function groupIssues(issues, categories = CATEGORIES) {
  const order = [...categories, ...new Set(issues.map((i) => i.category).filter((c) => !categories.includes(c)))];
  return order
    .map((category) => ({
      category,
      issues: issues
        .map((issue, idx) => ({ issue, idx }))
        .filter(({ issue }) => issue.category === category)
        .sort((a, b) => SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || a.idx - b.idx)
        .map(({ issue }) => issue),
    }))
    .filter((g) => g.issues.length > 0);
}

/**
 * Banner header for a scan result.
 * → { tone: 'ok' | 'warn' | 'bad' | 'off', title, detail }
 *   bad = at least one error, warn = warnings or info only, ok = clean, off = no rules switched on.
 */
export function summarize(result) {
  if (!result.total) {
    return { tone: 'off', title: 'HTML check: all rules are off', detail: 'Switch rules on in Settings.' };
  }
  const n = result.issues.length;
  const detail = `${result.passed} of ${result.total} rule${result.total === 1 ? '' : 's'} passed`;
  if (!n) {
    return { tone: result.errors.length ? 'warn' : 'ok', title: 'HTML check: no issues', detail };
  }
  const tone = result.counts.error ? 'bad' : 'warn';
  return { tone, title: `HTML check: ${n} issue${n === 1 ? '' : 's'}`, detail };
}

/** Chip text and tone for a severity. */
export function severityChip(severity) {
  if (severity === 'error') return { label: 'Error', tone: 'bad' };
  if (severity === 'warning') return { label: 'Warn', tone: 'warn' };
  return { label: 'Info', tone: undefined };
}

/** "scanned 4s ago" / "2m ago" / "1h ago". */
export function formatAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
