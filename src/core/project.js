// Detect the Iterable project the current tab is showing (content, top frame).
// See ARCHITECTURE §5.2. The pure helpers at the top are unit-tested.

import { appFetch } from './http.js';
import { makeProjectKey } from './api-validation.js';
import { createLogger } from './log.js';

export const USER_CONTEXT_PATH = '/i/user/context';
const REFRESH_THROTTLE_MS = 30_000;

/**
 * Pull { id, name } out of whatever /i/user/context returns. The endpoint is undocumented, so a
 * few plausible envelope shapes are tolerated. Returns null when neither id nor name is present.
 * (Lifted from the Iterable User Push userscript.)
 */
export function parseProjectContext(data) {
  const p = (data && (data.project || data.currentProject || (data.user && data.user.project))) || null;
  let id = null, name = '';
  if (p && typeof p === 'object') {
    id = p.id != null ? p.id : (p.projectId != null ? p.projectId : null);
    name = p.name || p.projectName || '';
  }
  if (id == null && data && data.projectId != null) id = data.projectId;
  if (!name && data && data.projectName) name = data.projectName;
  if (id == null && !name) return null;
  return {
    id: id != null ? String(id) : null,
    name: String(name || ('project ' + id)),
  };
}

/** `app.eu.iterable.com` → 'eu', everything else → 'us'. */
export function dataCenterFromHost(hostname) {
  return /(^|\.)eu\.iterable\.com$/i.test(String(hostname || '')) ? 'eu' : 'us';
}

/**
 * Build a full project record from a /i/user/context response, or null. The key comes from
 * makeProjectKey (the vault's own builder), so a name the vault would reject never becomes a key.
 */
export function projectFromContext(data, hostname) {
  const parsed = parseProjectContext(data);
  if (!parsed) return null;
  const dataCenter = dataCenterFromHost(hostname);
  const key = makeProjectKey({ dataCenter, id: parsed.id, name: parsed.name });
  if (!key) return null;
  return { key, id: parsed.id, name: parsed.name, dataCenter };
}

/**
 * createProjectTracker({ fetchContext, hostname, now }) → { current, refresh, onChange, error }.
 * The default export below is the tracker used by content scripts.
 */
export function createProjectTracker({
  fetchContext = () => appFetch(USER_CONTEXT_PATH),
  hostname = () => location.hostname,
  now = Date.now,
} = {}) {
  const log = createLogger('project');
  const listeners = new Set();
  let current = null;
  let lastError = null;
  let lastAt = 0;
  let inflight = null;
  let loggedShape = false;

  async function doRefresh() {
    let next = null;
    try {
      const data = await fetchContext();
      next = projectFromContext(data, hostname());
      if (!next) {
        lastError = 'No project in the /i/user/context response';
        if (!loggedShape) {
          loggedShape = true;
          log.warn('no project id/name in context response; keys were',
            data && typeof data === 'object' ? Object.keys(data) : typeof data);
        }
      } else {
        lastError = null;
      }
    } catch (err) {
      lastError = err?.message || String(err);
      log.debug('project refresh failed:', lastError);
    }
    lastAt = now();
    // A failed refresh keeps the last known project rather than flapping to null.
    if (next && (!current || current.key !== next.key || current.name !== next.name)) {
      const prev = current;
      current = Object.freeze(next);
      for (const cb of listeners) {
        try { cb(current, prev); } catch (e) { log.error('project listener threw', e); }
      }
    }
    return current;
  }

  return {
    current: () => current,
    error: () => lastError,
    /** Throttled to once per 30 s unless force. Concurrent calls share one request. */
    refresh({ force = false } = {}) {
      if (inflight) return inflight;
      if (!force && current && now() - lastAt < REFRESH_THROTTLE_MS) return Promise.resolve(current);
      inflight = doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
