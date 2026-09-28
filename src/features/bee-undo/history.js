// Pure logic for Delete confirm + undo (with redo): the in-memory snapshot history the top frame keeps, and
// the shapes of BEE's own postMessage protocol that both halves read or imitate. No DOM, no
// storage: node-tested (test/features/bee-undo.test.js) and imported by meta.js for its limits.

/** One snapshot larger than this (characters of template JSON) is not kept. */
export const SNAPSHOT_MAX_CHARS = 3_000_000;
/** All snapshots together; the oldest are dropped past this (V8 keeps ASCII JSON at 1 byte/char). */
export const HISTORY_MAX_TOTAL_CHARS = 32_000_000;
/** Frame-channel cap for a baseline: the snapshot as a JSON string field, quotes escaped. */
export const BASELINE_MAX_WIRE_CHARS = 8_000_000;
/** After our own restore, BEE's echo of the restored snapshot is ignored this long (as the script). */
export const RESTORE_GRACE_MS = 1500;
/** Snapshots up to this size are compared by normalised JSON; larger ones by their raw text. */
export const NORMALISE_MAX_CHARS = SNAPSHOT_MAX_CHARS;
export const HISTORY_LIMIT = Object.freeze({ min: 5, max: 100, default: 30 });

/** Marks the load we post and the onChange our bee half imitates, so neither is recorded. */
export const OWN_TAG = 'wbBeeUndo';

export function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return HISTORY_LIMIT.default;
  return Math.min(HISTORY_LIMIT.max, Math.max(HISTORY_LIMIT.min, Math.round(v)));
}

/** Cheap shape check for a template JSON string (a full parse happens only on undo). */
export function looksLikeTemplateJson(json) {
  return typeof json === 'string' && json.length >= 2 && json[0] === '{' && json[json.length - 1] === '}';
}

// Stable key order for plain objects (arrays keep theirs), so key order and whitespace don't count.
function sortKeys(_k, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = {};
  for (const key of Object.keys(v).sort()) Object.defineProperty(out, key, { value: v[key], enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * A comparison key for a template JSON string: parsed and re-serialised with sorted keys, so two
 * texts of the same template are equal. Over `maxChars`, unparsable or too deep: the raw text.
 */
export function normaliseJson(json, maxChars = NORMALISE_MAX_CHARS) {
  if (typeof json !== 'string' || json.length > maxChars) return json;
  try { return JSON.stringify(JSON.parse(json), sortKeys); } catch { return json; }
}

/**
 * Undo/redo history for one template. `entries[entries.length - 1]` is the editor's current
 * state; each earlier entry is one undo step back. `redos[redos.length - 1]` is the next redo
 * (the state the last undo left). Any new change, template load or clear empties `redos`.
 * The step limit and the size caps count both stacks together. Timestamps (`at`, Date.now()) let
 * a late baseline slot in before changes that were recorded after its load.
 */
export function createHistory({
  limit = HISTORY_LIMIT.default,
  maxSnapshotChars = SNAPSHOT_MAX_CHARS,
  maxTotalChars = HISTORY_MAX_TOTAL_CHARS,
  graceMs = RESTORE_GRACE_MS,
} = {}) {
  let entries = []; // { json, at }
  let redos = []; // { json, at }; the last one is the next redo
  let total = 0; // characters across entries and redos
  let max = clampLimit(limit);
  let restoringUntil = 0;
  let restored = null; // the snapshot our last undo/redo loaded; its echo during the grace period is ignored
  let tooBig = false; // the last snapshot we were given couldn't be kept

  function recount() { total = [...entries, ...redos].reduce((n, e) => n + e.json.length, 0); }

  // Oldest undo steps go first; the furthest redo steps only once no undo step is left.
  function dropOne() {
    if (entries.length > 1) total -= entries.shift().json.length;
    else if (redos.length) total -= redos.shift().json.length;
  }

  function trim() {
    while (entries.length - 1 + redos.length > max) dropOne();
    while ((entries.length > 1 || redos.length) && total > maxTotalChars) dropOne();
  }

  function reset() { entries = []; redos = []; total = 0; }

  function fits(json) { return typeof json === 'string' && json.length <= maxSnapshotChars; }

  // Two-slot memo of comparison keys: a record compares against the snapshot the previous one
  // normalised (and, during grace, the restored one), so each change is parsed about once.
  let memo = [];
  function keyOf(json) {
    const hit = memo.find((m) => m.json === json);
    if (hit) return hit.key;
    const key = normaliseJson(json);
    memo = [{ json, key }, ...memo].slice(0, 2);
    return key;
  }
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return keyOf(a) === keyOf(b);
  }

  return {
    /** Undo steps available. */
    get steps() { return Math.max(entries.length - 1, 0); },
    /** Redo steps available. */
    get redoSteps() { return redos.length; },
    get size() { return entries.length; },
    get totalChars() { return total; },
    /** True when the latest snapshot offered was too large (history was cleared then). */
    get tooBig() { return tooBig; },
    get limit() { return max; },

    setLimit(n) { max = clampLimit(n); trim(); },

    clear() { reset(); tooBig = false; restoringUntil = 0; restored = null; memo = []; },

    /**
     * A load seen by the bee half at `loadedAt`. Changes recorded since then stay on top of it;
     * anything older belonged to a previous load and goes. Returns 'reset' | 'too-big' | 'invalid'.
     */
    baseline(json, loadedAt = Date.now()) {
      if (!looksLikeTemplateJson(json)) return 'invalid';
      const after = entries.filter((e) => e.at >= loadedAt);
      if (!fits(json)) { reset(); tooBig = true; return 'too-big'; }
      // The same load reported again (the editor half reconnected) changes nothing; any other
      // load is a new starting point, so the redo steps no longer apply.
      if (entries[0]?.at === loadedAt && same(json, entries[0].json)) return 'reset';
      redos = [];
      entries = [{ json, at: loadedAt }, ...after];
      tooBig = false;
      recount();
      trim();
      return 'reset';
    },

    /** The bee half reported a load too large to send: nothing before it is valid any more. */
    baselineTooBig() { reset(); tooBig = true; },

    /**
     * BEE's onChange JSON at `now`. Returns 'recorded' | 'grace' | 'duplicate' | 'too-big' | 'invalid'.
     * During the grace period after an undo/redo, a change equal (normalised) to the snapshot we
     * just restored is BEE's echo of our load and is ignored; any other change is a real edit.
     * A snapshot too large to keep clears the history (older steps no longer lead back to the
     * current state); the next one that fits starts it again. A recorded change clears redo.
     * Snapshots are compared by normalised JSON (normaliseJson), so a re-serialised echo is a
     * duplicate, not a step.
     */
    record(json, now = Date.now()) {
      if (!looksLikeTemplateJson(json)) return 'invalid';
      if (now < restoringUntil && same(json, restored)) return 'grace';
      if (!fits(json)) { reset(); tooBig = true; return 'too-big'; }
      tooBig = false;
      if (entries.length && same(entries[entries.length - 1].json, json)) return 'duplicate';
      for (const r of redos) total -= r.json.length;
      redos = [];
      entries.push({ json, at: now });
      total += json.length;
      trim();
      return 'recorded';
    },

    /** The snapshot one step back (what undo would load), or null. */
    peekUndo() { return entries.length >= 2 ? entries[entries.length - 2].json : null; },

    /** Move the current state onto the redo stack and start the grace period; returns the state to load, or null. */
    commitUndo(now = Date.now()) {
      if (entries.length < 2) return null;
      redos.push(entries.pop());
      restoringUntil = now + graceMs;
      restored = entries[entries.length - 1].json;
      return restored;
    },

    /** The snapshot redo would load, or null. */
    peekRedo() { return redos.length ? redos[redos.length - 1].json : null; },

    /** Move the next redo back onto the undo stack and start the grace period; returns the state to load, or null. */
    commitRedo(now = Date.now()) {
      if (!redos.length) return null;
      const e = redos.pop();
      entries.push(e);
      restoringUntil = now + graceMs;
      restored = e.json;
      return restored;
    },

    /** The redo target turned out unusable (didn't parse): forget it so the next redo goes further. */
    discardRedoTarget() {
      if (redos.length) total -= redos.pop().json.length;
    },

    /** The undo target turned out unusable (didn't parse): forget it so the next undo goes further. */
    discardUndoTarget() {
      if (entries.length < 2) return;
      total -= entries.splice(entries.length - 2, 1)[0].json.length;
    },

    get restoringUntil() { return restoringUntil; },
  };
}

// ---------------------------------------------------------------------------
// BEE's own protocol (Iterable page ↔ app.getbee.io plugin frame)
// ---------------------------------------------------------------------------

/** Template JSON from a BEE → Iterable onChange message, or null. Our own imitation → null. */
export function onChangeJson(data) {
  if (!data || typeof data !== 'object') return null;
  let action; let args; let own;
  try { ({ action, args, [OWN_TAG]: own } = data); } catch { return null; }
  if (action !== 'onChange' || own) return null;
  let json;
  try { json = Array.isArray(args) || (args && typeof args === 'object') ? args[0] : undefined; } catch { return null; }
  return typeof json === 'string' ? json : null;
}

/**
 * An Iterable → BEE load message: { own, template } or null. `own` marks the load our undo posted.
 */
export function readLoad(data) {
  if (!data || typeof data !== 'object') return null;
  let action; let inner; let own;
  try { ({ action, data: inner, [OWN_TAG]: own } = data); } catch { return null; }
  if (action !== 'load' || !inner || typeof inner !== 'object') return null;
  let template;
  try { template = inner.template; } catch { return null; }
  if (!template || typeof template !== 'object') return null;
  return { own: own === true, template };
}

/** The load message our undo/redo posts to the BEE frame (as Iterable's own, plus our tag). */
export function makeLoadMessage(template) {
  return { action: 'load', data: { template }, [OWN_TAG]: true };
}

/**
 * The challenge the top half posts straight to the editor frame's window; the bee half answers
 * with the nonce over the frame channel (`claim`), which tells the top half which channel peer is
 * the editor. No `action`, so BEE ignores it.
 */
export function makeClaimMessage(nonce) {
  return { [OWN_TAG]: 'claim', nonce };
}

/** The nonce from a claim challenge, or null. */
export function readClaim(data) {
  if (!data || typeof data !== 'object') return null;
  let tag; let nonce;
  try { ({ [OWN_TAG]: tag, nonce } = data); } catch { return null; }
  return tag === 'claim' && typeof nonce === 'string' && nonce.length >= 16 && nonce.length <= 64 ? nonce : null;
}

/**
 * The onChange our bee half posts to Iterable after a restore: Iterable saves from its cached
 * onChange JSON, so without this a Save after Undo would write the pre-undo template.
 */
export function makeSyncChange(json) {
  const change = { code: '0000', value: '', description: 'Undo/redo (Loophole)', patches: [] };
  return { action: 'onChange', args: [json, change, 0], [OWN_TAG]: true };
}

/** templateId from a location.search string ('' when absent). */
export function templateIdFrom(search) {
  try { return new URLSearchParams(search || '').get('templateId') || ''; } catch { return ''; }
}

export function undoLabel(steps) {
  return `Undo (${Math.max(0, steps | 0)})`;
}

export function redoLabel(steps) {
  return `Redo (${Math.max(0, steps | 0)})`;
}
