// Pure decisions for Login autofill (no DOM, no chrome.*): unit-tested in
// test/features/login-autofill.test.js. index.js reads the page into a snapshot and asks these.

export const AUTH_ORIGIN_PATTERN = 'https://auth.iterable.com/*';
/** /u/login, /u/login?state=…, /u/login/identifier?… (tested against pathname + search). */
export const LOGIN_ROUTE = /^\/u\/login(?:[/?#]|$)/;
/** Auth0's password step: never act there. */
export const PASSWORD_PATH = /^\/u\/login\/password(?:[/?#]|$)/;
export const MAX_DELAY = 60;
export const DEFAULT_DELAY = 5;
/** The userscript's default value: never a real address. */
export const PLACEHOLDER_EMAIL = 'your@email.com';
/** A field name / id / autocomplete that says "password" (pass, passwd, pwd, current-password…). */
export const PASSWORDISH_RE = /pass|pwd|secret/i;

/**
 * Does a form field (other than the username field) look like a password? `f` describes it:
 * { type, name, id, autocomplete }. Hidden inputs are Auth0's state tokens: not passwords.
 */
export function looksLikePasswordField(f) {
  const type = String(f?.type || '').toLowerCase();
  if (type === 'password') return true;
  if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio') return false;
  return [f?.name, f?.id, f?.autocomplete].some((v) => typeof v === 'string' && PASSWORDISH_RE.test(v));
}

/**
 * Do any of `elements` (form controls: the form's descendants plus `form.elements`, which also
 * holds inputs outside the form linked with form="…") hold a password? Any password input counts
 * (visible or not); other fields by looksLikePasswordField, except `field` (the username field).
 */
export function anyPasswordField(elements, field) {
  const list = [...(elements || [])].filter((el) => el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(el.tagName || '').toUpperCase()));
  const typeOf = (el) => el.getAttribute?.('type') || (String(el.tagName).toUpperCase() === 'INPUT' ? 'text' : String(el.tagName).toLowerCase());
  if (list.some((el) => String(el.tagName).toUpperCase() === 'INPUT' && typeOf(el).toLowerCase() === 'password')) return true;
  return list.some((el) => el !== field && looksLikePasswordField({ type: typeOf(el), name: el.name, id: el.id, autocomplete: el.getAttribute?.('autocomplete') }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Trimmed email, or '' when unset (empty or the userscript's placeholder). */
export function cleanEmail(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.toLowerCase() === PLACEHOLDER_EMAIL ? '' : s;
}

/** Looks like an email address (one @, a dotted domain, no spaces, ≤ 254 chars). */
export function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** Options-form check for the email setting: empty (filling off) or an email address. */
export function emailSettingError(v) {
  const email = cleanEmail(v);
  return !email || isValidEmail(email) ? null : 'Enter an email address, like you@example.com, or leave it empty.';
}

/** Whole seconds in 0…MAX_DELAY; anything unusable → DEFAULT_DELAY. */
export function normalizeDelay(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_DELAY;
  return Math.min(MAX_DELAY, Math.max(0, Math.round(n)));
}

/** Same address, ignoring case and surrounding spaces. */
export function sameEmail(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * What to do on this page. `page` is a snapshot read by index.js:
 *   { inFrame, path, hasField, fieldValue, isUsernameStep, hasError, hasButton, hasPasswordField }
 *   hasPasswordField: the form holds a password input (visible or not) or another field that
 *   looks like one: continuing would submit whatever a password manager put there.
 * `values` = the feature's settings. → { fill, submit, delay, reason }
 *   fill    set the username field to `email` (false when it already holds exactly that)
 *   submit  click the continue button (after `delay` seconds)
 *   reason  why nothing (more) happens: 'frame' | 'no-email' | 'invalid-email' | 'no-field' |
 *           'password-step' | 'not-username-step' | 'error' | 'user-value' | 'no-button' |
 *           'fill-only' | 'password-field' | ''
 */
export function planAutofill(values, page) {
  const none = (reason) => ({ fill: false, submit: false, delay: 0, reason });
  if (page.inFrame) return none('frame');
  const email = cleanEmail(values?.email);
  if (!email) return none('no-email');
  if (!isValidEmail(email)) return none('invalid-email');
  if (PASSWORD_PATH.test(page.path || '')) return none('password-step');
  if (!page.hasField) return none('no-field');
  if (!page.isUsernameStep) return none('not-username-step');
  const current = String(page.fieldValue ?? '');
  if (current.trim() && !sameEmail(current, email)) return none('user-value');
  // An error on the page (wrong address, blocked account): leave it for the person to read.
  if (page.hasError) return none('error');
  const fill = current !== email;
  // A password field in this form: filling the username is fine, but continuing would submit
  // the password too (e.g. one a password manager filled). Never continue there.
  if (page.hasPasswordField !== false) return { fill, submit: false, delay: 0, reason: 'password-field' };
  if (values?.autoContinue === false) return { fill, submit: false, delay: 0, reason: 'fill-only' };
  if (!page.hasButton) return { fill, submit: false, delay: 0, reason: 'no-button' };
  return { fill, submit: true, delay: normalizeDelay(values?.delay), reason: '' };
}

/**
 * Last check right before clicking continue (the page may have changed during the countdown).
 * → '' when it's safe, else the reason ('cancelled' | 'error' | 'user-value' | …).
 */
export function submitBlocker(email, page, { cancelled = false, submitted = false } = {}) {
  if (cancelled) return 'cancelled';
  if (submitted) return 'submitted';
  if (page.inFrame) return 'frame';
  if (PASSWORD_PATH.test(page.path || '')) return 'password-step';
  if (!page.hasField) return 'no-field';
  if (!page.isUsernameStep) return 'not-username-step';
  if (page.hasError) return 'error';
  if (page.hasPasswordField !== false) return 'password-field';
  if (!sameEmail(page.fieldValue, email)) return 'user-value';
  if (!page.hasButton) return 'no-button';
  return '';
}

/** Countdown label: "Continuing in 5 s" / "Continuing…". */
export function countdownText(secondsLeft) {
  return secondsLeft > 0 ? `Continuing to the password step in ${secondsLeft} s` : 'Continuing…';
}
