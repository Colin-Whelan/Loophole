// Pure helpers for the Live preview editor's isolated side (index.js). Unit-tested.

import { aceBindKey, fontStack, FONT_SIZE_MIN, FONT_SIZE_MAX } from './commands.js';
import { normalizeShortcut, isValidShortcut } from '../../core/shortcut.js';

export const SAVE_TEST_DATA_PATH = '/templates/saveJsonTestDataReturningRenderedData';
export const SHOW_HTML_PATH = '/templates/showHtml';
export const UNSAVED_TEXT = 'There are unsaved changes';
export const WIDTH_MIN = 25;
export const WIDTH_MAX = 75;
export const MAX_RECENT = 10;
export const MAX_PAYLOADS = 50;
export const MAX_PAYLOAD_NAME = 80;
export const MAX_TEST_DATA = 1024 * 1024;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** The template id from a location.search ('?templateId=123&locale=fr'), digits only, or null. */
export function templateIdFrom(search) {
  const id = new URLSearchParams(search || '').get('templateId');
  return id && /^\d{1,15}$/.test(id) ? id : null;
}

/** The ?locale= value, or '' when absent. */
export function localeFrom(search) {
  return new URLSearchParams(search || '').get('locale') || '';
}

/** Same-origin path of the rendered preview (the script's showHtml URL; locale only when set). */
export function previewPath(templateId, locale, now = Date.now()) {
  const q = new URLSearchParams({ templateId: String(templateId), _t: String(now) });
  if (locale) q.set('locale', locale);
  return `${SHOW_HTML_PATH}?${q}`;
}

/** Body of POST /templates/saveJsonTestDataReturningRenderedData, exactly as the script sent it. */
export function testDataBody(templateId, userJson) {
  return {
    jsonTestData: { dataFeedJson: {}, userJson },
    payload: {},
    templateId: parseInt(templateId, 10),
    subject: '',
    webBody: '',
    webTitle: '',
  };
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The JSON editor's text → { ok, value } where value is always an object ({} when the text isn't
 * a JSON object; the script fell back to {} too, and Iterable's userJson is an object).
 */
export function parseTestData(text) {
  try {
    const v = JSON.parse(String(text ?? '').trim() || '{}');
    return isRecord(v) ? { ok: true, value: v } : { ok: false, value: {}, error: 'Test data must be a JSON object.' };
  } catch (e) {
    return { ok: false, value: {}, error: `Test data isn't valid JSON (${e.message}).` };
  }
}

/** Pretty-print JSON text (2 spaces), or return it unchanged when it doesn't parse. */
export function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text ?? ''); }
}

/**
 * Pushed values on top of the test data (a copy). A dotted field ("a.b") is set nested, as the
 * push wrote it; a non-object on the way is replaced. Reserved names are skipped.
 * overrides: Map or [[field, value]].
 */
export function applyOverrides(userJson, overrides) {
  const out = structuredClone(isRecord(userJson) ? userJson : {});
  for (const [field, value] of overrides || []) {
    const keys = String(field).split('.');
    if (!keys.every((k) => k && !FORBIDDEN.has(k))) continue;
    let cur = out;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) { cur[k] = value; return; }
      if (!isRecord(cur[k])) cur[k] = {};
      cur = cur[k];
    });
  }
  return out;
}

/** The override chip text: up to 3 names, else the first 2 and "+N". */
export function overridesLabel(fields) {
  const f = [...fields];
  return f.length <= 3 ? f.join(', ') : `${f.slice(0, 2).join(', ')} +${f.length - 2}`;
}

/** Saved payloads from storage (or an import) → [{ name, data }] with sane names and strings. */
export function normalizePayloads(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const p of v) {
    if (!isRecord(p)) continue;
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, MAX_PAYLOAD_NAME) : '';
    const data = typeof p.data === 'string' ? p.data : isRecord(p.data) ? JSON.stringify(p.data) : null;
    if (!name || data === null || data.length > MAX_TEST_DATA || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, data });
    if (out.length >= MAX_PAYLOADS) break;
  }
  return out;
}

/** Save `data` under `name`: replaces a payload of that name, else appends. → new list */
export function upsertPayload(list, name, data) {
  const n = String(name ?? '').trim().slice(0, MAX_PAYLOAD_NAME);
  if (!n) return list;
  const out = list.map((p) => (p.name === n ? { name: n, data } : p));
  if (!out.some((p) => p.name === n)) out.push({ name: n, data });
  return out.slice(-MAX_PAYLOADS);
}

/** Most recent first, no duplicates, at most `max`. */
export function pushRecent(list, field, max = MAX_RECENT) {
  const f = String(field ?? '').trim();
  const prev = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x && x !== f) : [];
  return (f ? [f, ...prev] : prev).slice(0, max);
}

export function clampWidth(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 50;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, v));
}

/**
 * Settings → what main.js's configure() takes, plus the shortcuts that refresh the preview (the
 * refresh shortcut and any "Refresh preview" keybinding; handled on the isolated side).
 * → { bindings: [{ command, win, mac }], snippets: [{ body, win, mac }], font, refreshKeys }
 */
export function editorPlan(settings = {}) {
  const bindings = [];
  const refreshKeys = [];
  const addRefresh = (k) => { const n = normalizeShortcut(k); if (n && isValidShortcut(n) && !refreshKeys.includes(n)) refreshKeys.push(n); };
  addRefresh(settings.refreshShortcut);
  for (const b of Array.isArray(settings.keybindings) ? settings.keybindings : []) {
    if (!b || typeof b.command !== 'string') continue;
    if (b.command === 'refreshPreview') { addRefresh(b.keys); continue; }
    const k = aceBindKey(b.keys);
    if (k) bindings.push({ command: b.command, ...k });
  }
  const snippets = [];
  for (const s of Array.isArray(settings.snippets) ? settings.snippets : []) {
    if (!s || typeof s.body !== 'string' || !s.shortcut) continue;
    const k = aceBindKey(s.shortcut);
    if (k) snippets.push({ body: s.body, ...k });
  }
  const size = Number.isInteger(settings.fontSize) ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize)) : 13;
  const family = fontStack(settings.fontFamily) ? settings.fontFamily : '';
  return { bindings, snippets, font: { family, size }, refreshKeys };
}

/**
 * State name of one template's own test data: `testData:<projectSlot>:t<templateId>` (or
 * `testData:t<templateId>` with no project). Matches the backup restore's RESTORE_NAME_RE.
 */
export function testDataName(slot, templateId) {
  return `testData:${slot ? `${slot}:` : ''}t${templateId}`;
}

/**
 * What a refresh may do (index.js refresh()). Nothing leaves the page unless the person asked:
 *   trigger  'explicit'  the Refresh button, the refresh shortcut, "Apply & refresh"
 *            'testData'  the person changed this template's test data (payload, profile, push)
 *            'show'      the preview appeared (page load, Live, un-hide)
 *            'url'       the templateId / locale in the URL changed
 *   editorPresent  the code editor (and so our bar) is on the page; false on drag-and-drop
 *                  templates, where the feature does nothing at all
 *   sidebarShown   our live preview sidebar is showing (open, Live mode)
 *   templateId     from the URL (null → nothing)
 *   testDataFor    the template the test data in our editor belongs to (loaded from its own
 *                  saved copy, or edited while on it); null while it's only the starting text
 *   unsaved        Iterable shows "There are unsaved changes"
 * → { reload, save, post }
 *   reload  load the rendered preview into our sidebar (a GET of showHtml)
 *   save    click Iterable's Save first: only for an explicit refresh with the sidebar showing
 *   post    send the test data to this template: only on the person's action, and only its own
 */
export function refreshPlan({ trigger, editorPresent, sidebarShown, templateId, testDataFor, unsaved }) {
  const none = { reload: false, save: false, post: false };
  if (!editorPresent || !templateId) return none;
  const reload = !!sidebarShown;
  if (trigger === 'url' || trigger === 'show') return { ...none, reload };
  if (trigger !== 'explicit' && trigger !== 'testData') return none;
  return {
    reload,
    save: trigger === 'explicit' && !!sidebarShown && !!unsaved,
    post: testDataFor != null && String(testDataFor) === String(templateId),
  };
}

/** Rank of refresh triggers, for merging one queued behind a running refresh. */
export const TRIGGER_RANK = Object.freeze({ url: 0, show: 0, testData: 1, explicit: 2 });

/** Toast shown when a person's action finished on a template other than the one it started on. */
export const SWITCHED_TEXT = 'Switched templates — nothing was applied.';

/**
 * Is a person's action (Load profile, a payload, "Apply & refresh", a push) still on the template
 * it started on? Checked by every async continuation before it writes local state, clicks
 * Iterable's Save or posts test data.
 *   scope { tid, gen, slot }   captured when the action started: the template whose test data was
 *                              showing, the template generation (bumped on every template load, so
 *                              A → B → A still counts as a switch) and the project slot
 *   now   { tid, urlTid, gen, slot, aborted }   the same, read at the continuation
 */
export function actionCurrent(scope, now) {
  if (!scope || !now || now.aborted) return false;
  return now.gen === scope.gen && now.tid === scope.tid && now.urlTid === scope.tid && now.slot === scope.slot;
}
