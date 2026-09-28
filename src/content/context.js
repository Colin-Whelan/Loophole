// Builds the `ctx` object each feature's mount(ctx) receives (ARCHITECTURE §8.2).
// The router supplies the lifecycle parts (signal, settings, onSettings, onAction); this adds
// the shared services.

import { API_ERROR } from '../core/messages.js';
import { createState } from '../core/state.js';
import { updateFeatureValues } from '../core/settings.js';
import * as http from '../core/http.js';
import * as dom from '../core/dom.js';
import { apiRequest, keyStatus, openOptions, onKeysChanged } from '../core/api.js';
import { createLogger } from '../core/log.js';
import * as shadow from '../ui/shadow.js';
import * as components from '../ui/components.js';
import { inertFrames } from '../core/frames.js';
import { unavailablePage } from '../core/page-rpc.js';

const ui = Object.freeze({ ...shadow, ...components });

/** ctx.api where the background refuses API access (bee and auth frames): answer locally. */
function noApi(where) {
  return Object.freeze({
    request: () => Promise.resolve({
      ok: false, status: 0,
      error: { code: API_ERROR.BAD_REQUEST, message: `API calls are not available ${where}.` },
    }),
    keyStatus: () => Promise.resolve({ hasKey: false, masked: '', name: '' }),
    onKeysChanged: () => () => {},
  });
}
const beeApi = noApi('inside the drag-and-drop editor frame');
const authApi = noApi('on the sign-in page');

/**
 * makeContext(meta, base, { project, frame, frames, page })
 *   base     from the router: { signal, settings, onSettings, onAction, holdMount, onRouteActive,
 *            onUrlChange }
 *   project  core/project.js tracker (top frame) or null (bee / auth frames)
 *   frame    'top' | 'bee' | 'auth'. Bee and auth frames may only open the options page
 *            (background policy); they get no API access.
 *   frames   core/frames.js hub (createTopHub / createBeeHub) or null → ctx.frames (§6.2)
 *   page     core/page-rpc.js hub (createPageHub) or null → ctx.page (§6.3)
 */
export function makeContext(meta, base, { project = null, frame = 'top', frames = null, page = null } = {}) {
  const currentKey = () => project?.current()?.key || null;

  // The background refuses API and key-status requests from app.getbee.io frames by design;
  // answer locally with a clear error instead of a round trip.
  const api = frame === 'bee' ? beeApi : frame === 'auth' ? authApi : Object.freeze({
    /** wb:api, bound to the current project unless opts.projectKey is given. Never rejects. */
    request(opts = {}) {
      const projectKey = opts.projectKey || currentKey();
      if (!projectKey) {
        return Promise.resolve({
          ok: false, status: 0,
          error: { code: API_ERROR.NO_KEY, message: 'No Iterable project detected on this page yet.' },
        });
      }
      return apiRequest({ ...opts, projectKey });
    },
    /** Masked key status → { hasKey, masked, name }. Defaults to the current project. */
    keyStatus(projectKey) {
      const pk = projectKey || currentKey();
      if (!pk) return Promise.resolve({ hasKey: false, masked: '', name: '' });
      return keyStatus(pk);
    },
    /**
     * cb() after any change to the saved keys (added, replaced, removed, tested), in any project.
     * Carries no details: call keyStatus() again. Unsubscribes on unmount; returns unsubscribe.
     */
    onKeysChanged: (cb) => onKeysChanged(cb, base.signal),
  });

  return Object.freeze({
    featureId: meta.id,
    meta,
    settings: base.settings,
    onSettings: base.onSettings,
    signal: base.signal,
    project,
    frame,
    api,
    // Frame channel between this feature's top and bee halves (§6.2). Page-visible: no secrets.
    frames: frames ? frames.forFeature(meta, base.signal) : inertFrames(meta),
    // Page-world RPC to this feature's main.js (§6.3). Results are untrusted page data.
    page: page ? page.forFeature(meta.id, base.signal) : unavailablePage(),
    http,
    ui,
    dom,
    state: createState(meta.id),
    log: createLogger(meta.id),
    // Default: this feature's settings. (#feature/<id> and #feature?id=<id> both work in the
    // options page; the background only accepts plain section names, hence the params form.)
    openOptions: (section, params) => (section ? openOptions(section, params) : openOptions('feature', { id: meta.id })),
    onAction: base.onAction,
    // Keep this feature mounted while busy even if its routes stop matching (ARCHITECTURE §5.4).
    holdMount: base.holdMount,
    onRouteActive: base.onRouteActive,
    // cb(href) after every SPA URL change (pushState/replaceState, back/forward, search or hash
    // only) while mounted. Returns unsubscribe; dropped automatically on unmount.
    onUrlChange: base.onUrlChange,
    /**
     * Merge a patch into this feature's stored values (as the options page's save does). `patch`
     * may be `(latestValues) => patch | null`, computed from the values read inside the same
     * read-modify-write; null skips the write. An `undefined` value deletes that key (back to the
     * default). Resolves this feature's resolved values; rejects if storage fails.
     */
    saveSettings: (patch) => updateFeatureValues(meta.id, patch).then((s) => s.features[meta.id]?.values),
  });
}
