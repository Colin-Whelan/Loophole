import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanEmail, isValidEmail, normalizeDelay, sameEmail, planAutofill, submitBlocker, countdownText, looksLikePasswordField, anyPasswordField,
  LOGIN_ROUTE, PASSWORD_PATH, AUTH_ORIGIN_PATTERN,
} from '../../src/features/login-autofill/logic.js';
import importer, { mapLoginAutofill } from '../../src/features/login-autofill/import.js';
import meta from '../../src/features/login-autofill/meta.js';
import { mergeValues, defaultValues } from '../../src/core/settings.js';
import { fieldValidateError } from '../../src/core/schema.js';
import { validateFrameMetas, featureMatchesOrigin } from '../../src/core/feature-frames.js';

const EMAIL = 'someone@example.test';
const page = (over = {}) => ({
  inFrame: false, path: '/u/login/identifier?state=abc', hasField: true, fieldValue: '',
  isUsernameStep: true, hasError: false, hasButton: true, hasPasswordField: false, ...over,
});
const vals = (over = {}) => ({ email: EMAIL, delay: 5, autoContinue: true, ...over });

test('meta: optional auth frame, off by default, sign-in group, routes', () => {
  assert.equal(meta.id, 'login-autofill');
  assert.equal(meta.frame, 'auth');
  assert.equal(meta.group, 'signin');
  assert.equal(meta.defaultEnabled, false);
  assert.equal(meta.usesApiKey, false);
  assert.deepEqual(meta.permissions, { origins: [AUTH_ORIGIN_PATTERN] });
  assert.equal(AUTH_ORIGIN_PATTERN, 'https://auth.iterable.com/*');
  assert.ok(featureMatchesOrigin(meta, 'https://auth.iterable.com'));
  assert.ok(!featureMatchesOrigin(meta, 'https://app.iterable.com'));
  assert.deepEqual(meta.legacy, ['Login Screen - Auto Fill Username']);
  for (const p of ['/u/login', '/u/login?state=x', '/u/login/identifier?state=x', '/u/login/password?state=x']) {
    assert.ok(meta.routes.some((r) => r.test(p)), p);
  }
  for (const p of ['/u/loginx', '/u/signup', '/login', '/']) assert.ok(!meta.routes.some((r) => r.test(p)), p);
  assert.ok(PASSWORD_PATH.test('/u/login/password?state=x'));
  assert.ok(!PASSWORD_PATH.test('/u/login/identifier?state=x'));
  assert.deepEqual(
    validateFrameMetas([meta], {
      files: () => new Set(['index.js', 'meta.js', 'logic.js', 'import.js']),
      optionalOrigins: ['https://auth.iterable.com/*'],
    }),
    [],
  );
  assert.equal(LOGIN_ROUTE.test('/u/login'), true);
});

test('meta: settings schema and defaults', () => {
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), ['autoContinue', 'delay', 'email']);
  assert.equal(byKey.email.type, 'string');
  assert.match(byKey.email.help, /stored only in this browser/i);
  assert.equal(byKey.delay.type, 'number');
  assert.equal(byKey.delay.min, 0);
  assert.equal(byKey.delay.max, 60);
  assert.match(byKey.delay.help, /0 continues immediately/);
  assert.equal(byKey.autoContinue.type, 'boolean');
  assert.deepEqual(defaultValues(meta), { email: '', autoContinue: true, delay: 5 });
  // The options form checks the email (empty = filling off; the placeholder counts as empty).
  assert.equal(fieldValidateError(byKey.email, ''), null);
  assert.equal(fieldValidateError(byKey.email, '  you@example.com '), null);
  assert.equal(fieldValidateError(byKey.email, 'your@email.com'), null);
  assert.match(fieldValidateError(byKey.email, 'not an email'), /email address/);
  assert.match(fieldValidateError(byKey.email, 'a@b'), /email address/);
  // Out-of-range stored values fall back to the default.
  assert.equal(mergeValues(meta, { delay: 61 }).delay, 5);
  assert.equal(mergeValues(meta, { delay: -1 }).delay, 5);
  assert.equal(mergeValues(meta, { delay: 0 }).delay, 0);
});

test('cleanEmail / isValidEmail / sameEmail', () => {
  assert.equal(cleanEmail('  a@b.co '), 'a@b.co');
  assert.equal(cleanEmail('your@email.com'), '', 'the script placeholder counts as unset');
  assert.equal(cleanEmail('YOUR@EMAIL.COM'), '');
  assert.equal(cleanEmail(null), '');
  assert.equal(cleanEmail(5), '');
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.org', EMAIL]) assert.ok(isValidEmail(ok), ok);
  for (const bad of ['', 'a', 'a@b', '@b.co', 'a@.co', 'a b@c.co', 'a@b..co', 'a@@b.co', 'a@b.co ', `${'x'.repeat(250)}@b.co`, null]) {
    assert.ok(!isValidEmail(bad), String(bad));
  }
  assert.ok(sameEmail(' A@B.co', 'a@b.CO'));
  assert.ok(!sameEmail('a@b.co', 'c@b.co'));
});

test('normalizeDelay', () => {
  assert.equal(normalizeDelay(5), 5);
  assert.equal(normalizeDelay(0), 0);
  assert.equal(normalizeDelay(2.6), 3);
  assert.equal(normalizeDelay(99), 60);
  assert.equal(normalizeDelay(-3), 0);
  assert.equal(normalizeDelay('7'), 7);
  assert.equal(normalizeDelay(''), 5);
  assert.equal(normalizeDelay(NaN), 5);
  assert.equal(normalizeDelay(undefined), 5);
});

test('planAutofill: happy path fills and submits after the delay', () => {
  assert.deepEqual(planAutofill(vals(), page()), { fill: true, submit: true, delay: 5, reason: '' });
  assert.deepEqual(planAutofill(vals({ delay: 0 }), page()), { fill: true, submit: true, delay: 0, reason: '' });
  // Already holds exactly our value: no refill, still continues.
  assert.deepEqual(planAutofill(vals(), page({ fieldValue: EMAIL })), { fill: false, submit: true, delay: 5, reason: '' });
  // Same address in another case: normalised to ours, continues.
  assert.deepEqual(planAutofill(vals(), page({ fieldValue: EMAIL.toUpperCase() })), { fill: true, submit: true, delay: 5, reason: '' });
  // Whitespace-only counts as empty.
  assert.equal(planAutofill(vals(), page({ fieldValue: '  ' })).fill, true);
});

test('planAutofill: fill only when autoContinue is off; never clicks', () => {
  assert.deepEqual(planAutofill(vals({ autoContinue: false }), page()), { fill: true, submit: false, delay: 0, reason: 'fill-only' });
  assert.deepEqual(planAutofill(vals(), page({ hasButton: false })), { fill: true, submit: false, delay: 0, reason: 'no-button' });
});

test('planAutofill: refuses in the unsafe cases', () => {
  const none = (reason) => ({ fill: false, submit: false, delay: 0, reason });
  assert.deepEqual(planAutofill(vals(), page({ inFrame: true })), none('frame'));
  assert.deepEqual(planAutofill(vals({ email: '' }), page()), none('no-email'));
  assert.deepEqual(planAutofill(vals({ email: 'your@email.com' }), page()), none('no-email'));
  assert.deepEqual(planAutofill(vals({ email: 'not-an-email' }), page()), none('invalid-email'));
  assert.deepEqual(planAutofill(vals(), page({ path: '/u/login/password?state=x' })), none('password-step'));
  assert.deepEqual(planAutofill(vals(), page({ hasField: false })), none('no-field'));
  assert.deepEqual(planAutofill(vals(), page({ isUsernameStep: false })), none('not-username-step'));
  assert.deepEqual(planAutofill(vals(), page({ fieldValue: 'other@example.test' })), none('user-value'));
  assert.deepEqual(planAutofill(vals(), page({ hasError: true })), none('error'));
  // The user's own value wins even when fill-only.
  assert.deepEqual(planAutofill(vals({ autoContinue: false }), page({ fieldValue: 'typed' })), none('user-value'));
});

test('submitBlocker: re-checks right before the click', () => {
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL })), '');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL }), { cancelled: true }), 'cancelled');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL }), { submitted: true }), 'submitted');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, hasError: true })), 'error');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL + 'x' })), 'user-value');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, isUsernameStep: false })), 'not-username-step');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, hasButton: false })), 'no-button');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, hasField: false })), 'no-field');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, inFrame: true })), 'frame');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, path: '/u/login/password' })), 'password-step');
});

test('a password field in the form: never continues (fill only), and the last check refuses too', () => {
  const p = planAutofill(vals(), page({ hasPasswordField: true }));
  assert.deepEqual(p, { fill: true, submit: false, delay: 0, reason: 'password-field' });
  // A password manager may have filled the username too: still no submit.
  assert.equal(planAutofill(vals(), page({ hasPasswordField: true, fieldValue: EMAIL })).submit, false);
  assert.equal(planAutofill(vals({ delay: 0 }), page({ hasPasswordField: true })).submit, false);
  // Unknown (a snapshot without the flag) counts as "has one": fail closed.
  assert.equal(planAutofill(vals(), page({ hasPasswordField: undefined })).submit, false);
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, hasPasswordField: true })), 'password-field');
  assert.equal(submitBlocker(EMAIL, page({ fieldValue: EMAIL, hasPasswordField: undefined })), 'password-field');
});

test('looksLikePasswordField', () => {
  for (const f of [
    { type: 'password' }, { type: 'PASSWORD' }, { type: 'text', name: 'password' }, { type: 'text', id: 'pwd' },
    { type: 'text', autocomplete: 'current-password' }, { type: 'email', name: 'passcode' }, { type: 'text', name: 'client_secret' },
  ]) assert.ok(looksLikePasswordField(f), JSON.stringify(f));
  for (const f of [
    { type: 'hidden', name: 'state' }, { type: 'hidden', name: 'password' }, { type: 'text', name: 'username' },
    { type: 'email', id: 'username', autocomplete: 'email' }, { type: 'checkbox', name: 'remember' }, {},
  ]) assert.ok(!looksLikePasswordField(f), JSON.stringify(f));
});

test('anyPasswordField: descendants plus form.elements (inputs linked with form="…" from outside)', () => {
  const el = (tagName, attrs = {}) => ({ tagName, name: attrs.name || '', id: attrs.id || '', getAttribute: (k) => attrs[k] ?? null });
  const user = el('INPUT', { type: 'text', name: 'username', autocomplete: 'username' });
  const state = el('INPUT', { type: 'hidden', name: 'state' });
  const btn = el('BUTTON', { type: 'submit', name: 'action' });
  const descendants = [state, user];
  assert.equal(anyPasswordField(descendants, user), false);
  // form.elements repeats the descendants and adds the linked outside controls (and buttons).
  const outsidePw = el('INPUT', { type: 'PASSWORD', name: 'p' });
  assert.equal(anyPasswordField([...descendants, state, user, btn, outsidePw], user), true);
  const outsideText = el('INPUT', { name: 'x1', autocomplete: 'current-password' });
  assert.equal(anyPasswordField([...descendants, outsideText], user), true);
  assert.equal(anyPasswordField([...descendants, el('TEXTAREA', { name: 'pwd' })], user), true);
  // The username field itself never counts by name; buttons / fieldsets are not fields.
  const oddUser = el('INPUT', { type: 'text', name: 'passport-user' });
  assert.equal(anyPasswordField([oddUser, el('BUTTON', { name: 'password' }), el('FIELDSET', { name: 'pass' })], oddUser), false);
  assert.equal(anyPasswordField(null, user), false);
});

test('countdownText', () => {
  assert.match(countdownText(5), /in 5 s$/);
  assert.equal(countdownText(0), 'Continuing…');
});

test('import: email and delay; placeholder skipped; notes never contain the email', () => {
  assert.deepEqual(importer.scripts, ['Login Screen - Auto Fill Username']);
  const r = mapLoginAutofill({ autoLoginEmail: EMAIL, autoLoginDelay: 3 }, { name: 'Login Screen - Auto Fill Username' });
  assert.deepEqual(r.values, { email: EMAIL, delay: 3 });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /switch it on/i);
  assert.match(r.notes[0], /auth\.iterable\.com/);
  assert.ok(!r.notes.join(' ').includes(EMAIL));

  assert.deepEqual(mapLoginAutofill({ autoLoginEmail: 'your@email.com', autoLoginDelay: 5 }).values, { delay: 5 });
  assert.deepEqual(mapLoginAutofill({ autoLoginEmail: 'your@email.com' }), { values: {}, notes: [] });
  assert.deepEqual(mapLoginAutofill({}), { values: {}, notes: [] });
  assert.deepEqual(mapLoginAutofill(null), { values: {}, notes: [] });
  assert.deepEqual(mapLoginAutofill('junk'), { values: {}, notes: [] });

  // Decoded strings, JSON-encoded strings, trimming.
  assert.deepEqual(mapLoginAutofill({ autoLoginEmail: ` ${EMAIL} `, autoLoginDelay: '0' }).values, { email: EMAIL, delay: 0 });
  assert.deepEqual(mapLoginAutofill({ autoLoginEmail: JSON.stringify(EMAIL) }).values, { email: EMAIL });
  assert.equal(mapLoginAutofill({ autoLoginDelay: 2.4 }).values.delay, 2);

  const bad = mapLoginAutofill({ autoLoginEmail: 'nope', autoLoginDelay: 90 });
  assert.deepEqual(bad.values, {});
  assert.equal(bad.notes.length, 2);
  assert.ok(!bad.notes.join(' ').includes('nope'));
  assert.equal(mapLoginAutofill({ autoLoginEmail: { x: 1 } }).notes.length, 1);
  assert.equal(mapLoginAutofill({ autoLoginDelay: 'soon' }).notes.length, 1);

  // Imported values pass the schema.
  const merged = mergeValues(meta, r.values);
  assert.deepEqual(merged, { email: EMAIL, delay: 3, autoContinue: true });
});
