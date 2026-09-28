// Login autofill: port of "Login Screen - Auto Fill Username" v2.0.
// On auth.iterable.com/u/login (Auth0's username step) it fills the saved username, shows a
// countdown with "Cancel (Esc)" in the shared bottom-right dock (shadow root), then clicks the
// continue button to reach the password step. It never reads or fills the password.
//
// Differences from the script: the settings live on the options page (not a GM menu overlay);
// the value is set with setNativeValue + input/change events; it refuses to submit when the page
// shows an error, when the field holds something else (typed by the person, or a login_hint), when
// the form isn't the username step or holds a password field (visible or not: a password manager
// may have filled it), inside iframes, or when the value changed during the countdown;
// typing in the field or clicking the button yourself also stops the countdown. Cancelling holds
// for this page load (a settings change doesn't restart it). The email is never logged.

import { cleanEmail, countdownText, planAutofill, submitBlocker, anyPasswordField } from './logic.js';

// The script's selectors first, then Auth0 Universal Login's stable attributes.
const FIELD_SEL = ['#username', 'input[name="username"]'];
const FORM_SEL = 'form._form-login-id';
const BUTTON_SEL = 'button._button-login-id';
const ERROR_SEL = [
  '[id^="error-element-"]', '.ulp-input-error-message', '.ulp-error-info', '#prompt-alert',
  '.ulp-alert', '[role="alert"]', '.alert-danger',
].join(',');

const REASON_TEXT = {
  error: 'the page shows an error',
  'user-value': 'the username field holds a different value',
  'not-username-step': 'this isn’t the username step',
  'no-field': 'the username field is gone',
  'no-button': 'no continue button was found',
  'password-step': 'this is the password step',
  'password-field': 'this form has a password field',
};

// Per page load (the module lives as long as the content script): a cancel or a submit is never
// undone by a remount (feature switched off and on, settings saved).
const pageLoad = { cancelled: false, submitted: false, noticed: false };

const EXTRA_CSS = `
.la{display:flex; align-items:center; gap:8px; font-size:13px}
.la .t{font-variant-numeric:tabular-nums}
.la.warn .t{color:var(--wb-warn)}
`;

function visible(el) {
  return !!el && !el.hidden && el.getClientRects().length > 0;
}

function findField() {
  for (const s of FIELD_SEL) {
    const el = document.querySelector(s);
    if (el instanceof HTMLInputElement) return el;
  }
  return null;
}

function findForm(field) {
  const known = document.querySelector(FORM_SEL);
  if (known && field && known.contains(field)) return known;
  return field?.closest('form') || null;
}

function isUsernameStep(form, field) {
  if (!form || !field || !form.contains(field)) return false;
  if (form.matches(FORM_SEL)) return true;
  // Fallback forms: Auth0's primary form, and no password input anywhere in it.
  return form.matches('form[data-form-primary]') && !form.querySelector('input[type="password"]');
}

/**
 * Any password input in the form (visible or not), or any other field that looks like one.
 * Without a form, the whole page is checked. The username field itself and hidden inputs
 * (Auth0's state) don't count.
 */
function hasPasswordField(form, field) {
  const scope = form || document;
  const els = [...scope.querySelectorAll('input, textarea, select'), ...formControls(form)];
  return anyPasswordField(els, field);
}

/** form.elements (includes controls outside the form linked by form="…"), unshadowable by a
 *  control named "elements". */
function formControls(form) {
  if (!form) return [];
  try { return [...Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form)]; } catch { return []; }
}

function findButton(form) {
  if (!form) return null;
  const b = form.querySelector(BUTTON_SEL)
    || form.querySelector('button[type="submit"][name="action"][value="default"]')
    || form.querySelector('button[type="submit"]');
  return b && !b.disabled ? b : null;
}

function hasError(field) {
  if (field?.getAttribute('aria-invalid') === 'true') return true;
  for (const el of document.querySelectorAll(ERROR_SEL)) {
    if (el.textContent.trim() && visible(el)) return true;
  }
  return false;
}

function snapshot() {
  const field = findField();
  const form = findForm(field);
  return {
    field, form, button: findButton(form),
    page: {
      inFrame: window.top !== window,
      path: location.pathname + location.search,
      hasField: !!field,
      fieldValue: field ? field.value : '',
      isUsernameStep: isUsernameStep(form, field),
      hasError: hasError(field),
      hasButton: !!findButton(form),
      hasPasswordField: hasPasswordField(form, field),
    },
  };
}

export function mount(ctx) {
  if (window.top !== window) return () => {}; // registered top-frame only; belt and braces
  const { h } = ctx.dom;
  let values = ctx.settings;
  let bar = null;        // floating bar (only while something shows)
  let countdown = null;  // { email, timer, left, ac }
  let started = false;   // acted (filled / counting) on this mount

  const showBar = (content, { tone } = {}) => {
    if (!bar) {
      bar = ctx.ui.floatingBar({ label: ctx.meta.name, signal: ctx.signal });
      bar.el.prepend(h('style', null, EXTRA_CSS));
    }
    for (const n of [...bar.el.childNodes]) if (n.nodeName !== 'STYLE') n.remove();
    bar.el.append(h('div', { class: ['la', tone] }, ctx.ui.mark(), content));
    bar.show(true);
  };
  const hideBar = (afterMs = 0) => {
    const b = bar;
    bar = null;
    if (!b) return;
    if (afterMs) setTimeout(() => b.destroy(), afterMs);
    else b.destroy();
  };
  const note = (text, { tone, ms = 3000, extra = null } = {}) => {
    showBar([h('span', { class: 't', role: 'status' }, text), extra], { tone });
    hideBar(ms);
  };

  function stopCountdown() {
    if (!countdown) return;
    clearInterval(countdown.timer);
    countdown.ac.abort();
    countdown = null;
  }

  function cancel(message = 'Auto-continue cancelled for this page.') {
    if (!countdown) return;
    stopCountdown();
    pageLoad.cancelled = true;
    note(message);
  }

  function go(email) {
    stopCountdown();
    const snap = snapshot();
    const why = submitBlocker(email, snap.page, pageLoad);
    if (why) {
      ctx.log.info(`not continuing: ${why}`);
      if (REASON_TEXT[why]) note(`Not continuing: ${REASON_TEXT[why]}.`, { tone: 'warn', ms: 5000 });
      else hideBar();
      return;
    }
    pageLoad.submitted = true;
    ctx.log.debug('continuing to the password step');
    snap.button.click();
    note('Continuing…', { ms: 2000 });
  }

  function startCountdown(email, seconds, field, button) {
    const ac = new AbortController();
    const signal = ctx.dom.linkSignal(ctx.signal, ac.signal);
    countdown = { email, left: seconds, ac, timer: 0 };
    const text = h('span', { class: 't', role: 'timer', 'aria-live': 'off' }, countdownText(seconds));
    showBar([text, ctx.ui.button('Cancel (Esc)', { size: 'sm', onClick: () => cancel() })]);

    // Esc anywhere cancels (even with focus in the username field).
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.repeat) cancel();
    }, { capture: true, signal });
    // The person taking over: typing in the field, or submitting themselves.
    field.addEventListener('input', (e) => {
      if (e.isTrusted) cancel('You edited the username, so Loophole won’t continue for you.');
    }, { signal });
    field.form?.addEventListener('submit', (e) => { if (e.isTrusted) { stopCountdown(); hideBar(); } }, { signal });
    button.addEventListener('click', (e) => { if (e.isTrusted) { stopCountdown(); hideBar(); } }, { signal });

    countdown.timer = setInterval(() => {
      if (!countdown) return;
      countdown.left -= 1;
      if (countdown.left <= 0) go(email);
      else text.textContent = countdownText(countdown.left);
    }, 1000);
  }

  function run() {
    if (ctx.signal.aborted || started || pageLoad.cancelled || pageLoad.submitted) return;
    const snap = snapshot();
    const plan = planAutofill(values, snap.page);
    if (plan.reason === 'invalid-email') {
      if (!pageLoad.noticed) {
        pageLoad.noticed = true;
        note('The saved username isn’t an email address, so nothing was filled.', {
          tone: 'warn', ms: 8000,
          extra: ctx.ui.button('Open settings', { size: 'sm', variant: 'ghost', onClick: () => ctx.openOptions() }),
        });
      }
      return;
    }
    if (!plan.fill && !plan.submit) {
      ctx.log.debug(`nothing to do: ${plan.reason}`);
      return;
    }
    started = true;
    const email = cleanEmail(values.email);
    if (plan.fill) ctx.dom.setNativeValue(snap.field, email);
    if (!plan.submit) {
      ctx.log.debug(`filled; not continuing: ${plan.reason}`);
      if (plan.reason === 'password-field') note(`Filled your username. Not continuing: ${REASON_TEXT['password-field']}.`, { ms: 5000 });
      return;
    }
    if (plan.delay === 0) go(email);
    else startCountdown(email, plan.delay, snap.field, snap.button);
  }

  // Auth0 renders the form server-side, but wait for it in case the page builds it late.
  // (Microtask: onElement's first scan runs before it returns stopWatch.)
  const stopWatch = ctx.dom.onElement(FIELD_SEL.join(','), () => queueMicrotask(() => { stopWatch(); run(); }), { signal: ctx.signal });

  ctx.onSettings((v) => {
    const prev = values;
    values = v;
    if (countdown && (v.autoContinue === false || cleanEmail(v.email) !== countdown.email)) {
      stopCountdown();
      hideBar();
      return;
    }
    if (!started && cleanEmail(v.email) !== cleanEmail(prev.email)) run();
  });

  return () => stopCountdown();
}
