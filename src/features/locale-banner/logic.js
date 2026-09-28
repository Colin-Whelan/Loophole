// Pure helpers for the locale banner. No DOM, no chrome.*: unit-tested in Node
// (test/features/locale-banner*.test.js) and safe for import.js (runs in the service worker).

export const MAX_LABEL = 24; // a ?locale= value is page input; keep the badge toolbar-sized

/** `?locale=` from a location.search string, trimmed; '' when absent or empty. */
export function localeFromSearch(search) {
  let v = null;
  try { v = new URLSearchParams(String(search || '')).get('locale'); } catch { v = null; }
  return typeof v === 'string' ? v.trim() : '';
}

/** Locale codes compare case-insensitively, and `en_CA` matches `en-CA`. */
export function sameLocale(a, b) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/_/g, '-');
  const x = norm(a);
  return !!x && x === norm(b);
}

/** Uppercased badge text, shortened with an ellipsis past MAX_LABEL characters. */
export function badgeLabel(locale) {
  const s = String(locale || '').trim().toUpperCase();
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}

/**
 * What the badge should show.
 *   locale           the current ?locale= value ('' / null when absent)
 *   settings         { defaultLocale, pulseNonDefault, hideWhenNoLocale } (resolved values)
 *   reducedMotion    prefers-reduced-motion: reduce matches → never pulse
 * → { visible, tone: 'neutral' | 'default' | 'alt', label, title, pulse }
 *
 * Tones: no default configured → every locale is 'neutral' (accent). With a default, the default
 * locale is 'default' (green) and any other is 'alt' (amber). Only 'alt' may pulse.
 * No locale in the URL: hidden when hideWhenNoLocale; otherwise the configured default locale in
 * green (Iterable edits the template's default content then), or a neutral "DEFAULT".
 */
export function classifyLocale(locale, settings = {}, { reducedMotion = false } = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const current = String(locale ?? '').trim();
  const def = typeof s.defaultLocale === 'string' ? s.defaultLocale.trim() : '';
  const hideWhenNoLocale = s.hideWhenNoLocale !== false;
  const pulseNonDefault = s.pulseNonDefault !== false;
  const hidden = { visible: false, tone: 'neutral', label: '', title: '', pulse: false };

  if (!current) {
    if (hideWhenNoLocale) return hidden;
    return def
      ? { visible: true, tone: 'default', label: badgeLabel(def), title: `No locale in the URL: editing the default locale (${def})`, pulse: false }
      : { visible: true, tone: 'neutral', label: 'DEFAULT', title: 'No locale in the URL: editing the default content', pulse: false };
  }

  const label = badgeLabel(current);
  if (!def) {
    return { visible: true, tone: 'neutral', label, title: `Editing locale ${label}`, pulse: false };
  }
  if (sameLocale(current, def)) {
    return { visible: true, tone: 'default', label, title: `Editing the default locale (${label})`, pulse: false };
  }
  return {
    visible: true, tone: 'alt', label,
    title: `Editing locale ${label}, not your default (${badgeLabel(def)})`,
    pulse: pulseNonDefault && !reducedMotion,
  };
}
