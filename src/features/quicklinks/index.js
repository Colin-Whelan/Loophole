// Quicklinks: user-defined shortcuts in the shared Loophole navbar strip (ARCHITECTURE §7.2).
// Ported from "Custom Quicklinks". Plain <a> elements, as the userscript used, so a relative path
// navigates within the app (the browser, or Iterable's own SPA router if it intercepts same-origin
// clicks, handles it) and an https:// URL opens the target site; `openInNewTab` sets target/rel.

import { normalizeQuickLink, quickLinkSlug } from './links.js';

export function mount(ctx) {
  const { ui, dom } = ctx;
  const item = ui.navSlot({ featureId: ctx.featureId, order: 10, signal: ctx.signal });

  let settings = ctx.settings;

  function render() {
    dom.clear(item);
    const links = Array.isArray(settings.links) ? settings.links : [];
    for (const raw of links) {
      const link = normalizeQuickLink(raw);
      if (!link) continue;
      item.append(dom.h('a', {
        class: 'ql',
        href: link.url,
        target: settings.openInNewTab ? '_blank' : null,
        rel: settings.openInNewTab ? 'noopener noreferrer' : null,
        'data-test': `quicklink-${quickLinkSlug(link.name)}-item`,
      }, link.name));
    }
  }
  render();

  const off = ctx.onSettings((values) => { settings = values; render(); });

  return () => { off?.(); };
}
