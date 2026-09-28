// Snippet viewer: a searchable browser for the project's snippets (FetchSnippets GraphQL), with the
// code, a sandboxed HTML preview, and one-click copies of the handlebars usage and the content.
// Opened from a "Snippets" button in the template editor toolbar (the script's placement rule), a
// "Snippets" item in the navbar strip (setting), the popup, or an optional shortcut.
// Port of "Iterable Snippet Viewer" v1.1.0. The list is cached per project in ctx.state.
//
// Security: snippet HTML is only ever rendered inside an <iframe sandbox=""> via srcdoc (no
// scripts, opaque origin), never inserted into our own DOM. The script used
// sandbox="allow-same-origin" + document.write, which would give snippet scripts Iterable's origin
// the moment scripts were allowed.

import { fetchSnippets } from '../../lib/iterable/snippets.js';
import { isAbortError } from '../../lib/iterable/errors.js';
import { linkSignal } from '../../core/dom.js';
import { getMigrated } from '../../core/state.js';
import {
  EDITOR_ANCHOR, EDITOR_ROUTE, buildSnippetSyntax, cacheStateName, legacyCacheStateNames, filterSnippets, incompleteText,
  isStale, makeCache, previewDoc, readCache, timeAgo,
} from './logic.js';

const SOURCE = 'Snippet viewer';
const NAV_ORDER = 30;

const CSS = `
.sv{display:grid; grid-template-columns:minmax(220px,320px) minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); gap:10px 14px; height:100%; min-height:0}
.sv-top{grid-column:1/-1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; color:var(--wb-muted)}
.sv-top .sp{flex:1}
.sv-count{font-weight:600; color:var(--wb-ink)}
.sv-left{display:flex; flex-direction:column; gap:8px; min-height:0}
.sv-list{flex:1; min-height:0; overflow:auto; border:1px solid var(--wb-line); border-radius:var(--wb-r); background:var(--wb-surface)}
.sv-item{display:block; width:100%; text-align:left; border:0; border-bottom:1px solid var(--wb-line); background:transparent; padding:7px 10px; cursor:pointer; color:var(--wb-ink)}
.sv-item:last-child{border-bottom:0}
.sv-item:hover{background:var(--wb-raised)}
.sv-item[aria-selected="true"]{background:var(--wb-accent-soft); box-shadow:inset 3px 0 0 var(--wb-accent)}
.sv-item .n{display:block; font-weight:600; font-size:12.5px; overflow-wrap:anywhere}
.sv-item .d{display:block; font-size:11.5px; color:var(--wb-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px}
.sv-item .m{display:flex; gap:8px; font-size:11px; color:var(--wb-faint); margin-top:2px; min-width:0}
.sv-item .p{font-family:var(--wb-mono); color:var(--wb-accent-strong); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0}
.sv-empty{padding:24px 12px; text-align:center; color:var(--wb-faint); font-size:12.5px}
.sv-empty .wb-btn{margin-top:10px}
.sv-detail{display:flex; flex-direction:column; gap:10px; min-height:0; min-width:0}
.sv-name{font-size:15px; font-weight:600; overflow-wrap:anywhere}
.sv-desc{margin:0; font-size:12.5px; color:var(--wb-muted); overflow-wrap:anywhere}
.sv-params{display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:12px; color:var(--wb-muted)}
.sv-params .wb-chip{font-family:var(--wb-mono)}
.sv-detail .kv{margin:0}
.sv-usage{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.sv-syntax{flex:1 1 240px; min-width:0; font:12px var(--wb-mono); background:var(--wb-sunken); border:1px solid var(--wb-line); border-radius:var(--wb-r); padding:5px 8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--wb-ink)}
.sv-pane{flex:1; min-height:0; display:flex; flex-direction:column}
.sv-pane .wb-code{flex:1; min-height:0; display:flex; flex-direction:column}
.sv-pane .wb-code-pre{flex:1; min-height:0}
.sv-frame{flex:1; min-height:240px; width:100%; border:1px solid var(--wb-line); border-radius:var(--wb-r); background:#fff}
@media (max-width:760px){
  .sv{grid-template-columns:minmax(0,1fr); grid-template-rows:auto auto minmax(0,1fr)}
  .sv-list{max-height:30vh}
}
`;

export function mount(ctx) {
  const { ui, dom, signal, log } = ctx;
  const { h } = dom;

  let settings = ctx.settings;
  const mem = new Map();        // projectKey ('' = unknown project) → cache record
  const inflight = new Map();   // projectKey → Promise<{ pk, cache }>
  let view = null;              // the open dialog's controller

  // ── Data ─────────────────────────────────────────────────────────────────

  async function projectKey({ force = false } = {}) {
    try { await ctx.project?.refresh({ force }); } catch { /* keep the last known project */ }
    return ctx.project?.current()?.key || '';
  }

  async function loadCache(pk) {
    if (mem.has(pk)) return mem.get(pk);
    if (!pk) return null;   // unknown project: never read (or mix) another project's cache
    try {
      // Moved from its pre-projectSlot name ('cache:<projectKey>') on first read.
      const c = readCache(await getMigrated(ctx.state, cacheStateName(pk), legacyCacheStateNames(pk), null));
      if (c) mem.set(pk, c);
      return c;
    } catch (e) {
      log.warn('could not read the snippet cache', e?.message);
      return null;
    }
  }

  /** Fetch the current project's snippets → { pk, cache }. Concurrent calls share one request. */
  function refetch() {
    const run = async () => {
      const pk = await projectKey({ force: true });   // pin the project for this fetch
      const res = await fetchSnippets({ http: ctx.http }, { signal });
      const cache = makeCache(res);
      const after = await projectKey();
      if (after !== pk) {
        // The project changed mid-fetch: we can't tell which one the list belongs to.
        const err = new Error('The project changed while snippets were loading. Try again.');
        err.code = 'PROJECT_CHANGED';
        throw err;
      }
      mem.set(pk, cache);
      if (pk) {
        ctx.state.set(cacheStateName(pk), cache)
          .catch((e) => log.warn('could not save the snippet cache', e?.message));
      }
      if (!cache.complete) log.debug('snippet list may be incomplete', cache.snippets.length, cache.total);
      return { pk, cache };
    };
    const key = ctx.project?.current()?.key || '';
    if (inflight.has(key)) return inflight.get(key);
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ── Dialog ───────────────────────────────────────────────────────────────

  async function open() {
    if (signal.aborted) return;
    if (view) { view.focusSearch(); return; }
    view = createView();
    const v = view;
    const pk = await projectKey();
    if (v.closed) return;
    const cache = await loadCache(pk);
    if (v.closed) return;
    if (cache) {
      v.show(cache);
      if (isStale(cache, settings.cacheMinutes)) v.refresh({ quiet: true });
    } else {
      v.refresh();
    }
  }

  function createView() {
    const st = { cache: null, filtered: [], selectedId: null, tab: 'code', term: '', loading: false };
    const count = h('span', { class: 'sv-count' });
    const age = h('span', { class: 'sv-age' });
    const warn = h('span', { class: 'sv-warn' });
    const refreshBtn = ui.button('Refresh', { size: 'sm', variant: 'ghost', title: 'Fetch the snippets again', onClick: () => refresh() });
    const search = ui.input({ placeholder: 'Search by name, description or parameter…', ariaLabel: 'Search snippets', onInput: (t) => setTerm(t) });
    search.type = 'search';
    search.addEventListener('keydown', onSearchKey);
    const list = h('div', { class: 'sv-list', role: 'listbox', 'aria-label': 'Snippets' });
    const detail = h('div', { class: 'sv-detail' });

    const body = h('div', { class: 'sv' },
      h('div', { class: 'sv-top' }, count, age, warn, h('span', { class: 'sp' }), refreshBtn),
      h('div', { class: 'sv-left' }, search, list),
      detail);

    const d = ui.dialog({ title: 'Snippets', source: SOURCE, size: 'xl', body, css: CSS });
    const ageTimer = setInterval(renderTop, 30000);
    const self = {
      closed: false,
      show, refresh,
      focusSearch: () => search.focus(),
      close: () => d.close(null),
    };
    d.closed.then(() => {
      self.closed = true;
      clearInterval(ageTimer);
      if (view === self) view = null;
    });

    renderTop();
    renderList();
    renderDetail();
    search.focus();

    function show(cache) {
      st.cache = cache;
      applyFilter();
      renderTop();
    }

    async function refresh({ quiet = false } = {}) {
      if (st.loading) return;
      st.loading = true;
      refreshBtn.disabled = true;
      renderTop();
      if (!st.cache) renderList();
      try {
        const { cache } = await refetch();
        if (self.closed) return;
        const first = !st.cache;
        show(cache);
        if (!quiet && !first) ui.toast(`Fetched ${cache.snippets.length} snippets`, { tone: 'ok', source: SOURCE, timeoutMs: 2500 });
      } catch (e) {
        if (isAbortError(e) || self.closed) return;
        log.warn('fetching snippets failed', e?.code, e?.status);
        const msg = `Couldn’t load snippets: ${e?.message || 'unknown error'}`;
        if (st.cache) ui.toast(msg, { tone: 'bad', source: SOURCE });
        else st.error = msg;
      } finally {
        st.loading = false;
        refreshBtn.disabled = false;
        if (!self.closed) { renderTop(); if (!st.cache) renderList(); }
      }
    }

    function renderTop() {
      const c = st.cache;
      count.textContent = c ? `${c.snippets.length.toLocaleString('en-US')} snippet${c.snippets.length === 1 ? '' : 's'}` : '';
      age.textContent = c ? `Fetched ${timeAgo(c.fetchedAt)}${st.loading ? ' · refreshing…' : ''}` : '';
      age.title = c ? `Cached ${new Date(c.fetchedAt).toLocaleString()}` : '';
      dom.clear(warn);
      const text = incompleteText(c);
      if (text) warn.append(ui.chip(text, { tone: 'warn', dot: true }));
    }

    function setTerm(t) {
      st.term = t;
      applyFilter();
    }

    function applyFilter() {
      const all = st.cache?.snippets || [];
      st.filtered = filterSnippets(all, st.term);
      if (!st.filtered.some((s) => s.id === st.selectedId)) st.selectedId = st.filtered[0]?.id ?? null;
      renderList();
      renderDetail();
    }

    function select(id, { focus = false } = {}) {
      if (st.selectedId === id) return;
      st.selectedId = id;
      for (const el of list.children) {
        if (el.dataset?.id == null) continue;
        const on = el.dataset.id === id;
        el.setAttribute('aria-selected', String(on));
        if (on) { el.scrollIntoView({ block: 'nearest' }); if (focus) el.focus(); }
      }
      renderDetail();
    }

    function onSearchKey(e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      const i = st.filtered.findIndex((s) => s.id === st.selectedId);
      if (e.key === 'Enter') {
        const s = st.filtered[i];
        if (s) { e.preventDefault(); copyUsage(s); }
        return;
      }
      e.preventDefault();
      const next = st.filtered[Math.max(0, Math.min(st.filtered.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.id);
    }

    function renderList() {
      dom.clear(list);
      if (!st.cache) {
        if (st.error && !st.loading) {
          list.append(h('div', { class: 'sv-empty' }, st.error, h('br'),
            ui.button('Try again', { size: 'sm', onClick: () => { st.error = null; refresh(); } })));
        } else {
          list.append(h('div', { class: 'sv-empty' }, 'Fetching snippets…'));
        }
        return;
      }
      if (!st.filtered.length) {
        list.append(h('div', { class: 'sv-empty' }, st.cache.snippets.length ? 'No snippets match.' : 'This project has no snippets.'));
        return;
      }
      for (const s of st.filtered) {
        const params = s.positionalParameters.join(', ');
        list.append(h('button', {
          type: 'button', class: 'sv-item', role: 'option', dataset: { id: s.id },
          'aria-selected': String(s.id === st.selectedId),
          title: 'Double-click to copy the usage',
          onClick: () => select(s.id),
          onDblclick: () => copyUsage(s),
        },
        h('span', { class: 'n' }, s.name),
        s.description ? h('span', { class: 'd', title: s.description }, s.description) : null,
        h('span', { class: 'm' },
          s.updatedAt != null ? h('span', { title: new Date(s.updatedAt).toLocaleString() }, `Updated ${timeAgo(s.updatedAt)}`) : null,
          params ? h('span', { class: 'p', title: params }, params) : null)));
      }
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }

    function renderDetail() {
      dom.clear(detail);
      const s = st.filtered.find((x) => x.id === st.selectedId);
      if (!s) {
        if (st.cache) detail.append(h('div', { class: 'sv-empty' }, 'Select a snippet to preview.'));
        return;
      }
      const syntax = buildSnippetSyntax(s);
      const meta = [];
      if (s.updatedAt != null) meta.push(['Updated', `${new Date(s.updatedAt).toLocaleString()} (${timeAgo(s.updatedAt)})`]);
      if (s.updatedBy) meta.push(['Updated by', s.updatedBy]);
      const pane = h('div', { class: 'sv-pane' });
      const tabs = ui.tabs({
        flush: false,
        tabs: [{ id: 'code', label: 'Code' }, { id: 'preview', label: 'Preview' }],
        selected: st.tab,
        onSelect: (id) => { st.tab = id; renderPane(pane, s); },
      });
      dom.append(detail,
        h('div', { class: 'sv-name' }, s.name),
        s.description ? h('p', { class: 'sv-desc' }, s.description) : null,
        s.positionalParameters.length
          ? h('div', { class: 'sv-params' }, 'Parameters', s.positionalParameters.map((p) => ui.chip(p)))
          : null,
        meta.length ? ui.kv(meta) : null,
        h('div', { class: 'sv-usage' },
          h('code', { class: 'sv-syntax', title: syntax }, syntax),
          ui.copyButton(syntax, { label: 'Copy usage', variant: 'primary', title: 'Copy the handlebars insert' }),
          ui.copyButton(() => s.content, { label: 'Copy content', title: 'Copy the snippet’s content' })),
        tabs,
        pane);
      renderPane(pane, s);
    }

    function renderPane(pane, s) {
      dom.clear(pane);
      if (st.tab === 'preview') {
        const frame = document.createElement('iframe');
        // Order matters: the sandbox is in place before the srcdoc document is created.
        frame.setAttribute('sandbox', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('title', `Preview of ${s.name}`);
        frame.className = 'sv-frame';
        frame.srcdoc = previewDoc(s.content);
        pane.append(frame);
      } else {
        pane.append(ui.codeBlock({ code: s.content, label: s.name, maxHeight: 'none', wrap: true, copy: false }));
      }
    }

    async function copyUsage(s) {
      const syntax = buildSnippetSyntax(s);
      const ok = await ui.copyText(syntax);
      ui.toast(ok ? `Copied: ${syntax}` : 'Couldn’t copy to the clipboard.', { tone: ok ? 'ok' : 'bad', source: SOURCE, timeoutMs: 2500 });
    }

    return self;
  }

  // ── Editor toolbar button (the script's placement rule) ──────────────────

  let editorBtn = null;   // { anchor, m }
  function ensureEditorButton() {
    if (signal.aborted) return;
    const path = location.pathname + location.search;
    const anchor = EDITOR_ROUTE.test(path) ? document.querySelector(EDITOR_ANCHOR) : null;
    if (editorBtn && editorBtn.anchor === anchor && editorBtn.m.host.isConnected) return;
    editorBtn?.m.destroy();
    editorBtn = null;
    if (!anchor?.parentNode) return;
    const m = ui.mountInline(anchor, 'after', { className: 'sv-inj' });
    m.el.append(ui.injectedButton('Snippets', { size: 'sm', title: 'Browse this project’s snippets', onClick: () => open() }));
    editorBtn = { anchor, m };
  }
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; ensureEditorButton(); });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ctx.onUrlChange(() => ensureEditorButton());
  ensureEditorButton();

  // ── Navbar strip item (setting) ──────────────────────────────────────────

  let navCtl = null;
  function syncNavbar() {
    if (settings.showInNavbar && !navCtl && !signal.aborted) {
      navCtl = new AbortController();
      const item = ui.navSlot({ featureId: ctx.featureId, order: NAV_ORDER, signal: linkSignal(signal, navCtl.signal) });
      item.append(ui.button('Snippets', { className: 'ql', title: 'Browse this project’s snippets', onClick: () => open() }));
    } else if (!settings.showInNavbar && navCtl) {
      navCtl.abort();
      navCtl = null;
    }
  }
  syncNavbar();

  // ── Shortcut (setting) ───────────────────────────────────────────────────

  let shortcutCtl = null;
  let shortcut = null;
  function syncShortcut() {
    const combo = settings.openShortcut || '';
    if (combo === shortcut) return;
    shortcutCtl?.abort();
    shortcutCtl = new AbortController();
    shortcut = combo;
    if (combo) dom.onShortcut(combo, () => { open(); }, { signal: linkSignal(signal, shortcutCtl.signal) });
  }
  syncShortcut();

  const offAction = ctx.onAction('open', () => open());
  const offSettings = ctx.onSettings((v) => { settings = v; syncNavbar(); syncShortcut(); });

  return () => {
    obs.disconnect();
    offAction?.();
    offSettings?.();
    navCtl?.abort();
    shortcutCtl?.abort();
    editorBtn?.m.destroy();
    editorBtn = null;
    view?.close();
  };
}
