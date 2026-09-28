// Where a feature runs, and the optional-permission rules for features that need an optional host.
// Pure: no chrome.*, no DOM. Used by the router, the content entries, the background, extension
// pages, scripts/build.mjs (validation) and tests. Contract: ARCHITECTURE §4, §6.2, §8.1, §9.
//
// meta.frame            home frame: 'top' (default) | 'bee' | 'auth'. Popup actions and the
//                       "where" chips refer to it; routes are matched there.
// meta.companionFrames  optional, e.g. ['bee']: the feature also runs in those frames, from
//                       src/features/<id>/<frame>.js (mount(ctx), same ctx shape). A companion
//                       mounts whenever the feature is enabled (routes apply to the home frame
//                       only: the frame's own URL means nothing to Iterable routes). Use ctx.frames
//                       to talk between the halves.
// meta.permissions      optional { origins: ['https://host/*'] }: optional host permissions the
//                       feature needs. Each must be listed in manifest optional_host_permissions.
//                       Required for frame 'auth' (its content script is registered at runtime for
//                       the granted origins, never listed in the static manifest).
// meta.frameMessages    optional frame-channel schemas (core/frames.js compileFrameMessages).

export const FRAMES = Object.freeze(['top', 'bee', 'auth']);
/** Frames a companion may run in. 'auth' has no companions and can't be one. */
export const COMPANION_FRAMES = Object.freeze(['top', 'bee']);

/** Registered content script for frame:'auth' features (background/index.js syncs it). */
export const AUTH_SCRIPT_ID = 'wb-auth';
export const AUTH_SCRIPT_FILE = 'content-auth.js';

const ORIGIN_PATTERN_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\/\*$/;
const FEATURE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function homeFrame(meta) {
  return meta?.frame || 'top';
}

export function companionFrames(meta) {
  return Array.isArray(meta?.companionFrames) ? meta.companionFrames : [];
}

/** Does this feature run (home or companion) in `frame`? */
export function runsIn(meta, frame) {
  return homeFrame(meta) === frame || companionFrames(meta).includes(frame);
}

export function isCompanionIn(meta, frame) {
  return homeFrame(meta) !== frame && companionFrames(meta).includes(frame);
}

/** Optional host permission patterns the feature declares ([] when none). */
export function featureOrigins(meta) {
  const o = meta?.permissions?.origins;
  return Array.isArray(o) ? o.filter((x) => typeof x === 'string') : [];
}

export function needsOptionalAccess(meta) {
  return featureOrigins(meta).length > 0;
}

/** 'https://auth.iterable.com/*' → 'https://auth.iterable.com' (null for anything else). */
export function patternOrigin(pattern) {
  if (typeof pattern !== 'string' || !ORIGIN_PATTERN_RE.test(pattern)) return null;
  return pattern.slice(0, -2);
}

/** Does `origin` (location.origin) fall under one of the feature's declared origins? */
export function featureMatchesOrigin(meta, origin) {
  return featureOrigins(meta).some((p) => patternOrigin(p) === origin);
}

/**
 * Validate every meta's frame fields. `files(id)` → Set of file names in src/features/<id>/.
 * `optionalOrigins` = manifest optional_host_permissions. Returns an array of error strings.
 */
export function validateFrameMetas(metas, { files = () => new Set(), optionalOrigins = [], requiredOrigins = [] } = {}) {
  const errors = [];
  for (const meta of metas) {
    const id = meta?.id;
    const where = `Feature "${id}"`;
    if (typeof id !== 'string' || !FEATURE_ID_RE.test(id)) { errors.push(`${where}: id is not kebab-case`); continue; }
    const home = homeFrame(meta);
    if (!FRAMES.includes(home)) errors.push(`${where} has unknown frame "${meta.frame}"`);
    const comps = meta.companionFrames;
    if (comps !== undefined) {
      if (!Array.isArray(comps)) errors.push(`${where}: companionFrames must be an array`);
      else {
        if (home === 'auth' && comps.length) errors.push(`${where}: frame 'auth' features can't have companion frames`);
        for (const f of comps) {
          if (!COMPANION_FRAMES.includes(f)) errors.push(`${where}: companion frame "${f}" (expected ${COMPANION_FRAMES.join(' | ')})`);
          else if (f === home) errors.push(`${where}: companion frame "${f}" is its home frame`);
          else if (!files(id).has(`${f}.js`)) errors.push(`${where} runs in "${f}" but has no src/features/${id}/${f}.js`);
        }
        if (new Set(comps).size !== comps.length) errors.push(`${where}: duplicate companion frames`);
      }
    }
    if (meta.permissions !== undefined) {
      const p = meta.permissions;
      if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push(`${where}: permissions must be { origins: [...] }`);
      else {
        for (const k of Object.keys(p)) if (k !== 'origins') errors.push(`${where}: permissions.${k} is not supported (only origins)`);
        if (!Array.isArray(p.origins) || !p.origins.length) errors.push(`${where}: permissions.origins must be a non-empty array`);
        else {
          for (const o of p.origins) {
            if (!patternOrigin(o)) errors.push(`${where}: permission origin "${o}" must look like https://host.example/*`);
            else if (!optionalOrigins.includes(o)) errors.push(`${where}: permission origin "${o}" is not in manifest optional_host_permissions`);
            else if (requiredOrigins.includes(o)) errors.push(`${where}: permission origin "${o}" is already a required host permission`);
          }
        }
      }
    }
    if (home === 'auth' && !needsOptionalAccess(meta)) errors.push(`${where}: frame 'auth' needs permissions.origins (the hosts its content script runs on)`);
    if (home === 'auth' && files(id).has('main.js')) errors.push(`${where}: page-world handlers (main.js) aren't supported in frame 'auth'`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Optional-permission sync (background) and UI helpers
// ---------------------------------------------------------------------------

/**
 * The content scripts that should be registered right now: one 'wb-auth' script for the union of
 * the origins of enabled frame:'auth' features whose origins are granted. `granted` is a Set of
 * origin patterns (each checked with chrome.permissions.contains). `settings` = resolved settings.
 */
export function desiredAuthScripts({ metas, settings, granted }) {
  const matches = new Set();
  for (const meta of metas) {
    if (homeFrame(meta) !== 'auth' || !settings?.features?.[meta.id]?.enabled) continue;
    for (const o of featureOrigins(meta)) if (granted.has(o)) matches.add(o);
  }
  if (!matches.size) return [];
  return [{
    id: AUTH_SCRIPT_ID,
    js: [AUTH_SCRIPT_FILE],
    matches: [...matches].sort(),
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }];
}

/**
 * Diff registered scripts against the desired set. Only ids starting with 'wb-' are ours to touch.
 * → { unregister: [id], register: [script] } (a changed script is unregistered and re-registered).
 */
export function planScriptSync(current, desired) {
  const ours = (current || []).filter((s) => typeof s?.id === 'string' && s.id.startsWith('wb-'));
  const want = new Map(desired.map((s) => [s.id, s]));
  const unregister = [];
  const register = [];
  const same = (a, b) => {
    const norm = (x) => JSON.stringify({
      js: x.js || [], matches: [...(x.matches || [])].sort(), runAt: x.runAt || 'document_idle', allFrames: !!x.allFrames,
    });
    return norm(a) === norm(b);
  };
  const have = new Map(ours.map((s) => [s.id, s]));
  for (const s of ours) {
    const d = want.get(s.id);
    if (!d || !same(s, d)) unregister.push(s.id);
  }
  for (const d of desired) {
    const s = have.get(d.id);
    if (!s || !same(s, d)) register.push(d);
  }
  return { unregister, register };
}

/**
 * Optional origins that no enabled feature needs any more (after `settings`): offered for removal
 * when a feature that needed them is switched off. Only origins declared by some feature.
 */
export function unneededOrigins({ metas, settings, candidates }) {
  const needed = new Set();
  for (const meta of metas) {
    if (settings?.features?.[meta.id]?.enabled) for (const o of featureOrigins(meta)) needed.add(o);
  }
  return [...new Set(candidates)].filter((o) => !needed.has(o));
}
