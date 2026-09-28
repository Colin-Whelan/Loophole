// Pure helpers for the dynamic-lists feature. No DOM, no chrome.*: unit-tested in Node
// (test/features/dynamic-lists*.test.js). Endpoints, query shape and the group-OR search are
// lifted from the "Iterable Dynamic Lists Checker" userscript (v2.1.0).

import { projectSlot } from '../../core/state.js';
import { stableHash64 } from '../../core/hash.js';

export const GROUP_SIZE = 30;          // lists per first-level Or query (script: CONFIG.GROUP_SIZE)
export const SEGMENT_QUERY_PATH = '/lists/segmentUsersQuery';
export const MAX_CACHED_USERS = 200;   // per project; oldest checks are dropped first
export const MAX_RETRY_AFTER_MS = 60 * 1000;   // a longer server Retry-After is capped (Stop still works)

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** GET endpoint listing the project's lists for this profile (the segment is reused as-is). */
export function profileDetailsPath(profileId) {
  return `/users/profiles/${profileId}/getProfileDetails`;
}

/**
 * The dynamic lists out of a getProfileDetails response ({ userLists: [...] }), in response order.
 * → [{ id, name }]. Entries without an id are dropped; ids are kept as strings.
 */
export function dynamicListsFrom(details) {
  const all = details && typeof details === 'object' && Array.isArray(details.userLists) ? details.userLists : [];
  const out = [];
  const seen = new Set();
  for (const l of all) {
    if (!l || typeof l !== 'object' || l.emailListType !== 'Dynamic') continue;
    const id = l.id == null ? '' : String(l.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof l.name === 'string' && l.name.trim() ? l.name.trim() : `List ${id}` });
  }
  return out;
}

/**
 * POST /lists/segmentUsersQuery body: "is the user with this email in ANY of these lists?"
 * (count > 0). Same shape the userscript sent.
 */
export function segmentQueryBody(listIds, email) {
  const listCriteria = listIds.map((id) => ({
    dataType: 'user',
    searchCombo: {
      combinator: 'And',
      searchQueries: [{
        value: String(id), dataType: 'user', field: 'userListIds', comparatorType: 'Equals', fieldType: 'long',
      }],
    },
  }));
  return {
    page: 1,
    pageSize: 1,
    searchQuery: {
      combinator: 'And',
      searchQueries: [
        { combinator: 'Or', searchQueries: listCriteria },
        {
          combinator: 'And',
          searchQueries: [{
            dataType: 'user',
            searchCombo: {
              combinator: 'And',
              searchQueries: [{
                value: email, dataType: 'user', field: 'email', comparatorType: 'Equals', fieldType: 'string',
              }],
            },
          }],
        },
      ],
    },
    sorting: 'desc',
  };
}

/** segmentUsersQuery response → did it match anyone? */
export function isHit(data) {
  return (Number(data && typeof data === 'object' ? data.count : 0) || 0) > 0;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** Run fn over items with at most `limit` in flight. Stops taking new items once signal aborts. */
export async function mapLimit(items, limit, fn, signal) {
  const queue = [...items];
  const n = Math.max(1, Math.min(queue.length, Math.floor(limit) || 1));
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      if (signal?.aborted) throw abortError(signal);
      await fn(queue.shift());
    }
  });
  await Promise.all(workers);
}

/**
 * Group testing, as in the userscript: query groups of `groupSize` lists with one Or query each;
 * drop negative groups, split positive ones in half and re-test, until single lists remain.
 *   test(ids) → Promise<boolean>   true if the user is in ANY of the ids (throws on failure: a
 *                                  silent false would wrongly clear a whole group)
 *   onProgress({ resolved, total, queries })
 * → { found: [list] in the input order, queries }
 */
export async function findMemberships(lists, { test, concurrency = 8, groupSize = GROUP_SIZE, onProgress, signal } = {}) {
  const total = lists.length;
  let resolved = 0;
  let queries = 0;
  const found = [];
  let groups = [];
  for (let i = 0; i < total; i += groupSize) groups.push(lists.slice(i, i + groupSize));

  while (groups.length) {
    const next = [];
    await mapLimit(groups, concurrency, async (group) => {
      const hit = await test(group.map((l) => l.id));
      if (signal?.aborted) throw abortError(signal);
      queries++;
      if (!hit) {
        resolved += group.length;
      } else if (group.length === 1) {
        found.push(group[0]);
        resolved++;
      } else {
        const mid = Math.ceil(group.length / 2);
        next.push(group.slice(0, mid), group.slice(mid));
      }
      onProgress?.({ resolved, total, queries });
    }, signal);
    groups = next;
  }

  const order = new Map(lists.map((l, i) => [l.id, i]));
  found.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { found, queries };
}

// ── Age display ──────────────────────────────────────────────────────────

/** Compact age for a chip: "now", "12 min", "5 h", "1 day", "3 days". */
export function ageLabel(at, now = Date.now()) {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return 'now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h`;
  const d = Math.floor(age / DAY);
  return d === 1 ? '1 day' : `${d} days`;
}

/** "Checked just now" / "Last checked 3 days ago". */
export function lastCheckedText(at, now = Date.now()) {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return 'Checked just now';
  const [n, unit] = age < HOUR ? [Math.floor(age / MINUTE), 'minute']
    : age < DAY ? [Math.floor(age / HOUR), 'hour'] : [Math.floor(age / DAY), 'day'];
  return `Last checked ${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * Chip tone by age. The script used five colours (green <1 h, light green <1 day, yellow <3 days,
 * orange <1 week, red older); the Loophole chips have three tones: ok <1 day, warn <1 week, bad.
 */
export function ageTone(at, now = Date.now()) {
  const age = Math.max(0, now - at);
  if (age < DAY) return 'ok';
  if (age < 7 * DAY) return 'warn';
  return 'bad';
}

/** Where a list opens (relative, so the EU app works too; the script hard-coded app.iterable.com). */
export function listUrl(id) {
  return `/segmentation?emailListId=${encodeURIComponent(id)}`;
}

// ── Cache ────────────────────────────────────────────────────────────────
// One ctx.state entry per project: cache:<projectSlot> = { v: 1, users: { [userHash]: { at, lists } } }.
// The user part of the key is a hash of the profile id, so no id or email ends up in storage keys.

/** State name for a project's cache: `cache:<projectSlot>` (core/state.js). '' for no project. */
export function cacheStateName(projectKey) {
  const slot = projectSlot(projectKey);
  return slot ? 'cache:' + slot : '';
}

/** Names the cache had before projectSlot (read once, then moved; see getMigrated). */
export function legacyCacheStateNames(projectKey) {
  if (typeof projectKey !== 'string' || !projectKey) return [];
  return [('cache:' + projectKey).replace(/[^A-Za-z0-9_.:|-]/g, '_').slice(0, 128)];
}

/**
 * The per-user key inside a project's cache: 64-bit FNV-1a (core/hash.js) of
 * `<projectKey>\n<profileId>`, 16 hex digits. Synchronous pure JS: the SHA-256 this used to be
 * can't be read from crypto.subtle's result in Firefox content scripts.
 */
export function userHash(projectKey, profileId) {
  return stableHash64(`${projectKey}\n${profileId}`);
}

/**
 * The key older versions used (first 16 hex of SHA-256 of the same text), for a read fallback
 * so cached checks survive the switch. null when it can't be computed (Firefox content scripts,
 * no crypto.subtle): the check then simply runs again.
 */
export async function legacyUserHash(projectKey, profileId) {
  try {
    const bytes = new TextEncoder().encode(`${projectKey}\n${profileId}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < 8; i++) out += view[i].toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

function normaliseLists(lists) {
  if (!Array.isArray(lists)) return null;
  const out = [];
  for (const l of lists) {
    if (!l || typeof l !== 'object') continue;
    const id = l.id == null ? '' : String(l.id);
    if (!id) continue;
    out.push({ id, name: typeof l.name === 'string' ? l.name : `List ${id}` });
  }
  return out;
}

/** A cached check for this user, or null when missing, malformed, or older than maxAgeMs. */
export function readCache(cache, hash, { now = Date.now(), maxAgeMs } = {}) {
  const e = cache && typeof cache === 'object' && cache.users && typeof cache.users === 'object'
    ? cache.users[hash] : null;
  if (!e || typeof e !== 'object' || !Object.prototype.hasOwnProperty.call(cache.users, hash)) return null;
  const at = Number(e.at);
  const lists = normaliseLists(e.lists);
  if (!Number.isFinite(at) || !lists) return null;
  if (maxAgeMs > 0 && now - at > maxAgeMs) return null;
  return { at, lists };
}

/**
 * The cache with this user's result stored, expired entries dropped and at most `maxUsers` kept
 * (newest first). Returns a new object; `cache` may be anything (it is validated).
 */
export function writeCache(cache, hash, lists, { now = Date.now(), maxAgeMs, maxUsers = MAX_CACHED_USERS } = {}) {
  const users = new Map();
  const src = cache && typeof cache === 'object' && cache.users && typeof cache.users === 'object' ? cache.users : {};
  for (const [k, e] of Object.entries(src)) {
    if (k === hash || !/^[0-9a-f]{16}$/.test(k)) continue;
    const at = Number(e?.at);
    const l = normaliseLists(e?.lists);
    if (!Number.isFinite(at) || !l) continue;
    if (maxAgeMs > 0 && now - at > maxAgeMs) continue;
    users.set(k, { at, lists: l });
  }
  users.set(hash, { at: now, lists: normaliseLists(lists) || [] });
  const kept = [...users.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, maxUsers);
  return { v: 1, users: Object.fromEntries(kept) };
}

// ── Settings ─────────────────────────────────────────────────────────────

export function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Errors: HttpError from appFetch → { status, retryAfterMs? } for sendWithRetry, which waits at
 * least the server's Retry-After before retrying.
 */
export function toResponse(err) {
  const status = Number.isInteger(err?.status) ? err.status : 0;
  const out = {
    ok: false,
    status,
    error: { code: status ? 'HTTP' : 'NETWORK', message: err?.message || (status ? `HTTP ${status}` : 'Network error') },
  };
  const ra = Number(err?.retryAfterMs);
  if (ra > 0) out.retryAfterMs = Math.min(ra, MAX_RETRY_AFTER_MS);
  return out;
}

/** User-facing text for a failed check. */
export function failureMessage(status) {
  if (status === 401 || status === 403) {
    return `Iterable refused the request (HTTP ${status}). Your session may have expired, or your role can't query lists. Reload the page, sign in again, and retry.`;
  }
  if (status === 429) return 'Iterable is rate limiting these queries (HTTP 429). Wait a minute, or lower "Concurrent queries" in the settings, then try again.';
  if (status >= 500) return `Iterable returned a server error (HTTP ${status}). Try again in a moment.`;
  if (status === 404) return "Iterable couldn't find this profile's lists (HTTP 404).";
  if (status) return `The check failed (HTTP ${status}).`;
  return 'The check failed: network error. Check your connection and try again.';
}
