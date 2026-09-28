// API key vault over chrome.storage.local `wb:keys` (docs/ARCHITECTURE.md §5.1, §9).
//
// Runs in the background, popup and options pages ONLY. Content scripts must never import this
// module: they ask the background for a masked status (MSG.KEYS_STATUS) instead.
//
// Stored shape:
//   wb:keys = { version: 1,
//     projects: { [projectKey]: { name, dataCenter: 'us'|'eu', apiKey, savedAt, lastTest } } }
//   wb:keys-rev = number   bumped in the same set() as every vault write; no key material
//
// Writes are read-modify-write, so they are serialized: first by an in-module promise chain
// (same JS context), then by a Web Lock (navigator.locks, shared by every context of the
// extension origin — background, popup and every options tab), so two tabs saving at once can't
// drop each other's changes. Reads are single storage.get snapshots and need no lock.
//
// Nothing thrown or returned from here contains a raw key, except getRawKey()/getKeyForUse().

import { STORAGE } from './messages.js';
import {
  parseProjectKey, makeProjectKey, legacyProjectKey, maskKey, isDataCenter, cleanName, validateApiKey,
} from './api-validation.js';

// Pure helpers re-exported so options/popup code has one import for everything key-related.
export { parseProjectKey, makeProjectKey, legacyProjectKey, maskKey };

const VAULT_VERSION = 1;
const LOCK_NAME = 'wb:keys:write';
const LOCK_TIMEOUT_MS = 10_000;
const IMPORT_MAX = 1000;

export class KeyVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyVaultError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Storage access
// ---------------------------------------------------------------------------

function area() {
  // Defense in depth: a web page context (content script) must never touch the raw vault.
  const loc = globalThis.location;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
    throw new KeyVaultError('FORBIDDEN_CONTEXT', 'The key vault is not available in web pages.');
  }
  const local = globalThis.chrome?.storage?.local;
  if (!local) throw new KeyVaultError('NO_STORAGE', 'chrome.storage.local is unavailable.');
  return local;
}

function emptyVault() {
  return { version: VAULT_VERSION, projects: {} };
}

/** A stored entry is usable only if every field is sane. Invalid entries are never served. */
function entryValid(pk, e) {
  const parsed = parseProjectKey(pk);
  if (!parsed || !e || typeof e !== 'object' || e.dataCenter !== parsed.dataCenter) return false;
  const k = validateApiKey(e.apiKey);
  return k.ok && k.value === e.apiKey;
}

/**
 * Read the vault. `forWrite` makes shape problems fatal so a write can never clobber data it
 * doesn't understand (e.g. a vault written by a newer version of the extension).
 */
async function readVault({ forWrite = false } = {}) {
  const got = await area().get(STORAGE.KEYS);
  const raw = got ? got[STORAGE.KEYS] : undefined;
  if (raw === undefined || raw === null) return emptyVault();
  const shapeOk = typeof raw === 'object' && !Array.isArray(raw) &&
    raw.version === VAULT_VERSION && raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects);
  if (!shapeOk) {
    if (forWrite) {
      throw new KeyVaultError('UNSUPPORTED_VAULT',
        typeof raw === 'object' && raw && typeof raw.version === 'number' && raw.version > VAULT_VERSION
          ? 'Saved keys were written by a newer version of Workbench; not modifying them.'
          : 'Saved keys are in an unexpected format; not modifying them.');
    }
    return emptyVault();
  }
  // Copy into a fresh object; ignore inherited properties. A stored "__proto__" (never a valid
  // projectKey) would re-parent the copy on assignment, so such names are skipped.
  const projects = {};
  for (const pk of Object.keys(raw.projects)) {
    if (pk === '__proto__' || pk === 'constructor' || pk === 'prototype') continue;
    projects[pk] = raw.projects[pk];
  }
  return { version: VAULT_VERSION, projects };
}

/**
 * Write the vault together with `wb:keys-rev`, a bare change counter content scripts can watch
 * (they never see wb:keys changes). The rev is a number derived only from the clock and the
 * previous rev: it must never carry anything from the vault. Callers hold the write lock.
 */
async function writeVault(vault) {
  const got = await area().get(STORAGE.KEYS_REV);
  const prev = Number(got ? got[STORAGE.KEYS_REV] : 0);
  const rev = Math.max(Date.now(), Number.isFinite(prev) ? Math.floor(prev) + 1 : 0);
  await area().set({ [STORAGE.KEYS]: vault, [STORAGE.KEYS_REV]: rev });
}

// Same-context serialization. Each call waits for the previous one regardless of its outcome.
let chain = Promise.resolve();

function withWriteLock(fn) {
  const run = async () => {
    const locks = globalThis.navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      const opts = { mode: 'exclusive' };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = AbortSignal.timeout(LOCK_TIMEOUT_MS);
      }
      try {
        return await locks.request(LOCK_NAME, opts, () => fn());
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new KeyVaultError('BUSY', 'Another Workbench window is saving keys; try again.');
        }
        throw e;
      }
    }
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

async function mutate(fn) {
  return withWriteLock(async () => {
    const vault = await readVault({ forWrite: true });
    const before = JSON.stringify(vault);
    const result = await fn(vault);
    // Skip no-op writes so other contexts don't see spurious storage.onChanged events.
    if (JSON.stringify(vault) !== before) await writeVault(vault);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireProjectKey(pk) {
  const parsed = parseProjectKey(pk);
  if (!parsed) throw new KeyVaultError('INVALID_PROJECT_KEY', 'Project key is malformed.');
  return parsed;
}

function defaultName(parsed) {
  return parsed.name != null ? parsed.name : 'Project ' + parsed.id;
}

function publicView(pk, e) {
  const valid = entryValid(pk, e);
  const parsed = parseProjectKey(pk);
  const name = typeof e?.name === 'string' && cleanName(e.name) !== null ? e.name : (parsed ? defaultName(parsed) : '');
  return {
    projectKey: pk,
    name,
    dataCenter: parsed ? parsed.dataCenter : null,
    masked: valid ? maskKey(e.apiKey) : '',
    hasKey: valid,
    savedAt: typeof e?.savedAt === 'string' ? e.savedAt : null,
    lastTest: e && e.lastTest && typeof e.lastTest === 'object'
      ? { ok: !!e.lastTest.ok, status: Number.isInteger(e.lastTest.status) ? e.lastTest.status : 0,
          at: typeof e.lastTest.at === 'string' ? e.lastTest.at : null }
      : null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All saved projects, sorted by name. Never includes raw keys. */
export async function listProjects() {
  const vault = await readVault();
  return Object.keys(vault.projects)
    .filter((pk) => parseProjectKey(pk))
    .map((pk) => publicView(pk, vault.projects[pk]))
    .sort((a, b) => a.name.localeCompare(b.name) || a.projectKey.localeCompare(b.projectKey));
}

/** Masked status for one project: { hasKey, masked, name, dataCenter, lastTest }. */
export async function getStatus(projectKey) {
  const parsed = parseProjectKey(projectKey);
  if (!parsed) return { hasKey: false, masked: '', name: '' };
  const vault = await readVault();
  if (!Object.hasOwn(vault.projects, projectKey)) {
    return { hasKey: false, masked: '', name: '' };
  }
  const v = publicView(projectKey, vault.projects[projectKey]);
  return { hasKey: v.hasKey, masked: v.masked, name: v.name, dataCenter: v.dataCenter, lastTest: v.lastTest };
}

/**
 * Save (or replace) a project's key. Returns the public view.
 * `dataCenter` is optional; when given it must agree with the projectKey.
 */
export async function setKey({ projectKey, name, dataCenter, apiKey } = {}) {
  const parsed = requireProjectKey(projectKey);
  if (dataCenter != null && dataCenter !== parsed.dataCenter) {
    if (!isDataCenter(dataCenter)) throw new KeyVaultError('INVALID_DATA_CENTER', 'Data center must be "us" or "eu".');
    throw new KeyVaultError('INVALID_DATA_CENTER', 'Data center does not match the project key.');
  }
  const k = validateApiKey(apiKey);
  if (!k.ok) throw new KeyVaultError('INVALID_API_KEY', k.message);
  const cleaned = cleanName(name, { allowEmpty: true });
  if (cleaned === null) throw new KeyVaultError('INVALID_NAME', 'Project name is too long or contains control characters.');

  return mutate((vault) => {
    const prev = Object.hasOwn(vault.projects, projectKey) ? vault.projects[projectKey] : null;
    const sameKey = prev && prev.apiKey === k.value;
    const entry = {
      name: cleaned || (prev && typeof prev.name === 'string' && prev.name) || defaultName(parsed),
      dataCenter: parsed.dataCenter,
      apiKey: k.value,
      savedAt: sameKey && typeof prev.savedAt === 'string' ? prev.savedAt : nowIso(),
      // A test result describes a specific key; a new key starts untested.
      lastTest: sameKey ? (prev.lastTest ?? null) : null,
    };
    vault.projects[projectKey] = entry;
    return publicView(projectKey, entry);
  });
}

export async function renameProject(projectKey, name) {
  requireProjectKey(projectKey);
  const cleaned = cleanName(name);
  if (cleaned === null) throw new KeyVaultError('INVALID_NAME', 'Project name is empty, too long or contains control characters.');
  return mutate((vault) => {
    if (!Object.hasOwn(vault.projects, projectKey)) throw new KeyVaultError('NOT_FOUND', 'No key saved for that project.');
    vault.projects[projectKey] = { ...vault.projects[projectKey], name: cleaned };
    return publicView(projectKey, vault.projects[projectKey]);
  });
}

/** Remove a project's key. Resolves true if something was removed. */
export async function removeKey(projectKey) {
  requireProjectKey(projectKey);
  return mutate((vault) => {
    if (!Object.hasOwn(vault.projects, projectKey)) return false;
    delete vault.projects[projectKey];
    return true;
  });
}

/** The raw key for a project, or null. Background/options only. */
export async function getRawKey(projectKey) {
  const e = await getKeyForUse(projectKey);
  return e ? e.apiKey : null;
}

/**
 * Raw key plus the metadata the background needs: { apiKey, dataCenter, savedAt } | null.
 * `savedAt` lets recordTest() ignore a result for a key that was replaced mid-test.
 */
export async function getKeyForUse(projectKey) {
  if (!parseProjectKey(projectKey)) return null;
  const vault = await readVault();
  if (!Object.hasOwn(vault.projects, projectKey)) return null;
  const e = vault.projects[projectKey];
  if (!entryValid(projectKey, e)) return null;
  return { apiKey: e.apiKey, dataCenter: e.dataCenter, savedAt: typeof e.savedAt === 'string' ? e.savedAt : null };
}

/**
 * Record a key test result. If `savedAt` is given and the stored key has changed since
 * (different savedAt), the result is dropped. Resolves true if recorded.
 */
export async function recordTest(projectKey, { ok, status, savedAt } = {}) {
  requireProjectKey(projectKey);
  return mutate((vault) => {
    if (!Object.hasOwn(vault.projects, projectKey)) return false;
    const e = vault.projects[projectKey];
    if (savedAt !== undefined && e.savedAt !== savedAt) return false;
    const st = Number.isInteger(status) && status >= 0 && status <= 999 ? status : 0;
    vault.projects[projectKey] = { ...e, lastTest: { ok: !!ok, status: st, at: nowIso() } };
    return true;
  });
}

/**
 * Import keys (from the legacy importer or a settings backup).
 *   list: [{ projectKey, name?, dataCenter?, apiKey }]   (legacy '18244' / 'name:Foo' keys accepted)
 *   onConflict: 'keep' (default) | 'replace' — what to do when a project already has a different key.
 * Returns { added, replaced, kept, unchanged, conflicts: [{projectKey, name}], invalid: [{index, reason}] }.
 * `conflicts` lists every project whose existing key differed from the imported one (kept or replaced).
 * Reasons never contain key material. The whole import is one atomic write.
 */
export async function importKeys(list, { onConflict = 'keep' } = {}) {
  if (!Array.isArray(list)) throw new KeyVaultError('INVALID_IMPORT', 'Import must be a list.');
  if (list.length > IMPORT_MAX) throw new KeyVaultError('INVALID_IMPORT', `Import is limited to ${IMPORT_MAX} keys.`);
  if (onConflict !== 'keep' && onConflict !== 'replace') {
    throw new KeyVaultError('INVALID_IMPORT', 'onConflict must be "keep" or "replace".');
  }

  // Validate everything before taking the lock.
  const invalid = [];
  const items = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') { invalid.push({ index, reason: 'not an object' }); return; }
    const pk = parseProjectKey(item.projectKey) ? item.projectKey : legacyProjectKey(item.projectKey);
    const parsed = pk && parseProjectKey(pk);
    if (!parsed) { invalid.push({ index, reason: 'malformed project key' }); return; }
    if (item.dataCenter != null && item.dataCenter !== parsed.dataCenter) {
      invalid.push({ index, reason: 'data center does not match project key' }); return;
    }
    const k = validateApiKey(item.apiKey);
    if (!k.ok) { invalid.push({ index, reason: k.message }); return; }
    const name = cleanName(item.name, { allowEmpty: true });
    if (name === null) { invalid.push({ index, reason: 'invalid project name' }); return; }
    items.push({ projectKey: pk, parsed, apiKey: k.value, name });
  });

  const result = { added: 0, replaced: 0, kept: 0, unchanged: 0, conflicts: [], invalid };
  if (!items.length) return result;

  return mutate((vault) => {
    const at = nowIso();
    for (const it of items) {
      const prev = Object.hasOwn(vault.projects, it.projectKey) ? vault.projects[it.projectKey] : null;
      const prevValid = prev && entryValid(it.projectKey, prev);
      if (prevValid && prev.apiKey === it.apiKey) {
        result.unchanged++;
        if (!prev.name && it.name) vault.projects[it.projectKey] = { ...prev, name: it.name };
        continue;
      }
      if (prevValid) {
        result.conflicts.push({ projectKey: it.projectKey, name: prev.name || it.name || defaultName(it.parsed) });
        if (onConflict === 'keep') { result.kept++; continue; }
        result.replaced++;
      } else {
        result.added++;
      }
      vault.projects[it.projectKey] = {
        name: it.name || (prev && typeof prev.name === 'string' && prev.name) || defaultName(it.parsed),
        dataCenter: it.parsed.dataCenter,
        apiKey: it.apiKey,
        savedAt: at,
        lastTest: null,
      };
    }
    return result;
  });
}

/** For tests only: wait for queued same-context writes. */
export function _settled() {
  return chain;
}
