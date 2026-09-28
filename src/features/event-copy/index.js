// Copy event data: a small "Copy dataFields" button on custom-event rows in a user's Event History.
// The event JSON is rebuilt from Iterable's rendered tree (types preserved, see parse.js) and its
// dataFields are copied prettified. Port of "Iterable Event History - Copy dataFields" v1.0.0.

import { SELECTORS, dataFieldsForRow, isCustomEvent, isHistoryPath } from './parse.js';

const LABEL = 'Copy dataFields';
const FLASH_MS = 1500;
const DEBOUNCE_MS = 200;

const EXTRA_CSS = `
.wb.ec{display:inline-flex; margin-left:8px; vertical-align:middle}
.wb-btn.wb-inj.flash{background:var(--wb-ok-soft)}
.wb-btn.wb-inj.flash::before{background:var(--wb-ok)}
.wb-btn.wb-inj.flash-bad{background:var(--wb-bad-soft)}
.wb-btn.wb-inj.flash-bad::before{background:var(--wb-bad)}
`;

const FLASH_TEXT = { 'no-json': 'No JSON', 'no-datafields': 'No dataFields' };

export function mount(ctx) {
  const { h } = ctx.dom;
  let allEvents = ctx.settings.allEvents === true;
  const mounts = new Map(); // name cell → { mount }
  const ours = new WeakSet(); // our shadow hosts, so their insertion doesn't trigger a re-scan

  // Shared flash (ui/components.js): swaps the label, adds .flash / .flash-bad, restores itself.
  const flash = (btn, label, ok) => ctx.ui.flash(btn, { label, ms: FLASH_MS, tone: ok ? undefined : 'bad' });

  async function onCopy(cell, btn) {
    try {
      const result = dataFieldsForRow(cell);
      if (result.status !== 'ok') {
        ctx.log.warn(result.status === 'no-json' ? 'No JSON tree found for the row' : 'Event has no dataFields');
        flash(btn, FLASH_TEXT[result.status], false);
        return;
      }
      const ok = await ctx.ui.copyText(result.text);
      if (ctx.signal.aborted) return;
      if (!ok) {
        ctx.log.warn('Copy failed (clipboard refused)');
        flash(btn, 'Copy failed', false);
        return;
      }
      ctx.log.debug(`Copied dataFields (${result.text.length} chars)`);
      flash(btn, 'Copied ✓', true);
    } catch (e) {
      ctx.log.warn('Copy failed', e?.name || 'error');
      if (!ctx.signal.aborted) flash(btn, 'Error', false);
    }
  }

  function attach(cell) {
    const m = ctx.ui.mountInline(cell, 'append', { className: 'ec' });
    ours.add(m.host);
    m.root.prepend(h('style', null, EXTRA_CSS));
    const entry = { mount: m };
    const btn = ctx.ui.injectedButton(LABEL, {
      size: 'sm',
      title: 'Copy this event’s dataFields (prettified) to the clipboard',
      onClick: (e) => {
        // Keep the click from toggling the row in Iterable's table.
        e.stopPropagation();
        e.preventDefault();
        onCopy(cell, btn);
      },
    });
    m.el.append(btn);
    mounts.set(cell, entry);
  }

  function detach(cell, entry) {
    entry.mount.destroy();
    mounts.delete(cell);
  }

  function processRows() {
    // Drop buttons whose row went away or was re-rendered without them.
    for (const [cell, entry] of mounts) {
      if (!cell.isConnected || entry.mount.host.parentNode !== cell) detach(cell, entry);
    }
    if (!isHistoryPath(location.pathname)) return;
    let injected = 0;
    for (const cell of document.querySelectorAll(SELECTORS.nameCell)) {
      if (mounts.has(cell)) continue;
      if (!allEvents && !isCustomEvent(cell)) continue;
      attach(cell);
      injected++;
    }
    if (injected) ctx.log.debug(`Injected ${injected} button(s)`);
  }

  // SPA awareness: re-scan (debounced, as the userscript did) on any DOM change, which covers
  // client-side navigation into the Event History tab and rows rendered later (paging, filters).
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!ctx.signal.aborted) processRows(); }, DEBOUNCE_MS);
  };
  const obs = new MutationObserver((records) => {
    // Adding or removing our own hosts doesn't need a re-scan.
    if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => ours.has(n)))) return;
    schedule();
  });
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  processRows();

  const offSettings = ctx.onSettings((v) => {
    const next = v.allEvents === true;
    if (next === allEvents) return;
    allEvents = next;
    for (const [cell, entry] of mounts) detach(cell, entry);
    processRows();
  });

  return () => {
    obs.disconnect();
    clearTimeout(timer);
    offSettings?.();
    for (const [cell, entry] of mounts) detach(cell, entry);
  };
}
