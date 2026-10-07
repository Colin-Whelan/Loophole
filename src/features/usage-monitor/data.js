// Usage monitor: the two requests and the stored state around them. No DOM: the popup, the
// options editor and the background read the same state through these helpers.
//
// State (wb:state:usage-monitor:*), all per org (logic.js orgSlot):
//   orgs              { [orgSlot]: { host, projectIds, projectNames, updatedAt } }  index
//   snap:<orgSlot>    logic.js buildSnapshot()
//   alerts:<orgSlot>  logic.js alert state
//   check:<slot>      once-a-day gate + lock (orgSlot, or unknownSlot before the first check)
//   access            { [host]: { denied, at } }  this login can't read usage (401/403)

import {
  LIMITS_PATH, FALLBACK_DAYS, limitsBody, usagePath, parseLimits, parseUsage, contractTerm, buildSnapshot,
  addDays, findOrgSlot, orgSlot, REQUEST_TIMEOUT_MS, withDefaultLimits, monthBounds, monthUsagePath, DEFAULT_MONTHLY,
} from './logic.js';
import { linkSignal } from '../../core/dom.js';

/**
 * Fetch limits + usage and build a snapshot. `http` is ctx.http. Throws the HttpError of a failed
 * limits request (a 401/403 there means this login can't see usage); a failed term-range usage
 * request is retried once over the last 30 days, flow limits then marked unavailable.
 */
export async function fetchSnapshot(http, { today, now, host, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  // Each request gets its own timeout, linked to the caller's signal.
  const timed = () => {
    const t = AbortSignal.timeout(timeoutMs);
    return signal ? linkSignal(signal, t) : t;
  };
  const limitsData = await http.appFetch(LIMITS_PATH, { method: 'POST', body: limitsBody(), signal: timed() });
  const limits = parseLimits(limitsData, today);
  const term = contractTerm(limits, limitsData, today);
  let query = term ? { start: term.start, end: term.end, partial: false } : null;
  let usageData = null;
  if (query) {
    try {
      usageData = await http.appFetch(usagePath(query.start, query.end), { signal: timed() });
    } catch (e) {
      if (signal?.aborted) throw e;
      usageData = null;
    }
  }
  if (!usageData) {
    query = { start: addDays(today, -(FALLBACK_DAYS - 1)), end: today, partial: true };
    usageData = await http.appFetch(usagePath(query.start, query.end), { signal: timed() });
  }
  // Default monthly allowances (journey events): month-to-date usage in a third request. If it
  // fails, only those rows are unavailable.
  const all = withDefaultLimits(limits, today);
  const monthly = all.filter((l) => l.period === 'month');
  let month = null;
  if (monthly.length) {
    const { start, end } = monthBounds(today);
    const groups = [...new Set(monthly.map((l) => DEFAULT_MONTHLY[l.metric]?.group).filter(Boolean))];
    let usage = null;
    try {
      usage = parseUsage(await http.appFetch(monthUsagePath(start, end, groups), { signal: timed() }));
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    month = { start, end, usage };
  }
  return buildSnapshot({ limits: all, usage: parseUsage(usageData), query, term, today, now, host, month });
}

/**
 * Stored org index entry for a fresh snapshot (project names stay in this browser only). The slot
 * comes from the response's projects; the project the check ran from is added to the entry's ids
 * even when the response didn't list it, so the next page load from that project finds this org
 * (and its check gate) instead of checking again.
 */
export function orgEntry(snap, fallbackProjectId) {
  const ids = snap.projects.map((p) => p.id);
  if (!ids.length && fallbackProjectId != null) ids.push(String(fallbackProjectId));
  const known = fallbackProjectId != null && !ids.includes(String(fallbackProjectId))
    ? [...ids, String(fallbackProjectId)] : ids;
  return {
    slot: orgSlot(snap.host, ids),
    entry: {
      host: snap.host, projectIds: known,
      projectNames: snap.projects.slice(0, 50).map((p) => p.name), updatedAt: snap.at,
    },
  };
}

/** Save a snapshot: snap:<slot>, the org index and the slot's check gate. → slot */
export async function saveSnapshot(state, snap, { fallbackProjectId, gate }) {
  const { slot, entry } = orgEntry(snap, fallbackProjectId);
  const orgs = await state.get('orgs', {});
  const prev = orgs?.[slot];
  // Keep projects earlier checks were run from (added by orgEntry) when another one checks.
  if (Array.isArray(prev?.projectIds)) entry.projectIds = [...new Set([...entry.projectIds, ...prev.projectIds.map(String)])];
  const next = { ...(orgs && typeof orgs === 'object' ? orgs : {}), [slot]: entry };
  await state.set('snap:' + slot, snap);
  await state.set('orgs', next);
  await state.set('check:' + slot, gate);
  const access = await state.get('access', {});
  if (access?.[snap.host]?.denied) await state.set('access', { ...access, [snap.host]: { denied: false, at: snap.at } });
  return slot;
}

export async function setAccessDenied(state, host, at) {
  const access = await state.get('access', {});
  await state.set('access', { ...(access && typeof access === 'object' ? access : {}), [host]: { denied: true, at } });
}

/** → { slot, snap } for this host + project from stored state (snap null when none yet). */
export async function loadForProject(state, host, projectId) {
  const orgs = await state.get('orgs', {});
  const slot = findOrgSlot(orgs, host, projectId);
  if (!slot) return { slot: null, snap: null, orgs };
  return { slot, snap: await state.get('snap:' + slot, null), orgs };
}

/** Every stored snapshot: [{ slot, org, snap }]. */
export async function allSnapshots(state) {
  const orgs = await state.get('orgs', {});
  const out = [];
  for (const [slot, org] of Object.entries(orgs && typeof orgs === 'object' ? orgs : {})) {
    const snap = await state.get('snap:' + slot, null);
    if (snap) out.push({ slot, org, snap });
  }
  return out.sort((a, b) => (b.snap.at || 0) - (a.snap.at || 0));
}

/** "Check now": forget every check gate, so the next Iterable page load checks. */
export async function clearCheckGates(state) {
  for (const name of await state.list()) if (name.startsWith('check:')) await state.remove(name);
}
