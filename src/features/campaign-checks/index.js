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
import { projectSlot } from '../../core/state.js';
import { createApprovalView, collect, cardElement, CARD_CSS, PAGE, emailSource } from './approval.js';
import { compactCss, COMPACT_STYLE_ID, campaignIdFromPath, parseSchedule } from './approval-logic.js';
import {
  checkAudience, checkSeedLists, checkSuppression, checkSubject, toDatetimeLocal, parseDatetimeLocal,
  defaultSendAt, relativeTime, iterableScheduleStrings, parseMonthLabel,
  planCalendarNavigation, selectDayTile, exceedsScheduleLimit, SCHEDULE_MAX_DAYS_AHEAD,
  describeRate, toWholeNumber, scheduleFillDecision,
} from './logic.js';

// A planned time is remembered for at most this long (index.js persists it in ctx.state, keyed by
// campaign id + projectSlot — owner feedback #4): stale plans for a campaign nobody returned to
// shouldn't linger forever, or silently resurface in the approval view months later.
const PLANNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Proven by the userscript (data-test attributes and ids, not generated class names), plus the
// real Schedule modal / calendar DOM the owner pasted from a live campaign (2026-09-28).
export const SELECTORS = Object.freeze({
  recipients: '[data-test="form-readonly-field-recipients"]',
  sendLists: '[data-test="form-readonly-field-sendLists"]',
  suppressionLists: '[data-test="form-readonly-field-suppressionLists"]',
  subject: '[data-test="form-readonly-field-subject"]',
  scheduleStart: '[data-test="form-readonly-field-scheduleStartTime"]',
  formField: '[data-test="form-field"]',
  pageHeader: '[data-input-type="pageHeader"]',
  optimize: '[data-test="optimize-section"]',
  rateReadonly: '[data-test="form-readonly-field-sendRateLimit"]',
  // Schedule modal: <dialog data-test="modal-schedule-modal" id="schedule-modal">. The date field
  // is a *readonly* input behind a popover trigger — setting its value programmatically doesn't
  // touch react-calendar's own state (the reported bug), so it must be opened and clicked through.
  scheduleModal: '[data-test="modal-schedule-modal"]',
  scheduleDateTrigger: '[data-test="date-dropdown-trigger"]',
  scheduleDate: '#scheduleCampaignStartDateAndTime',
  scheduleTimeWrap: '[data-test="typeahead-time-picker"]',
  scheduleTime: '#typeahead-input',
  scheduleTimezone: '[data-test="radio-list-option-ProjectTimeZone"]',
  // The calendar renders in a portal outside the dialog.
  calendar: '[data-test="single-date-calendar"], .react-calendar',
  calendarMonthText: '.react-calendar__navigation__label__labelText',
  calendarYearText: '.react-calender_customYear', // sic: Iterable's own typo
  calendarLabel: '.react-calendar__navigation__label',
  calendarNext: '.react-calendar__navigation__next-button',
  calendarPrev: '.react-calendar__navigation__prev-button',
  calendarTile: '.react-calendar__tile',
  calendarTileNeighbor: 'react-calendar__month-view__days__day--neighboringMonth',
  // Never queried for clicking — see the "never click Launch/Schedule/confirm" rule below.
  scheduleConfirm: '[data-test="schedule-campaign-modal-button"]',
  // Opens the Schedule dialog (clicked by "Fill schedule" itself — see requestFill — never on its
  // own; this is not the "never click" list above, scheduleConfirm is).
  scheduleButton: '[data-test="schedule-button"]',
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
// How long "Fill schedule" waits for Iterable's Schedule dialog to appear after clicking its own
// schedule button, before giving up and telling the user to open it by hand (live checklist §24).
const SCHEDULE_MODAL_TIMEOUT = 5000;
const SCHEDULE_MODAL_POLL = 100;
const CANT_OPEN_SCHEDULE_MSG = 'Couldn’t open Iterable’s schedule dialog — open it and press Fill schedule again.';

/** Polls for Iterable's Schedule dialog inputs until they appear, the signal aborts, or timeout. */
async function waitForScheduleModal(signal, timeoutMs = SCHEDULE_MODAL_TIMEOUT, pollMs = SCHEDULE_MODAL_POLL) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inputs = findScheduleInputs();
    if (inputs) return inputs;
    if (signal.aborted || Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}
const isTextInput = (el) => el instanceof HTMLInputElement && !['hidden', 'radio', 'checkbox', 'button', 'submit'].includes(el.type);

function campaignName() {
  const el = document.querySelector(SELECTORS.pageHeader);
  const v = el && ('value' in el && typeof el.value === 'string' ? el.value : el.textContent);
  return String(v || '').trim() || document.title || '';
}

/**
 * Iterable's Schedule dialog inputs, or null while the dialog isn't open.
 * → { modal, trigger, date, time } — `date` is Iterable's own readonly text input (its value is
 * only ever set by clicking a calendar day, never programmatically — see fillDate); `trigger` is
 * the popover control that opens the calendar.
 */
export function findScheduleInputs(doc = document) {
  const modal = doc.querySelector(SELECTORS.scheduleModal);
  // Iterable renders this <dialog> without the `open` attribute (it's shown by styling), so judge
  // "open" by visibility, not dialog.open.
  if (!modal || modal.getAttribute('aria-hidden') === 'true' || !modal.getClientRects().length) return null;
  const trigger = modal.querySelector(SELECTORS.scheduleDateTrigger);
  let date = modal.querySelector(SELECTORS.scheduleDate);
  if (date && !isTextInput(date)) date = date.querySelector('input');
  if (!trigger || !isTextInput(date)) return null;
  // #typeahead-input is a generic id: prefer the one inside the schedule dialog.
  const timeScope = modal.querySelector(SELECTORS.scheduleTimeWrap) || modal;
  const time = timeScope.querySelector(SELECTORS.scheduleTime) || doc.querySelector(SELECTORS.scheduleTime);
  return isTextInput(time) ? { modal, trigger, date, time } : null;
}

/** The project timezone radio's own label, or '' when none is checked (nothing is ever changed). */
export function selectedTimezoneLabel(modal) {
  const opt = modal?.querySelector?.(`${SELECTORS.scheduleTimezone}[aria-checked="true"]`);
  return opt ? textOf(opt) : '';
}

export function findRateInput(doc = document) {
  for (const sel of RATE_INPUTS) {
    for (const el of doc.querySelectorAll(sel)) if (isTextInput(el)) return el;
  }
  return null;
}

/** The calendar's shown month/year, from its label (react-calendar's own text, or Iterable's split label + year span). */
function shownMonth(cal) {
  // Most reliable: a this-month day tile's <abbr aria-label="09/01/2026">.
  for (const tile of cal.querySelectorAll(SELECTORS.calendarTile)) {
    if (tile.classList.contains(SELECTORS.calendarTileNeighbor)) continue;
    const m = /^(\d{2})\/\d{2}\/(\d{4})$/.exec(tile.querySelector('abbr')?.getAttribute('aria-label') || '');
    if (m) return { year: Number(m[2]), month: Number(m[1]) - 1 };
  }
  // Iterable nests the year span *inside* the month label ("September<span>2026</span>"), so
  // take the label's text and split letters from digits.
  const label = textOf(cal.querySelector(SELECTORS.calendarLabel)).replace(/([A-Za-z])(\d)/, '$1 $2');
  const parsed = parseMonthLabel(label);
  if (parsed) return parsed;
  const d = new Date(`${label} 1`);
  return Number.isNaN(d.getTime()) ? null : { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * Open Iterable's calendar (a click on the popover trigger — the date input itself is readonly
 * and never written to directly, since that leaves react-calendar's own state behind, which is
 * the bug this replaces), navigate to the target month with real next/prev clicks (handles a
 * month or year turnover: `planCalendarNavigation`, unit-tested), then click the target day
 * (`selectDayTile`, unit-tested — matches the tile's exact date first, so an adjacent-month tile
 * showing the same day number is never picked; skips disabled tiles, which is how Iterable marks
 * past days and anything past its `SCHEDULE_MAX_DAYS_AHEAD`-day window).
 * → { ok, reason? } — `ok` also requires the date input's value to read back as the target date.
 */
async function fillDate(trigger, dateInput, target, signal, targetDateStr) {
  trigger.click();
  let cal = null;
  for (let i = 0; i < 15 && !cal && !signal.aborted; i++) {
    cal = document.querySelector(SELECTORS.calendar);
    if (!cal) await sleep(100);
  }
  if (signal.aborted) return { ok: false, reason: 'aborted' };
  if (!cal) return { ok: false, reason: 'The calendar didn’t open.' };
  for (let i = 0; i < 12 && !signal.aborted; i++) {
    const shown = shownMonth(cal);
    if (!shown) return { ok: false, reason: 'Couldn’t read the calendar’s month.' };
    const plan = planCalendarNavigation(shown, target);
    if (!plan.direction) break;
    if (!plan.complete) return { ok: false, reason: 'That date is too far away for the calendar to reach.' };
    const nav = cal.querySelector(plan.direction === 'next' ? SELECTORS.calendarNext : SELECTORS.calendarPrev);
    if (!nav || nav.disabled) return { ok: false, reason: 'That month isn’t reachable (Iterable only schedules a few weeks ahead).' };
    nav.click();
    await sleep(180);
  }
  if (signal.aborted) return { ok: false, reason: 'aborted' };
  const tiles = [...cal.querySelectorAll(SELECTORS.calendarTile)].map((el) => ({
    el,
    day: Number(textOf(el.querySelector('abbr') || el)),
    ariaLabel: (el.querySelector('abbr') || el).getAttribute?.('aria-label') || '',
    neighboring: el.classList.contains(SELECTORS.calendarTileNeighbor),
    disabled: el.disabled,
  }));
  const idx = selectDayTile(tiles, targetDateStr, target.getDate());
  if (idx < 0) return { ok: false, reason: 'Couldn’t find that day in the calendar (it may be disabled).' };
  pressLikeMouse(tiles[idx].el);
  // Iterable updates its (read-only) date box after the calendar popover closes: poll for it.
  for (let i = 0; i < 20 && !signal.aborted; i++) {
    if (dateInput.value === targetDateStr) return { ok: true, reason: null };
    await sleep(100);
  }
  return { ok: false, reason: `The date box shows ${dateInput.value || 'nothing'} after clicking ${targetDateStr}.` };
}

/** The pointer/mouse sequence a real click produces (some widgets listen for pointerdown/mouseup). */
function pressLikeMouse(el) {
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const P = window.PointerEvent || MouseEvent;
  el.dispatchEvent(new P('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new P('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

/**
 * Set Iterable's time typeahead the way the userscript did: write the value, then either click
 * the matching option from the listbox it opens or confirm with Enter, then blur and verify.
 */
async function fillTime(timeInput, timeStr, signal) {
  setNativeValue(timeInput, '');
  timeInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(30);
  if (signal.aborted) return false;
  setNativeValue(timeInput, timeStr);
  timeInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  if (signal.aborted) return false;
  const option = [...document.querySelectorAll('[role="option"], [role="listbox"] li')].find((o) => textOf(o) === timeStr);
  if (option) option.click();
  else {
    timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    timeInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  }
  timeInput.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  timeInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await sleep(150);
  return timeInput.value === timeStr;
}

export function mount(ctx) {
  const { ui, signal, log } = ctx;
  let settings = ctx.settings;

  const badges = new Map(); // key → { mount, target, sig }
  let results = { audience: null, seed: null, suppression: null, subject: null };

  // Schedule preview state (per page; reset when the campaign changes). Starts as `null` (not the
  // current pathname) so the first tick also loads any persisted planned time for this campaign.
  let campaignPath = null;
  let sendAt = defaultSendAt();
  let panelOpen = false;
  let edited = false; // the user picked a time (else the default is refreshed on open)
  let pendingFill = false;
  let filling = false;
  let openingDialog = false; // guards against re-clicking Iterable's schedule button mid-wait
  let prepare = null; // { mount, anchor }
  let panel = null; // { mount, anchor, input, rel, chips, status, fillBtn }
  let dialogBtn = null; // { mount, anchor }
  let rate = null; // { mount, anchor, sig }
  // The time planned with our own tool (ctx.state, keyed by campaign id + projectSlot), fed into
  // the approval view's schedule row when Iterable itself has nothing scheduled (owner feedback
  // #3/#4). null unless a still-fresh (< 7 days) plan was restored or the person just set one.
  let plannedTime = null;

  const toast = (msg, tone) => ui.toast(msg, { tone, source: SOURCE, timeoutMs: tone === 'ok' ? 6000 : 8000 });

  // ── Planned-time persistence (ctx.state) ────────────────────────────────

  function plannedStateKey(campaignId) {
    const slot = projectSlot(ctx.project?.current?.()?.key || '');
    return slot && campaignId ? `planned:${slot}:${campaignId}` : null;
  }

  async function loadPlanned(campaignId) {
    plannedTime = null;
    const key = plannedStateKey(campaignId);
    if (!key) return;
    let rec;
    try { rec = await ctx.state.get(key); } catch { return; }
    if (!rec || typeof rec !== 'object' || typeof rec.sendAt !== 'string' || typeof rec.savedAt !== 'string') return;
    const savedAt = Date.parse(rec.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > PLANNED_TTL_MS) {
      try { await ctx.state.remove(key); } catch { /* try again next time */ }
      return;
    }
    const d = new Date(rec.sendAt);
    if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) return;
    plannedTime = d;
    sendAt = d;
    edited = true;
    if (panel) { panel.input.value = toDatetimeLocal(sendAt); updateRel(); }
  }

  async function savePlanned(campaignId) {
    const key = plannedStateKey(campaignId);
    if (!key) return;
    if (edited && sendAt.getTime() > Date.now()) {
      plannedTime = sendAt;
      try { await ctx.state.set(key, { sendAt: sendAt.toISOString(), savedAt: new Date().toISOString() }); } catch { /* best effort */ }
    } else {
      plannedTime = null;
      try { await ctx.state.remove(key); } catch { /* best effort */ }
    }
    schedule();
  }

  async function clearPlanned(campaignId) {
    plannedTime = null;
    const key = plannedStateKey(campaignId);
    if (!key) return;
    try { await ctx.state.remove(key); } catch { /* best effort */ }
  }

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
    const recipEl = document.querySelector(SELECTORS.recipients);
    results = {
      audience: settings.audienceCheck && recipEl ? checkAudience(recipEl.textContent || '', settings.audienceMin) : null,
      seed: settings.seedListCheck && sendEl ? checkSeedLists(listNames(sendEl), settings.seedListKeyword) : null,
      suppression: settings.suppressListCheck && suppEl
        ? checkSuppression({
          campaignName: campaignName(), attached: listNames(suppEl), alwaysRequire: settings.alwaysRequireSuppression,
          rules: settings.campaignRules, warnNoSuppression: settings.warnNoSuppression,
        }) : null,
      subject: settings.subjectCheck && subjEl ? checkSubject(subjEl.textContent || '') : null,
    };
    placeBadge('audience', recipEl, results.audience);
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
    const list = [results.audience, results.seed, results.suppression, results.subject].filter(Boolean);
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
        if (d) {
          sendAt = d;
          edited = true;
          setStatus('');
          savePlanned(campaignIdFromPath(location.pathname)).catch(() => {});
        }
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
          clearPlanned(campaignIdFromPath(location.pathname)).catch(() => {});
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

  // "Fill schedule" itself opens Iterable's Schedule dialog (clicking its own schedule button)
  // rather than just waiting for the user to open it — but every safety rule stays: the 21-day /
  // past-time checks run before anything is clicked, a campaign that's already scheduled or
  // launched is never poked, and scheduleConfirm is never queried for a click. If the dialog is
  // already open, this fills it directly (no button click needed).
  async function requestFill() {
    if (sendAt.getTime() <= Date.now()) {
      setStatus('That time has already passed. Pick a later one.', 'bad');
      return;
    }
    if (exceedsScheduleLimit(sendAt)) {
      setStatus(`Iterable only schedules up to ${SCHEDULE_MAX_DAYS_AHEAD} days ahead. Pick a closer time.`, 'bad');
      return;
    }
    if (openingDialog || filling) return; // already trying — don't double-click Iterable's button

    // Re-check live: the panel only renders while the field reads "Not launched", but re-read it
    // here too in case the page moved on since (another tab, a race with Iterable's own refresh).
    const already = findScheduleInputs();
    const schedField = document.querySelector(SELECTORS.scheduleStart);
    const notLaunched = !schedField || /not launched/i.test(textOf(schedField));
    const scheduleButton = document.querySelector(SELECTORS.scheduleButton);
    const decision = scheduleFillDecision({ dialogOpen: !!already, notLaunched, scheduleButtonFound: !!scheduleButton });

    if (decision.action === 'fill') { fillInto(already); return; }
    if (decision.action === 'refuse') {
      if (decision.reason === 'already-scheduled') {
        setStatus('This campaign is already scheduled or launched — nothing to fill.', 'bad');
      } else {
        setStatus(CANT_OPEN_SCHEDULE_MSG, 'bad');
        toast(CANT_OPEN_SCHEDULE_MSG, 'warn');
      }
      return;
    }

    openingDialog = true;
    setStatus('Opening Iterable’s Schedule dialog…');
    try {
      scheduleButton.click();
      const inputs = await waitForScheduleModal(signal);
      if (signal.aborted) return;
      if (!inputs) {
        setStatus(CANT_OPEN_SCHEDULE_MSG, 'bad');
        toast(CANT_OPEN_SCHEDULE_MSG, 'warn');
        return;
      }
      await fillInto(inputs);
    } finally {
      openingDialog = false;
    }
  }

  // Fills Iterable's own Schedule dialog with the prepared time, using real UI interaction (a
  // click on the calendar's popover trigger, month navigation, a click on the target day, then
  // the time typeahead) rather than writing the readonly date input's value directly — that leaves
  // react-calendar's own state behind, which is why the date box used to visually fill without
  // Iterable actually picking it up. Never clicks Schedule / Launch / confirm (SELECTORS.scheduleConfirm
  // is declared but never queried for a click).
  async function fillInto({ modal, trigger, date, time }) {
    if (filling) return;
    filling = true;
    pendingFill = false;
    const target = new Date(sendAt.getTime());
    const s = iterableScheduleStrings(target);
    try {
      if (exceedsScheduleLimit(target)) {
        setStatus(`That time is more than ${SCHEDULE_MAX_DAYS_AHEAD} days away — Iterable’s dialog won’t accept it. Pick a closer time.`, 'bad');
        toast(`Iterable only schedules up to ${SCHEDULE_MAX_DAYS_AHEAD} days ahead. Pick a closer time, then fill again.`, 'warn');
        return;
      }
      const dateRes = await fillDate(trigger, date, target, signal, s.date);
      if (signal.aborted) return;
      const timeOk = await fillTime(time, s.time, signal);
      if (signal.aborted) return;
      const dateOk = dateRes.ok;
      log.debug('schedule filled', { dateOk, timeOk, dateReason: dateRes.reason });
      if (dateOk && timeOk) {
        setStatus(`Filled ${s.date} ${s.time}. Review it in Iterable’s dialog, then confirm there.`, 'ok');
        toast(`Filled ${s.date} ${s.time} into Iterable’s Schedule dialog. Nothing is scheduled until you confirm there.`, 'ok');
      } else {
        const miss = [!dateOk && `date (${s.date})`, !timeOk && `time (${s.time})`].filter(Boolean).join(' and ');
        const why = !dateOk && dateRes.reason ? ` ${dateRes.reason}` : '';
        setStatus(`Couldn’t set the ${miss}.${why} Enter it in Iterable’s dialog by hand.`, 'bad');
        toast(`Couldn’t set the ${miss} in Iterable’s Schedule dialog.${why} Enter it by hand.`, 'warn');
      }
    } finally {
      filling = false;
    }
  }

  function refreshDialogBtn() {
    const inputs = panelOpen ? findScheduleInputs() : null;
    if (!inputs) { destroyDialogBtn(); return; }
    if (pendingFill && !filling) fillInto(inputs);
    const anchor = inputs.trigger.closest(SELECTORS.formField) || inputs.trigger.parentElement;
    if (!anchor) { destroyDialogBtn(); return; }
    const s = iterableScheduleStrings(sendAt);
    const tz = selectedTimezoneLabel(inputs.modal);
    const label = `Fill prepared time (${s.date} ${s.time}${tz ? ` · ${tz}` : ''})`;
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
    const campaignId = campaignIdFromPath(location.pathname);
    if (location.pathname !== campaignPath) {
      campaignPath = location.pathname;
      sendAt = defaultSendAt();
      edited = false;
      pendingFill = false;
      panelOpen = false;
      destroyPanel();
      plannedTime = null;
      if (campaignId) loadPlanned(campaignId).catch(() => {});
    }
    // Once Iterable itself shows a schedule (or the campaign launched), our stand-in is stale —
    // read independently of the schedulePreview setting so it's cleared even while switched off.
    const schedField = document.querySelector(SELECTORS.scheduleStart);
    if (schedField && plannedTime && !/not launched/i.test(textOf(schedField))) {
      clearPlanned(campaignId).catch(() => {});
    }
    const field = settings.schedulePreview ? schedField : null;
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
    getModel: () => collect(settings, emailScanner, { ourPlanned: plannedTime }),
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
    const model = collect(settings, emailScanner, { ourPlanned: plannedTime });
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
