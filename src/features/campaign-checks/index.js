// Campaign checks: pre-launch badges (seed list, required suppression lists, subject line), a
// schedule preview that fills Iterable's own Schedule dialog, and a send-rate helper.
// Port of "Campaign Preview Enhancements" v1.5.0.
//
// Differences from the script:
// - Badges are shadow-root chips (ok / warn / bad) placed after Iterable's read-only fields, kept
//   in place by one throttled MutationObserver instead of the script's timed retries.
// - Suppression rules are an objectList setting (comma-separated keywords / lists, "All
//   campaigns" instead of "Global"); matching is unchanged (case-insensitive substrings). The
//   campaign name comes from the page header, falling back to document.title as the script did.
// - The subject check reads the field's text rather than its innerHTML (markup can't trigger it).
// - Schedule preview: one datetime-local input (the mockup) instead of separate date/time inputs;
//   the "Not launched" text stays visible. "Fill schedule" never clicks Iterable's Schedule,
//   Launch or confirm buttons: it fills the dialog when it is open, or waits for the user to open
//   it and fills it then. Values are set with setNativeValue; only if the date doesn't stick does
//   it fall back to picking the day in the dialog's react-calendar (the script's approach).
// - Send rate: the script re-submitted the whole campaign to POST /campaigns/createSubmit with
//   hard-coded fields (labels, frequency cap, conversions, priority, type "Blast"), which could
//   silently wipe real settings. Here we only fill Iterable's own rate-limit input when it is on
//   the page ("Fill rate limit"; the user saves through Iterable), else show the value as
//   guidance. The hidden-iframe scrape of per-message-type rate limits is gone too.
// - Dropped: CSS "layout tightening" through obfuscated styled-component classes (the optional
//   compact page uses data-test hooks only), the section reorder by moving React-owned nodes
//   (CSS `order` instead), and the standalone HTML scan (Email HTML check does it; the approval
//   view shows its result).

import { h, setNativeValue, onShortcut } from '../../core/dom.js';
import { load as loadSettings, subscribe as subscribeSettings } from '../../core/settings.js';
import { captureVisibleTab, openCapturePage } from '../../core/api.js';
import { createApprovalView, collect, cardElement, CARD_CSS, PAGE, emailSource } from './approval.js';
import { compactCss, COMPACT_STYLE_ID, campaignIdFromPath, parseSchedule } from './approval-logic.js';
import {
  checkSeedLists, checkSuppression, checkSubject, toDatetimeLocal, parseDatetimeLocal,
  defaultSendAt, relativeTime, iterableScheduleStrings, parseMonthLabel, monthDelta, describeRate,
  toWholeNumber,
} from './logic.js';

// Proven by the userscript (data-test attributes and ids, not generated class names).
export const SELECTORS = Object.freeze({
  sendLists: '[data-test="form-readonly-field-sendLists"]',
  suppressionLists: '[data-test="form-readonly-field-suppressionLists"]',
  subject: '[data-test="form-readonly-field-subject"]',
  scheduleStart: '[data-test="form-readonly-field-scheduleStartTime"]',
  formField: '[data-test="form-field"]',
  pageHeader: '[data-input-type="pageHeader"]',
  optimize: '[data-test="optimize-section"]',
  rateReadonly: '[data-test="form-readonly-field-sendRateLimit"]',
  scheduleDate: '#scheduleCampaignStartDateAndTime',
  scheduleTime: '#typeahead-input',
  calendar: '.react-calendar',
});

// Iterable's rate-limit input. Only `rate-limit-input` is proven (the message-type settings
// modal); the rest are guesses for the campaign's Optimize section (live checklist).
export const RATE_INPUTS = Object.freeze([
  '[data-test="rate-limit-input"]',
  'input[name="sendRateLimit"]',
  'input[name="rateLimitPerMin"]',
  '[data-test="form-field-sendRateLimit"] input',
  '[data-test*="rate-limit" i] input',
  '[data-test*="rateLimit" i] input',
]);

const TICK_DELAY = 250;
const REL_EVERY = 30_000;
const SOURCE = 'Campaign checks';

const CSS = `
.wb.cc-badge{display:inline-flex; align-items:center; gap:6px; margin:4px 8px 0 0; max-width:100%; vertical-align:middle}
.cc-badge .wb-chip{white-space:normal; line-height:1.35; padding:3px 8px}
.cc-badge .mark{width:13px; height:13px}
.wb.cc-sched, .wb.cc-rate{display:block; max-width:400px; margin:10px 0 14px}
.cc-sched .wb-pb{display:flex; flex-direction:column; gap:10px}
.cc-rel{font-size:12px; font-weight:600; margin:0}
.cc-rel[data-tone="ok"]{color:var(--wb-ok)}
.cc-rel[data-tone="warn"]{color:var(--wb-warn)}
.cc-rel[data-tone="bad"]{color:var(--wb-bad)}
.cc-chips{display:flex; flex-wrap:wrap; gap:6px}
.cc-chips .wb-chip{white-space:normal}
.cc-status{margin:0}
.cc-status[data-tone="ok"]{color:var(--wb-ok)}
.cc-status[data-tone="bad"]{color:var(--wb-bad)}
.cc-actions{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.cc-rate .wb-pb{display:flex; flex-direction:column; gap:8px}
.cc-rate .cc-val{font-family:var(--wb-mono); font-size:12.5px}
.wb.cc-inj{display:block; margin:8px 0}
.wb.cc-hdr{display:inline-flex; align-items:flex-end; align-self:flex-end; margin:0 8px 0 0; vertical-align:bottom}
.wb.cc-oncard{display:block; margin:0 0 14px; order:-3}
.cc-oncard .wb-panel{box-shadow:none}
`;

function style() { return h('style', null, CSS); }

const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const linkNames = (el) => (el ? [...el.querySelectorAll('a')].map(textOf).filter(Boolean) : []);
/** List names in a readonly field: its links, else its text split on commas ("None" → []). */
const listNames = (el) => {
  const links = linkNames(el);
  if (links.length || !el) return links;
  const t = textOf(el);
  return !t || /^(none|—|-|n\/a)$/i.test(t) ? [] : t.split(',').map((x) => x.trim()).filter(Boolean);
};
const CAPTURE_URL_MAX = 64 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTextInput = (el) => el instanceof HTMLInputElement && !['hidden', 'radio', 'checkbox', 'button', 'submit'].includes(el.type);

function campaignName() {
  const el = document.querySelector(SELECTORS.pageHeader);
  const v = el && ('value' in el && typeof el.value === 'string' ? el.value : el.textContent);
  return String(v || '').trim() || document.title || '';
}

/** Iterable's Schedule dialog inputs, or null while the dialog isn't open. */
export function findScheduleInputs(doc = document) {
  let date = doc.querySelector(SELECTORS.scheduleDate);
  if (date && !isTextInput(date)) date = date.querySelector('input');
  if (!isTextInput(date)) return null;
  // #typeahead-input is a generic id: prefer the one inside the same dialog as the date input.
  const scope = date.closest('[role="dialog"], [aria-modal="true"]') || doc;
  const time = scope.querySelector(SELECTORS.scheduleTime) || doc.querySelector(SELECTORS.scheduleTime);
  return isTextInput(time) ? { date, time } : null;
}

export function findRateInput(doc = document) {
  for (const sel of RATE_INPUTS) {
    for (const el of doc.querySelectorAll(sel)) if (isTextInput(el)) return el;
  }
  return null;
}

/** Pick `target`'s day in the dialog's react-calendar (the script's fallback). → boolean */
async function pickFromCalendar(dateInput, target, signal) {
  dateInput.focus();
  dateInput.click();
  let cal = null;
  for (let i = 0; i < 15 && !cal && !signal.aborted; i++) {
    cal = document.querySelector(SELECTORS.calendar);
    if (!cal) await sleep(100);
  }
  if (!cal) return false;
  for (let i = 0; i < 24 && !signal.aborted; i++) {
    const label = textOf(cal.querySelector('.react-calendar__navigation__label__labelText, .react-calendar__navigation__label'));
    let shown = parseMonthLabel(label);
    if (!shown) {
      const d = new Date(`${label} 1`);
      if (Number.isNaN(d.getTime())) return false;
      shown = { year: d.getFullYear(), month: d.getMonth() };
    }
    const delta = monthDelta(shown, target);
    if (delta === 0) break;
    const nav = cal.querySelector(delta > 0 ? '.react-calendar__navigation__next-button' : '.react-calendar__navigation__prev-button');
    if (!nav || nav.disabled) return false;
    nav.click();
    await sleep(150);
  }
  const tile = [...cal.querySelectorAll('.react-calendar__tile')]
    .filter((t) => !t.classList.contains('react-calendar__month-view__days__day--neighboringMonth'))
    .find((t) => Number(textOf(t.querySelector('abbr') || t)) === target.getDate());
  if (!tile || tile.disabled) return false;
  tile.click();
  await sleep(200);
  return true;
}

export function mount(ctx) {
  const { ui, signal, log } = ctx;
  let settings = ctx.settings;

  const badges = new Map(); // key → { mount, target, sig }
  let results = { seed: null, suppression: null, subject: null };

  // Schedule preview state (per page; reset when the campaign changes).
  let campaignPath = location.pathname;
  let sendAt = defaultSendAt();
  let panelOpen = false;
  let edited = false; // the user picked a time (else the default is refreshed on open)
  let pendingFill = false;
  let filling = false;
  let prepare = null; // { mount, anchor }
  let panel = null; // { mount, anchor, input, rel, chips, status, fillBtn }
  let dialogBtn = null; // { mount, anchor }
  let rate = null; // { mount, anchor, sig }

  const toast = (msg, tone) => ui.toast(msg, { tone, source: SOURCE, timeoutMs: tone === 'ok' ? 6000 : 8000 });

  // ── Badges ───────────────────────────────────────────────────────────────

  function dropBadge(key) {
    badges.get(key)?.mount.destroy();
    badges.delete(key);
  }

  function placeBadge(key, target, result) {
    if (!target || !result) { dropBadge(key); return; }
    const sig = `${result.tone}\u0000${result.text}`;
    const cur = badges.get(key);
    const placed = cur && cur.target === target && cur.mount.host.isConnected
      && cur.mount.host.previousElementSibling === target;
    if (placed && cur.sig === sig) return;
    if (!placed) {
      dropBadge(key);
      const m = ui.mountInline(target, 'after', { className: 'cc-badge' });
      m.root.prepend(style());
      badges.set(key, { mount: m, target, sig: '' });
    }
    const b = badges.get(key);
    b.sig = sig;
    b.mount.el.title = result.title ? `${result.title}

Loophole · ${SOURCE}` : `Loophole · ${SOURCE}`;
    b.mount.el.replaceChildren(ui.mark(), ui.chip(result.text, { tone: result.tone, dot: true }));
  }

  function runChecks() {
    const sendEl = document.querySelector(SELECTORS.sendLists);
    const suppEl = document.querySelector(SELECTORS.suppressionLists);
    const subjEl = document.querySelector(SELECTORS.subject);
    results = {
      seed: settings.seedListCheck && sendEl ? checkSeedLists(listNames(sendEl), settings.seedListKeyword) : null,
      suppression: settings.suppressListCheck && suppEl
        ? checkSuppression({
          campaignName: campaignName(), attached: listNames(suppEl), alwaysRequire: settings.alwaysRequireSuppression,
          rules: settings.campaignRules, warnNoSuppression: settings.warnNoSuppression,
        }) : null,
      subject: settings.subjectCheck && subjEl ? checkSubject(subjEl.textContent || '') : null,
    };
    placeBadge('seed', sendEl, results.seed);
    placeBadge('suppression', suppEl, results.suppression);
    placeBadge('subject', subjEl, results.subject);
  }

  // ── Schedule preview ─────────────────────────────────────────────────────

  function destroyPrepare() { prepare?.mount.destroy(); prepare = null; }
  function destroyPanel() { panel?.mount.destroy(); panel = null; }
  function destroyDialogBtn() { dialogBtn?.mount.destroy(); dialogBtn = null; }

  function setStatus(text, tone) {
    if (!panel) return;
    panel.status.textContent = text || '';
    panel.status.hidden = !text;
    if (tone) panel.status.dataset.tone = tone; else delete panel.status.dataset.tone;
  }

  function updateRel() {
    if (!panel) return;
    const r = relativeTime(sendAt);
    panel.rel.textContent = r.text;
    panel.rel.dataset.tone = r.tone;
    panel.input.min = toDatetimeLocal(new Date());
  }

  function renderPanelChips() {
    if (!panel) return;
    const list = [results.seed, results.suppression, results.subject].filter(Boolean);
    panel.chips.replaceChildren(...list.map((r) => ui.chip(r.text, { tone: r.tone, dot: true })));
    panel.chips.hidden = !list.length;
  }

  function buildPanel(anchor) {
    destroyPanel();
    const m = ui.mountInline(anchor, 'after', { className: 'cc-sched' });
    m.root.prepend(style());
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
    const input = ui.input({
      type: 'datetime-local', value: toDatetimeLocal(sendAt), ariaLabel: 'Send at',
      onInput: (v) => {
        const d = parseDatetimeLocal(v);
        if (d) { sendAt = d; edited = true; setStatus(''); }
        updateRel();
        refreshDialogBtn();
      },
    });
    const rel = h('p', { class: 'cc-rel', 'aria-live': 'polite' });
    const chips = h('div', { class: 'cc-chips' });
    const status = h('p', { class: 'wb-help cc-status', hidden: true, 'aria-live': 'polite' });
    // Filling Iterable's dialogs / fields: trusted clicks only (ARCHITECTURE §7 trusted input).
    const fillBtn = ui.button('Fill schedule', { variant: 'primary', trusted: true, onClick: () => requestFill() });
    const body = [
      ui.field({ label: tz ? `Send at (${tz})` : 'Send at', control: input }),
      rel,
      chips,
      h('div', { class: 'cc-actions' }, fillBtn,
        ui.button('Reset', { variant: 'ghost', size: 'sm', onClick: () => {
          sendAt = defaultSendAt();
          edited = false;
          input.value = toDatetimeLocal(sendAt);
          pendingFill = false;
          setStatus('');
          updateRel();
          refreshDialogBtn();
        } })),
      status,
      h('p', { class: 'wb-help', style: 'margin:0' },
        'Fills the date and time into Iterable’s Schedule dialog. Nothing is scheduled until you confirm there.'),
    ];
    const p = ui.panel({ title: 'Schedule preview', brand: 'Campaign', body, onClose: () => togglePanel(false) });
    m.el.append(p);
    panel = { mount: m, anchor, input, rel, chips, status, fillBtn };
    updateRel();
    renderPanelChips();
    if (pendingFill) setStatus('Waiting for Iterable’s Schedule dialog: open it with Iterable’s Schedule button.');
  }

  function togglePanel(open) {
    panelOpen = open;
    if (open && !edited) sendAt = defaultSendAt();
    if (!open) { pendingFill = false; destroyPanel(); destroyDialogBtn(); }
    schedule();
  }

  function requestFill() {
    if (sendAt.getTime() <= Date.now()) {
      setStatus('That time has already passed. Pick a later one.', 'bad');
      return;
    }
    const inputs = findScheduleInputs();
    if (inputs) { fillInto(inputs); return; }
    pendingFill = true;
    setStatus('Waiting for Iterable’s Schedule dialog: open it with Iterable’s Schedule button and the time is filled in.');
  }

  async function fillInto({ date, time }) {
    if (filling) return;
    filling = true;
    pendingFill = false;
    const target = new Date(sendAt.getTime());
    const s = iterableScheduleStrings(target);
    try {
      setNativeValue(date, s.date);
      await sleep(150);
      if (signal.aborted) return;
      let dateOk = date.value === s.date;
      if (!dateOk) {
        log.debug('date value did not stick, trying the calendar');
        await pickFromCalendar(date, target, signal);
        if (signal.aborted) return;
        dateOk = date.value === s.date;
      }
      setNativeValue(time, s.time);
      time.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      time.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await sleep(150);
      if (signal.aborted) return;
      const timeOk = time.value === s.time;
      log.debug('schedule filled', { dateOk, timeOk });
      if (dateOk && timeOk) {
        setStatus(`Filled ${s.date} ${s.time}. Review it in Iterable’s dialog, then confirm there.`, 'ok');
        toast(`Filled ${s.date} ${s.time} into Iterable’s Schedule dialog. Nothing is scheduled until you confirm there.`, 'ok');
      } else {
        const miss = [!dateOk && `date (${s.date})`, !timeOk && `time (${s.time})`].filter(Boolean).join(' and ');
        setStatus(`Couldn’t set the ${miss}. Enter it in Iterable’s dialog by hand.`, 'bad');
        toast(`Couldn’t set the ${miss} in Iterable’s Schedule dialog. Enter it by hand.`, 'warn');
      }
    } finally {
      filling = false;
    }
  }

  function refreshDialogBtn() {
    const inputs = panelOpen ? findScheduleInputs() : null;
    if (!inputs) { destroyDialogBtn(); return; }
    if (pendingFill && !filling) fillInto(inputs);
    const anchor = inputs.date.closest(SELECTORS.formField) || inputs.date.parentElement;
    if (!anchor) { destroyDialogBtn(); return; }
    const s = iterableScheduleStrings(sendAt);
    const label = `Fill prepared time (${s.date} ${s.time})`;
    const placed = dialogBtn && dialogBtn.anchor === anchor && dialogBtn.mount.host.isConnected
      && dialogBtn.mount.host.previousElementSibling === anchor;
    if (!placed) {
      destroyDialogBtn();
      const m = ui.mountInline(anchor, 'after', { className: 'cc-inj' });
      m.root.prepend(style());
      dialogBtn = { mount: m, anchor, label: '' };
    }
    if (dialogBtn.label !== label) {
      dialogBtn.label = label;
      dialogBtn.mount.el.replaceChildren(ui.injectedButton(label, {
        size: 'sm', trusted: true,
        onClick: () => { const now = findScheduleInputs(); if (now) fillInto(now); },
      }));
    }
  }

  function runSchedule() {
    if (location.pathname !== campaignPath) {
      campaignPath = location.pathname;
      sendAt = defaultSendAt();
      edited = false;
      pendingFill = false;
      panelOpen = false;
      destroyPanel();
    }
    const field = settings.schedulePreview ? document.querySelector(SELECTORS.scheduleStart) : null;
    const notLaunched = field && /not launched/i.test(textOf(field));
    if (!notLaunched) {
      destroyPrepare(); destroyPanel(); destroyDialogBtn();
      return;
    }
    // Toggle button right after the "Not launched" field.
    if (!(prepare && prepare.anchor === field && prepare.mount.host.isConnected
      && prepare.mount.host.previousElementSibling === field)) {
      destroyPrepare();
      const m = ui.mountInline(field, 'after', { className: 'cc-badge' });
      m.root.prepend(style());
      const btn = ui.injectedButton('Prepare send time', { size: 'sm', onClick: () => togglePanel(!panelOpen) });
      m.el.append(btn);
      prepare = { mount: m, anchor: field, btn };
    }
    prepare.btn.textContent = panelOpen ? 'Hide schedule preview' : 'Prepare send time';
    prepare.btn.setAttribute('aria-expanded', String(panelOpen));

    if (panelOpen) {
      const anchor = field.closest(SELECTORS.formField) || field;
      if (!(panel && panel.anchor === anchor && panel.mount.host.isConnected
        && panel.mount.host.previousElementSibling === anchor)) buildPanel(anchor);
      else renderPanelChips();
    } else {
      destroyPanel();
    }
    refreshDialogBtn();
  }

  // ── Send rate ────────────────────────────────────────────────────────────

  function destroyRate() { rate?.mount.destroy(); rate = null; }

  function runRate() {
    if (!settings.rateHelper) { destroyRate(); return; }
    const input = findRateInput();
    const optimize = document.querySelector(SELECTORS.optimize);
    const readonly = document.querySelector(SELECTORS.rateReadonly);
    let anchor = null;
    let where = 'append';
    if (optimize) anchor = optimize;
    else if (input) { anchor = input.closest(SELECTORS.formField) || input.parentElement; where = 'after'; }
    else if (readonly) { anchor = readonly.closest(SELECTORS.formField) || readonly; where = 'after'; }
    if (!anchor) { destroyRate(); return; }

    const n = settings.customRateLimit;
    const current = input ? toWholeNumber(input.value) : null;
    const state = !input ? 'none' : input.disabled || input.readOnly ? 'locked' : current === n ? 'same' : 'fill';
    const sig = `${n}\u0000${state}`;
    const placed = rate && rate.anchor === anchor && rate.mount.host.isConnected
      && (where === 'append' ? rate.mount.host.parentElement === anchor : rate.mount.host.previousElementSibling === anchor);
    if (placed && rate.sig === sig) return;
    if (!placed) {
      destroyRate();
      const m = ui.mountInline(anchor, where, { className: 'cc-rate' });
      m.root.prepend(style());
      rate = { mount: m, anchor, sig: '' };
    }
    rate.sig = sig;
    const r = describeRate(n);
    const body = [h('div', { class: 'cc-val' }, `Your usual rate: ${r.text}`)];
    if (state === 'fill') {
      body.push(h('div', { class: 'cc-actions' }, ui.button('Fill rate limit', {
        variant: 'primary', size: 'sm', trusted: true,
        onClick: () => {
          const el = findRateInput();
          if (!el || el.disabled || el.readOnly) { toast('Iterable’s rate-limit field isn’t available right now.', 'warn'); schedule(); return; }
          setNativeValue(el, String(n));
          if (toWholeNumber(el.value) === n) toast(`Filled ${r.perMinute.toLocaleString('en-US')}/min. Save the campaign in Iterable to keep it.`, 'ok');
          else toast('Iterable didn’t take the value. Enter it by hand.', 'warn');
          schedule();
        },
      })));
    } else if (state === 'same') {
      body.push(ui.chip('Iterable’s rate-limit field has this value', { tone: 'ok', dot: true }));
    } else if (state === 'locked') {
      body.push(h('p', { class: 'wb-help', style: 'margin:0' }, 'Switch Iterable’s rate limit to a custom value first, then fill it.'));
    } else {
      body.push(h('p', { class: 'wb-help', style: 'margin:0' },
        'To use it, edit the campaign and set a custom send rate limit in Iterable’s Optimize settings.'));
    }
    rate.mount.el.replaceChildren(ui.panel({
      title: 'Send rate', brand: 'Loophole', body: [
        ...body,
        h('div', { class: 'cc-actions' }, ui.button('Change in settings', { variant: 'ghost', size: 'sm', onClick: () => ctx.openOptions() })),
      ],
    }));
  }

  // ── Approval ─────────────────────────────────────────────────────────────

  // Email HTML check's switches, so the view's HTML chip matches its banner (null until read).
  let emailScanner = null;
  const setScanner = (resolved) => { emailScanner = resolved?.features?.['email-scanner'] || null; };
  loadSettings().then((r) => { if (!signal.aborted) { setScanner(r); schedule(); } }).catch(() => {});
  const offScanner = subscribeSettings((r) => { setScanner(r); schedule(); });

  const onCampaign = () => campaignIdFromPath(location.pathname) != null;
  let hdr = null; // { mount, anchor, where }
  let onCard = null; // { mount, anchor, sig }
  let autoOpenedFor = null;

  const view = createApprovalView({
    ui, log,
    getModel: () => collect(settings, emailScanner),
    getEmail: () => emailSource(),
    settings: () => settings,
    captureTab: captureVisibleTab,
    openCapturePage,
  });

  function openView() {
    if (!onCampaign()) { toast('Open a campaign’s page first: the approval view reads its details.', 'warn'); return false; }
    view.open();
    return true;
  }

  function placedAt(rec, anchor, where) {
    if (!rec || rec.anchor !== anchor || !rec.mount.host.isConnected) return false;
    return where === 'prepend' ? rec.mount.host.parentElement === anchor : rec.mount.host.previousElementSibling === anchor;
  }

  function destroyHdr() { hdr?.mount.destroy(); hdr = null; }
  function runHeaderButton() {
    if (!settings.approvalView || !onCampaign()) { destroyHdr(); return; }
    let anchor = document.querySelector(PAGE.headerActions);
    let where = 'prepend';
    if (!anchor) { anchor = document.querySelector(SELECTORS.pageHeader); where = 'after'; }
    if (!anchor) { destroyHdr(); return; }
    if (placedAt(hdr, anchor, where)) return;
    destroyHdr();
    const m = ui.mountInline(anchor, where, { className: 'cc-hdr' });
    m.root.prepend(style());
    m.el.append(ui.injectedButton('Approval view', { title: 'Details, checks and the email on one screen (Loophole)', trusted: true, onClick: () => openView() }));
    hdr = { mount: m, anchor, where };
  }

  function destroyCard() { onCard?.mount.destroy(); onCard = null; }
  function runCard() {
    if (!settings.showCardOnPage || !onCampaign()) { destroyCard(); return; }
    const first = document.querySelector(PAGE.optimize) || document.querySelector(PAGE.sendingInfo);
    const container = first?.parentElement;
    if (!container) { destroyCard(); return; }
    if (!placedAt(onCard, container, 'prepend')) {
      destroyCard();
      const m = ui.mountInline(container, 'prepend', { className: 'cc-oncard' });
      m.root.prepend(style(), h('style', null, CARD_CSS));
      onCard = { mount: m, anchor: container, sig: '' };
    }
    const model = collect(settings, emailScanner);
    const sig = JSON.stringify([model.rows, model.checks.items]);
    if (sig === onCard.sig) return;
    onCard.sig = sig;
    const bCard = ui.button('Copy card', { size: 'sm', title: 'Copy the details as an image', trusted: true, onClick: () => view.copyCard(bCard) });
    const bText = ui.button('Copy text', { size: 'sm', title: 'Copy the details as plain text', trusted: true, onClick: () => view.copyText(bText) });
    const bView = ui.injectedButton('Approval view', { size: 'sm', trusted: true, onClick: () => openView() });
    onCard.mount.el.replaceChildren(cardElement(ui, model, {
      header: { title: 'Approval summary', brand: 'Campaign checks', actions: [bCard, bText, bView] },
    }));
  }

  function runCompact() {
    const el = document.getElementById(COMPACT_STYLE_ID);
    if (!settings.compactLayout) { el?.remove(); return; }
    if (el) return;
    const st = document.createElement('style');
    st.id = COMPACT_STYLE_ID;
    st.textContent = compactCss();
    (document.head || document.documentElement).append(st);
  }

  function runAutoOpen() {
    const id = campaignIdFromPath(location.pathname);
    if (!id) { autoOpenedFor = null; return; }
    if (autoOpenedFor === id || !settings.openApprovalAutomatically || !settings.approvalView) return;
    const field = document.querySelector(SELECTORS.scheduleStart);
    if (!field) return; // wait until the summary has rendered
    autoOpenedFor = id;
    const sch = parseSchedule(textOf(field));
    const launched = !sch.notLaunched && !(sch.date && sch.date.getTime() > Date.now());
    if (!launched && !view.isOpen()) view.open();
  }

  function runApproval() {
    runCompact();
    runHeaderButton();
    runCard();
    runAutoOpen();
    if (view.isOpen()) { if (onCampaign()) view.refresh(); else view.close(); }
  }

  let stopShortcut = () => {};
  function bindShortcut() {
    stopShortcut();
    stopShortcut = settings.approvalShortcut
      ? onShortcut(settings.approvalShortcut, () => {
        if (!onCampaign()) return false;
        view.toggle();
        return true;
      }, { signal })
      : () => {};
  }
  bindShortcut();

  // Popup / background requests (content/app.js → router.requestAction; runtime messages only,
  // page script can't send them). Payloads are checked here.
  // Capture protocol: capture-prepare → { ready, captureId } (the capture guard is running) →
  // the caller captures → capture-done { captureId } → { intact } (popup) or capture-result
  // { captureId, dataUrl | error } (command). An image is used only if its guard passed.
  const captureIdOf = (p) => (p && typeof p.captureId === 'string' && /^[0-9a-f-]{36}$/.test(p.captureId) ? p.captureId : null);
  ctx.onAction('approval', () => openView());
  ctx.onAction('capture-prepare', async () => {
    if (!onCampaign()) return { ready: false, reason: 'Open a campaign’s page first.' };
    return view.prepareCapture();
  });
  ctx.onAction('capture-done', (p) => view.finishCapture(captureIdOf(p)));
  ctx.onAction('capture-result', (p) => {
    if (!p || typeof p !== 'object') return false;
    const dataUrl = typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/png;base64,') && p.dataUrl.length <= CAPTURE_URL_MAX ? p.dataUrl : null;
    const e = p.error && typeof p.error === 'object' ? p.error : null;
    const error = e ? {
      code: String(e.code || 'FAILED').slice(0, 40),
      message: String(e.message || '').slice(0, 300),
      shortcut: typeof e.shortcut === 'string' ? e.shortcut.slice(0, 40) : '',
    } : null;
    if (!view.isOpen()) return false; // the capture was of the open view; closed since → drop it
    return view.showShot({
      dataUrl, error: dataUrl ? null : error || { code: 'FAILED', message: 'No screenshot came back.' },
      autoCopy: p.autoCopy === true, captureId: captureIdOf(p),
    });
  });

  // ── Loop ─────────────────────────────────────────────────────────────────

  function tick() {
    if (signal.aborted) return;
    try { runChecks(); } catch (e) { log.warn('checks failed', e?.message); }
    try { runSchedule(); } catch (e) { log.warn('schedule preview failed', e?.message); }
    try { runRate(); } catch (e) { log.warn('rate helper failed', e?.message); }
    try { runApproval(); } catch (e) { log.warn('approval view failed', e?.message); }
  }

  let pending = null;
  function schedule() {
    if (pending || signal.aborted) return;
    pending = setTimeout(() => { pending = null; tick(); }, TICK_DELAY);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value', 'disabled'],
  });
  ctx.onUrlChange(schedule);
  const offSettings = ctx.onSettings((v) => {
    const shortcutChanged = v.approvalShortcut !== settings.approvalShortcut;
    settings = v;
    if (shortcutChanged) bindShortcut();
    schedule();
  });
  const relTimer = setInterval(() => { if (panel) updateRel(); }, REL_EVERY);
  // Typing in Iterable's rate field doesn't mutate the DOM; listen for it (capture, page-wide).
  const onPageInput = (e) => { if (settings.rateHelper && e.target instanceof HTMLInputElement) schedule(); };
  document.addEventListener('input', onPageInput, { capture: true, signal });
  tick();

  return () => {
    observer.disconnect();
    clearTimeout(pending);
    clearInterval(relTimer);
    offSettings?.();
    for (const key of [...badges.keys()]) dropBadge(key);
    destroyPrepare();
    destroyPanel();
    destroyDialogBtn();
    destroyRate();
    offScanner?.();
    stopShortcut();
    view.close();
    destroyHdr();
    destroyCard();
    document.getElementById(COMPACT_STYLE_ID)?.remove();
  };
}
