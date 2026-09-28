// Settings schema helpers for the structured field types (ARCHITECTURE §8.1): `shortcut` and
// `objectList`. Pure, DOM-free: used by core/settings.js (all contexts, service worker included)
// and by the options page's generated form.

import { isValidShortcut, normalizeShortcut, shortcutError } from './shortcut.js';

/** Sub-field types an objectList item may use. */
export const ITEM_FIELD_TYPES = ['string', 'text', 'select', 'boolean', 'number', 'shortcut'];

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Default for one objectList sub-field: its `default`, else '' / false / min or 0 / first option. */
export function itemFieldDefault(sub) {
  if (sub.default !== undefined) return sub.default;
  switch (sub.type) {
    case 'boolean': return false;
    case 'number': return sub.min ?? 0;
    case 'select': return sub.options?.[0]?.value ?? '';
    default: return '';
  }
}

/** A new item with every sub-field at its default. */
export function newItem(field) {
  const item = {};
  for (const sub of field.fields || []) item[sub.key] = clone(itemFieldDefault(sub));
  return item;
}

/** Type check for one sub-field value (what storage accepts; `required`/`validate` are form-only). */
export function isValidItemValue(sub, value) {
  switch (sub.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (sub.min != null && value < sub.min) return false;
      if (sub.max != null && value > sub.max) return false;
      return true;
    case 'string':
    case 'text': return typeof value === 'string';
    case 'select': return (sub.options || []).some((o) => o.value === value);
    case 'shortcut': return isValidShortcut(value);
    default: return true;
  }
}

/**
 * Normalise a stored objectList: non-object items are dropped; every declared sub-field that is
 * missing or of the wrong type gets its default (so adding a sub-field in a later version keeps
 * the user's items); shortcuts are canonicalised; undeclared keys (an item `id`, say) are kept.
 * → the repaired array, or null when `value` isn't an array or the repaired list breaks
 * minItems / maxItems (the caller then falls back to the field default).
 */
export function normalizeObjectList(field, value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    const item = clone(raw);
    for (const sub of field.fields || []) {
      let v = item[sub.key];
      if (sub.type === 'shortcut' && typeof v === 'string') v = normalizeShortcut(v) ?? v;
      item[sub.key] = isValidItemValue(sub, v) ? v : clone(itemFieldDefault(sub));
    }
    out.push(item);
  }
  if (field.minItems != null && out.length < field.minItems) return null;
  if (field.maxItems != null && out.length > field.maxItems) return null;
  return out;
}

/** Strict check used by isValidValue: already in normal form and within the item bounds. */
export function isValidObjectList(field, value) {
  if (!Array.isArray(value) || !value.every(isPlainObject)) return false;
  if (field.minItems != null && value.length < field.minItems) return false;
  if (field.maxItems != null && value.length > field.maxItems) return false;
  return value.every((item) => (field.fields || []).every((sub) => (
    Object.prototype.hasOwnProperty.call(item, sub.key) && isValidItemValue(sub, item[sub.key])
    && (sub.type !== 'shortcut' || normalizeShortcut(item[sub.key]) === item[sub.key]))));
}

/**
 * Form validation for one sub-field value as the user entered it. → error message or null.
 * Adds, on top of the type check: `required` (non-empty after trim), shortcut rules, and an
 * optional `validate(value, item)` → message | null declared on the sub-field.
 */
export function itemFieldError(sub, value, item = {}, { mac } = {}) {
  const empty = value == null || (typeof value === 'string' && value.trim() === '');
  if (sub.required && empty) return `${sub.label || sub.key} is required.`;
  switch (sub.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
      if (sub.min != null && value < sub.min) return `Must be at least ${sub.min}.`;
      if (sub.max != null && value > sub.max) return `Must be at most ${sub.max}.`;
      break;
    case 'select':
      if (!isValidItemValue(sub, value)) return 'Pick one of the options.';
      break;
    case 'shortcut': {
      const err = shortcutError(value ?? '', mac === undefined ? {} : { mac });
      if (err) return err;
      break;
    }
    default:
      if (!isValidItemValue(sub, value)) return 'Invalid value.';
  }
  if (typeof sub.validate === 'function') {
    try {
      const msg = sub.validate(value, item);
      if (msg) return String(msg);
    } catch (e) {
      return 'Invalid value.';
    }
  }
  return null;
}

/**
 * Validate an objectList as entered in the form.
 * → { ok, listError: string|null, itemErrors: [{ index, key, message }], value }
 * `value` has shortcuts canonicalised. Also reports duplicate non-empty shortcuts within the list
 * (two items can't share a key combo).
 */
export function validateObjectList(field, items, { mac } = {}) {
  const itemErrors = [];
  const value = [];
  const combos = new Map();
  (Array.isArray(items) ? items : []).forEach((raw, index) => {
    const item = { ...raw };
    for (const sub of field.fields || []) {
      if (sub.type === 'shortcut' && typeof item[sub.key] === 'string') {
        item[sub.key] = normalizeShortcut(item[sub.key]) ?? item[sub.key];
      }
      const message = itemFieldError(sub, item[sub.key], item, { mac });
      if (message) { itemErrors.push({ index, key: sub.key, message }); continue; }
      if (sub.type === 'shortcut' && item[sub.key]) {
        const k = `${sub.key}\u0000${item[sub.key]}`;
        if (combos.has(k)) itemErrors.push({ index, key: sub.key, message: `Already used by ${field.itemLabel || 'item'} ${combos.get(k) + 1}.` });
        else combos.set(k, index);
      }
    }
    value.push(item);
  });
  let listError = null;
  const label = (field.itemLabel || 'item').toLowerCase();
  if (field.minItems != null && value.length < field.minItems) listError = `Add at least ${field.minItems} ${label}${field.minItems === 1 ? '' : 's'}.`;
  if (field.maxItems != null && value.length > field.maxItems) listError = `At most ${field.maxItems} ${label}${field.maxItems === 1 ? '' : 's'}.`;
  return { ok: !listError && itemErrors.length === 0, listError, itemErrors, value };
}

/**
 * Group fields by their `section` in first-seen order. Fields without a section share an
 * untitled group (title null) that sits where the first of them appears.
 * → [{ title: string|null, fields: [field] }]
 */
export function groupSections(fields) {
  const groups = [];
  const byTitle = new Map();
  for (const f of fields) {
    const title = typeof f.section === 'string' && f.section.trim() ? f.section.trim() : null;
    let g = byTitle.get(title);
    if (!g) { g = { title, fields: [] }; byTitle.set(title, g); groups.push(g); }
    g.fields.push(f);
  }
  return groups;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * JSON deep copy that drops `__proto__` / `constructor` / `prototype` keys at every depth
 * (JSON.parse would keep them as own properties). Used for every stored value settings repair
 * or merge copies, so a crafted objectList item or value can't carry them along.
 */
export function cloneJsonSafe(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v), (k, val) => (FORBIDDEN_KEYS.has(k) ? undefined : val));
}

const clone = cloneJsonSafe;
