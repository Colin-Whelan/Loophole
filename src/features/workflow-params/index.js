// Workflow link parameters: on journey (workflow) Details panels and the template editor, fill
// the "Links" section (Google Analytics campaign + link parameter rows) from settings.
// A small Apply bar is mounted inline right after the "Links" header (so it never covers Iterable's
// own Save / Done buttons), only while that section is on screen; a keyboard shortcut and a popup
// action run the same thing. Settings live on the options page (gear button).

import { applyToLinks, findLinksSection, summarize } from './links.js';
import { normalizeLinkParams } from './config.js';

const SOURCE = 'Workflow link params';
const VISIBILITY_DEBOUNCE = 200;

// Compact, one row, left-aligned under the LINKS label; wraps rather than overflowing narrow panels.
const CSS = `
.wp-bar{display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-start; gap:4px; margin:6px 0 8px; font-family:var(--wb-font); color:var(--wb-ink)}
.wp-bar .mark{margin-right:2px}
`;

export function mount(ctx) {
  const { ui, dom, signal, log } = ctx;
  const h = dom.h;

  let settings = ctx.settings;
  let running = false;

  // ── Inline bar (a sibling right after the Links header) ─────────────────

  // Writes into Iterable's workflow form: the person's click / shortcut only (§7 trusted input).
  const applyBtn = ui.button('Apply link params', { variant: 'primary', size: 'sm', trusted: true, onClick: () => run() });
  const gear = ui.iconButton('gear', { label: 'Workflow link parameter settings', onClick: () => ctx.openOptions() });
  // Built once and moved between mounts, so a re-mount mid-run keeps the "Applying…" state.
  const bar = h('div', { class: 'wp-bar', role: 'toolbar', 'aria-label': 'Workflow link parameters' });
  bar.append(ui.mark(), applyBtn, gear);

  function updateButton() {
    applyBtn.disabled = running;
    applyBtn.textContent = running ? 'Applying…' : 'Apply link params';
    const keys = settings.shortcut ? dom.formatShortcut(settings.shortcut) : '';
    applyBtn.title = `Fill Google Analytics and link parameters${keys ? ` (${keys})` : ''}`;
  }
  updateButton();

  let placed = null; // { header, mount }

  function unplace() {
    placed?.mount.destroy();
    placed = null;
  }

  // Idempotent: returns early while our host still sits right after the same header, so our own
  // insertion (which the observer also sees) never causes another mount.
  function place() {
    const header = findLinksSection(document);
    if (!header) { unplace(); return; }
    const host = placed?.mount.host;
    if (placed?.header === header && host.isConnected && host.previousElementSibling === header) return;
    unplace();
    // A sibling, never inside the header: findLinksSection needs the header to stay a leaf. The
    // host has no light-DOM <label>, so findFieldByLabel's sibling walk passes straight over it.
    const mount = ui.mountInline(header, 'after', { display: 'block' });
    mount.root.prepend(h('style', null, CSS));
    mount.el.append(bar);
    placed = { header, mount };
  }

  let timer = null;
  const updateVisibility = () => {
    timer = null;
    if (!signal.aborted) place();
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
    unplace();
  };
}
