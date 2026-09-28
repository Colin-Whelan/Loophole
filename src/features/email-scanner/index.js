// Email HTML check: scans the campaign's email HTML (the preview iframe's srcdoc) with the rules
// in rules.js and shows a collapsible banner before the Content step's Edit button.
// Port of "Iterable Email HTML Scanner" v2.0.0.
//
// Differences from the script:
// - The 1 s poll is replaced by a MutationObserver (iframe added/removed, srcdoc changes, the
//   banner's anchor re-rendered) plus ctx.onUrlChange, throttled to one scan per SCAN_DELAY.
// - Unchanged HTML is still skipped (the raw srcdoc is compared before decoding); a settings
//   change or the popup's "Rescan" action forces a rescan.
// - Settings are per-rule switches on the options page (grouped by category); the in-page gear
//   opens them. The expanded/collapsed state is remembered (ctx.state 'expanded').
// - The banner lists issues only (grouped by category, most severe first, capped per rule), with
//   "N of M rules passed · scanned Xs ago" in the header. The script's global CSS overrides for
//   Iterable's generated classes are gone: the banner is a shadow-root flex item.

import { h } from '../../core/dom.js';
import { scanHtml, summarize, groupIssues, severityChip, enabledKey, formatAgo } from './scan.js';

// Proven by the userscript.
export const SELECTORS = Object.freeze({
  iframe: '[data-test="secure-iframe-full-doc"]',
  content: '[data-test="complete-step-Content"]',
  editButton: '[data-test="content-edit-button-tooltip-test-id"]',
});

const SCAN_DELAY = 250;
const AGO_EVERY = 5000;
const MAX_PER_RULE = 20;

const EXTRA_CSS = `
.wb.es{flex:1 1 auto; min-width:0; align-self:flex-start; margin:0 12px 8px 0}
.es-top{display:flex; align-items:center; gap:2px; padding-right:6px; background:var(--wb-warn-soft)}
.es-top .scan-h{background:transparent; flex:1; min-width:0}
.scan[data-tone="ok"] .es-top{background:var(--wb-ok-soft)}
.scan[data-tone="bad"] .es-top{background:var(--wb-bad-soft)}
.scan[data-tone="off"] .es-top{background:var(--wb-sunken)}
.es-top .wb-help{margin:0}
.scan-list{max-height:420px; overflow:auto}
.scan-list li.es-cat{display:block; padding:6px 12px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--wb-muted); background:var(--wb-raised)}
.scan-list li.es-foot{display:block}
.scan-list li{grid-template-columns:auto minmax(0,1fr)}
.scan-list .es-msg{min-width:0; overflow-wrap:anywhere}
.scan-h .caret{display:grid; place-items:center}
.scan-h .caret svg{width:16px; height:16px}
.scan-list .es-note{margin:4px 0 0}
.scan-list .wb-chip{justify-self:start; align-self:start}
`;

const caret = () => h('svg', { viewBox: '0 0 24 24' }, h('path', {
  d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}));

/**
 * srcdoc text → HTML, as the script did (textarea decode: character references only), in an
 * inert DOMParser document instead of assigning innerHTML. The "\n" after <textarea> is the one
 * newline the parser drops there, so a leading newline in `raw` survives; "</textarea" in raw is
 * escaped so it stays text, exactly as the fragment parse of the script's innerHTML kept it.
 */
function decodeSrcdoc(raw) {
  const safe = String(raw).replace(/<\/(textarea)/gi, '&lt;/$1');
  const doc = new DOMParser().parseFromString('<!doctype html><body><textarea>\n' + safe, 'text/html');
  return doc.querySelector('textarea')?.value ?? '';
}

export function mount(ctx) {
  const { ui, signal, log } = ctx;

  let settings = ctx.settings;
  let lastRaw = null;
  let lastKey = null;
  let result = null;
  let scannedAt = 0;
  let open = false;
  let banner = null; // { mount, anchor, root, toggle, list, title, detail }

  ctx.state.get('expanded').then((v) => {
    if (typeof v === 'boolean' && !signal.aborted) { open = v; applyOpen(); }
  }).catch(() => {});

  // ── Banner ───────────────────────────────────────────────────────────────

  function removeBanner() {
    banner?.mount.destroy();
    banner = null;
  }

  function applyOpen() {
    if (!banner) return;
    banner.root.dataset.open = String(open);
    banner.toggle.setAttribute('aria-expanded', String(open));
    banner.list.hidden = !open;
  }

  function updateAgo() {
    if (!banner || !result) return;
    banner.detail.textContent = `${summarize(result).detail} · scanned ${formatAgo(Date.now() - scannedAt)}`;
  }

  function createBanner(anchor) {
    removeBanner();
    const m = ui.mountInline(anchor, 'before', { className: 'es' });
    m.root.prepend(h('style', null, EXTRA_CSS));
    const title = h('span', { class: 'n' });
    const detail = h('span', { class: 'wb-help' });
    const list = h('ul', { class: 'scan-list', id: 'es-list' });
    const toggle = h('button', {
      type: 'button', class: 'scan-h', 'aria-controls': 'es-list', 'aria-expanded': 'false',
      onClick: () => {
        open = !open;
        applyOpen();
        ctx.state.set('expanded', open).catch(() => {});
      },
    }, ui.mark(), h('span', null, title, h('br'), detail), h('span', { class: 'caret', 'aria-hidden': 'true' }, caret()));
    const gear = ui.iconButton('gear', { label: 'Email HTML check settings', onClick: () => ctx.openOptions() });
    const root = h('div', { class: 'scan', role: 'region', 'aria-label': 'Email HTML check' },
      h('div', { class: 'es-top' }, toggle, gear), list);
    m.el.append(root);
    banner = { mount: m, anchor, root, toggle, list, title, detail };
    render();
  }

  function render() {
    if (!banner || !result) return;
    const sum = summarize(result);
    banner.root.dataset.tone = sum.tone;
    banner.title.textContent = sum.title;
    updateAgo();

    const items = [];
    for (const group of groupIssues(result.issues)) {
      items.push(h('li', { class: 'es-cat' }, group.category));
      const shown = new Map();
      for (const issue of group.issues) {
        const n = (shown.get(issue.ruleId) || 0) + 1;
        shown.set(issue.ruleId, n);
        if (n > MAX_PER_RULE) continue;
        const chip = severityChip(issue.severity);
        items.push(h('li', null,
          ui.chip(chip.label, { tone: chip.tone }),
          h('div', { class: 'es-msg' },
            issue.message,
            issue.snippet && h('code', null, issue.snippet),
            issue.note && h('div', { class: 'wb-help es-note' }, issue.note))));
      }
      for (const [ruleId, n] of shown) {
        if (n > MAX_PER_RULE) {
          const label = result.results.find((r) => r.rule.id === ruleId)?.rule.label || ruleId;
          items.push(h('li', { class: 'es-foot' },
            h('span', { class: 'wb-help' }, `…and ${n - MAX_PER_RULE} more from "${label}".`)));
        }
      }
    }
    if (result.errors.length) {
      items.push(h('li', { class: 'es-foot' }, h('span', { class: 'wb-help' },
        `${result.errors.length} rule${result.errors.length === 1 ? '' : 's'} couldn't run on this HTML.`)));
    }
    if (!result.issues.length && result.total) {
      items.push(h('li', { class: 'es-foot' }, h('span', { class: 'wb-help' }, 'Every switched-on rule passed.')));
    }
    items.push(h('li', { class: 'es-foot' }, h('span', { class: 'wb-help' },
      'Rules can be switched on and off in Settings → Email HTML check.')));
    banner.list.replaceChildren(...items);
    applyOpen();
  }

  // ── Scan ─────────────────────────────────────────────────────────────────

  function clearAll() {
    lastRaw = null;
    lastKey = null;
    result = null;
    removeBanner();
  }

  function tick() {
    if (signal.aborted) return;
    const iframe = document.querySelector(SELECTORS.iframe);
    const raw = iframe?.getAttribute('srcdoc');
    if (!raw) {
      // No preview (the user is editing, or another step/page): drop stale results.
      if (result || banner) { clearAll(); log.debug('preview gone, cleared'); }
      return;
    }

    const key = enabledKey(settings);
    let changed = false;
    if (raw !== lastRaw || key !== lastKey) {
      lastRaw = raw;
      lastKey = key;
      result = scanHtml(decodeSrcdoc(raw), settings);
      scannedAt = Date.now();
      changed = true;
      log.debug('scanned', { chars: raw.length, rules: result.total, issues: result.issues.length, failedRules: result.errors });
    }

    const content = document.querySelector(SELECTORS.content);
    const anchor = content && (content.querySelector(SELECTORS.editButton) || document.querySelector(SELECTORS.editButton));
    if (!anchor) { removeBanner(); return; }
    const placed = banner && banner.anchor === anchor && banner.mount.host.isConnected
      && banner.mount.host.nextElementSibling === anchor;
    if (!placed) createBanner(anchor);
    else if (changed) render();
  }

  let pending = null;
  const schedule = () => {
    if (pending || signal.aborted) return;
    pending = setTimeout(() => { pending = null; tick(); }, SCAN_DELAY);
  };
  const rescan = () => { lastRaw = null; schedule(); };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['srcdoc'],
  });
  ctx.onUrlChange(schedule);
  const agoTimer = setInterval(updateAgo, AGO_EVERY);
  const offSettings = ctx.onSettings((v) => { settings = v; schedule(); });
  const offAction = ctx.onAction('rescan', () => rescan());
  tick();

  return () => {
    observer.disconnect();
    clearTimeout(pending);
    clearInterval(agoTimer);
    offSettings?.();
    offAction?.();
    removeBanner();
  };
}
