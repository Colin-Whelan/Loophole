// Dynamic list membership: a side panel on a user profile's Lists tab showing which dynamic lists
// the user is in. Fetches the project's lists (GET /users/profiles/{id}/getProfileDetails), then
// narrows membership down with group-OR queries (POST /lists/segmentUsersQuery), caching results
// per project + user. Ported from "Iterable Dynamic Lists Checker".
//
// Privacy: never log the email, the profile id, list names or which lists matched; counts only.

import { sendWithRetry } from '../../core/retry.js';
import { linkSignal } from '../../core/dom.js';
import { getMigrated } from '../../core/state.js';
import { profileIdFromPath, readProfileIdentity } from '../../lib/iterable/profile-page.js';
import {
  SEGMENT_QUERY_PATH, profileDetailsPath, dynamicListsFrom, segmentQueryBody,
  isHit, findMemberships, ageLabel, ageTone, lastCheckedText, listUrl, cacheStateName, legacyCacheStateNames, userHash, legacyUserHash, readCache,
  writeCache, clampInt, toResponse, failureMessage,
} from './logic.js';

// Iterable's own DOM, read-only. The panel goes beside the list table (the script's anchor).
const LIST_TABLE_SELECTOR = '[data-test="list-table"]';

const SOURCE = 'Dynamic lists';
const BACKOFFS = [1000, 2000, 4000];
const TICK_MS = 15 * 1000;      // housekeeping: age chips, re-anchoring after React churn
const ANCHOR_WAIT_MS = 8000;   // then fall back to a floating panel
const AUTOSTART_DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const CSS = `
.dl-side{flex:0 0 400px; max-width:100%; min-width:0}
.dl-above{display:block; max-width:640px; margin:0 0 16px}
.dl-float{position:fixed; right:16px; bottom:16px; width:360px; max-width:calc(100vw - 32px); box-shadow:var(--wb-shadow)}
.dl-float .wb-pb{max-height:min(60vh, 520px); overflow:auto}
.dl-head{justify-content:space-between; flex-wrap:nowrap; margin-bottom:8px}
.dl-head .wb-help{margin:0}
.dl-bar{margin-bottom:8px}
.dl-list{max-height:480px; overflow:auto}
.dl-row a{overflow-wrap:anywhere}
.dl-note{font-size:12px; line-height:1.45; border-radius:4px; padding:7px 9px; margin-bottom:8px; background:var(--wb-raised); color:var(--wb-ink)}
.dl-note.warn{background:var(--wb-warn-soft); color:var(--wb-warn)}
.dl-note.bad{background:var(--wb-bad-soft); color:var(--wb-bad)}
.dl-empty{font-size:12.5px; color:var(--wb-muted); padding:6px 0}
`;

class CheckError extends Error {
  constructor(status, message, fatal) {
    super(message);
    this.name = 'CheckError';
    this.status = status;
    this.fatal = !!fatal;
  }
}

export function mount(ctx) {
  const { h, clear, append } = ctx.dom;
  const { ui, log, signal } = ctx;
  let settings = ctx.settings;

  let profileId = profileIdFromPath(location.pathname);
  let view = freshView(profileId);
  let run = null;          // { ac, profileId } for the check in flight
  let seq = 0;             // bumps on every profile change; stale async work compares against it
  let autoTimer = null;
  let renderedAgeKey = '';  // age text last rendered, so the chips refresh without rebuilding every tick
  const mountedAt = Date.now();

  function freshView(pid) {
    return {
      profileId: pid,
      loading: true,       // reading the cache
      at: null,            // time of the shown result
      lists: null,         // shown result (from cache or the last check), null = none yet
      noDynamic: false,    // the project has no dynamic lists at all
      progress: null,      // { resolved, total } while running
      error: null,         // message of the last failed check
      dismissed: false,    // floating panel closed
      autoTried: false,
    };
  }

  // ── Panel DOM (built once, moved between anchors) ────────────────────────

  const status = h('span', { class: 'wb-help', role: 'status' });
  const runBtn = ui.button('Check now', { size: 'sm', trusted: true, onClick: () => (run ? stopCheck() : startCheck()) });
  const barFill = h('i');
  const bar = h('div', { class: 'bar dl-bar', hidden: true }, barFill);
  const content = h('div');
  const body = h('div', null, h('div', { class: 'row dl-head' }, status, runBtn), bar, content);
  const panelEl = ui.panel({ title: 'Dynamic list membership', brand: 'Lists', body });
  panelEl.setAttribute('aria-label', 'Dynamic list membership');

  // ── Anchoring ────────────────────────────────────────────────────────────

  let anchor = null;       // { m, mode: 'side'|'above'|'float', table, restore }

  function unanchor() {
    if (!anchor) return;
    anchor.restore?.();
    anchor.m.destroy();
    anchor = null;
  }

  // Reversibly style the host page's elements (only the properties we set, restored on unmount).
  function setStyles(pairs) {
    const saved = [];
    for (const [el, props] of pairs) {
      for (const [p, v] of Object.entries(props)) {
        saved.push([el, p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
        el.style.setProperty(p, v);
      }
    }
    return () => {
      for (const [el, p, v, prio] of saved) {
        if (v) el.style.setProperty(p, v, prio); else el.style.removeProperty(p);
      }
    };
  }

  function mountAt(table) {
    unanchor();
    let m, mode, restore = null;
    if (table) {
      const parent = table.parentElement;
      const others = parent ? Array.from(parent.children).filter((c) => c !== table && c.localName !== 'wb-host') : [];
      // Beside the table, as the script did, but without moving Iterable's node (React owns it;
      // moving it is what forced the script to reload the page on navigation). Only when the
      // table is alone in its container, so no other host content gets reflowed.
      if (parent && !others.length) {
        mode = 'side';
        restore = setStyles([
          [parent, { display: 'flex', 'flex-wrap': 'wrap', gap: '20px', 'align-items': 'flex-start' }],
          [table, { flex: '1 1 600px', 'min-width': '0' }],
        ]);
        m = ui.mountInline(table, 'after', { className: 'dl-side' });
      } else {
        mode = 'above';
        m = ui.mountInline(table, 'before', { className: 'dl-above' });
      }
    } else {
      // Not in the shared floating dock (ui.floatingBar): the dock is for one-row toolbars in a
      // shadow root shared by every feature, with no way to add this panel's CSS there, and a
      // 360px scrolling panel would push every other bar up. Its own float mount sits at the same
      // corner; toasts may overlap it, and it can be closed.
      mode = 'float';
      m = ui.mountOverlay('float');
    }
    m.root.prepend(h('style', null, CSS));
    panelEl.classList.toggle('dl-float', mode === 'float');
    m.el.append(panelEl);
    anchor = { m, mode, table, restore };
    render();
  }

  function ensureAnchor() {
    if (signal.aborted) return;
    const table = document.querySelector(LIST_TABLE_SELECTOR);
    if (table) {
      if (!anchor || anchor.table !== table || !anchor.m.host.isConnected) mountAt(table);
      maybeAutoStart();
      return;
    }
    if (anchor && anchor.mode !== 'float') {
      // React replaced the table; keep the panel until a new one appears or we fall back.
      if (anchor.m.host.isConnected && anchor.table.isConnected) return;
      unanchor();
    }
    if (!anchor && !view.dismissed && Date.now() - mountedAt > ANCHOR_WAIT_MS) mountAt(null);
  }

  // ── Profile tracking ─────────────────────────────────────────────────────
  // The router keeps us mounted between two profiles' Lists tabs, so follow URL changes.

  function switchProfile(pid) {
    stopCheck();
    clearTimeout(autoTimer);
    seq++;
    profileId = pid;
    view = freshView(pid);
    render();
    if (pid) loadCached(pid, seq);
  }

  // The user's email off the profile header, read at call time (the query matches on email).
  const readEmail = () => readProfileIdentity({ onError: (e) => log.warn('could not read the profile header', e?.message || e) }).email;

  ctx.onUrlChange(() => {
    const pid = profileIdFromPath(location.pathname);
    if (pid !== profileId) switchProfile(pid);
    ensureAnchor();
  });
  const tick = setInterval(() => {
    ensureAnchor();
    if (view.lists && !run && ageKey() !== renderedAgeKey) render();   // keep the age chips current
  }, TICK_MS);
  // Floating fallback when the list table never shows up.
  const anchorFallback = setTimeout(ensureAnchor, ANCHOR_WAIT_MS + 50);

  // ── Cache ────────────────────────────────────────────────────────────────

  const maxAgeMs = () => clampInt(settings.cacheDays, 1, 60, 14) * DAY_MS;

  async function cacheRef(pid, { force = false } = {}) {
    await ctx.project.refresh({ force });
    const pk = ctx.project.current()?.key;
    if (!pk) return null;   // unknown project: never mix results across projects
    return { pk, name: cacheStateName(pk), hash: userHash(pk, pid) };
  }

  /** The project's cache record; moved from its pre-projectSlot name on first read. */
  const readCacheRecord = (ref) => getMigrated(ctx.state, ref.name, legacyCacheStateNames(ref.pk), null);

  async function loadCached(pid, mySeq) {
    let hit = null;
    try {
      const ref = await cacheRef(pid);
      if (ref) {
        const cache = await readCacheRecord(ref);
        hit = readCache(cache, ref.hash, { maxAgeMs: maxAgeMs() });
        if (!hit) {
          // Checks cached before the switch from SHA-256 keys (Chromium can still compute those).
          const old = await legacyUserHash(ref.pk, pid);
          if (old) hit = readCache(cache, old, { maxAgeMs: maxAgeMs() });
        }
      }
    } catch (e) {
      log.warn('could not read the cache', e?.message || e);
    }
    if (signal.aborted || mySeq !== seq) return;
    view.loading = false;
    if (hit && !run) {
      view.at = hit.at;
      view.lists = hit.lists;
    }
    render();
    maybeAutoStart();
  }

  async function saveCached(ref, lists) {
    try {
      if (!ref) return;
      const current = await readCacheRecord(ref);
      await ctx.state.set(ref.name, writeCache(current, ref.hash, lists, { maxAgeMs: maxAgeMs() }));
    } catch (e) {
      log.warn('could not save the cache', e?.message || e);
    }
  }

  // ── Check ────────────────────────────────────────────────────────────────

  function maybeAutoStart() {
    if (!settings.autoStart || view.autoTried || view.loading || view.lists || run || !profileId) return;
    if (!anchor || anchor.mode === 'float') return;   // wait for the page, as the script did
    view.autoTried = true;
    const mySeq = seq;
    autoTimer = setTimeout(() => { if (mySeq === seq) startCheck(); }, AUTOSTART_DELAY_MS);
  }

  function stopCheck() {
    if (!run) return;
    run.ac.abort();
    run = null;
    view.progress = null;
    render();
  }

  // One internal request with retry (429 / 5xx / network, backoff 1-2-4 s); throws CheckError.
  async function request(path, opts, runSignal) {
    const res = await sendWithRetry(async () => {
      try {
        return { ok: true, status: 200, data: await ctx.http.appFetch(path, { ...opts, signal: runSignal }) };
      } catch (e) {
        if (e?.name === 'AbortError' || runSignal.aborted) throw e;
        return toResponse(e);
      }
    }, {
      backoffs: BACKOFFS,
      signal: runSignal,
      onRetry: ({ attempt, retries, delayMs, status: st }) => log.info(`query failed (status ${st}); retry ${attempt} of ${retries} in ${delayMs} ms`),
    });
    if (!res.ok) throw new CheckError(res.status, failureMessage(res.status), res.fatal);
    return res.data;
  }

  async function startCheck() {
    if (run || signal.aborted) return;
    clearTimeout(autoTimer);
    // Never start for the previous profile, even if the URL change hasn't been handled yet.
    const urlPid = profileIdFromPath(location.pathname);
    if (urlPid !== profileId) switchProfile(urlPid);
    const pid = profileId;
    const mySeq = seq;
    if (!pid) return;
    const email = readEmail();
    if (!email) {
      view.error = "Couldn't read the user's email from the profile header. Has the page finished loading?";
      render();
      return;
    }
    // Results belong to the profile captured here; any later profile switch bumps `seq`.
    const same = () => !signal.aborted && mySeq === seq && profileIdFromPath(location.pathname) === pid;
    const ac = new AbortController();              // Stop, or one failed group (reason: CheckError)
    const runSignal = linkSignal(signal, ac.signal);   // ... or unmount
    const me = { ac, profileId: pid };
    run = me;
    view.error = null;
    view.progress = { resolved: 0, total: 0 };
    render();

    try {
      // Pin the project for the whole check (the cache is per project); re-checked at the end.
      const ref = await cacheRef(pid, { force: true }).catch(() => null);
      const details = await request(profileDetailsPath(pid), { method: 'GET' }, runSignal);
      // The header must still show the same user (SPA transitions can leave the old one briefly).
      if (!same() || readEmail() !== email) throw new DOMException('Profile changed', 'AbortError');
      const lists = dynamicListsFrom(details);
      log.info(`checking ${lists.length} dynamic lists`);
      if (!lists.length) {
        finish(me, () => { view.noDynamic = true; view.lists = []; view.at = Date.now(); });
        return;
      }
      view.progress = { resolved: 0, total: lists.length };
      render();
      const { found, queries } = await findMemberships(lists, {
        concurrency: clampInt(settings.batchSize, 1, 16, 8),
        signal: runSignal,
        test: async (ids) => {
          try {
            return isHit(await request(SEGMENT_QUERY_PATH, { method: 'POST', body: segmentQueryBody(ids, email) }, runSignal));
          } catch (e) {
            ac.abort(e);   // one failed group means no reliable answer: stop the other workers
            throw e;
          }
        },
        onProgress: ({ resolved, total }) => {
          if (run !== me) return;
          view.progress = { resolved, total };
          render();
        },
      });
      if (!same() || readEmail() !== email) throw new DOMException('Profile changed', 'AbortError');
      log.info(`check done: ${queries} queries`);
      const end = ref && await cacheRef(pid, { force: true }).catch(() => null);
      if (ref && end?.pk !== ref.pk) {
        finish(me, () => { view.error = 'The project changed during the check, so the result was discarded. Check again.'; });
        return;
      }
      const at = Date.now();
      finish(me, () => { view.noDynamic = false; view.lists = found; view.at = at; });
      saveCached(ref, found);
    } catch (e) {
      const err = e instanceof CheckError ? e : ac.signal.reason instanceof CheckError ? ac.signal.reason : e;
      if (err instanceof CheckError) {
        log.warn(`check failed (status ${err.status}${err.fatal ? ', stopped' : ''})`);
        finish(me, () => { view.error = err.message; });
      } else if (err?.name !== 'AbortError') {
        log.error('check failed', err?.message || err);
        finish(me, () => { view.error = 'The check failed unexpectedly. Try again.'; });
      } else {
        finish(me, () => {});
      }
    }

    function finish(r, apply) {
      if (run !== r) return;   // stopped, or superseded by a profile switch
      run = null;
      if (!same()) return;
      view.progress = null;
      apply();
      render();
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const ageKey = (now = Date.now()) => (view.at ? lastCheckedText(view.at, now) + '|' + ageLabel(view.at, now) : '');

  function render() {
    if (signal.aborted) return;
    const now = Date.now();
    renderedAgeKey = ageKey(now);
    const running = !!run;
    const p = view.progress;

    runBtn.textContent = running ? 'Stop' : 'Check now';
    runBtn.classList.toggle('ghost', running);
    runBtn.disabled = !profileId;

    if (running) {
      status.textContent = p?.total ? `Checking ${p.total} lists… ${p.resolved}/${p.total}` : 'Fetching lists…';
    } else if (view.loading) {
      status.textContent = 'Loading…';
    } else if (view.at) {
      status.textContent = lastCheckedText(view.at, now);
    } else {
      status.textContent = 'Not checked yet';
    }

    bar.hidden = !(running && settings.showProgressBar);
    barFill.style.width = p?.total ? `${Math.round((p.resolved / p.total) * 100)}%` : '0%';

    const rows = [];
    if (view.error) rows.push(h('div', { class: 'dl-note bad', role: 'alert' }, view.error));
    if (view.lists) {
      if (view.noDynamic) {
        rows.push(h('div', { class: 'dl-empty' }, 'This project has no dynamic lists.'));
      } else if (!view.lists.length) {
        rows.push(h('div', { class: 'dl-empty' }, 'Not in any dynamic lists.'));
      } else {
        const tone = ageTone(view.at, now);
        const age = ageLabel(view.at, now);
        rows.push(h('div', { class: 'dl-list' }, view.lists.map((l) => h('div', { class: 'dl-row' },
          h('a', { href: listUrl(l.id), target: '_blank', rel: 'noopener', title: `List ID ${l.id}` }, l.name),
          ui.chip(age, { tone })))));
      }
    } else if (!running && !view.loading && !view.error) {
      rows.push(h('div', { class: 'dl-empty' },
        settings.autoStart ? 'No cached result for this user.' : 'No cached result for this user. Check now queries Iterable for each group of lists.'));
    }
    append(clear(content), rows);

    // Floating fallback: allow closing it (it may sit over the page).
    if (anchor?.mode === 'float') {
      if (!panelEl.querySelector('.wb-x')) {
        panelEl.querySelector('.wb-ph').append(h('button', {
          type: 'button', class: 'wb-x', 'aria-label': 'Close', onClick: () => { view.dismissed = true; unanchor(); },
        }, '×'));
      }
    } else {
      panelEl.querySelector('.wb-ph .wb-x')?.remove();
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  const offSettings = ctx.onSettings((v) => {
    settings = v;
    render();
    maybeAutoStart();
  });
  const offAction = ctx.onAction('check', () => {
    if (!run) startCheck();
  });

  ctx.dom.onElement(LIST_TABLE_SELECTOR, () => ensureAnchor(), { signal });   // also runs it now
  render();
  if (profileId) loadCached(profileId, seq);

  return () => {
    clearInterval(tick);
    clearTimeout(anchorFallback);
    clearTimeout(autoTimer);
    offSettings?.();
    offAction?.();
    run?.ac.abort();
    run = null;
    unanchor();
  };
}
