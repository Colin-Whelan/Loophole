// Bulk data: an "Export CSV" button beside every catalog on the catalogs index table (the
// Catalog Push userscript's row buttons). Reads Iterable's DOM only to find the per-row links;
// the data-test hook is the stable part, the generated sc-* classes are never used. Each button
// lives in its own shadow mount next to the link, never inside it.

import { h } from '../../core/dom.js';
import { catalogNameFromPath, isCatalogsIndexPath } from './catalog-logic.js';

export const INDEX_ROW_LINK_SELECTOR = '[data-test="tableRow"] a[href^="/catalogs/table/"]';
const SCAN_MS = 500;   // the table re-renders on sort/filter on its own schedule: debounce the rescans

/** Watch the index table; onExport(name) on a click. → stop() (also stops on ctx.signal). */
export function watchCatalogRows(ctx, onExport) {
  const mounts = new Map();   // link element → shadow mount
  let timer = null;

  function scan() {
    timer = null;
    // Drop buttons whose row went away or was re-rendered without them.
    for (const [a, m] of mounts) {
      if (!a.isConnected || a.nextElementSibling !== m.host) { m.destroy(); mounts.delete(a); }
    }
    if (!isCatalogsIndexPath(location.pathname)) return;
    let links;
    try { links = document.querySelectorAll(INDEX_ROW_LINK_SELECTOR); } catch { return; }
    for (const a of links) {
      if (mounts.has(a)) continue;
      const name = catalogNameFromPath(a.getAttribute('href') || '');
      if (!name) continue;
      const m = ctx.ui.mountInline(a, 'after', { className: 'bd-rowx' });
      m.root.prepend(h('style', null, '.bd-rowx{margin-left:10px; display:inline-flex; vertical-align:middle}'));
      m.el.append(ctx.ui.injectedButton('Export CSV', {
        size: 'sm',
        title: 'Export ' + name + ' to CSV',
        onClick: (e) => {
          // Keep the click from reaching the row (which navigates to the catalog).
          e.preventDefault();
          e.stopPropagation();
          onExport(name);
        },
      }));
      mounts.set(a, m);
    }
  }

  const schedule = () => {
    if (!timer && (mounts.size || isCatalogsIndexPath(location.pathname))) timer = setTimeout(scan, SCAN_MS);
  };
  const obs = new MutationObserver((records) => {
    // Our own mounts appearing are mutations too; ignore batches made only of those.
    if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeName === 'WB-HOST'))) return;
    schedule();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  const unsubUrl = ctx.onUrlChange(schedule);
  scan();

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    obs.disconnect();
    unsubUrl?.();
    clearTimeout(timer);
    for (const m of mounts.values()) m.destroy();
    mounts.clear();
  }
  ctx.signal.addEventListener('abort', stop, { once: true });
  return stop;
}
