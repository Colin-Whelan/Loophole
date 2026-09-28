// Bulk data: a drawer docked beside Iterable's left nav for pushing CSVs into Iterable
// (Users: users/bulkUpdate or lists/subscribe with profile fields; Lists: static lists and
// keys-only member uploads; Catalogs: catalog item upload and export). Port of the "Iterable
// User Push" and "Iterable Catalog Push" userscripts.
//
// Nothing is sent until the user presses Start (or a list action button). Every run pins the
// project at Start (after a forced project refresh) and keeps that project's key to the end.

import { classifyFailure, nf } from './logic.js';
import { boundRequest } from './requests.js';
import { createListStore } from './lists.js';
import { createUsersTab } from './tab-users.js';
import { createListsTab } from './tab-lists.js';
import { createCatalogsTab } from './tab-catalogs.js';
import { createSettingsTab } from './tab-settings.js';
import { createCatalogStore } from './catalogs.js';
import { watchCatalogRows } from './catalog-rows.js';
import { areaOf } from './catalog-logic.js';
import { DRAWER_CSS, banner } from './ui.js';

// Read-only measure of the app's own left nav so the drawer starts where the content does. Any
// miss (selector gone, chrome-less route) falls back to the default nav width.
const SIDEBAR_SELECTOR = '#navbar-left-sidebar-nav';
const SIDEBAR_FALLBACK = 72;
const UI_STATE = 'ui';

// Tab factories in display order: each takes the shell and returns
// { id, label, el, isRunning(), onShow?(), destroy() }.
const TAB_FACTORIES = [createUsersTab, createListsTab, createCatalogsTab, createSettingsTab];

export function mount(ctx) {
  const { h } = ctx.dom;
  const ui = ctx.ui;
  const overlay = ui.mountOverlay('drawer');
  overlay.root.insertBefore(h('style', null, DRAWER_CSS), overlay.el);

  // ── Settings values (shared with the options page) ────────────────────
  let values = { ...ctx.settings };
  const valueListeners = new Set();
  const unsubSettings = ctx.onSettings((v) => {
    values = { ...v };
    for (const cb of valueListeners) cb(values);
  });

  // ── Project + key status ──────────────────────────────────────────────
  let keyInfo = null;          // { projectKey, hasKey, masked, error? } for the current project
  let authProblem = null;      // { projectKey, projectName, status } after a 401/403
  const statusListeners = new Set();
  const projectListeners = new Set();
  const runs = new Set();

  const toast = (message, tone) => ui.toast(message, { tone, source: 'Bulk data', timeoutMs: tone === 'bad' ? 7000 : 4000 });
  const emitStatus = () => {
    renderHeader();
    renderNotices();
    for (const cb of statusListeners) { try { cb(); } catch (e) { ctx.log.error('status listener threw', e); } }
  };

  async function refreshKey() {
    const p = ctx.project?.current();
    if (!p) { keyInfo = null; emitStatus(); return null; }
    const k = await ctx.api.keyStatus(p.key);
    if (ctx.project.current()?.key !== p.key) return keyInfo; // switched meanwhile
    keyInfo = { projectKey: p.key, hasKey: !!k.hasKey, masked: k.masked || '', error: k.error || null };
    emitStatus();
    return keyInfo;
  }

  const shell = {
    ctx,
    values: () => values,
    subscribeValues(cb) { valueListeners.add(cb); return () => valueListeners.delete(cb); },
    saveValues: (patch) => ctx.saveSettings(patch).catch((e) => {
      ctx.log.error('could not save settings', e);
      toast('Could not save that setting.', 'bad');
    }),
    keyInfo: () => keyInfo,
    refreshKey,
    onStatus(cb) { statusListeners.add(cb); return () => statusListeners.delete(cb); },
    onProjectChange(cb) { projectListeners.add(cb); return () => projectListeners.delete(cb); },
    toast,
    openKeys: () => ctx.openOptions('keys'),
    requestFor: (projectKey) => boundRequest(ctx, projectKey),

    /**
     * Refresh the project (forced; a failed refresh blocks) and make sure it has a key. → { projectKey, projectName,
     * masked, request } with `request` bound to that project, or null (and the reason shown).
     */
    async pin() {
      await ctx.project.refresh({ force: true });
      const p = ctx.project.current();
      // A failed refresh keeps the last known project, which may be stale: never pin that.
      if (p && ctx.project.error?.()) {
        toast('Couldn’t re-check which project this page is in, so nothing was sent. Reload the page and try again.', 'bad');
        emitStatus();
        return null;
      }
      if (!p) {
        toast('Couldn’t detect the current Iterable project. Reload the page and try again.', 'bad');
        emitStatus();
        return null;
      }
      const k = await refreshKey();
      if (!k || k.projectKey !== p.key) { toast('The project changed. Try again.', 'warn'); return null; }
      if (k.error) { toast('Couldn’t check the API key: ' + k.error.message, 'bad'); return null; }
      if (!k.hasKey) {
        toast('No API key saved for ' + p.name + '. Add one in Loophole settings.', 'bad');
        return null;
      }
      return { projectKey: p.key, projectName: p.name, masked: k.masked, request: boundRequest(ctx, p.key) };
    },

    describeError(res, prefix) {
      return prefix + ': ' + classifyFailure(res).summary + '.';
    },

    /** 401/403 → point at the key settings; a missing key → re-check the status. */
    handleAuthFailure(res, pin) {
      const status = Number(res?.status) || 0;
      if (status === 401 || status === 403) {
        authProblem = { projectKey: pin.projectKey, projectName: pin.projectName, status };
        emitStatus();
      } else if (res?.error?.code === 'NO_KEY') {
        refreshKey();
      }
    },

    trackRun(run) { runs.add(run); syncHold(); renderLauncher(); },
    runsChanged: () => renderLauncher(),
    runEnded(run) {
      runs.delete(run);
      renderLauncher();
      // After the toast below: releasing may unmount the drawer (we're off the Lists page).
      queueMicrotask(syncHold);
      const s = run.stats;
      if (run.endToast) {
        // The run wrote its own summary (catalog export).
        toast(run.endToast.message, run.endToast.tone);
      } else if (run.fatal) {
        toast(run.label + ': stopped, ' + run.fatal.summary + '. Progress is saved.', 'bad');
        shell.handleAuthFailure({ status: run.fatal.status, error: { code: run.fatal.reason === 'no_key' ? 'NO_KEY' : '' } },
          { projectKey: run.projectKey, projectName: run.projectName });
      } else if (run.error) {
        toast(run.label + ': the run ended with an error. Progress is saved.', 'bad');
      } else if (run.finished) {
        toast(run.label + ': finished. ' + nf(s.sentOk) + ' ok, ' + nf(s.failed) + ' failed.', s.failed ? 'warn' : 'ok');
      } else {
        toast(run.label + ': stopped. Progress is saved.', 'warn');
      }
    },
  };
  shell.lists = createListStore(shell);
  shell.catalogs = createCatalogStore(shell);
  const anyRunning = () => [...runs].some((r) => r.running);

  // Auto-load the lists for whichever tab needs them, instead of making the person hit Reload.
  const LIST_TABS = new Set(['users', 'lists']);
  shell.ensureListsLoaded = () => {
    const p = ctx.project?.current();
    if (!p || shell.lists.state.loading) return;
    if (shell.lists.state.loaded && shell.lists.state.projectKey === p.key) return;
    shell.lists.refresh();
  };

  // ── Route: the launcher lives on the Lists and Catalogs index pages only ─
  // A tracked run holds the mount, so navigating away mid-run keeps the drawer (and the run) with
  // a route note; the router unmounts us once the last run ends if we're still off those pages.
  let routeActive = true;
  let releaseHold = null;
  function syncHold() {
    if (runs.size && !releaseHold) releaseHold = ctx.holdMount();
    else if (!runs.size && releaseHold) { const r = releaseHold; releaseHold = null; r(); }
  }

  // ── Drawer ────────────────────────────────────────────────────────────
  const projectChip = ui.chip('Detecting project…', { tone: 'accent' });
  const collapseBtn = h('button', { type: 'button', class: 'wb-x', 'aria-label': 'Collapse drawer', title: 'Collapse', onClick: () => close() }, '‹');
  const notices = h('div', { class: 'bd-view', hidden: true });
  const routeNote = h('div', { class: 'bd-route', role: 'status', hidden: true },
    'A run is in progress. Loophole keeps this open until it finishes.');
  const views = h('div');
  const tabs = TAB_FACTORIES.map((make) => make(shell));
  let current = tabs[0].id;
  let lastListsTab = current;   // the tab to go back to when leaving the catalogs page
  const tabStrip = ui.tabs({ tabs: tabs.map((t) => ({ id: t.id, label: t.label })), selected: current, onSelect: selectTab });
  for (const t of tabs) { t.el.hidden = t.id !== current; views.append(t.el); }

  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Bulk data', hidden: true },
    h('div', { class: 'wb-ph' }, ui.mark(), h('span', { class: 't' }, 'Bulk data'), projectChip, collapseBtn),
    routeNote,
    h('div', { class: 'drawer-body' }, tabStrip, notices, views));

  const launchPct = h('span', { class: 'pct', hidden: true });
  const launchDot = h('span', { class: 'busy', hidden: true });
  const launcher = h('button', { type: 'button', class: 'bd-launch', title: 'Open Bulk data', 'aria-label': 'Open Bulk data', onClick: () => open() },
    ui.mark(), h('span', { class: 'lbl' }, 'Bulk data'), launchDot, launchPct);
  overlay.el.append(launcher, drawer);

  function selectTab(id) {
    if (!tabs.some((t) => t.id === id)) return;
    current = id;
    if (id !== 'catalogs') lastListsTab = id;
    tabStrip.select(id);
    for (const t of tabs) t.el.hidden = t.id !== id;
    tabs.find((t) => t.id === id)?.onShow?.();
    if (LIST_TABS.has(id)) shell.ensureListsLoaded();
    ctx.state.set(UI_STATE, { tab: id }).catch(() => {});
  }

  /** Catalogs page → Catalogs tab; lists page → back to Users/Lists (or Settings) if on Catalogs. */
  function applyArea() {
    const area = areaOf(location.pathname);
    if (area === 'catalogs' && current !== 'catalogs') selectTab('catalogs');
    else if (area === 'lists' && current === 'catalogs') selectTab(lastListsTab === 'catalogs' ? 'users' : lastListsTab);
  }

  function open() {
    drawer.hidden = false;
    applyArea();
    applyRoute();
    refreshKey();
    ctx.project.refresh();
    if (LIST_TABS.has(current)) shell.ensureListsLoaded();
    collapseBtn.focus();
  }

  function close() {
    const hadFocus = overlay.root.activeElement != null;
    drawer.hidden = true;
    applyRoute();
    if (hadFocus && !launcher.hidden) launcher.focus();
  }

  function applyRoute() {
    launcher.hidden = !routeActive || !drawer.hidden;
    routeNote.hidden = routeActive || drawer.hidden;
    layout();
  }

  function sidebarWidth() {
    try {
      const el = document.querySelector(SIDEBAR_SELECTOR);
      if (el) {
        const w = Math.round(el.getBoundingClientRect().width);
        if (w > 0 && w < 400) return w;
      }
    } catch { /* fall through */ }
    return SIDEBAR_FALLBACK;
  }

  function layout() {
    const left = sidebarWidth() + 'px';
    drawer.style.left = left;
    launcher.style.left = left;
  }

  function renderHeader() {
    const p = ctx.project?.current();
    projectChip.textContent = p ? p.name : (ctx.project?.error() ? 'Project unknown' : 'Detecting project…');
    projectChip.className = 'wb-chip ' + (p ? 'accent' : 'warn');
    projectChip.title = p ? p.name + ' (' + p.key + ')' : '';
  }

  function renderNotices() {
    notices.replaceChildren();
    const p = ctx.project?.current();
    if (!p) {
      if (ctx.project?.error()) {
        notices.append(banner({ tone: 'bad', chipText: 'No project', chipTone: 'bad',
          text: 'Couldn’t detect the current Iterable project, so nothing can be sent. Reload the page to try again.' }));
      }
    } else if (authProblem && authProblem.projectKey === p.key) {
      notices.append(banner({ tone: 'bad', chipText: 'HTTP ' + authProblem.status, chipTone: 'bad',
        text: 'Iterable rejected the API key for ' + authProblem.projectName + '. Check it in Settings → Projects & keys.',
        actions: [
          { label: 'Open keys', onClick: () => shell.openKeys() },
          { label: 'Dismiss', variant: 'ghost', onClick: () => { authProblem = null; emitStatus(); } },
        ] }));
    } else if (keyInfo && keyInfo.projectKey === p.key && !keyInfo.hasKey && !keyInfo.error) {
      notices.append(banner({ chipText: 'No key',
        text: 'No API key saved for ' + p.name + '. Runs and list actions need one. Dry runs work without it.',
        actions: [{ label: 'Add key', onClick: () => shell.openKeys() }] }));
    }
    notices.hidden = !notices.childElementCount;
  }

  function renderLauncher() {
    const live = [...runs].filter((r) => r.running);
    launchDot.hidden = !live.length;
    launchPct.hidden = !live.length;
    if (live.length) {
      const r = live[0];
      launchDot.classList.toggle('paused', !!r.paused);
      launchPct.textContent = Math.floor(r.snapshot().pct) + '%';
      launcher.title = r.label + ' run ' + (r.paused ? 'paused' : 'in progress') + '. Open Bulk data';
    } else {
      launcher.title = 'Open Bulk data';
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  const unsubProject = ctx.project.onChange((next, prev) => {
    if (prev && next && prev.key !== next.key) {
      if (shell.lists.state.projectKey && shell.lists.state.projectKey !== next.key) shell.lists.reset();
      if (shell.catalogs.state.projectKey && shell.catalogs.state.projectKey !== next.key) shell.catalogs.reset();
      if (authProblem && authProblem.projectKey !== next.key) authProblem = null;
    }
    keyInfo = null;
    emitStatus();
    for (const cb of projectListeners) { try { cb(next, prev); } catch (e) { ctx.log.error('project listener threw', e); } }
    if (!drawer.hidden) {
      refreshKey();
      if (LIST_TABS.has(current)) shell.ensureListsLoaded();
    }
  });

  // A key added, replaced or removed anywhere (options page, popup): re-check this project's.
  // Runs still re-check at Start (pin()), so a stale status never starts one.
  ctx.api.onKeysChanged(() => { if (!drawer.hidden) refreshKey(); });
  window.addEventListener('resize', layout, { signal: ctx.signal });
  // A run needs this tab open; warn before leaving mid-run.
  window.addEventListener('beforeunload', (e) => {
    if (anyRunning()) { e.preventDefault(); e.returnValue = ''; }
  }, { signal: ctx.signal });

  let sidebarObserver = null;
  if (typeof ResizeObserver === 'function') {
    sidebarObserver = new ResizeObserver(() => layout());
    ctx.dom.onElement(SIDEBAR_SELECTOR, (el) => { sidebarObserver.observe(el); layout(); }, { signal: ctx.signal });
  }

  const unsubAction = ctx.onAction('open', () => open());
  const unsubRoute = ctx.onRouteActive((active) => { routeActive = active; applyRoute(); });
  // Lists ↔ Catalogs while open: follow the page, unless the visible tab has a run going.
  const unsubUrl = ctx.onUrlChange(() => {
    if (!drawer.hidden && routeActive && !tabs.find((t) => t.id === current)?.isRunning()) applyArea();
  });

  // Catalogs index: an Export CSV button on every catalog row (the userscript's row buttons).
  const catalogsTab = tabs.find((t) => t.id === 'catalogs');
  const stopRows = watchCatalogRows(ctx, (name) => {
    open();
    selectTab('catalogs');
    catalogsTab.exportCatalog(name);
  });

  // Escape closes the drawer: from inside it, or from the page when no other Loophole dialog
  // (modal, popover) is open. Those handle Escape themselves in the capture phase first.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || drawer.hidden) return;
    const inside = e.composedPath().includes(overlay.host);
    if (!inside && otherLoopholeDialogOpen()) return;
    e.stopPropagation();
    close();
  }, { signal: ctx.signal });

  function otherLoopholeDialogOpen() {
    for (const host of document.querySelectorAll('wb-host')) {
      // Our roots are closed: look inside through the registry, never host.shadowRoot.
      if (host !== overlay.host && ui.shadowRootOf(host)?.querySelector('.wb-scrim, [role="dialog"]')) return true;
    }
    return false;
  }

  ctx.state.get(UI_STATE, null).then((s) => {
    // Only while closed: open() picks the tab for the page, and a late restore mustn't undo that.
    if (s && typeof s.tab === 'string' && s.tab !== current && !ctx.signal.aborted && drawer.hidden) selectTab(s.tab);
  }).catch(() => {});

  layout();
  renderHeader();
  renderNotices();

  return () => {
    unsubSettings?.();
    unsubProject?.();
    unsubAction?.();
    unsubRoute?.();
    unsubUrl?.();
    stopRows();
    sidebarObserver?.disconnect();
    for (const r of runs) if (r.running) r.stop();
    for (const t of tabs) { try { t.destroy?.(); } catch (e) { ctx.log.error('tab cleanup threw', e); } }
    overlay.destroy();
  };
}
