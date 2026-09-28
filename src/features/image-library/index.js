// Image library: a "Creative Library" button next to the template editor's view selector opens
// the asset browser (browser.js) in copy mode: clicking an image copies its URL. Port of
// "Iterable Image Path Selector" v2.0.0; the popup's "Open image library" action opens it too.

import { openAssetBrowser } from './browser.js';

// The script's anchor: the editor's "basic / drag-and-drop" view selector. The button goes right
// after it, pushed to the right of the toolbar as the script did (margin-left: auto).
export const TARGET_SELECTOR = '[data-test="basic-select-email-editor-view"]';
const DEBOUNCE_MS = 150;

const BUTTON_CSS = `
.wb.il-inj{display:inline-flex; align-items:center; margin:auto 1rem auto auto}
.wb.il-inj .il-ico{width:14px; height:14px}
`;

export function mount(ctx) {
  const { h } = ctx.dom;
  const mounts = new Map(); // target element → inline mount
  const ours = new WeakSet();
  let open = null; // Promise while the browser is open

  function openLibrary() {
    if (open) return open;
    open = openAssetBrowser(ctx, { mode: 'copy' })
      .catch((e) => {
        ctx.log.warn('Image library failed', e?.name || 'error');
        return null;
      })
      .finally(() => { open = null; });
    return open;
  }

  function attach(target) {
    const m = ctx.ui.mountInline(target, 'after', { className: 'il-inj' });
    ours.add(m.host);
    m.root.prepend(h('style', null, BUTTON_CSS));
    m.el.append(ctx.ui.injectedButton('Creative Library', {
      size: 'sm',
      title: 'Browse, upload and copy image URLs (Workbench)',
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); openLibrary(); },
    }));
    mounts.set(target, m);
  }

  function scan() {
    for (const [target, m] of mounts) {
      // Target gone, or re-rendered without our button right after it.
      if (!target.isConnected || m.host.previousElementSibling !== target) {
        m.destroy();
        mounts.delete(target);
      }
    }
    for (const target of document.querySelectorAll(TARGET_SELECTOR)) {
      if (!mounts.has(target) && target.parentNode) attach(target);
    }
  }

  let timer = 0;
  const obs = new MutationObserver((records) => {
    if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => ours.has(n)))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!ctx.signal.aborted) scan(); }, DEBOUNCE_MS);
  });
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  scan();

  ctx.onAction?.('open', () => { openLibrary(); });

  return () => {
    obs.disconnect();
    clearTimeout(timer);
    for (const m of mounts.values()) m.destroy();
    mounts.clear();
  };
}
