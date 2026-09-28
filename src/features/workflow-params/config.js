// Settings shape and normalisation for workflow-params. DOM-free: import.js (service worker) uses it.

import { normalizeShortcut, isValidShortcut } from '../../core/shortcut.js';

export const DEFAULT_GA_CAMPAIGN = '{{lower campaignName}}';
// Empty by default: Iterable's own Google Analytics option may already add utm_source /
// utm_medium, and a fixed utm_medium=email would be wrong for SMS and push.
export const DEFAULT_LINK_PARAMS = Object.freeze([]);
export const DEFAULT_SHORTCUT = 'Mod+Shift+L';   // the userscript's Ctrl/Cmd+Shift+L

/**
 * A shortcut string in the older formats → the core `shortcut` format, or undefined when it
 * can't be read. Both the userscript's fixed Ctrl/Cmd+Shift+L and this feature's own earlier
 * plain string (where "Ctrl" also meant ⌘ on macOS) mean the platform's primary modifier, so
 * Ctrl / Control / Mod become `Mod`: "Ctrl+Shift+L" → "Mod+Shift+L". "-" separators are
 * accepted as before. '' stays '' (no shortcut).
 */
export function legacyShortcut(v) {
  if (typeof v !== 'string') return undefined;
  if (!v.trim()) return '';
  const parts = v.split(/\s*[+-]\s*(?=.)/).map((p) => p.trim()).filter(Boolean);
  const mapped = parts.map((p, i) => (i < parts.length - 1 && /^(ctrl|control|mod)$/i.test(p) ? 'Mod' : p));
  const out = normalizeShortcut(mapped.join('+'));
  return out && isValidShortcut(out) ? out : undefined;
}

/** true/false, or the strings "true"/"false" (older exports); anything else → undefined. */
export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * [{ key, value }] with trimmed, non-empty string keys and string values. Numbers/booleans are
 * stringified; anything else (null, objects, rows without a key) is dropped. Never throws.
 */
export function normalizeLinkParams(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const key = typeof p.key === 'string' ? p.key.trim() : typeof p.key === 'number' ? String(p.key) : '';
    if (!key) continue;
    const v = p.value;
    const value = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
    out.push({ key, value });
  }
  return out;
}

/**
 * The userscript's config object ({ enableGA, gaCampaign, enableLinkParams, linkParams }, plus
 * an optional `shortcut` string in the older format) → { values, dropped }. Only fields that
 * were present and readable go in `values`, so anything missing keeps the Workbench default.
 * `dropped` counts link-parameter rows left out.
 */
export function configToValues(cfg) {
  const values = {};
  let dropped = 0;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { values, dropped };
  const ga = toBool(cfg.enableGA);
  if (ga !== undefined) values.enableGA = ga;
  if (typeof cfg.gaCampaign === 'string') values.gaCampaign = cfg.gaCampaign;
  const lp = toBool(cfg.enableLinkParams);
  if (lp !== undefined) values.enableLinkParams = lp;
  if (Array.isArray(cfg.linkParams)) {
    values.linkParams = normalizeLinkParams(cfg.linkParams);
    dropped = cfg.linkParams.length - values.linkParams.length;
  }
  const sc = legacyShortcut(cfg.shortcut);
  if (sc !== undefined) values.shortcut = sc;
  return { values, dropped };
}
