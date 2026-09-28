// Turn whatever the user dropped into a list of legacy scripts (ARCHITECTURE §8.4). Pure: works on
// { path, bytes } records so it runs the same in the options page and in Node tests.
//
// Accepted:
//   - Tampermonkey zip export: <Name>.user.js, <Name>.options.json, and (only with "Include script
//     storage") <Name>.storage.json = { ts, data: { <GM key>: value } }
//   - the same files loose, or an unzipped folder
//   - Tampermonkey's single-file JSON export: { scripts: [{ name, options?, storage? }, …] }
//   - a Loophole backup (handled by the caller)
//
// Zips are untrusted input: only .json / .js / .zip entries are inflated, each entry and the whole
// import have a decompressed-size budget, the entry count is checked (and zip64 refused) before
// fflate walks the central directory, and nesting is capped. Loose files get the same per-file and
// total budgets. Whatever is left out is reported, never dropped silently.

import { unzipSync, strFromU8 } from 'fflate';
import { normalizeScriptName, userScriptName, fileStem } from './names.js';
import { decodeStorageReport } from './decode.js';

/** `app` value our own backups are written with. */
export const BACKUP_APP = 'loophole';
/** `app` values a restore also accepts: backups from before the rename to Loophole. */
export const LEGACY_BACKUP_APPS = Object.freeze(['workbench-for-iterable']);

/** Is `app` the id of one of our own backups (current or legacy)? */
export function isBackupApp(app) {
  return app === BACKUP_APP || LEGACY_BACKUP_APPS.includes(app);
}

const MB = 1024 * 1024;
export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 50 * MB,     // one file, loose or inside a zip (decompressed)
  maxTotalBytes: 100 * MB,   // everything decompressed from zips in one import
  maxLooseTotalBytes: 100 * MB, // loose files (chosen / dropped files and folders, zips included) in one import
  maxZipEntries: 2000,       // per zip (a Tampermonkey export has ~3 files per script)
  maxZipDepth: 2,            // a zip inside a zip is fine; a zip inside that is not
});

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_ENTRY_RE = /\.(json|js|zip)$/i;

function isZip(path, bytes) {
  if (/\.zip$/i.test(path)) return true;
  return bytes && bytes.length >= 4 && ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

function parseJson(bytes) {
  try { return JSON.parse(strFromU8(bytes).replace(/^﻿/, '')); } catch { return undefined; }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const fmtMb = (n) => `${Math.round(n / MB)} MB`;

export const ZIP_NOT_VALID = 'it isn’t a valid zip file';
export const ZIP64_REFUSED = 'it uses a format Loophole doesn’t read (zip64)';

/**
 * Look at a zip's end-of-central-directory record the way fflate's unzipSync (0.8.x) does, before
 * fflate sees the bytes: → { count } (the 16-bit entry count fflate will loop over) or
 * { error } (a reason for the "unreadable" list). fflate trusts that record blindly: its only
 * entry-count paths are the EOCD's 16-bit count and, when a zip64 locator signature sits 20 bytes
 * before the EOCD, a 32-bit count from the zip64 record the locator points to, read even when that
 * record runs past the end of the buffer (missing bytes read as 0). A forged count there makes
 * fflate loop millions of times per archive. Tampermonkey exports are never zip64, so a zip64
 * locator at that spot (the bytes are read exactly as fflate reads them, in bounds or not) refuses
 * the whole zip; so does a missing EOCD.
 */
export function inspectZip(bytes) {
  if (!bytes || bytes.length < 22) return { error: ZIP_NOT_VALID };
  // Out-of-range indices read as undefined → 0, exactly like fflate's b2 / b4.
  const b2 = (i) => bytes[i] | (bytes[i + 1] << 8);
  const b4 = (i) => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
  let e = bytes.length - 22;
  while (b4(e) !== 0x06054B50) {
    if (!e || bytes.length - e > 65558) return { error: ZIP_NOT_VALID };
    --e;
  }
  if (b4(e - 20) === 0x07064B50) return { error: ZIP64_REFUSED };
  return { count: b2(e + 8) };
}

/** inspectZip(bytes).count, or null when the zip is refused (no EOCD, or zip64). */
export function zipEntryCount(bytes) {
  const r = inspectZip(bytes);
  return r.error ? null : r.count;
}

/**
 * Keep loose files (chosen, or dropped as files / folders) within the same budgets zips get, before
 * they are read into memory: [{ path, size }] → { accepted, skipped: [{ path, reason }], notes }.
 * A file over maxFileBytes is skipped on its own; files that would take the total past
 * maxLooseTotalBytes are skipped and summarised in one note.
 */
export function admitLooseFiles(files, limits = IMPORT_LIMITS) {
  const accepted = [];
  const skipped = [];
  const overBudget = [];
  let used = 0;
  for (const f of files) {
    const size = Number(f.size) || 0;
    if (size > limits.maxFileBytes) {
      skipped.push({ path: f.path, reason: `it is larger than ${fmtMb(limits.maxFileBytes)}` });
    } else if (used + size > limits.maxLooseTotalBytes) {
      overBudget.push(f.path);
    } else {
      used += size;
      accepted.push(f);
    }
  }
  const notes = [];
  if (overBudget.length) {
    const n = overBudget.length;
    const names = overBudget.slice(0, 3).join(', ') + (n > 3 ? `, and ${n - 3} more` : '');
    notes.push(`Skipped ${n} file${n === 1 ? '' : 's'} (${names}): together the files add up to more than ${fmtMb(limits.maxLooseTotalBytes)}.`);
  }
  return { accepted, skipped, notes };
}

/**
 * `{ ts, data }` → decoded GM values; a bare object of GM values → decoded itself; else null.
 * Tampermonkey's type tags ("s…", "b…") are removed here, so everything downstream (key
 * extraction, mappers, the stash) sees decoded values. Returns { values, failed } | null, where
 * `failed` lists GM keys whose value couldn't be decoded (left out of `values`).
 */
export function readStorage(storage) {
  if (!isObject(storage)) return null;
  if (isObject(storage.data)) {
    const r = decodeStorageReport(storage.data, { tagged: true });
    return { values: r.values, failed: r.failed };
  }
  if ('data' in storage || 'ts' in storage) return { values: {}, failed: [] }; // an export with an empty store
  const r = decodeStorageReport(storage);
  return { values: r.values, failed: r.failed };
}

/** readStorage(...).values, or null. */
export function storageValues(storage) {
  return readStorage(storage)?.values ?? null;
}

/**
 * Tampermonkey single-file JSON export, detected by shape only: an object with a `scripts` array
 * of objects, at least one of them named. Nameless items are skipped (and reported) by readInputs,
 * not a reason to ignore the whole export.
 */
export function isTampermonkeyJson(json) {
  return isObject(json) && Array.isArray(json.scripts) && json.scripts.length > 0 &&
    json.scripts.every(isObject) && json.scripts.some(hasName);
}

const hasName = (s) => isObject(s) && typeof s.name === 'string' && s.name.trim() !== '';

export function isLoopholeBackup(json) {
  return isObject(json) && isBackupApp(json.app);
}

function sameStorage(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function decodeNotes(failed) {
  if (!failed.length) return [];
  const names = failed.slice(0, 5).map((k) => `“${k}”`).join(', ') + (failed.length > 5 ? `, and ${failed.length - 5} more` : '');
  return [`Skipped ${failed.length} saved value${failed.length === 1 ? '' : 's'} that couldn’t be decoded: ${names}.`];
}

/**
 * readInputs([{ path, bytes }]) → {
 *   scripts:   [{ name, normName, storage (GM values) | null, hasOptions, hasUserJs, sources,
 *                 notes: [string], duplicate?: true }],
 *   backups:   [Loophole backup objects],
 *   sawTampermonkey: true when anything Tampermonkey-shaped was found,
 *   ignored:   [paths that weren't recognised],
 *   skipped:   [{ path, reason }] left out because of a size / count / nesting limit,
 *   unreadable:[{ path, reason }] recognised by name but couldn't be parsed,
 *   notes:     [string] summaries of what else was left out (other files inside a zip, loose
 *              files over the total budget),
 * }
 * Paths inside a zip are reported as "export.zip › Name.storage.json". opts.unzip replaces fflate's
 * unzipSync (tests use it to prove refused zips never reach fflate).
 * Two scripts whose names normalise the same are merged when their storage agrees (or one has
 * none); when both carry different storage they are both listed (the later one marked
 * `duplicate`), each with a note, so neither file's keys or settings disappear silently.
 */
export function readInputs(inputs, limits = IMPORT_LIMITS, { unzip = unzipSync } = {}) {
  const byStem = new Map(); // stem → partial record (loose / zip files are grouped by file stem)
  const direct = [];        // records from TM single-file JSON (already named)
  const backups = [];
  const ignored = [];
  const skipped = [];
  const unreadable = [];
  const notes = [];
  const budget = { used: 0 };
  let sawTampermonkey = false;

  const stemRecord = (stem) => {
    if (!byStem.has(stem)) {
      byStem.set(stem, {
        stem, optionsName: null, userJsName: null, storage: null, failed: [],
        hasOptions: false, hasUserJs: false, sources: [],
      });
    }
    return byStem.get(stem);
  };

  // `path` is the zip as the user knows it ("export.zip", or "export.zip › inner.zip").
  const visitZip = (path, bytes, depth) => {
    if (depth >= limits.maxZipDepth) { skipped.push({ path, reason: 'a zip nested this deep isn’t opened' }); return; }
    // Checked before fflate touches the bytes: it would trust a forged count (see inspectZip).
    const info = inspectZip(bytes);
    if (info.error) { unreadable.push({ path, reason: info.error }); return; }
    if (info.count > limits.maxZipEntries) {
      skipped.push({ path, reason: `it has more than ${limits.maxZipEntries} entries` });
      return;
    }
    let entries;
    let others = 0;
    try {
      entries = unzip(bytes, {
        filter: (f) => {
          if (f.name.endsWith('/')) return false;
          const where = `${path} › ${f.name}`;
          if (!ZIP_ENTRY_RE.test(f.name)) { ignored.push(where); others++; return false; }
          // Stored entries are copied at their compressed size; inflated ones are allocated at
          // originalSize (fflate never grows that buffer). Budget whichever is larger.
          const cost = Math.max(Number(f.originalSize) || 0, Number(f.size) || 0);
          if (cost > limits.maxFileBytes) {
            skipped.push({ path: where, reason: `it is larger than ${fmtMb(limits.maxFileBytes)} uncompressed` });
            return false;
          }
          if (budget.used + cost > limits.maxTotalBytes) {
            skipped.push({ path: where, reason: `the import would unpack to more than ${fmtMb(limits.maxTotalBytes)}` });
            return false;
          }
          budget.used += cost;
          return true;
        },
      });
    } catch {
      unreadable.push({ path, reason: 'it couldn’t be unzipped' });
      return;
    }
    if (others) {
      notes.push(`Skipped ${others} other file${others === 1 ? '' : 's'} in ${path} (only .json, .js and .zip files are read).`);
    }
    for (const [name, data] of Object.entries(entries)) visit(name, data, depth + 1, `${path} › ${name}`);
  };

  // `path` is the file's own name (used for its stem and extension); `where` is how it is shown in
  // reports: the same for a loose file, "export.zip › Name.storage.json" inside a zip.
  const visit = (path, bytes, depth, where = path) => {
    if (isZip(path, bytes)) { visitZip(where, bytes, depth); return; }
    const lower = path.toLowerCase();
    if (lower.endsWith('.storage.json')) {
      sawTampermonkey = true;
      const rec = stemRecord(fileStem(path));
      rec.sources.push(where);
      const read = readStorage(parseJson(bytes));
      if (!read) {
        rec.unreadable = true;
        unreadable.push({ path: where, reason: 'it isn’t valid Tampermonkey storage JSON' });
        return;
      }
      rec.storage = read.values;
      rec.failed.push(...read.failed);
    } else if (lower.endsWith('.options.json')) {
      sawTampermonkey = true;
      const rec = stemRecord(fileStem(path));
      const json = parseJson(bytes);
      rec.hasOptions = true;
      if (typeof json?.meta?.name === 'string' && json.meta.name) rec.optionsName = json.meta.name;
      rec.sources.push(where);
    } else if (lower.endsWith('.user.js')) {
      sawTampermonkey = true;
      const rec = stemRecord(fileStem(path));
      rec.hasUserJs = true;
      rec.userJsName = userScriptName(strFromU8(bytes));
      rec.sources.push(where);
    } else if (lower.endsWith('.json')) {
      const json = parseJson(bytes);
      if (json === undefined) {
        unreadable.push({ path: where, reason: 'it isn’t valid JSON' });
      } else if (isLoopholeBackup(json)) {
        backups.push(json);
      } else if (isTampermonkeyJson(json)) {
        sawTampermonkey = true;
        const nameless = json.scripts.filter((s) => !hasName(s)).length;
        if (nameless) skipped.push({ path: where, reason: `${nameless} script${nameless === 1 ? ' has' : 's have'} no name` });
        for (const s of json.scripts) {
          if (!hasName(s)) continue;
          const read = s.storage === undefined ? null : readStorage(s.storage);
          direct.push({
            name: s.name,
            storage: read ? read.values : null,
            failed: read ? read.failed : [],
            hasOptions: s.options !== undefined,
            hasUserJs: typeof s.source === 'string',
            sources: [where],
          });
        }
      } else if (isObject(json) && isObject(json.data)) {
        // A loose storage dump saved under another name.
        sawTampermonkey = true;
        const rec = stemRecord(fileStem(path));
        const read = readStorage(json);
        rec.storage = read.values;
        rec.failed.push(...read.failed);
        rec.sources.push(where);
      } else {
        ignored.push(where);
      }
    } else {
      ignored.push(where);
    }
  };

  // The same per-file and total budgets the options page applies before reading (admitLooseFiles).
  const loose = admitLooseFiles(inputs.map((input) => ({ ...input, size: input.bytes ? input.bytes.length : 0 })), limits);
  skipped.push(...loose.skipped);
  notes.push(...loose.notes);
  for (const { path, bytes } of loose.accepted) visit(path, bytes, 0);

  // Merge by normalised script name; a record with storage wins over one without. Two different
  // stores for the same name are both kept (see above).
  const merged = new Map(); // normName → [records]
  const add = (r) => {
    const normName = normalizeScriptName(r.name);
    const rec = { name: r.name, normName, storage: r.storage, hasOptions: r.hasOptions, hasUserJs: r.hasUserJs,
      sources: [...r.sources], notes: decodeNotes(r.failed || []) };
    const list = merged.get(normName);
    if (!list) { merged.set(normName, [rec]); return; }
    const target = list.find((p) => p.storage === null || rec.storage === null || sameStorage(p.storage, rec.storage));
    if (target) {
      target.storage = target.storage ?? rec.storage;
      target.hasOptions ||= rec.hasOptions;
      target.hasUserJs ||= rec.hasUserJs;
      target.sources.push(...rec.sources);
      for (const n of rec.notes) if (!target.notes.includes(n)) target.notes.push(n);
      return;
    }
    const first = list[0];
    const note = (other) => `Another file also has saved settings for this script (${other.sources.join(', ')}). ` +
      'Both are listed; tick only the one you want, or the one lower in the list wins.';
    first.notes.push(note(rec));
    rec.notes.push(note(first));
    rec.duplicate = true;
    list.push(rec);
  };
  for (const rec of byStem.values()) {
    add({
      name: rec.optionsName || rec.userJsName || rec.stem,
      storage: rec.storage,
      failed: rec.failed,
      hasOptions: rec.hasOptions,
      hasUserJs: rec.hasUserJs,
      sources: rec.sources,
    });
  }
  direct.forEach(add);

  const scripts = [...merged.values()].flat().sort((a, b) => a.name.localeCompare(b.name));
  return { scripts, backups, sawTampermonkey, ignored, skipped, unreadable, notes };
}

/**
 * True when Tampermonkey files were found but none of them carried storage (§8.4). A storage
 * file that was present but unreadable doesn't count as "missing": the caller reports it instead.
 */
export function missingStorage(result) {
  return result.sawTampermonkey && result.scripts.length > 0 && result.scripts.every((s) => s.storage === null) &&
    !(result.unreadable || []).length;
}
