// Campaign approval view (the approved option C) and the approval card (option B) for Campaign
// checks: DOM reading, the sandboxed email preview, the card as DOM and as a PNG drawn on a
// canvas, clipboard helpers. Pure parts live in approval-logic.js.
//
// Nothing here restyles Iterable's page: the view is its own overlay (drawer layer, own closed
// shadow root) and only reads the page.
//
// Security (ARCHITECTURE §8.5, §9): every button acts only on trusted clicks; images (the card,
// screenshots) never enter the page's DOM: Copy writes the clipboard from content-script memory,
// Save hands the PNG to the extension's capture page. Captures run inside a capture guard
// (capture-guard.js) that refuses when something covers the view and discards the image when the
// page changed during the capture.

import { h, append } from '../../core/dom.js';
import { stableHash64 } from '../../core/hash.js';
import { deepActiveElement } from '../../core/own-roots.js';
import {
  normalizeDetails, cardRows, aggregateChecks, htmlCheck, summaryText, layoutCard, formatStamp,
  emailCsp, doctypeString, fromText, DASH, CARD_FONTS,
} from './approval-logic.js';
import { checkSeedLists, checkSubject, checkSuppression } from './logic.js';
import { scanHtml, enabledKey } from '../email-scanner/scan.js';
import { startCaptureGuard, COVERED_MESSAGE } from './capture-guard.js';
import { sanitizePreviewDocument } from '../../core/preview.js';

export const PAGE = Object.freeze({
  readonly: '[data-test^="form-readonly-field-"]',
  formField: '[data-test="form-field"]',
  pageHeader: '[data-input-type="pageHeader"]',
  iframe: '[data-test="secure-iframe-full-doc"]',
  content: '[data-test="complete-step-Content"]',
  headerActions: '[data-test="page-header-page-actions"]',
  sendingInfo: '[data-test="sending-information-section"]',
  optimize: '[data-test="optimize-section"]',
  lastSaved: '[data-test="last-saved-indicator"]',
  // Guesses for a status badge in the campaign header (live checklist); the schedule field's
  // "Not launched" is the fallback.
  status: ['[data-test="campaign-status"]', '[data-test="campaign-state"]', '[data-test="status-badge"]', '[data-test="page-header-status"]'],
});

export const DEVICE_WIDTHS = Object.freeze({ desktop: 600, mobile: 375 });

const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const linkNames = (el) => (el ? [...el.querySelectorAll('a')].map(textOf).filter(Boolean) : []);

// ── Reading the page ────────────────────────────────────────────────────────

/**
 * Where a "Not launched" schedule field may keep the planned time: title / aria-label /
 * <time datetime> on the field and inside it, and the text of each inner element. Deduplicated,
 * at most 20 strings of at most 200 characters.
 */
function fieldHints(el) {
  const out = new Set();
  const add = (v) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 200) out.add(t); };
  for (const n of [el, ...el.querySelectorAll('*')]) {
    if (out.size >= 20) break;
    add(n.getAttribute('title'));
    add(n.getAttribute('aria-label'));
    add(n.getAttribute('datetime'));
    if (n !== el) add(n.textContent);
  }
  return [...out].slice(0, 20);
}

function headerText(doc) {
  const el = doc.querySelector(PAGE.pageHeader);
  const v = el && ('value' in el && typeof el.value === 'string' ? el.value : el.textContent);
  const t = String(v || '').trim();
  return t || String(doc.title || '').replace(/\s*[|·-]\s*Iterable\s*$/i, '').trim();
}

/** Labelled rows: [{ label, text, links }] from Iterable's `[data-test="form-field"]` rows. */
function labeledRows(doc) {
  const out = [];
  for (const row of doc.querySelectorAll(PAGE.formField)) {
    const labelEl = row.querySelector('label') || row.firstElementChild;
    const label = textOf(labelEl);
    if (!label || label.length > 60) continue;
    const valueEl = row.querySelector(PAGE.readonly);
    let text;
    if (valueEl) text = textOf(valueEl);
    else {
      text = textOf(row);
      if (text.startsWith(label)) text = text.slice(label.length).trim();
    }
    out.push({ label, text, links: linkNames(valueEl || row).filter((l) => l !== label) });
  }
  return out;
}

/** The preview iframe's srcdoc (what Iterable renders), or null. */
export function emailSource(doc = document) {
  const raw = doc.querySelector(PAGE.iframe)?.getAttribute('srcdoc');
  return raw || null;
}

// The fingerprint is recomputed only when the srcdoc changes (readPage runs on every page tick).
let fpCache = { src: null, fp: null };

/** Everything approval-logic's normalizeDetails needs, read from the page. */
export function readPage(doc = document, loc = location) {
  const fields = {};
  for (const el of doc.querySelectorAll(PAGE.readonly)) {
    const name = el.getAttribute('data-test').slice('form-readonly-field-'.length);
    if (!name || fields[name]) continue;
    fields[name] = { text: textOf(el), rawText: el.textContent || '', links: linkNames(el) };
    if (name === 'scheduleStartTime') fields[name].hints = fieldHints(el);
  }
  const content = doc.querySelector(PAGE.content);
  const templateHrefs = content ? [...content.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) : [];
  const lastSaved = doc.querySelector(PAGE.lastSaved);
  const labeled = labeledRows(doc);
  if (lastSaved && textOf(lastSaved)) labeled.push({ label: 'Last edited', text: textOf(lastSaved), links: [] });
  let statusText = '';
  for (const sel of PAGE.status) { statusText = textOf(doc.querySelector(sel)); if (statusText) break; }
  const src = emailSource(doc);
  if (src && fpCache.src !== src) fpCache = { src, fp: stableHash64(src).slice(0, 8) };
  return {
    pathname: loc.pathname,
    header: headerText(doc),
    statusText,
    fields,
    labeled,
    templateHrefs,
    email: src ? { chars: src.length, fingerprint: fpCache.fp } : null,
  };
}

/**
 * srcdoc text → HTML for the HTML scan, exactly as Email HTML check decodes it (textarea decode in
 * an inert document), so both report the same issues.
 */
export function decodeForScan(raw) {
  const safe = String(raw).replace(/<\/(textarea)/gi, '&lt;/$1');
  const doc = new DOMParser().parseFromString('<!doctype html><body><textarea>\n' + safe, 'text/html');
  return doc.querySelector('textarea')?.value ?? '';
}

/**
 * The email as a standalone document for our sandboxed preview: parsed inertly (DOMParser runs
 * no scripts and loads nothing), then core/preview.js neutralises it: every <base>, <meta
 * http-equiv> and resource-hint <link> removed, navigation attributes (href, xlink:href, action,
 * formaction, ping, target) stripped from links / areas / forms / buttons / inputs, links made
 * inert with CSS; then our CSP meta goes first in <head> (so it covers everything after it) with
 * no-referrer. The iframe keeps sandbox="" (no scripts, no popups, no navigation of the top page).
 */
export function previewDocument(src, { remote = false } = {}) {
  const doc = new DOMParser().parseFromString(String(src ?? ''), 'text/html');
  sanitizePreviewDocument(doc, { csp: emailCsp({ remote }) });
  return doctypeString(doc.doctype) + doc.documentElement.outerHTML;
}

// ── Collecting details + checks ─────────────────────────────────────────────

let scanCache = { key: null, result: null };

/**
 * Read the page and run the checks. `emailScanner` = { enabled, values } of the Email HTML check
 * feature (its rule switches), or null to skip the HTML check.
 * → { details, results: { seed, suppression, subject }, checks, rows, checkedAt }
 */
export function collect(settings, emailScanner, { doc = document, now = new Date() } = {}) {
  const raw = readPage(doc);
  const d = normalizeDetails(raw);
  const seed = settings.seedListCheck && raw.fields.sendLists ? checkSeedLists(d.sendLists, settings.seedListKeyword) : null;
  const suppression = settings.suppressListCheck && raw.fields.suppressionLists
    ? checkSuppression({
      campaignName: d.campaignName, attached: d.suppressionLists, alwaysRequire: settings.alwaysRequireSuppression,
      rules: settings.campaignRules, warnNoSuppression: settings.warnNoSuppression,
    })
    : null;
  const subject = settings.subjectCheck && raw.fields.subject ? checkSubject(raw.fields.subject.rawText) : null;
  let html = null;
  const src = emailSource(doc);
  if (src && emailScanner?.enabled) {
    const key = `${enabledKey(emailScanner.values)}\u0000${src}`;
    if (scanCache.key !== key) scanCache = { key, result: scanHtml(decodeForScan(src), emailScanner.values) };
    html = htmlCheck(scanCache.result);
  }
  const checks = aggregateChecks({ seed, suppression, subject, html });
  const rows = cardRows(d, { seed, suppression, now });
  return { details: d, results: { seed, suppression, subject }, checks, rows, checkedAt: now };
}

export function textFor(model) {
  return summaryText(model.details, model.checks, { ...model.results, checkedAt: model.checkedAt });
}

// ── The card as DOM ─────────────────────────────────────────────────────────

export const CARD_CSS = `
.cc-card .ap-grid{display:grid; grid-template-columns:104px minmax(0,1fr); gap:7px 14px; padding:12px 14px; margin:0; font-size:13px}
.cc-card .ap-grid dt{color:var(--wb-muted); font-size:12px; padding-top:1px}
.cc-card .ap-grid dd{margin:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-width:0; overflow-wrap:anywhere; line-height:1.4}
.cc-card .ap-grid dd.strong{font-weight:600; font-size:14px}
.cc-card .ap-grid dd.none{color:var(--wb-faint)}
.cc-card .ap-time{font-weight:700}
.cc-card .ap-time.am{color:var(--wb-ok)}
.cc-card .ap-time.pm{color:var(--wb-bad)}
.cc-card .ap-list{font-size:12px; padding:1px 7px; border:1px solid var(--wb-line); border-radius:4px; background:var(--wb-raised)}
.cc-card .ap-checks{display:flex; flex-wrap:wrap; gap:6px; padding:9px 14px; border-top:1px solid var(--wb-line); background:var(--wb-raised); align-items:center}
.cc-card .ap-checks .sp{flex:1}
.cc-card .stamp{font:11px var(--wb-mono); color:var(--wb-faint)}
.cc-card .wb-chip{white-space:normal}
.cc-card .wb-ph .acts{display:flex; gap:6px; flex-wrap:wrap}
`;

/** The details card: dl rows + checks row. `header`: optional { title, brand, actions: [nodes] }. */
export function cardElement(ui, model, { header = null } = {}) {
  const grid = h('dl', { class: 'ap-grid' });
  for (const row of model.rows) {
    const dd = h('dd', { class: [row.strong && 'strong', !row.lists && row.value == null && 'none'], dataset: { key: row.key } });
    if (row.lists) {
      if (row.lists.length) append(dd, row.lists.map((s) => h('span', { class: 'ap-list' }, s)));
      else append(dd, h('span', { class: 'none', style: 'color:var(--wb-faint)' }, 'None'));
    } else if (row.time?.period && row.value?.includes(row.time.text)) {
      // The send time coloured: AM green, PM red (bold).
      const at = row.value.indexOf(row.time.text);
      append(dd, h('span', null, row.value.slice(0, at),
        h('span', { class: ['ap-time', row.time.period === 'AM' ? 'am' : 'pm'], title: row.time.period }, row.time.text),
        row.value.slice(at + row.time.text.length)));
    } else {
      dd.append(row.value ?? DASH);
    }
    if (row.chip) {
      const chip = ui.chip(row.chip.text, { tone: row.chip.tone, dot: row.key !== 'schedule' });
      if (row.chip.title) chip.title = row.chip.title;
      dd.append(chip);
    }
    grid.append(h('dt', null, row.label), dd);
  }
  const checks = h('div', { class: 'ap-checks' },
    model.checks.items.map((c) => { const el = ui.chip(c.label, { tone: c.tone, dot: true }); if (c.title) el.title = c.title; return el; }),
    h('span', { class: 'sp' }),
    h('span', { class: 'stamp' }, `checked ${formatStamp(model.checkedAt)}`));
  return h('div', { class: ['wb-panel', 'cc-card'] },
    header && h('div', { class: 'wb-ph' }, ui.mark(), h('span', { class: 't' }, header.title), header.brand && h('span', { class: 'brand' }, header.brand),
      header.actions && h('span', { class: 'acts' }, header.actions)),
    grid, checks);
}

// ── The card as a PNG ───────────────────────────────────────────────────────

function drawMark(g, x, y, size) {
  const s = size / 32;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = '#0d8a7e';
  g.beginPath();
  if (g.roundRect) g.roundRect(1, 1, 30, 30, 7); else g.rect(1, 1, 30, 30);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 2.4;
  g.lineJoin = 'round';
  g.beginPath(); g.moveTo(16, 6); g.lineTo(26, 16); g.lineTo(16, 26); g.lineTo(6, 16); g.closePath(); g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(16, 11.5); g.lineTo(20.5, 16); g.lineTo(16, 20.5); g.lineTo(11.5, 16); g.closePath(); g.fill();
  g.restore();
}

function roundRect(g, x, y, w, h2, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h2, r);
  else g.rect(x, y, w, h2);
}

/** Card model → canvas (2× device pixels by default). */
export function paintCard(model, { dpr = 2, doc = document } = {}) {
  const canvas = doc.createElement('canvas');
  const g = canvas.getContext('2d');
  const measure = (text, f) => { g.font = f; return g.measureText(text).width; };
  const layout = layoutCard({
    title: model.details.campaignName || 'Campaign',
    meta: [model.details.campaignId && `Campaign ${model.details.campaignId}`, model.details.status].filter(Boolean).join(' · '),
    rows: model.rows,
    checks: model.checks.items,
    stamp: `checked ${formatStamp(model.checkedAt)}`,
    footer: `Checked with Loophole for Iterable · ${formatStamp(model.checkedAt)}`,
  }, { measure });
  canvas.width = Math.ceil(layout.width * dpr);
  canvas.height = Math.ceil(layout.height * dpr);
  g.scale(dpr, dpr);
  g.textBaseline = 'top';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, layout.width, layout.height);
  for (const op of layout.ops) {
    if (op.t === 'rect') {
      roundRect(g, op.x, op.y, op.w, op.h, op.r);
      if (op.fill) { g.fillStyle = op.fill; g.fill(); }
      if (op.stroke) { g.strokeStyle = op.stroke; g.lineWidth = 1; roundRect(g, op.x + 0.5, op.y + 0.5, op.w - 1, op.h - 1, op.r); g.stroke(); }
    } else if (op.t === 'text') {
      g.font = op.font; g.fillStyle = op.color; g.fillText(op.text, op.x, op.y);
    } else if (op.t === 'dot') {
      g.beginPath(); g.arc(op.x, op.y, op.r, 0, Math.PI * 2); g.fillStyle = op.color; g.fill();
    } else if (op.t === 'line') {
      g.beginPath(); g.moveTo(op.x1, op.y1 + 0.5); g.lineTo(op.x2, op.y2 + 0.5); g.strokeStyle = op.color; g.lineWidth = 1; g.stroke();
    } else if (op.t === 'mark') {
      drawMark(g, op.x, op.y, op.size);
    }
  }
  canvas.dataset.cssWidth = String(layout.width);
  return canvas;
}

/** Ask the page's font set for the card fonts (they're injected by ui/fonts.js); no-op if blocked. */
export function preloadCardFonts(doc = document) {
  try {
    const fam = CARD_FONTS.sans;
    for (const f of [`400 13px ${fam}`, `500 11px ${fam}`, `600 14px ${fam}`, `700 15px ${fam}`, `400 11px ${CARD_FONTS.mono}`]) doc.fonts?.load(f).catch(() => {});
  } catch { /* no FontFaceSet */ }
}

/** data: URL → Blob, synchronously (so a clipboard write can start inside the click handler). */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl));
  if (!m) throw new TypeError('not a data URL');
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

/** Write a PNG blob to the clipboard → Promise<boolean>. */
export async function copyPng(blob) {
  try {
    if (typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fileStem(details) {
  return `approval-${details.campaignId || 'campaign'}`;
}

// ── The view ────────────────────────────────────────────────────────────────

const VIEW_CSS = `
.av{position:fixed; inset:0; display:flex; justify-content:center; background:var(--wb-raised); font-family:var(--wb-font); color:var(--wb-ink); font-size:13px}
.av-in{display:grid; width:100%; max-width:1400px; height:100%; grid-template-columns:minmax(360px,460px) minmax(0,780px); justify-content:center; grid-template-rows:auto auto minmax(0,1fr); min-height:0}
.av-top{grid-column:1/-1; grid-row:1; display:flex; align-items:center; gap:10px; padding:8px 14px; background:var(--wb-surface); border-bottom:1px solid var(--wb-line); min-width:0}
.av-top .ttl{min-width:0; flex:1}
.av-top h2{margin:0; font-size:16px; font-weight:700; line-height:1.25; overflow-wrap:anywhere}
.av-top .meta{color:var(--wb-muted); font:12px var(--wb-mono); margin-top:2px}
.av-acts{display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end}
.av-capnote{display:none; font:500 11px var(--wb-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--wb-accent-strong)}
.av[data-capturing] .av-acts{display:none}
.av[data-capturing] .av-capnote{display:block}
.av[data-capturing] .av-note{display:none}
.av-note{grid-column:1/-1; grid-row:2; margin:8px 14px 0; padding:6px 10px; border:1px solid var(--wb-line); border-left:3px solid var(--wb-accent); border-radius:6px; background:var(--wb-surface); display:flex; gap:10px; align-items:flex-start; line-height:1.5}
.av-note.bad{border-left-color:var(--wb-bad)}
.av-note .msg{flex:1}
.av-note .wb-keys{vertical-align:middle}
.av-left{grid-row:3; grid-column:1; padding:12px 14px; overflow:auto; display:flex; flex-direction:column; gap:8px; min-height:0}
.av-left .wb-panel{box-shadow:none}
.av-left .hint{margin:0; font-size:12px; color:var(--wb-muted); line-height:1.5}
.av-right{grid-row:3; grid-column:2; padding:12px 14px 12px 0; display:flex; flex-direction:column; gap:8px; min-width:0; min-height:0}
.av-prevhead{display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; font:500 11px var(--wb-mono); color:var(--wb-muted); letter-spacing:.04em; text-transform:uppercase}
.av-prevhead .ctl{display:flex; gap:10px; align-items:center; text-transform:none; letter-spacing:0; font-family:var(--wb-font); font-size:12px}
.av-prevhead label.rem{display:flex; gap:6px; align-items:center}
.inbox{background:var(--wb-surface); border:1px solid var(--wb-line); border-radius:8px; padding:9px 12px; font-size:12.5px; display:grid; gap:2px; min-width:0}
.inbox .from{font-weight:600}
.inbox .subj{font-weight:600}
.inbox .pre{color:var(--wb-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.inbox .none{color:var(--wb-faint)}
.stage{flex:1; min-height:0; background:var(--wb-sunken); border:1px solid var(--wb-line); border-radius:8px; overflow:hidden; position:relative}
.stage .fit{position:absolute; top:12px; left:50%; transform-origin:top left; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.12)}
.stage iframe{display:block; border:0; background:#fff}
.stage .empty{position:absolute; inset:0; display:grid; place-items:center; padding:24px; text-align:center; color:var(--wb-muted); line-height:1.5}
@media (max-width: 900px){
  .av{overflow:auto}
  .av-in{grid-template-columns:1fr; grid-template-rows:auto auto auto minmax(420px,1fr); height:auto; min-height:100%}
  .av-left{grid-row:3; grid-column:1; overflow:visible}
  .av-right{grid-row:4; grid-column:1; padding:0 14px 12px}
}
`;

/**
 * createApprovalView({ ui, ctx-ish deps }) → controller
 *   deps: { ui, log, getModel() → model, getEmail() → srcdoc | null, settings() → values,
 *           captureTab() → Promise<{ ok, dataUrl?, error? }>,
 *           openCapturePage({ dataUrl, name }) → Promise<{ ok, error? }>  (wb:capture:open),
 *           onClose? }
 * controller: { open(), close(), toggle(), isOpen(), refresh(),
 *               prepareCapture() → { ready, captureId?, reason? },
 *               finishCapture(captureId) → { intact, reason? }, endCapture(),
 *               showShot({ dataUrl?, error?, autoCopy?, captureId? }), copyCard(btn?), copyText(btn?),
 *               copyScreenshot(event), destroy() }
 * Privileged entry points taking an event (copyScreenshot) act only on a trusted one; the rest
 * are called from trusted clicks, the shortcut (trusted keydown) or extension messages.
 */
export function createApprovalView(deps) {
  const { ui, log } = deps;
  let mount = null;
  let els = null;
  let model = null;
  let sig = '';
  let device = 'desktop';
  let remote = false;
  let emailKey = null;
  let frameLoaded = Promise.resolve();
  let prevFocus = null;
  let ro = null;
  let capTimer = null;
  let shot = null;       // { dataUrl, name }: the last verified screenshot, content-script memory only
  let guard = null;      // capture guard session between prepareCapture and finishCapture
  let verifiedId = null; // captureId whose post-capture check passed (popup path: result comes later)

  const toast = (msg, tone) => ui.toast(msg, { tone, source: 'Campaign checks', timeoutMs: tone === 'ok' ? 5000 : 9000 });

  const deepActive = () => deepActiveElement(document);

  function fit() {
    if (!els) return;
    const { stage, fitBox, frame } = els;
    if (!frame) return;
    const w = DEVICE_WIDTHS[device];
    const avail = Math.max(120, stage.clientWidth - 24);
    const scale = Math.min(1, avail / w);
    const hh = Math.max(200, (stage.clientHeight - 12) / scale);
    frame.style.width = `${w}px`;
    frame.style.height = `${hh}px`;
    fitBox.style.transform = `translateX(-50%) scale(${scale})`;
    fitBox.style.transformOrigin = 'top center';
    fitBox.style.left = '50%';
  }

  function renderEmail(force = false) {
    if (!els) return;
    const src = deps.getEmail();
    const key = src ? `${remote ? 1 : 0}\u0000${src}` : null;
    if (!force && key === emailKey) return;
    emailKey = key;
    els.stage.replaceChildren();
    els.frame = null;
    if (!src) {
      els.stage.append(h('div', { class: 'empty' }, h('div', null,
        h('strong', null, 'The email preview isn’t on the page'), h('br'),
        'Open the campaign’s summary (Iterable shows the preview there). The view updates when it appears.')));
      frameLoaded = Promise.resolve();
      return;
    }
    const frame = document.createElement('iframe');
    // Order matters: the sandbox is in place before the srcdoc document is created. sandbox=""
    // (no allow-same-origin, no allow-scripts): the email runs no script, gets an opaque origin
    // (it can't reach Iterable's page or ours), can't submit forms, open popups or navigate the
    // top page. We never need its document, so nothing is relaxed.
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Email preview');
    frame.setAttribute('scrolling', 'yes');
    frameLoaded = new Promise((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, 2000);
    });
    frame.srcdoc = previewDocument(src, { remote });
    const fitBox = h('div', { class: 'fit' }, frame);
    els.stage.append(fitBox);
    els.frame = frame;
    els.fitBox = fitBox;
    fit();
  }

  function renderDetails(force = false) {
    if (!els) return;
    model = deps.getModel();
    const d = model.details;
    const nextSig = JSON.stringify([model.rows, model.checks.items, d.campaignName, d.status]);
    if (!force && nextSig === sig) return;
    sig = nextSig;
    els.title.textContent = d.campaignName || 'Campaign';
    els.meta.textContent = [d.campaignId && `Campaign ${d.campaignId}`, d.status, `checked ${formatStamp(model.checkedAt)}`].filter(Boolean).join(' · ');
    els.card.replaceChildren(cardElement(ui, model));
    const from = d.fromName || d.fromEmail;
    els.inbox.replaceChildren(
      h('span', { class: ['from', !from && 'none'] }, from || 'From: —'),
      h('span', { class: ['subj', !d.subject && 'none'] }, d.subject || 'Subject: —'),
      h('span', { class: ['pre', !d.preheader && 'none'] }, d.preheader || 'No preheader on the page'));
    els.inbox.title = [fromText(d), d.subject, d.preheader].filter(Boolean).join('\n');
    els.hint.textContent = d.email
      ? `The email on the right is this page’s current preview (HTML fingerprint ${d.email.fingerprint}, also on the copied card). Details are read from Iterable’s fields on this page.`
      : 'Details are read from Iterable’s fields on this page.';
  }

  function note(content, tone) {
    if (!els) return;
    if (!content) { els.note.hidden = true; els.note.replaceChildren(); return; }
    els.note.hidden = false;
    els.note.className = ['av-note', tone].filter(Boolean).join(' ');
    els.note.replaceChildren(h('div', { class: 'msg' }, content),
      ui.iconButton('close', { label: 'Dismiss', onClick: () => note(null) }));
  }

  function onKey(e) {
    if (!e.isTrusted || e.key !== 'Escape' || e.isComposing || !mount) return;
    e.stopPropagation();
    e.preventDefault();
    close();
  }

  function open() {
    if (mount) { renderDetails(); renderEmail(); return; }
    prevFocus = deepActive();
    remote = !!deps.settings().remoteImagesDefault;
    device = 'desktop';
    preloadCardFonts();
    mount = ui.mountOverlay('drawer');
    mount.root.prepend(h('style', null, CARD_CSS + VIEW_CSS));
    const title = h('h2');
    const meta = h('div', { class: 'meta' });
    const closeBtn = ui.button('Close (Esc)', { onClick: () => close() });
    // Copy / capture: trusted clicks only (a real click, or Enter / Space on the focused button).
    const btnCard = ui.button('Copy card', { title: 'Copy the details as an image (drawn by Loophole)', trusted: true, onClick: () => copyCard(btnCard) });
    const btnText = ui.button('Copy text', { title: 'Copy the details as plain text', trusted: true, onClick: () => copyTextNow(btnText) });
    const btnShot = ui.button('Copy screenshot', { variant: 'primary', title: 'Copy this whole view, email included', trusted: true, onClick: (e) => copyScreenshot(e) });
    const acts = h('div', { class: 'av-acts' }, btnCard, btnText, btnShot, closeBtn);
    const top = h('div', { class: 'av-top' }, ui.mark({ large: true }),
      h('div', { class: 'ttl' }, title, meta), acts, h('div', { class: 'av-capnote' }, 'Loophole · approval view'));
    const noteEl = h('div', { class: 'av-note', hidden: true, role: 'status' });
    const card = h('div');
    const hint = h('p', { class: 'hint' });
    const left = h('div', { class: 'av-left' }, card, hint);
    const seg = ui.segmented({
      ariaLabel: 'Email width', value: device,
      options: [{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' }],
      onChange: (v) => { device = v; fit(); },
    });
    const rem = ui.switchInput({ checked: remote, label: 'Load remote images', onChange: (on) => { remote = on; renderEmail(true); } });
    const inbox = h('div', { class: 'inbox' });
    const stage = h('div', { class: 'stage' });
    const right = h('div', { class: 'av-right' },
      h('div', { class: 'av-prevhead' }, h('span', null, 'Inbox + email'),
        h('span', { class: 'ctl' }, h('label', { class: 'rem', title: 'Off: nothing is fetched, so tracking pixels don’t fire. On: image hosts see the request. Scripts never run.' }, rem, 'Remote images'), seg)),
      inbox, stage);
    // .av covers the whole viewport (the capture guard needs our overlay on top everywhere);
    // .av-in is the centred, width-capped layout inside it.
    const root = h('div', { class: 'av', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Campaign approval view' },
      h('div', { class: 'av-in' }, top, noteEl, left, right));
    mount.el.append(root);
    els = { root, title, meta, acts, card, hint, inbox, stage, note: noteEl, frame: null, fitBox: null, btnShot, closeBtn };
    sig = '';
    emailKey = null;
    renderDetails(true);
    renderEmail(true);
    ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }

  function close() {
    if (!mount) return;
    document.removeEventListener('keydown', onKey, true);
    ro?.disconnect();
    ro = null;
    clearTimeout(capTimer);
    guard?.cancel();
    guard = null;
    verifiedId = null;
    mount.destroy();
    mount = null;
    els = null;
    shot = null;
    try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ }
    prevFocus = null;
    deps.onClose?.();
  }

  function refresh() {
    if (!mount) return;
    renderDetails();
    renderEmail();
  }

  // ── Copy actions ──────────────────────────────────────────────────────────

  function cardImage() {
    const m = mount ? model : deps.getModel();
    const dataUrl = paintCard(m).toDataURL('image/png');
    return { dataUrl, blob: dataUrlToBlob(dataUrl), model: m };
  }

  /**
   * The clipboard refused (or the person chose Save): hand the PNG to the extension's capture
   * page, where it can be saved or copied under the extension's origin. Never a page element.
   */
  async function toCapturePage(dataUrl, name, what) {
    let r;
    try { r = await deps.openCapturePage({ dataUrl, name }); } catch (e) { r = { ok: false, error: { message: e?.message } }; }
    if (r?.ok) toast(`Opened the ${what} in a Loophole tab: save or copy it there.`, 'ok');
    else toast(`Couldn’t open the ${what}: ${r?.error?.message || 'unknown error'}.`, 'bad');
    return !!r?.ok;
  }

  /** Copy card: draw it, write the PNG (made synchronously, inside the click). */
  async function copyCard(btn) {
    let made;
    try { made = cardImage(); } catch (e) { log.warn('card drawing failed', e?.message); toast('Couldn’t draw the card.', 'bad'); return false; }
    const ok = await copyPng(made.blob);
    if (ok) { if (btn) ui.flash(btn, { label: 'Card copied' }); toast('Approval card copied as an image.', 'ok'); return true; }
    await toCapturePage(made.dataUrl, `${fileStem(made.model.details)}-card.png`, 'card image');
    return false;
  }

  async function copyTextNow(btn) {
    const m = mount ? model : deps.getModel();
    const ok = await ui.copyText(textFor(m));
    if (btn) ui.flash(btn, ok ? { label: 'Copied' } : { label: 'Copy failed', tone: 'bad' });
    if (!ok) toast('Couldn’t copy the text.', 'bad');
    return ok;
  }

  function nextFrames() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
  }

  /**
   * Hide the view's own buttons (brief capturing state), wait for the email and a paint, then
   * start the capture guard: it refuses when anything covers the view (the view stays open and
   * says so). → { ready: true, captureId } | { ready: false, reason }
   */
  async function prepareCapture() {
    if (!mount) open();
    renderDetails();
    renderEmail();
    note(null);
    guard?.cancel();
    guard = null;
    verifiedId = null;
    els.root.setAttribute('data-capturing', '');
    clearTimeout(capTimer);
    // Never stay hidden (or keep a guard running) if the other side goes away.
    capTimer = setTimeout(() => { guard?.cancel(); guard = null; endCapture(); }, 8000);
    await frameLoaded;
    await nextFrames();
    // A random pause, so a page can't predict the exact moment of the capture from our click.
    await sleep(Math.floor(Math.random() * 150));
    if (!mount) return { ready: false, reason: 'The approval view was closed.' };
    const g = startCaptureGuard(mount.host);
    if (!g.ok) {
      log.warn('capture refused:', g.detail);
      endCapture();
      note(COVERED_MESSAGE, 'bad');
      toast(COVERED_MESSAGE, 'bad');
      return { ready: false, reason: COVERED_MESSAGE };
    }
    guard = g;
    return { ready: true, captureId: g.id };
  }

  /**
   * Right after the capture: re-check (nothing may have changed), then show the buttons again.
   * → { intact: true } | { intact: false, reason }. A failed check means: discard the image.
   */
  function finishCapture(captureId) {
    const g = guard;
    guard = null;
    let r;
    if (!g || typeof captureId !== 'string' || g.id !== captureId) {
      g?.cancel();
      r = { intact: false, reason: 'No screenshot was being taken here.' };
    } else {
      r = g.finish();
      if (r.intact) verifiedId = captureId;
      else log.warn('capture discarded:', r.detail);
    }
    endCapture();
    if (!r.intact && mount) { note(r.reason, 'bad'); toast(r.reason, 'bad'); }
    return r.intact ? { intact: true } : { intact: false, reason: r.reason };
  }

  function endCapture() {
    clearTimeout(capTimer);
    els?.root.removeAttribute('data-capturing');
  }

  function shortcutNote(error) {
    const sc = error?.shortcut;
    const how = sc
      ? ['press ', ui.kbd(sc), ' (Loophole’s “Copy approval screenshot” shortcut), or ']
      : ['set a key for Loophole’s “Copy approval screenshot” in your browser’s extension shortcuts page, or '];
    note(h('span', null,
      h('strong', null, 'Your browser needs one more click before Loophole may capture this tab. '),
      'To copy the screenshot, ', how, 'click the Loophole toolbar button and choose ',
      h('strong', null, 'Copy approval screenshot'),
      '. After that, this button works on this tab until you reload or leave it. ',
      'Copy card works any time (it draws the details itself).'));
  }

  /**
   * A screenshot came back (in-page button, command or popup fallback). It is used only if its
   * capture passed the guard: still running for `captureId` (checked now) or already verified.
   * Then: copy it if the browser lets us, else offer Copy (clipboard from this script's memory,
   * in the person's click) / Save (the extension's capture page). Nothing goes into the page.
   */
  async function showShot({ dataUrl = null, error = null, autoCopy = false, captureId = null } = {}) {
    if (!dataUrl) {
      if (guard && guard.id === captureId) { guard.cancel(); guard = null; }
      endCapture();
      if (!mount) return false;
      if (error?.code === 'NO_GRANT') shortcutNote(error);
      else note(`Couldn’t capture the tab: ${error?.message || 'unknown error'}.`, 'bad');
      return false;
    }
    let ok;
    if (guard && guard.id === captureId) ok = finishCapture(captureId).intact;
    else { ok = !!captureId && verifiedId === captureId; endCapture(); if (!ok && mount) note('That screenshot wasn’t checked, so it was discarded.', 'bad'); }
    verifiedId = null;
    if (!ok || !mount) return false;
    let blob;
    try { blob = dataUrlToBlob(dataUrl); } catch { note('The screenshot came back unreadable.', 'bad'); return false; }
    const name = `${fileStem(model?.details || {})}-view.png`;
    shot = { dataUrl, name, blob };
    const saveBtn = () => ui.button('Save…', {
      size: 'sm', trusted: true, title: 'Open the screenshot in a Loophole tab to save or copy it',
      onClick: () => { if (shot) toCapturePage(shot.dataUrl, shot.name, 'screenshot'); },
    });
    if (autoCopy && await copyPng(blob)) {
      if (!mount) return true;
      toast('Screenshot of the approval view copied.', 'ok');
      note(h('span', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' },
        h('strong', null, 'Screenshot copied'), '·', saveBtn()));
      return true;
    }
    if (!mount) return false;
    const copyBtn = ui.button('Copy', {
      variant: 'primary', size: 'sm', trusted: true,
      onClick: async () => {
        if (!shot) return;
        if (await copyPng(shot.blob)) { note(null); toast('Screenshot of the approval view copied.', 'ok'); }
        else await toCapturePage(shot.dataUrl, shot.name, 'screenshot');
      },
    });
    note(h('span', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' },
      h('strong', null, 'Screenshot ready'), '·', copyBtn, saveBtn()));
    copyBtn.focus();
    return true;
  }

  /**
   * The in-page button: capture through the background (works once the tab has activeTab).
   * Only for a trusted click that still carries the user activation.
   */
  async function copyScreenshot(e) {
    if (!e || e.isTrusted !== true) return false;
    if (globalThis.navigator?.userActivation && !navigator.userActivation.isActive) return false;
    const prep = await prepareCapture();
    if (!prep.ready) return false;
    let res;
    try { res = await deps.captureTab(); } catch (err) { res = { ok: false, error: { code: 'FAILED', message: err?.message } }; }
    if (!res?.ok) return showShot({ error: res?.error, captureId: prep.captureId });
    return showShot({ dataUrl: res.dataUrl, autoCopy: true, captureId: prep.captureId });
  }

  return {
    open,
    close,
    toggle: () => (mount ? close() : open()),
    isOpen: () => !!mount,
    refresh,
    prepareCapture,
    finishCapture,
    endCapture,
    showShot,
    copyCard,
    copyText: copyTextNow,
    copyScreenshot,
    destroy: close,
  };
}


