// Workflow link parameters: on journey (workflow) Details panels and the template editor, fill
// the "Links" section (Google Analytics campaign + link parameter rows) from settings.
// A floating Apply bar shows only while a Links section is on screen; a keyboard shortcut and a
// popup action run the same thing. Settings live on the options page (gear button).

import { applyToLinks, findLinksSection, summarize } from './links.js';
import { normalizeLinkParams } from './config.js';

const SOURCE = 'Workflow link params';
const VISIBILITY_DEBOUNCE = 200;

export function mount(ctx) {
  const { ui, dom, signal, log } = ctx;

  let settings = ctx.settings;
  let running = false;

  // ── Floating bar (shared bottom-right dock; toasts stack above it) ───────

  const bar = ui.floatingBar({ label: 'Workflow link parameters', signal });
  // Writes into Iterable's workflow form: the person's click / shortcut only (§7 trusted input).
  const applyBtn = ui.button('Apply link params', { variant: 'primary', size: 'sm', trusted: true, onClick: () => run() });
  const gear = ui.iconButton('gear', { label: 'Workflow link parameter settings', onClick: () => ctx.openOptions() });
  bar.el.append(ui.mark(), applyBtn, gear);

  function updateButton() {
    applyBtn.disabled = running;
    applyBtn.textContent = running ? 'Applying…' : 'Apply link params';
    const keys = settings.shortcut ? dom.formatShortcut(settings.shortcut) : '';
    applyBtn.title = `Fill Google Analytics and link parameters${keys ? ` (${keys})` : ''}`;
  }
  updateButton();

  let timer = null;
  const updateVisibility = () => {
    timer = null;
    if (!signal.aborted) bar.show(!!findLinksSection(document));
  };
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(updateVisibility, VISIBILITY_DEBOUNCE);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  updateVisibility();

  // ── Apply ────────────────────────────────────────────────────────────────

  async function run() {
    if (running) return;
    running = true;
    updateButton();
    const release = ctx.holdMount();
    try {
      const cfg = {
        enableGA: settings.enableGA,
        gaCampaign: settings.gaCampaign,
        enableLinkParams: settings.enableLinkParams,
        linkParams: normalizeLinkParams(settings.linkParams),
      };
      const report = await applyToLinks(document, cfg, { setValue: dom.setNativeValue, signal });
      log.debug('applied', {
        section: report.section, filled: report.filled.length, missing: report.missing, errors: report.errors.length,
      });
      const { tone, message } = summarize(report);
      ui.toast(message, { tone, source: SOURCE, timeoutMs: tone === 'ok' ? 4000 : 7000 });
    } catch (e) {
      if (e?.name !== 'AbortError') {
        log.warn('apply failed', e?.message);
        ui.toast(`Couldn't apply: ${e?.message || e}`, { tone: 'bad', source: SOURCE, timeoutMs: 7000 });
      }
    } finally {
      running = false;
      release();
      if (!signal.aborted) updateButton();
    }
  }

  // Works from inside the Links inputs too, as the userscript's did. Re-registered on change.
  let stopShortcut = () => {};
  function bindShortcut() {
    stopShortcut();
    stopShortcut = dom.onShortcut(settings.shortcut, () => { run(); }, { signal, allowInInputs: true });
  }
  bindShortcut();

  const offAction = ctx.onAction('apply', () => run());

  const offSettings = ctx.onSettings((values) => {
    const rebind = values.shortcut !== settings.shortcut;
    settings = values;
    if (rebind) bindShortcut();
    updateButton();
  });

  return () => {
    offSettings?.();
    offAction?.();
    observer.disconnect();
    if (timer) clearTimeout(timer);
    stopShortcut();
    bar.destroy();
  };
}
