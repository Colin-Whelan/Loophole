// Pure helpers for quick search tags: presets, normalisation, sorting. No DOM, safe in node tests.
//
// Stored shape (feature values):
//   tags:      [{ id, label, colorGradient: { start, end }, timestamp }]
//   sortOrder: 'custom' | 'alpha' | 'recent'

export const SORT_ORDERS = Object.freeze(['custom', 'alpha', 'recent']);
export const DEFAULT_SORT = 'custom';
export const MAX_TAG_LABEL = 60;

// The nine gradients from the userscript, in its order.
export const PRESET_GRADIENTS = Object.freeze([
  { start: '#10b981', end: '#047857' }, // green
  { start: '#84cc16', end: '#4d7c0f' }, // lime
  { start: '#06b6d4', end: '#0e7490' }, // cyan
  { start: '#6366f1', end: '#4338ca' }, // indigo
  { start: '#8b5cf6', end: '#6d28d9' }, // purple
  { start: '#ec4899', end: '#be185d' }, // pink
  { start: '#f59e0b', end: '#b45309' }, // amber
  { start: '#f97316', end: '#c2410c' }, // orange
  { start: '#ef4444', end: '#b91c1c' }, // red
].map((g) => Object.freeze(g)));

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(v) {
  return typeof v === 'string' && HEX.test(v.trim());
}

/** '#abc' / '#aabbcc' → '#aabbcc' (lower case), or null. */
export function expandHex(v) {
  if (!isHexColor(v)) return null;
  let s = v.trim().slice(1).toLowerCase();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return '#' + s;
}

/** Darken a hex colour by `amount` (0–1, share of each channel removed). null if not hex. */
export function darken(hex, amount = 0.3) {
  const full = expandHex(hex);
  if (!full) return null;
  const a = Math.min(1, Math.max(0, Number(amount) || 0));
  const channels = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return '#' + channels.map((c) => Math.round(c * (1 - a)).toString(16).padStart(2, '0')).join('');
}

export function presetAt(index) {
  const n = PRESET_GRADIENTS.length;
  const i = ((Math.trunc(Number(index)) || 0) % n + n) % n;
  return { ...PRESET_GRADIENTS[i] };
}

/** The preset a new tag gets: cycles through the nine in order. */
export function nextPresetIndex(tags) {
  return (Array.isArray(tags) ? tags.length : 0) % PRESET_GRADIENTS.length;
}

/** CSS background for a gradient (values are validated hex, so this is safe to put in style). */
export function gradientCss(g) {
  const safe = normaliseGradient(g) || presetAt(0);
  return `linear-gradient(135deg, ${safe.start} 0%, ${safe.end} 100%)`;
}

/** { start, end } with valid hex colours → normalised copy; anything else → null. */
export function normaliseGradient(g) {
  if (!g || typeof g !== 'object') return null;
  const start = expandHex(g.start);
  const end = expandHex(g.end);
  return start && end ? { start, end } : null;
}

/**
 * Accept any legacy/new tag shape and return the stored shape, or null when it has no usable label.
 * - new: { id, label, colorGradient: { start, end }, timestamp }
 * - old: { id, label, color, timestamp } → gradient from `color` to a darker shade of it
 * Unknown fields are dropped; bad colours fall back to preset `index`. Labels are capped at
 * MAX_TAG_LABEL characters.
 */
export function normaliseTag(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = (typeof raw.label === 'string' ? raw.label.trim()
    : typeof raw.label === 'number' ? String(raw.label) : '').slice(0, MAX_TAG_LABEL).trim();
  if (!label) return null;
  let colorGradient = normaliseGradient(raw.colorGradient);
  if (!colorGradient && isHexColor(raw.color)) {
    colorGradient = { start: expandHex(raw.color), end: darken(raw.color, 0.3) };
  }
  if (!colorGradient) colorGradient = presetAt(index);
  const ts = Number(raw.timestamp);
  const id = raw.id != null && String(raw.id).trim() ? String(raw.id).trim() : '';
  return { id, label, colorGradient, timestamp: Number.isFinite(ts) ? ts : 0 };
}

/** Normalise a whole list: drops unusable entries and makes ids unique and non-empty. */
export function normaliseTags(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    const t = normaliseTag(raw, i);
    if (!t) return;
    let id = t.id || `tag-${i + 1}`;
    for (let n = 2; seen.has(id); n++) id = `${t.id || `tag-${i + 1}`}-${n}`;
    seen.add(id);
    out.push({ ...t, id });
  });
  return out;
}

export function normaliseSortOrder(v) {
  return SORT_ORDERS.includes(v) ? v : DEFAULT_SORT;
}

/** Display order. 'custom' keeps the stored order; 'recent' = newest first (by timestamp). */
export function sortTags(tags, sortOrder) {
  const list = Array.isArray(tags) ? [...tags] : [];
  switch (sortOrder) {
    case 'alpha':
      return list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    case 'recent':
      return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    default:
      return list;
  }
}

/** Reorder `tags` to follow `ids`; tags missing from `ids` keep their relative order at the end. */
export function reorderTags(tags, ids) {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const out = [];
  for (const id of ids || []) {
    const t = byId.get(id);
    if (t) { out.push(t); byId.delete(id); }
  }
  return out.concat(tags.filter((t) => byId.has(t.id)));
}

export function hasLabel(tags, label) {
  const l = String(label || '').trim().toLowerCase();
  return !!l && tags.some((t) => t.label.toLowerCase() === l);
}

/** Build a new tag with a unique id. */
export function makeTag(label, colorGradient, existing = [], now = Date.now()) {
  const ids = new Set(existing.map((t) => t.id));
  let id = `t${now.toString(36)}`;
  for (let n = 2; ids.has(id); n++) id = `t${now.toString(36)}-${n}`;
  return {
    id,
    label: String(label).trim().slice(0, MAX_TAG_LABEL).trim(),
    colorGradient: normaliseGradient(colorGradient) || presetAt(nextPresetIndex(existing)),
    timestamp: now,
  };
}

/**
 * Three-way merge of the options editor's tag list into the latest stored one, by tag id, so a
 * tag saved from the page (or another tab) meanwhile isn't lost.
 *   base    the stored list the editor last synced from
 *   latest  the stored list now
 *   local   the editor's list (base + the user's adds, renames, deletes, reorder)
 * Local adds, deletes and renames win; tags added elsewhere are kept (appended in their stored
 * order); tags deleted elsewhere stay deleted unless renamed locally; otherwise the latest copy of
 * a tag is used. Order follows the editor's list.
 */
export function mergeTagEdits(base, latest, local) {
  const baseById = new Map((base || []).map((t) => [t.id, t]));
  const latestById = new Map((latest || []).map((t) => [t.id, t]));
  const localIds = new Set((local || []).map((t) => t.id));
  const out = [];
  for (const t of local || []) {
    const b = baseById.get(t.id);
    const l = latestById.get(t.id);
    if (!b) { out.push(t); continue; }                       // added in the editor
    if (JSON.stringify(b) !== JSON.stringify(t)) { out.push(t); continue; } // changed in the editor
    if (l) out.push(l);                                      // unchanged here: the latest copy
    // else: deleted elsewhere and untouched here, so it stays deleted
  }
  for (const t of latest || []) {
    if (localIds.has(t.id) || baseById.has(t.id)) continue;  // known, or deleted in the editor
    out.push(t);                                             // added elsewhere
  }
  return out;
}

/** Tolerant boolean: true/false, 'true'/'false', Tampermonkey-tagged 'btrue'/'bfalse', 1/0. */
export function parseBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'btrue' || s === '1') return true;
    if (s === 'false' || s === 'bfalse' || s === '0' || s === '') return false;
  }
  return fallback;
}
