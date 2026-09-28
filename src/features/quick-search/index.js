// Quick search tags: a strip of saved searches above Iterable's template list. Clicking a tag types
// its label into the template search box (native setter + input/change, so React notices).
// Port of "Iterable Template Quick Search" v2.2.0; tags are edited on the options page.

import {
  gradientCss, hasLabel, makeTag, MAX_TAG_LABEL, nextPresetIndex, normaliseSortOrder, normaliseTags, presetAt, sortTags,
} from './tags.js';

// Selectors proven by the userscript.
const ANCHOR = '[data-test="template-folder-page"] > div:nth-child(2)';
const SEARCH = '#template-search-input';

const EXTRA_CSS = `
.wb.qs{margin:12px 0}
.qs-h > button.t{border:0; background:transparent; padding:0; color:inherit; font:600 12px var(--wb-font); display:flex; align-items:center; gap:6px; cursor:pointer; text-align:left}
.qs-caret{display:inline-block; font-size:10px; color:var(--wb-muted); transition:transform .12s}
.qs.collapsed .qs-caret{transform:rotate(-90deg)}
.qs.collapsed .qs-h{margin-bottom:0}
.qs.collapsed .qs-tags{display:none}
.qs-empty{font-size:12px; color:var(--wb-muted)}
`;

export function mount(ctx) {
  const { h } = ctx.dom;
  const { mark, button, toast } = ctx.ui;
  const name = ctx.meta.name;

  let values = ctx.settings;
  let collapsed = false;
  let strip = null; // { anchor, mount, box, tagsRow, toggle }

  const searchInput = () => document.querySelector(SEARCH);

  ctx.state.get('collapsed', false).then((v) => {
    if (ctx.signal.aborted) return;
    collapsed = v === true;
    applyCollapsed();
  }).catch((e) => ctx.log.warn('could not read collapsed state', e));

  function setSearch(term) {
    const el = searchInput();
    if (!el) {
      toast('Couldn’t find the template search box on this page.', { tone: 'warn', source: name });
      return;
    }
    ctx.dom.setNativeValue(el, term);
    el.focus();
    syncActive();
  }

  async function saveCurrent() {
    const term = searchInput()?.value.trim();
    if (!term) {
      toast('Type something in the template search first.', { tone: 'warn', source: name });
      return;
    }
    if (term.length > MAX_TAG_LABEL) {
      toast(`Tags can be up to ${MAX_TAG_LABEL} characters. Shorten the search to save it.`, { tone: 'warn', source: name });
      return;
    }
    try {
      let duplicate = false;
      await ctx.saveSettings((latest) => {
        const tags = normaliseTags(latest.tags);
        if (hasLabel(tags, term)) { duplicate = true; return null; }
        return { tags: [...tags, makeTag(term, presetAt(nextPresetIndex(tags)), tags)] };
      });
      if (duplicate) {
        toast(`“${term}” is already a tag.`, { source: name });
        return;
      }
      toast(`Saved “${term}” as a tag.`, { tone: 'ok', source: name });
    } catch (e) {
      ctx.log.error('saving tag failed', e);
      toast('Couldn’t save the tag.', { tone: 'bad', source: name });
    }
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    applyCollapsed();
    ctx.state.set('collapsed', collapsed).catch((e) => ctx.log.warn('could not save collapsed state', e));
  }

  function applyCollapsed() {
    if (!strip) return;
    strip.box.classList.toggle('collapsed', collapsed);
    strip.toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function syncActive() {
    if (!strip) return;
    const current = (searchInput()?.value || '').trim();
    for (const b of strip.tagsRow.querySelectorAll('.qs-tag')) {
      b.setAttribute('aria-pressed', String(!!current && b.dataset.label === current));
    }
  }

  function renderTags() {
    if (!strip) return;
    const row = strip.tagsRow;
    ctx.dom.clear(row);
    const tags = sortTags(normaliseTags(values.tags), normaliseSortOrder(values.sortOrder));
    if (!tags.length) {
      row.append(h('span', { class: 'qs-empty' },
        'No tags yet. Type a search and click Save search, or add tags in Edit tags.'));
      return;
    }
    for (const t of tags) {
      row.append(h('button', {
        type: 'button', class: 'qs-tag', 'aria-pressed': 'false', title: `Search for “${t.label}”`,
        dataset: { label: t.label }, style: { background: gradientCss(t.colorGradient) },
        onClick: () => setSearch(t.label),
      }, t.label));
    }
    syncActive();
  }

  function attach(anchor) {
    strip?.mount.destroy();
    const m = ctx.ui.mountInline(anchor, 'after', { className: 'qs', display: 'block' });
    m.root.prepend(h('style', null, EXTRA_CSS));
    const toggle = h('button', { type: 'button', class: 't', 'aria-expanded': 'true', onClick: toggleCollapsed },
      h('span', { class: 'qs-caret', 'aria-hidden': 'true' }, '▼'), 'Quick search');
    const tagsRow = h('div', { class: 'row qs-tags' });
    m.el.append(
      h('div', { class: 'qs-h' },
        mark(),
        toggle,
        button('Save search', { variant: 'ghost', size: 'sm', title: 'Save the current search as a tag', trusted: true, onClick: saveCurrent }),
        button('Clear', { variant: 'ghost', size: 'sm', onClick: () => setSearch('') }),
        button('Edit tags', { variant: 'ghost', size: 'sm', onClick: () => ctx.openOptions() })),
      tagsRow);
    strip = { anchor, mount: m, box: m.el, tagsRow, toggle };
    applyCollapsed();
    renderTags();
  }

  // SPA awareness: (re)attach whenever the anchor appears, is replaced, or our strip is dropped.
  function ensure() {
    const anchor = document.querySelector(ANCHOR);
    if (!anchor) return;
    if (strip && strip.anchor === anchor && strip.mount.host.isConnected) return;
    attach(anchor);
  }
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!ctx.signal.aborted) ensure(); });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensure();

  // Keep the active tag in step with whatever is in the search box (typing, Clear, tag clicks).
  document.addEventListener('input', (e) => {
    if (e.target?.id === 'template-search-input') syncActive();
  }, { capture: true, signal: ctx.signal });

  const offSettings = ctx.onSettings((v) => { values = v; renderTags(); });

  return () => {
    obs.disconnect();
    offSettings?.();
    strip?.mount.destroy();
    strip = null;
  };
}
