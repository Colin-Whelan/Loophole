// Import & export (ARCHITECTURE §8.4): Tampermonkey exports in any shape, and Workbench's own
// backup file. Everything is parsed locally; nothing is uploaded.

import { STORAGE } from '../../core/messages.js';
import { h, clear, append, downloadBlob } from '../../core/dom.js';
import * as storage from '../../core/storage.js';
import * as settings from '../../core/settings.js';
import { writeStateEntries } from '../../core/state.js';
import { listProjects, getRawKey, maskKey, makeProjectKey } from '../../core/keys.js';
import { FEATURES, getMeta } from '../../features/registry.js';
import { importers } from '../../features/optional.js';
import { button, chip, toast, select, input, confirmDialog, switchInput } from '../../ui/components.js';
import { readInputs, missingStorage, admitLooseFiles, WORKBENCH_BACKUP_APP, IMPORT_LIMITS } from '../importer/sources.js';
import { extractLegacyKeys } from '../importer/legacy-keys.js';
import { planScripts, STATUS_LABEL } from '../importer/plan.js';
import { applyImport, importKeyLists } from '../importer/apply.js';
import { planBackupRestore, BACKUP_FORMAT, CHECKPOINT_PREFIX } from '../importer/backup.js';
import { testUnsavedKey } from '../importer/test-key.js';
import { heading } from './common.js';

const MAX_FILE_BYTES = IMPORT_LIMITS.maxFileBytes;

export function render(main) {
  main.append(...heading('Import & export',
    'Bring over your settings from the old Tampermonkey scripts, or back up Workbench itself. Files are read here in your browser; nothing is uploaded.'));
  main.append(tampermonkeyCard(), backupCard());
}

// ── Reading dropped / chosen files ───────────────────────────────────────

/**
 * [{ path, file }] → { inputs: [{ path, bytes }], skipped: [{ path, reason }], notes: [string] }.
 * Sizes are checked (per file and in total, admitLooseFiles) before anything is read into memory.
 */
async function readWithinBudget(list) {
  const { accepted, skipped, notes } = admitLooseFiles(list.map((x) => ({ ...x, size: x.file.size })));
  const inputs = [];
  for (const { path, file } of accepted) inputs.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
  return { inputs, skipped, notes };
}

function fromFiles(files) {
  return readWithinBudget(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
}

/** Files and folders from a drop (folders are walked recursively). */
async function fromDataTransfer(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return fromFiles([...(dt.files || [])]);
  const files = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      files.push({ path: prefix + file.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return readWithinBudget(files);
}

// ── Tampermonkey ─────────────────────────────────────────────────────────

function tampermonkeyCard() {
  const results = h('div');
  const pickFiles = h('input', { type: 'file', accept: '.zip,.json,.js', multiple: true, hidden: true });
  const pickFolder = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  const drop = h('div', { class: 'dropzone' },
    'Drop a Tampermonkey export here: the .zip, the files inside it, or the unzipped folder.',
    h('div', { class: 'row', style: 'justify-content:center; margin-top:10px' },
      button('Choose files', { onClick: () => pickFiles.click() }),
      button('Choose a folder', { onClick: () => pickFolder.click() })));

  const load = async (getInputs) => {
    clear(results).append(h('p', { class: 'wb-help' }, 'Reading…'));
    try {
      await handleInputs(results, await getInputs());
    } catch (e) {
      console.error('[WB:import]', e);
      clear(results).append(h('p', { class: 'err' }, `Could not read those files: ${e?.message || e}`));
    }
  };
  for (const picker of [pickFiles, pickFolder]) {
    picker.addEventListener('change', () => {
      const files = [...picker.files];
      picker.value = '';
      if (files.length) load(() => fromFiles(files));
    });
  }
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const dt = e.dataTransfer;
    if (dt) load(() => fromDataTransfer(dt));
  });

  return h('div', { class: 'card', style: 'margin-bottom:16px' },
    h('h3', null, 'Import from Tampermonkey'),
    h('p', { class: 'wb-help', style: 'margin:0 0 12px' },
      'In Tampermonkey, open the Dashboard, go to Utilities and export a zip with “Include script storage” ticked. Workbench picks up your API keys and saved settings from the old scripts. Settings for tools that aren’t in Workbench yet are kept and applied when they arrive.'),
    drop, pickFiles, pickFolder, results);
}

async function handleInputs(host, { inputs, skipped = [], notes = [] }) {
  const found = readInputs(inputs);
  clear(host);
  const problems = readProblems(found, { skipped, notes });
  if (problems) host.append(problems);
  if (found.backups.length) {
    await restoreBackup(found.backups[0]);
    if (!found.scripts.length) return;
  }
  if (!found.scripts.length) {
    if (!found.backups.length && !problems) {
      host.append(h('p', { class: 'wb-help' }, 'Nothing in those files looks like a Tampermonkey export or a Workbench backup.'));
    }
    return;
  }
  if (missingStorage(found)) {
    host.append(noStorageHelp(found.scripts.length));
    return;
  }
  // Storage files were there but none could be read: the notice above says which; no empty preview.
  if (found.scripts.every((sc) => sc.storage === null)) return;
  await renderPreview(host, found);
}

/**
 * Files that were too large, over a limit, not used or couldn't be parsed. `before` is what was
 * left out before reading (admitLooseFiles). Null when there were none.
 */
function readProblems(found, before) {
  const lines = [
    ...before.notes,
    ...[...before.skipped, ...found.skipped].map((s) => `${s.path}: skipped, ${s.reason}.`),
    ...found.unreadable.map((u) => `Couldn’t read ${u.path}: ${u.reason}.`),
    ...found.notes,
  ];
  if (!lines.length) return null;
  const max = 20;
  return h('div', { class: 'notice', style: 'margin-top:14px; display:block' },
    h('strong', null, 'Some files were not imported.'),
    h('ul', { style: 'margin:6px 0 0; padding-left:20px; line-height:1.6' },
      lines.slice(0, max).map((l) => h('li', null, l)),
      lines.length > max ? h('li', null, `…and ${lines.length - max} more.`) : null));
}

function noStorageHelp(count) {
  return h('div', { class: 'notice', style: 'margin-top:14px; display:block' },
    h('strong', null, 'These files don’t include your settings.'),
    h('p', { style: 'margin:6px 0' },
      `Found ${count} script${count === 1 ? '' : 's'}, but no saved storage. In Tampermonkey, export again with `,
      h('em', null, 'Include script storage'), ' ticked:'),
    h('ol', { style: 'margin:0; padding-left:20px; line-height:1.6' },
      h('li', null, 'Open the Tampermonkey Dashboard.'),
      h('li', null, 'Go to the Utilities tab.'),
      h('li', null, 'Under Zip, click Export.'),
      h('li', null, 'Tick “Include script storage”, then export.'),
      h('li', null, 'Drop the new zip here.')));
}

async function renderPreview(host, found) {
  const known = await listProjects().catch(() => []);
  const withStorage = found.scripts.filter((s) => s.storage);
  const keys = extractLegacyKeys(withStorage, { knownProjects: known });
  const allKeys = [...keys.assigned, ...keys.unassigned];
  const keySources = new Set(allKeys.flatMap((k) => k.sources));
  const secrets = allKeys.map((k) => k.apiKey);
  const items = planScripts(found.scripts, { importers, metas: FEATURES, keySources, secrets });
  const noStorage = found.scripts.length - withStorage.length;

  // Scripts
  const checks = new Map();
  const scriptList = h('div', { class: 'imp-list card' },
    h('h3', null, `Found ${items.length} script${items.length === 1 ? '' : 's'} with saved settings`),
    noStorage ? h('p', { class: 'wb-help', style: 'margin:0 0 6px' },
      `${noStorage} other script${noStorage === 1 ? '' : 's'} in these files had no saved storage.`) : null,
    items.map((item) => {
      const usable = item.status === 'import' || item.status === 'stash';
      // A second export of the same script starts unticked (its note explains why).
      const cb = h('input', { type: 'checkbox', checked: usable && !item.script.duplicate, disabled: !usable, 'aria-label': `Import ${item.script.name}` });
      checks.set(item, cb);
      return h('div', { class: 'imp-item' },
        cb,
        h('div', null,
          h('div', { style: 'font-weight:500' }, item.script.name,
            item.feature ? h('span', { class: 'wb-help' }, ` → ${item.feature.name}`) : null),
          h('div', { class: 'wb-help', style: 'margin:0' }, item.message),
          item.notes.length ? h('ul', null, item.notes.map((n) => h('li', null, n))) : null),
        planChip(item.status));
    }));

  // Keys
  const keyRows = [];
  const keyCard = await keysCard(keys, known, keyRows);

  const apply = button('Import selected', {
    variant: 'primary',
    onClick: async () => {
      const chosen = collectKeys(keyRows);
      if (chosen.error) { toast(chosen.error, { tone: 'bad', source: 'Import' }); return; }
      apply.disabled = true;
      try {
        const selected = items.filter((i) => checks.get(i)?.checked);
        const outcome = await applyImport({ items: selected, keys: chosen });
        // The result list covers every detected script, not only the ticked ones.
        for (const i of items) {
          if (selected.includes(i)) continue;
          outcome.scripts.push({ name: i.script.name, status: i.status === 'empty' ? 'empty' : i.status === 'error' ? 'error' : 'skipped' });
        }
        clear(host).append(resultView(outcome));
        toast('Import finished.', { tone: 'ok', source: 'Import' });
      } catch (e) {
        apply.disabled = false;
        toast(`Import failed: ${e?.message || e}`, { tone: 'bad', source: 'Import' });
      }
    },
  });

  append(host, scriptList, keyCard, h('div', { class: 'actions' }, apply));
}

function planChip(status) {
  if (status === 'import') return chip('ready', { tone: 'ok' });
  if (status === 'stash') return chip('keep for later', { tone: 'accent' });
  if (status === 'error') return chip('error', { tone: 'bad' });
  return chip('nothing to import');
}

/** Builds the API key card; pushes one descriptor per row into `rows`. */
async function keysCard(keys, known, rows) {
  if (!keys.assigned.length && !keys.unassigned.length) return null;
  const card = h('div', { class: 'imp-list card' }, h('h3', null, 'API keys'));

  for (const a of keys.assigned) {
    const existing = await getRawKey(a.projectKey).catch(() => null);
    const state = existing == null ? 'new' : existing === a.apiKey ? 'same' : 'conflict';
    const row = { kind: 'assigned', entry: a, state, choice: 'keep', cb: null };
    row.cb = h('input', { type: 'checkbox', checked: state !== 'same', disabled: state === 'same', 'aria-label': `Import key for ${a.name || a.projectKey}` });
    let right;
    if (state === 'same') right = chip('already saved');
    else if (state === 'new') right = chip('new', { tone: 'ok' });
    else {
      right = select({
        value: 'keep', ariaLabel: `Key for ${a.name || a.projectKey}`,
        options: [{ value: 'keep', label: 'Keep the saved key' }, { value: 'replace', label: 'Use the imported key' }],
        onChange: (v) => { row.choice = v; },
      });
      right.style.width = 'auto';
    }
    card.append(h('div', { class: 'imp-item' },
      row.cb,
      h('div', null,
        h('div', { style: 'font-weight:500' }, a.name || a.projectKey,
          h('span', { class: 'wb-help' }, ` · ${a.projectKey}`)),
        h('div', { class: 'wb-help', style: 'margin:0' },
          h('span', { class: 'code' }, maskKey(a.apiKey)), ` · from ${a.sources.join(', ')}`,
          state === 'conflict' ? ' · a different key is already saved for this project' : '')),
      right));
    rows.push(row);
  }

  if (keys.unassigned.length) {
    card.append(h('p', { class: 'wb-help', style: 'margin:12px 0 4px' },
      'These keys weren’t saved against a project. Pick the project each one belongs to, or leave it out.'));
  }
  const projectOptions = [];
  const seen = new Set();
  for (const p of [...known, ...keys.assigned]) {
    if (seen.has(p.projectKey)) continue;
    seen.add(p.projectKey);
    projectOptions.push({ value: p.projectKey, label: `${p.name || p.projectKey} (${p.projectKey})`, name: p.name });
  }
  for (const u of keys.unassigned) card.append(unassignedRow(u, projectOptions, rows));
  return card;
}

function unassignedRow(u, projectOptions, rows) {
  const row = { kind: 'unassigned', entry: u, picker: null, idInput: null, dcSelect: null, projectOptions };
  const other = h('div', { class: 'row', hidden: true, style: 'margin-top:6px' });
  row.idInput = input({ mono: true, placeholder: 'Project id, e.g. 18244', ariaLabel: 'Project id' });
  row.idInput.style.width = '180px';
  row.dcSelect = select({ value: 'us', ariaLabel: 'Data center', options: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] });
  row.dcSelect.style.width = 'auto';
  other.append(row.idInput, row.dcSelect);
  row.picker = select({
    value: '', ariaLabel: `Project for ${u.label}`,
    options: [{ value: '', label: 'Don’t import' }, ...projectOptions, { value: '__other', label: 'Another project…' }],
    onChange: (v) => { other.hidden = v !== '__other'; },
  });
  row.picker.style.width = 'auto';
  const result = h('span');
  const test = button('Test', {
    size: 'sm',
    onClick: async () => {
      const dc = row.picker.value === '__other' ? row.dcSelect.value : (row.picker.value.startsWith('eu:') ? 'eu' : 'us');
      test.disabled = true;
      clear(result).append(chip('testing…'));
      const res = await testUnsavedKey(u.apiKey, dc);
      test.disabled = false;
      const c = chip(res.ok ? 'works' : (res.status ? String(res.status) : 'failed'), { tone: res.ok ? 'ok' : 'bad', dot: true });
      c.title = res.message;
      clear(result).append(c);
    },
  });
  rows.push(row);
  return h('div', { class: 'imp-item', style: 'grid-template-columns:1fr auto' },
    h('div', null,
      h('div', { style: 'font-weight:500' }, u.label),
      h('div', { class: 'wb-help', style: 'margin:0' }, h('span', { class: 'code' }, maskKey(u.apiKey)), ` · from ${u.sources.join(', ')}`),
      other),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' }, row.picker, test, result));
}

/** → { keep: [...], replace: [...] } or { error } */
function collectKeys(rows) {
  const keep = [], replace = [];
  for (const row of rows) {
    if (row.kind === 'assigned') {
      if (!row.cb.checked || row.state === 'same') continue;
      const item = { projectKey: row.entry.projectKey, name: row.entry.name, apiKey: row.entry.apiKey };
      if (row.state === 'conflict' && row.choice === 'replace') replace.push(item);
      else if (row.state === 'new') keep.push(item);
      continue;
    }
    const v = row.picker.value;
    if (!v) continue;
    if (v === '__other') {
      const id = row.idInput.value.trim();
      const projectKey = makeProjectKey({ dataCenter: row.dcSelect.value, id });
      if (!projectKey) return { error: `Enter a valid project id for “${row.entry.label}”.` };
      keep.push({ projectKey, name: `Project ${id}`, apiKey: row.entry.apiKey });
    } else {
      const opt = row.projectOptions.find((o) => o.value === v);
      keep.push({ projectKey: v, name: opt?.name || '', apiKey: row.entry.apiKey });
    }
  }
  return { keep, replace };
}

function resultView(outcome) {
  const k = outcome.keys;
  const keyParts = [];
  if (k.added) keyParts.push(`${k.added} key${k.added === 1 ? '' : 's'} added`);
  if (k.replaced) keyParts.push(`${k.replaced} replaced`);
  if (k.kept) keyParts.push(`${k.kept} kept as they were`);
  const tone = { import: 'ok', stash: 'accent', empty: undefined, error: 'bad', skipped: undefined };
  const label = { ...STATUS_LABEL, skipped: 'Skipped' };
  return h('div', { class: 'imp-list card' },
    h('h3', null, 'Import finished'),
    keyParts.length ? h('p', { class: 'wb-help', style: 'margin:0 0 6px' }, `API keys: ${keyParts.join(', ')}.`) : null,
    outcome.scripts.map((s) => h('div', { class: 'imp-item', style: 'grid-template-columns:1fr auto' },
      h('div', { style: 'font-weight:500' }, s.name),
      chip(label[s.status] || s.status, { tone: tone[s.status] }))),
    h('div', { class: 'actions' }, button('Review keys', { onClick: () => { location.hash = 'keys'; } })));
}

// ── Workbench backup ─────────────────────────────────────────────────────

function backupCard() {
  const includeKeys = switchInput({ checked: false, label: 'Include API keys' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast(`${file.name} is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB; that isn’t a Workbench backup.`, { tone: 'bad', source: 'Restore' });
      return;
    }
    let backup = null;
    try { backup = JSON.parse(await file.text()); } catch { /* handled below */ }
    await restoreBackup(backup);
  });

  return h('div', { class: 'card' },
    h('h3', null, 'Back up and restore Workbench'),
    h('p', { class: 'wb-help', style: 'margin:0 0 12px' },
      'Save your Workbench settings to a file, or move them to another browser.'),
    h('div', { class: 'row', style: 'margin-bottom:6px' }, includeKeys, h('span', { style: 'font-size:13px' }, 'Include API keys')),
    h('p', { class: 'wb-help', style: 'margin:0 0 12px' }, 'Off by default. Anyone with a file that includes keys can use them, so keep it somewhere safe.'),
    h('div', { class: 'row' },
      button('Download backup', { variant: 'primary', onClick: () => exportBackup(includeKeys.input.checked) }),
      button('Restore from a file', { onClick: () => fileInput.click() })),
    fileInput);
}

async function exportBackup(withKeys) {
  const all = await storage.getAll();
  const state = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(STORAGE.STATE_PREFIX)) continue;
    // Bulk-data checkpoints point at files on this machine and may hold row data; a restore
    // skips them anyway, so they don't go into the file.
    if (k.slice(STORAGE.STATE_PREFIX.length).split(':').slice(1).join(':').startsWith(CHECKPOINT_PREFIX)) continue;
    state[k] = v;
  }
  const backup = {
    app: WORKBENCH_BACKUP_APP,
    format: BACKUP_FORMAT,
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: await settings.readRaw(),
    state,
  };
  if (withKeys) {
    backup.keys = [];
    for (const p of await listProjects()) {
      if (!p.hasKey) continue;
      backup.keys.push({ projectKey: p.projectKey, name: p.name, dataCenter: p.dataCenter, apiKey: await getRawKey(p.projectKey) });
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`workbench-backup-${date}${withKeys ? '-with-keys' : ''}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

async function restoreBackup(backup) {
  const plan = planBackupRestore(backup, { metas: FEATURES });
  if (!plan.ok) {
    toast(plan.error, { tone: 'bad', source: 'Restore' });
    return;
  }

  // Keys are opt-in, one by one, unticked (like the Tampermonkey preview): a backup file can come
  // from anyone, and a key saved against the wrong project would send that project's data elsewhere.
  const keyRows = [];
  for (const k of plan.keys) {
    const existing = await getRawKey(k.projectKey).catch(() => null);
    const state = existing == null ? 'new' : existing === k.apiKey ? 'same' : 'conflict';
    const cb = h('input', { type: 'checkbox', checked: false, disabled: state === 'same', 'aria-label': `Restore key for ${k.name || k.projectKey}` });
    keyRows.push({ entry: k, state, cb });
  }

  const skippedNotes = [];
  if (plan.skipped.checkpoints) {
    skippedNotes.push(`${plan.skipped.checkpoints} unfinished bulk run${plan.skipped.checkpoints === 1 ? '' : 's'} (checkpoints aren’t restored)`);
  }
  if (plan.skipped.unknownFeature) skippedNotes.push(`${plan.skipped.unknownFeature} saved item${plan.skipped.unknownFeature === 1 ? '' : 's'} for features this version doesn’t have`);
  if (plan.skipped.invalid) skippedNotes.push(`${plan.skipped.invalid} saved item${plan.skipped.invalid === 1 ? '' : 's'} with an invalid name or value`);
  if (plan.invalidKeys) skippedNotes.push(`${plan.invalidKeys} API key entr${plan.invalidKeys === 1 ? 'y' : 'ies'} that aren’t valid`);

  const ok = await confirmDialog({
    title: 'Restore this backup?', brand: 'Restore', confirmLabel: 'Restore',
    body: h('div', { style: 'font-size:13px; line-height:1.5' },
      h('p', { style: 'margin:0 0 8px' }, `From ${plan.exportedAt ? new Date(plan.exportedAt).toLocaleString() : 'an unknown date'}:`),
      h('ul', { style: 'margin:0; padding-left:18px' },
        h('li', null, `Settings for ${plan.featureCount} of ${FEATURES.length} features, plus general settings`),
        h('li', null, `${plan.stateCount} saved item${plan.stateCount === 1 ? '' : 's'}`),
        skippedNotes.length ? h('li', null, `Left out: ${skippedNotes.join('; ')}`) : null),
      keyRows.length
        ? h('div', { style: 'margin-top:10px' },
          h('div', { style: 'font-weight:500' }, `API keys in this file (${keyRows.length})`),
          h('p', { class: 'wb-help', style: 'margin:2px 0 4px' }, 'Tick only the keys you want. Check each project before you do: a key saved against the wrong project sends requests to it.'),
          keyRows.map((r) => h('label', { class: 'imp-item', style: 'grid-template-columns:auto 1fr auto; padding:6px 0' },
            r.cb,
            h('div', null,
              h('div', { style: 'font-weight:500' }, r.entry.name || r.entry.projectKey, h('span', { class: 'wb-help' }, ` · ${r.entry.projectKey}`)),
              h('div', { class: 'wb-help', style: 'margin:0' }, h('span', { class: 'code' }, r.entry.masked),
                r.state === 'conflict' ? ' · a different key is saved for this project; ticking replaces it' : '')),
            r.state === 'same' ? chip('already saved') : r.state === 'new' ? chip('new', { tone: 'ok' }) : chip('replaces saved key', { tone: 'bad' }))))
        : h('p', { class: 'wb-help', style: 'margin:10px 0 0' }, 'No API keys in this file.'),
      h('p', { class: 'wb-help' }, 'Your current settings are replaced. Saved API keys are never removed.')),
  });
  if (!ok) return;

  // Read the ticks now: the dialog is gone but its elements keep their state.
  const keep = [];
  const replace = [];
  for (const r of keyRows) {
    if (!r.cb.checked || r.state === 'same') continue;
    const item = { projectKey: r.entry.projectKey, name: r.entry.name, dataCenter: r.entry.dataCenter, apiKey: r.entry.apiKey };
    (r.state === 'conflict' ? replace : keep).push(item);
  }

  await settings.replaceRaw(plan.settings);
  await writeStateEntries(plan.state);
  let keyNote = '';
  if (keep.length || replace.length) {
    const res = await importKeyLists({ keep, replace });
    const parts = [];
    if (res.added) parts.push(`${res.added} key${res.added === 1 ? '' : 's'} added`);
    if (res.replaced) parts.push(`${res.replaced} replaced`);
    if (res.invalid) parts.push(`${res.invalid} not valid`);
    if (parts.length) keyNote = ` ${parts.join(', ')}.`;
  }
  toast(`Backup restored.${keyNote}`, { tone: 'ok', source: 'Restore' });
}
