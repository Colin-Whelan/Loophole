// SPA URL watcher: mounts/unmounts features by route + enabled state. See ARCHITECTURE §5.4.
// matchRoute / routeTarget / isCatchAll are pure and also used by the popup.

import { on as onBridge, BRIDGE } from './bridge.js';
import { createLogger } from './log.js';
import { runsIn, isCompanionIn } from './feature-frames.js';

const POLL_MS = 500;
const CATCH_ALL = Object.freeze([/.*/]);

/** What routes are tested against: pathname + search. */
export function routeTarget(loc) {
  return (loc.pathname || '/') + (loc.search || '');
}

/** True when any of `routes` (RegExp, or string prefix) matches `target`. */
export function matchRoute(routes, target) {
  for (const r of routes || []) {
    if (r instanceof RegExp) {
      r.lastIndex = 0; // a /g or /y regex would otherwise carry state between calls
      if (r.test(target)) return true;
    } else if (typeof r === 'string' && target.startsWith(r)) {
      return true;
    }
  }
  return false;
}

/** A feature that is active on every page (e.g. routes: [/.*\/]). */
export function isCatchAll(meta) {
  return matchRoute(meta.routes, '/') && matchRoute(meta.routes, '/wb-probe/x?y=1');
}

/**
 * createRouter({ frame, metas, impls, makeCtx, loadSettings, subscribeSettings })
 *
 *   metas              feature metas (all frames; filtered by `frame`, companions included)
 *   impls              { [id]: { mount(ctx) } }
 *   makeCtx(meta, b)   builds the feature ctx from the router's base parts:
 *                      b = { signal, settings, onSettings(cb), onAction(id, cb),
 *                            holdMount() → release, onRouteActive(cb), onUrlChange(cb) }
 *   loadSettings()     → Promise<resolved settings>        (core/settings.js load)
 *   subscribeSettings(cb) → unsubscribe                     (core/settings.js subscribe)
 */
export function createRouter({ frame, metas, impls, makeCtx, loadSettings, subscribeSettings, getLocation = () => location }) {
  const log = createLogger(`router:${frame}`);
  // Home-frame features, plus companions (meta.companionFrames) of features homed elsewhere.
  const features = metas.filter((m) => runsIn(m, frame));
  // A companion's routes belong to its home frame; here it mounts whenever the feature is enabled.
  const routesOf = (meta) => (isCompanionIn(meta, frame) ? CATCH_ALL : meta.routes);
  const records = new Map(); // id → { controller, cleanup, values, valuesJson, listeners, actions }
  // id → target it failed on. Not retried on that target until the URL changes (even back to the
  // same target) or that feature's settings / enabled state change.
  const failed = new Map();
  const urlListeners = new Set();
  let settings = null;
  let lastHref = null;
  let queue = Promise.resolve();
  let started = false;

  function schedule() {
    queue = queue.then(reconcile).catch((e) => log.error('reconcile failed', e));
    return queue;
  }

  async function reconcile() {
    if (!settings) return;
    const target = routeTarget(getLocation());
    for (const meta of features) {
      const s = settings.features[meta.id];
      const enabled = !!s?.enabled;
      const want = enabled && matchRoute(routesOf(meta), target);
      const rec = records.get(meta.id);
      if (!want) {
        if (!rec) continue;
        if (rec.holds.size) {
          // Held (e.g. a run in flight): keep it mounted but tell it the route is inactive. It
          // is unmounted when the last hold is released, unless the route matches again by then.
          if (!enabled && !rec.disabledWhileHeld) {
            rec.disabledWhileHeld = true;
            log.info(`${meta.id} was disabled while busy; unmounting once it finishes`);
          }
          if (s) pushValues(rec, s.values);
          setActive(meta.id, rec, false);
          continue;
        }
        unmount(meta.id);
        continue;
      }
      if (rec) {
        rec.disabledWhileHeld = false;
        pushValues(rec, s.values);
        setActive(meta.id, rec, true);
        continue;
      }
      if (failed.get(meta.id) === target) continue;
      // Not awaited: the record exists synchronously, so a slow async mount never holds up the
      // rest (an unmount mid-mount aborts ctx.signal and runs its cleanup when it resolves).
      mount(meta, s.values, target);
    }
  }

  function setActive(id, rec, active) {
    if (rec.active === active) return;
    rec.active = active;
    log.debug(`${id} route ${active ? 'active' : 'inactive (held)'}`);
    for (const cb of rec.routeListeners) {
      try { cb(active); } catch (e) { log.error('onRouteActive listener threw', e); }
    }
  }

  async function mount(meta, values, target) {
    const impl = impls[meta.id];
    if (!impl || typeof impl.mount !== 'function') {
      log.warn(`no implementation for ${meta.id}`);
      failed.set(meta.id, target);
      return;
    }
    const controller = new AbortController();
    const rec = {
      controller,
      cleanup: null,
      values: freeze(values),
      valuesJson: JSON.stringify(values),
      listeners: new Set(),
      actions: new Map(),
      holds: new Set(),
      routeListeners: new Set(),
      active: true,
      disabledWhileHeld: false,
    };
    records.set(meta.id, rec);
    const base = {
      signal: controller.signal,
      settings: rec.values,
      onSettings(cb) { rec.listeners.add(cb); return () => rec.listeners.delete(cb); },
      onAction(id, cb) { rec.actions.set(id, cb); return () => rec.actions.delete(id); },
      onRouteActive(cb) { rec.routeListeners.add(cb); return () => rec.routeListeners.delete(cb); },
      // cb(href) on every URL change (path, search or hash) while mounted; dropped on unmount.
      onUrlChange(cb) {
        if (controller.signal.aborted) return () => {};
        const fn = (href) => { if (!controller.signal.aborted) cb(href); };
        urlListeners.add(fn);
        const off = () => { urlListeners.delete(fn); controller.signal.removeEventListener('abort', off); };
        controller.signal.addEventListener('abort', off);
        return off;
      },
      holdMount() {
        if (controller.signal.aborted) return () => {};
        const token = {};
        rec.holds.add(token);
        return () => {
          if (!rec.holds.delete(token) || rec.holds.size || records.get(meta.id) !== rec) return;
          if (rec.disabledWhileHeld) log.info(`${meta.id} finished; unmounting (disabled while busy)`);
          schedule();
        };
      },
    };
    try {
      const ctx = makeCtx(meta, base);
      const cleanup = await impl.mount(ctx);
      if (controller.signal.aborted) {
        // Unmounted while an async mount was still running.
        runCleanup(meta.id, cleanup);
        return;
      }
      rec.cleanup = typeof cleanup === 'function' ? cleanup : null;
      failed.delete(meta.id);
      log.debug(`mounted ${meta.id}`);
    } catch (e) {
      log.error(`${meta.id} failed to mount on ${target}`, e);
      controller.abort();
      if (records.get(meta.id) === rec) records.delete(meta.id);
      failed.set(meta.id, target);
    }
  }

  function unmount(id) {
    const rec = records.get(id);
    if (!rec) return;
    records.delete(id);
    rec.controller.abort();
    runCleanup(id, rec.cleanup);
    log.debug(`unmounted ${id}`);
  }

  function runCleanup(id, cleanup) {
    if (typeof cleanup !== 'function') return;
    try { cleanup(); } catch (e) { log.error(`${id} cleanup threw`, e); }
  }

  function pushValues(rec, values) {
    const json = JSON.stringify(values);
    if (json === rec.valuesJson) return;
    rec.valuesJson = json;
    rec.values = freeze(values);
    for (const cb of rec.listeners) {
      try { cb(rec.values); } catch (e) { log.error('onSettings listener threw', e); }
    }
  }

  function checkUrl() {
    const href = getLocation().href;
    if (href === lastHref) return;
    lastHref = href;
    failed.clear();
    for (const cb of urlListeners) {
      try { cb(href); } catch (e) { log.error('url listener threw', e); }
    }
    schedule();
  }

  return {
    async start() {
      if (started) return;
      started = true;
      settings = await loadSettings();
      subscribeSettings((next) => {
        for (const id of [...failed.keys()]) {
          if (JSON.stringify(settings?.features?.[id]) !== JSON.stringify(next?.features?.[id])) failed.delete(id);
        }
        settings = next;
        schedule();
      });
      onBridge(BRIDGE.LOCATION, checkUrl);
      window.addEventListener('popstate', checkUrl);
      window.addEventListener('hashchange', checkUrl);
      setInterval(checkUrl, POLL_MS); // fallback for navigations we don't hear about
      checkUrl();
      return queue;
    },
    /** Ids of currently mounted features. */
    mounted: () => [...records.keys()],
    /** Run a popup action on a mounted feature. Returns false when nothing handled it. */
    dispatchAction(featureId, action) {
      const rec = records.get(featureId);
      const cb = rec?.actions.get(action);
      if (!cb) return false;
      try { cb(); } catch (e) { log.error(`${featureId} action ${action} threw`, e); }
      return true;
    },
    /**
     * Like dispatchAction, with a payload and a result: → undefined when the feature isn't
     * mounted or has no such action, else Promise<result> (cb(payload) may return a promise).
     */
    requestAction(featureId, action, payload) {
      const cb = records.get(featureId)?.actions.get(action);
      if (!cb) return undefined;
      return Promise.resolve().then(() => cb(payload));
    },
    onUrlChange(cb) {
      urlListeners.add(cb);
      return () => urlListeners.delete(cb);
    },
    /** Unmounts everything, holds included (the content script is going away). */
    unmountAll() {
      for (const id of [...records.keys()]) unmount(id);
    },
  };
}

function freeze(values) {
  return deepFreeze(JSON.parse(JSON.stringify(values ?? {})));
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
