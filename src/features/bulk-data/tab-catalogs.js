// Bulk data → Catalogs tab: upload catalog items from a CSV (POST /api/catalogs/{name}/items) and
// export any catalog back to CSV (GET /api/catalogs/{name}/items, paged). Ported from the
// "Iterable Catalog Push" userscript's Upload and Export tabs.

import { h, clear, append } from '../../core/dom.js';
import { readHeader, streamRows, countDataRows, rowToObject } from '../../core/csv.js';
import { RateLimiter } from '../../core/retry.js';
import { button, select, segmented, iconButton, input, confirmDialog } from '../../ui/components.js';
import {
  checkpointName, otherCheckpointNames, failuresCsv, retryCsv, createStartGuard, resumeBlocker, classifyFailure,
  DRY_RUN_ROWS, PACING, nf, tsName, fmtBytes, fmtDuration,
} from './logic.js';
import {
  detectIdColumn, periodColumns, coerceCell, buildDocument, catalogRunItem, documentWeight, catalogBatchRequest,
  catalogItemsPath, catalogScope, describeCatalogScope, createExportCollector, exportColumns, exportCsvChunks,
  exportFileName, sweepDone,
  CATALOG_FAILURE_COLUMNS, CATALOG_SCOPE_PREFIX, MAX_DOC_BYTES, MAX_CATALOG_BODY_BYTES, EXPORT_MAX_SWEEPS, EXPORT_PAGE_SIZE,
} from './catalog-logic.js';
import { Run } from './engine.js';
import { sendCatalogBatch, fetchCatalogItemsPage } from './requests.js';
import { fileChip, pacingFields, progressBlock, banner, switchRow, runLog } from './ui.js';

const OTHER = '\u0000other';   // select value for "type a name" (can't collide with a catalog name)

export function createCatalogsTab(shell) {
  const { ctx, catalogs } = shell;
  const spec = PACING.catalogs;

  // ── Catalog pickers (upload target, export source) ────────────────────
  // A select filled from GET /api/catalogs, plus "Other…" for typing a name (a catalog the list
  // didn't return, or a list endpoint that failed). fromList() tells the two apart: a listed name
  // was loaded for a known project, a typed one isn't checked until the first request.
  function catalogPicker(label, onChange) {
    const sel = select({ options: [], ariaLabel: label, onChange: () => { typed.hidden = sel.value !== OTHER; if (!typed.hidden) typed.focus(); onChange(); } });
    const typed = input({ mono: true, placeholder: 'Catalog name', ariaLabel: label + ' name', onInput: onChange });
    typed.hidden = true;
    const note = h('div', { class: 'bd-hint' });
    const reload = iconButton('reload', { label: 'Reload catalogs', onClick: () => catalogs.refresh() });
    const el = h('div', { class: 'bd-view', style: 'gap:6px' },
      h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, label), sel, reload), typed, note);
    function render() {
      const prev = sel.value;
      const s = catalogs.state;
      clear(sel);
      sel.append(h('option', { value: '' }, s.loaded ? (s.names.length ? 'Choose a catalog' : 'No catalogs in this project') : 'Reload to load catalogs'));
      for (const n of s.names) sel.append(h('option', { value: n }, n));
      sel.append(h('option', { value: OTHER }, 'Other (type a name)…'));
      sel.value = prev === OTHER || (prev && catalogs.has(prev)) ? prev : '';
      typed.hidden = sel.value !== OTHER;
      note.textContent = s.loading ? 'Loading catalogs…' : s.error || '';
      note.classList.toggle('warn', !!s.error && !s.loading);
      if (sel.value !== prev) onChange();
    }
    return {
      el,
      render,
      value: () => (sel.value === OTHER ? typed.value.trim() : sel.value),
      fromList: () => sel.value !== OTHER && sel.value !== '',
      set(name) {
        if (catalogs.has(name)) { sel.value = name; typed.hidden = true; } else { sel.value = OTHER; typed.value = name; typed.hidden = false; }
        onChange();
      },
    };
  }

  // ── Upload ────────────────────────────────────────────────────────────
  const st = {
    file: null, header: null, idCol: null, badColumns: [], run: null, pendingResume: null,
    fileToken: 0, resumeToken: 0,
  };
  const starting = createStartGuard(() => syncButtons());

  const resumeWrap = h('div', { class: 'bd-view', hidden: true });
  const chipF = fileChip({ onFile: selectFile, emptyTitle: 'Drop a catalog CSV here, or choose a file' });
  const headerProblem = h('div', { class: 'bd-view', hidden: true });
  const target = catalogPicker('Catalog', () => { syncButtons(); refreshResume(); });
  const idSel = select({ options: [{ value: '', label: 'Select a CSV first' }], ariaLabel: 'Item ID column', onChange: onIdColChange });
  const idHint = h('div', { class: 'bd-hint' }, 'Becomes the key in ', h('code', null, 'documents'),
    '. Letters, digits and dashes only, 255 characters max. It is not also sent as a field.');
  const merge = switchRow('Merge fields only', { checked: true, onChange: () => { updateModeUi(); refreshResume(); } });
  const mergeHint = h('div', { class: 'bd-hint' });
  const forceText = switchRow('All values as text', { onChange: refreshResume });
  const opts = h('fieldset', { class: 'bd-sec' },
    target.el,
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Item ID column'), idSel),
    idHint,
    merge.el, mergeHint,
    forceText.el,
    h('div', { class: 'bd-hint' }, 'Catalog field types are set by the first value written and stick. Turn this on when numeric-looking values are really codes or IDs: otherwise ',
      h('code', null, '00123'), ' keeps its zeros but ', h('code', null, '12345'), ' becomes a number for good.'));

  const pacing = pacingFields({ values: shell.values, save: shell.saveValues, subscribe: shell.subscribeValues, spec, batchLabel: 'Items per batch' });
  const prog = progressBlock({ skippedWhy: 'bad ID or document too large' });
  const runBtn = button('Upload', { variant: 'primary', disabled: true, onClick: onRunButton });
  const stopBtn = button('Stop', { disabled: true, onClick: () => st.run?.stop() });
  const dryBtn = button('Dry run', { variant: 'ghost', disabled: true, onClick: doDryRun });
  const failBtn = button('Download failures', { variant: 'ghost', size: 'sm', disabled: true, onClick: () => {
    if (st.run) ctx.dom.downloadBlob('catalog_failures_' + tsName() + '.csv', failuresCsv(st.run.failures, CATALOG_FAILURE_COLUMNS), 'text/csv;charset=utf-8');
  } });
  const retryBtn = button('Retry CSV', { variant: 'ghost', size: 'sm', disabled: true, title: 'Every row of the batches that failed, in the original columns', onClick: () => {
    if (st.run) ctx.dom.downloadBlob('catalog_retry_' + tsName() + '.csv', retryCsv(st.header, st.run.retryRows), 'text/csv;charset=utf-8');
  } });
  const dryOut = h('details', { class: 'bd-dry', hidden: true });

  const uploadView = h('div', { class: 'bd-view' },
    resumeWrap, chipF.el, headerProblem, opts, pacing.el, prog.el,
    h('div', { class: 'row' }, runBtn, stopBtn, dryBtn, h('span', { style: 'flex:1' }), failBtn, retryBtn),
    dryOut);
  prog.log.add('Ready. Choose a catalog and a CSV with an item ID column.');
  updateModeUi();

  async function selectFile(file) {
    if (st.run?.running || starting.busy) return;
    const token = ++st.fileToken;
    st.resumeToken++;
    Object.assign(st, { file, header: null, idCol: null, badColumns: [], run: null, pendingResume: null });
    dryOut.hidden = true;
    headerProblem.hidden = true;
    resumeWrap.hidden = true;
    failBtn.disabled = true; retryBtn.disabled = true;
    failBtn.textContent = 'Download failures'; retryBtn.textContent = 'Retry CSV';
    prog.idle();
    populateIdSelect([]);
    chipF.set(file, 'Reading header…');
    syncButtons();

    let header;
    try { header = await readHeader(file); } catch (err) {
      if (token === st.fileToken) chipF.set(file, 'Could not read the file: ' + (err?.message || err), true);
      return;
    }
    if (token !== st.fileToken) return;
    if (!header || !header.length) { chipF.set(file, 'This CSV is empty.', true); return; }
    st.header = header;
    // Periods address nested paths in Iterable, so a flat "a.b" field can't be referenced again.
    // Block rather than silently rename.
    st.badColumns = periodColumns(header);
    clear(headerProblem);
    if (st.badColumns.length) {
      headerProblem.append(banner({ tone: 'bad', chipText: 'Periods', chipTone: 'bad',
        text: 'Field names can’t contain periods: ' + st.badColumns.join(', ') + '. Rename these columns in the CSV and select it again. ' +
          'Iterable uses periods for nested paths, so a flat field with one in its name can’t be referenced afterwards.' }));
    }
    headerProblem.hidden = !st.badColumns.length;
    populateIdSelect(header);
    st.idCol = detectIdColumn(header);
    idSel.value = st.idCol || '';
    renderFileMeta();
    prog.log.add('Selected ' + file.name + '.');
    syncButtons();
    refreshResume();
  }

  function populateIdSelect(header) {
    clear(idSel);
    idSel.append(h('option', { value: '' }, header.length ? 'Choose the ID column' : 'Select a CSV first'));
    for (const c of header) idSel.append(h('option', { value: c }, c));
  }

  function renderFileMeta() {
    if (!st.file || !st.header) return;
    const detected = detectIdColumn(st.header);
    chipF.set(st.file, fmtBytes(st.file.size) + ' · ' + st.header.length + ' columns · ID column: ' +
      (st.idCol ? st.idCol + (st.idCol === detected ? ' (detected)' : '') : 'pick one below'), !st.idCol);
  }

  function onIdColChange() {
    st.idCol = idSel.value || null;
    renderFileMeta();
    syncButtons();
    refreshResume();
  }

  function updateModeUi() {
    clear(mergeHint);
    if (merge.input.checked) {
      mergeHint.className = 'bd-hint';
      mergeHint.append('Sends ', h('code', null, 'replaceUploadedFieldsOnly: true'),
        ': only the columns in this CSV are written; everything else on an existing item is left alone.');
    } else {
      mergeHint.className = 'bd-note bad';
      mergeHint.append('Destructive: every matching item is completely overwritten by its CSV row. Any field the catalog has that this CSV doesn’t is removed.');
    }
  }

  function readOptions() {
    const v = shell.values();
    return {
      catalogName: target.value(),
      idCol: st.idCol,
      merge: merge.input.checked,
      forceText: forceText.input.checked,
      rateLimit: v[spec.rateKey],
      batchSize: v[spec.batchKey],
    };
  }

  // ── Resume ────────────────────────────────────────────────────────────
  async function refreshResume() {
    const token = ++st.resumeToken;
    st.pendingResume = null;
    clear(resumeWrap);
    resumeWrap.hidden = true;
    if (!st.file || !st.header || !st.idCol || st.run?.running) return;
    const o = readOptions();
    if (!o.catalogName) return;
    const scope = catalogScope(o);
    const name = checkpointName(scope, st.file);
    const ck = await ctx.state.get(name, null);
    if (token !== st.resumeToken) return;

    if (!ck || !ck.committedRows) {
      for (const other of otherCheckpointNames(await ctx.state.list(), st.file, scope, CATALOG_SCOPE_PREFIX)) {
        const data = await ctx.state.get(other.name, null);
        if (token !== st.resumeToken) return;
        if (!data || !(data.committedRows > 0)) continue;
        resumeWrap.append(banner({ tone: 'info', chipText: 'Note', chipTone: 'accent',
          text: 'This file has an unfinished upload saved under different settings (' + describeCatalogScope(other.scope, data) + ', ' +
            nf(data.committedRows) + ' rows done). It won’t resume into the current settings; switch back to match it to continue.' }));
        resumeWrap.hidden = false;
        break;
      }
      return;
    }

    st.pendingResume = { ck, name };
    const when = ck.savedAt ? new Date(ck.savedAt).toLocaleString() : 'earlier';
    resumeWrap.append(banner({
      chipText: 'Paused run',
      text: st.file.name + ' stopped at row ' + nf(ck.committedRows) + ' of ' + nf(ck.totalRows) + ' → ' + describeCatalogScope(scope, ck) +
        (ck.projectName ? ' in ' + ck.projectName : '') + ', saved ' + when + '.',
      actions: [
        { label: 'Resume', onClick: () => guardedStart(ck) },
        { label: 'Start over', variant: 'ghost', onClick: async () => {
          if (starting.busy || st.run?.running) return;
          await ctx.state.remove(name);
          st.pendingResume = null;
          resumeWrap.hidden = true;
          prog.log.add('Saved progress discarded. The next upload starts from row 1.');
        } },
      ],
    }));
    resumeWrap.hidden = false;
    syncButtons();
  }

  // ── Dry run ───────────────────────────────────────────────────────────
  async function doDryRun() {
    if (!uploadReady() || st.run?.running || starting.busy) return;
    const o = readOptions();
    dryBtn.disabled = true;
    clear(dryOut);
    dryOut.hidden = false;
    dryOut.open = true;
    dryOut.append(h('summary', null, 'Dry run: nothing is sent'),
      h('div', { class: 'bd-note', style: 'margin-top:8px' }, 'Reading the first ' + nf(DRY_RUN_ROWS) + ' rows and counting the file…'));

    const samples = [];
    const colTypes = Object.create(null);
    const problems = Object.create(null);
    const seenIds = new Set();
    let examined = 0, dupes = 0, maxBytes = 0, total = 0;
    try {
      await streamRows(st.file, (fields) => {
        if (examined >= DRY_RUN_ROWS) return 'stop';
        examined++;
        const obj = rowToObject(st.header, fields);
        const built = buildDocument(obj, o.idCol, o.forceText);
        if (built.error) {
          problems[built.error] = (problems[built.error] || 0) + 1;
        } else {
          if (built.bytes > maxBytes) maxBytes = built.bytes;
          if (seenIds.has(built.id)) dupes++; else seenIds.add(built.id);
          if (samples.length < 3) samples.push(built);
        }
        for (const col of st.header) {
          if (col === o.idCol) continue;
          const val = coerceCell(obj[col], o.forceText);
          if (val === undefined) continue;
          const t = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
          (colTypes[col] || (colTypes[col] = Object.create(null)))[t] = true;
        }
        return examined >= DRY_RUN_ROWS ? 'stop' : undefined;
      });
      total = await countDataRows(st.file);   // a raw newline scan, never a full parse
    } catch (err) {
      clear(dryOut);
      dryOut.append(h('summary', null, 'Dry run failed'), h('div', { class: 'bd-note bad' }, String(err?.message || err)));
      dryBtn.disabled = false;
      return;
    }

    const nBatches = Math.ceil(total / o.batchSize);
    const estMin = o.rateLimit > 0 ? nBatches / o.rateLimit / 60 : 0;
    const lines = [
      'endpoint:     POST ' + catalogItemsPath(o.catalogName || '<choose a catalog>'),
      'id column:    ' + o.idCol + '   (map key; not sent as a field)',
      'mode:         replaceUploadedFieldsOnly: ' + o.merge + (o.merge ? '   (merge)' : '   (FULL OVERWRITE)'),
      'values:       ' + (o.forceText ? 'all sent as text' : 'type-inferred'),
      'total rows:   ' + nf(total),
      'batches:      ' + nf(nBatches) + ' × ' + nf(o.batchSize) + ' at ' + o.rateLimit + ' req/s' +
        '   (closed early at ' + fmtBytes(MAX_CATALOG_BODY_BYTES) + ' of documents)',
      'estimated:    ' + estMin.toFixed(1) + ' minutes of request pacing (network time not included)',
      'largest doc:  ' + nf(maxBytes) + ' bytes of ' + nf(MAX_DOC_BYTES) + ' allowed (sampled)',
    ];
    const problemRows = Object.keys(problems).map((k) => h('tr', null, h('td', { class: 'bad' }, k), h('td', null, nf(problems[k]))));
    const typeRows = st.header.filter((c) => c !== o.idCol).slice().sort().map((c) => h('tr', null,
      h('td', null, c), h('td', null, colTypes[c] ? Object.keys(colTypes[c]).sort().join(', ') : 'always empty')));

    clear(dryOut);
    // core/dom append: flattens the arrays and skips the nulls below (Element.append would print them).
    append(dryOut,
      h('summary', null, 'Dry run: nothing was sent'),
      h('pre', null, lines.join('\n')),
      problemRows.length ? [
        h('div', { class: 'bd-h', style: 'margin-top:10px; color:var(--wb-bad)' }, 'Rows that would be skipped (first ' + nf(examined) + ')'),
        h('table', null, h('tbody', null, problemRows)),
      ] : null,
      dupes ? h('div', { class: 'bd-note warn', style: 'margin-top:8px' }, nf(dupes) + ' duplicate item ID' + (dupes === 1 ? '' : 's') +
        ' in the sample. Duplicates inside one batch collapse into a single document (last row wins); across batches the later batch overwrites the earlier one.') : null,
      h('div', { class: 'bd-h', style: 'margin-top:10px' }, 'Inferred field types, first ' + nf(examined) + ' rows'),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'field'), h('th', null, 'type(s)'))),
        h('tbody', null, typeRows.length ? typeRows : h('tr', null, h('td', { colspan: '2' }, 'No fields besides the ID.')))),
      h('div', { class: 'bd-h', style: 'margin-top:10px' }, 'Sample documents (entries in the documents map)'),
      samples.length ? samples.map((s) => h('pre', null, JSON.stringify({ [s.id]: s.doc }, null, 2))) : h('div', { class: 'bd-note' }, 'No valid rows in the sample.'));
    dryBtn.disabled = false;
  }

  // ── Run ───────────────────────────────────────────────────────────────
  function uploadReady() {
    return !!(st.file && st.header && st.idCol && !st.badColumns.length);
  }

  function onRunButton() {
    const r = st.run;
    if (r?.running) { if (r.paused) r.resume(); else r.pause(); return; }
    if (starting.busy) return;
    if (st.pendingResume) { shell.toast('Choose Resume or Start over first.', 'warn'); return; }
    guardedStart(null);
  }

  function guardedStart(ck) {
    return starting.run(() => confirmAndStart(ck));
  }

  /** A full overwrite is destructive, so it (and a resume of one) goes through a confirm; merge doesn't. */
  async function confirmAndStart(ck) {
    if (st.run?.running || !uploadReady()) return;
    const o = readOptions();
    if (!o.catalogName) { shell.toast('Choose the catalog to upload into.', 'warn'); return; }
    if (!o.merge) {
      const ok = await confirmDialog({
        title: 'Overwrite catalog items?',
        brand: 'Bulk data',
        danger: true,
        confirmLabel: 'Overwrite and upload',
        body: h('div', { class: 'bd-view', style: 'gap:8px' },
          h('div', null, 'Full overwrite: every matching item in ', h('b', null, o.catalogName),
            ' is replaced by its CSV row. Fields not in this CSV are removed. Iterable cannot undo this.'),
          h('div', { class: 'endpoint' }, h('b', null, 'POST'), ' ' + catalogItemsPath(o.catalogName))),
      });
      if (!ok) return;
    }
    await startUpload(ck);
  }

  async function startUpload(ck) {
    if (st.run?.running || !uploadReady()) return;
    const pin = await shell.pin({ quiet: false });
    if (!pin) { syncButtons(); return; }
    const o = readOptions();
    if (!o.catalogName) { syncButtons(); return; }
    if (target.fromList() && catalogs.state.projectKey !== pin.projectKey) {
      shell.toast('The project changed since the catalogs were loaded. Reload the catalogs and choose the catalog again.', 'bad');
      catalogs.reset();
      syncButtons();
      return;
    }
    if (resumeBlocker(ck, pin.projectKey)) {
      shell.toast(ck.projectKey
        ? 'This upload was started in ' + (ck.projectName || 'another project') + '. Switch back to that project to resume it, or choose Start over.'
        : 'This saved upload doesn’t record which project it was for, so it can’t be resumed safely. Choose Start over.', 'bad');
      syncButtons();
      return;
    }

    // Frozen at start, like the project: changing the options mid-run changes nothing.
    const { catalogName, idCol, forceText: asText } = o;
    const mergeMode = o.merge;
    const scope = catalogScope(o);
    const ckName = checkpointName(scope, st.file);
    const limiter = new RateLimiter(o.rateLimit);
    const path = catalogItemsPath(catalogName);
    st.pendingResume = null;
    resumeWrap.hidden = true;

    const run = new Run({
      file: st.file, header: st.header, batchSize: o.batchSize, signal: ctx.signal,
      buildItem: (obj) => catalogRunItem(obj, idCol, asText),
      weightOf: documentWeight,
      maxBatchWeight: MAX_CATALOG_BODY_BYTES,
      idsOf: (obj) => ({ itemId: obj[idCol] || '' }),
      sendBatch: async (items, r) => {
        const req = catalogBatchRequest(catalogName, items, { merge: mergeMode });
        const res = await sendCatalogBatch({ request: pin.request, path: req.path, body: req.body, limiter, signal: ctx.signal, run: r });
        return { ...res, collisions: req.collisions };
      },
      onBatchOk: (res, items, r) => {
        const c = res.collisions || 0;
        if (c) {
          r.stats.collisions += c;
          r.log('Batch ' + r.batchNo + ': ' + nf(c) + ' duplicate item ID' + (c === 1 ? '' : 's') +
            ' inside this batch; only the last row for each was sent.', 'warn');
        }
        return { success: items.length - c, fail: 0 };
      },
      checkpoints: { save: (d) => ctx.state.set(ckName, d), clear: () => ctx.state.remove(ckName) },
      checkpointMeta: { projectKey: pin.projectKey, projectName: pin.projectName, catalogName, idCol, merge: mergeMode, forceText: asText },
      onLog: (m, c) => prog.log.add(m, c),
      onChange: (r) => { prog.render(r); syncButtons(); shell.runsChanged(); },
    });
    run.projectKey = pin.projectKey;
    run.projectName = pin.projectName;
    run.label = 'Catalog upload';
    st.run = run;
    shell.trackRun(run);

    dryOut.open = false;
    prog.log.clear();
    prog.log.add('Project: ' + pin.projectName + (pin.masked ? ' (key ' + pin.masked + ')' : ''));
    prog.log.add('Target: POST ' + path + (mergeMode ? ' (merge fields only)' : ''));
    if (!mergeMode) prog.log.add('FULL OVERWRITE: matching items are replaced entirely; fields absent from this CSV are removed.', 'warn');
    if (asText) prog.log.add('All values are sent as text.');
    prog.log.add('Catalog uploads are asynchronous: an accepted batch means Iterable queued it, not that every item was written. ' +
      'Per-item rejections are only visible in the catalog itself.', 'warn');
    prog.log.add('Pacing: ' + o.rateLimit + ' req/s, up to ' + nf(o.batchSize) + ' items per batch.');
    syncButtons();

    await run.start(ck ? (ck.committedRows || 0) : 0, ck ? ck.stats : null);

    if (run.finished) {
      prog.log.add('Iterable processes catalog uploads asynchronously. "ok" means the batches were accepted, not that every item landed. ' +
        'Check the catalog in Iterable to confirm.', 'warn');
    }
    failBtn.disabled = !run.failures.length;
    failBtn.textContent = run.failures.length ? 'Download failures (' + nf(run.failures.length) + ')' : 'Download failures';
    retryBtn.disabled = !run.retryRows.length;
    retryBtn.textContent = run.retryRows.length ? 'Retry CSV (' + nf(run.retryRows.length) + ')' : 'Retry CSV';
    shell.runEnded(run);
    syncButtons();
    refreshResume();
  }

  // ── Export ────────────────────────────────────────────────────────────
  // Read-only, so simpler than the upload: no checkpoint, no pause, no failure file. Items are
  // kept in memory (the column union isn't known until the last page), then written as Blob
  // chunks that the upload side takes straight back.
  const exportGuard = createStartGuard(() => syncExport());
  let exp = null;          // the current / last export (a Run-like object for the shell)
  let lastExport = null;   // { blob, name } for "Download again"

  const source = catalogPicker('Catalog', () => syncExport());
  const pageSizeIn = input({ value: String(EXPORT_PAGE_SIZE), mono: true, type: 'number', min: '1', max: '1000', step: '1', ariaLabel: 'Page size' });
  pageSizeIn.style.width = '90px';
  const orderByIn = input({ mono: true, placeholder: '(Iterable default)', ariaLabel: 'Order by' });
  orderByIn.style.cssText = 'width:200px; flex:none';
  const exportOpts = h('fieldset', { class: 'bd-sec' },
    source.el,
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Page size'), pageSizeIn),
    h('div', { class: 'bd-hint' }, 'Items per ', h('code', null, 'GET /api/catalogs/{name}/items'),
      ' page. Iterable doesn’t document a maximum; if a page comes back 400, or never arrives because it is too large, lower this.'),
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Order by'), orderByIn),
    h('div', { class: 'bd-hint' }, 'Optional ', h('code', null, 'orderBy'), ' field. Iterable’s default order has no documented tiebreaker, and page boundaries shift if the catalog is written to mid-export. ' +
      'Items are deduplicated by ID and short passes are re-swept regardless; a stable sort field makes that rarely necessary.'),
    h('div', { class: 'bd-hint' }, 'Output: an ', h('code', null, 'id'), ' column, then every field found. Nested values are written as JSON. The file re-imports as-is with Upload; ',
      h('code', null, 'lastModified'), ' and ', h('code', null, 'size'), ' are metadata and are left out on purpose.'));

  const xPct = h('span', { class: 'code' }, '0%');
  const xEta = h('span', { class: 'wb-help', style: 'margin:0' }, 'Not started');
  const xBar = h('i');
  const tile = (k) => { const v = h('div', { class: 'v' }, '0'); return { el: h('div', { class: 'stat' }, h('div', { class: 'k' }, k), v), v }; };
  const xItems = tile('Items'), xPages = tile('Pages'), xDupes = tile('Re-served'), xRetries = tile('Retries');
  const xLog = runLog();
  const exportBtn = button('Export CSV', { variant: 'primary', disabled: true, onClick: () => startExport(source.value()) });
  const exportStop = button('Stop', { disabled: true, onClick: () => exp?.stop() });
  const againBtn = button('Download again', { variant: 'ghost', size: 'sm', disabled: true, onClick: () => {
    if (lastExport) ctx.dom.downloadBlob(lastExport.name, lastExport.blob);
  } });
  const exportView = h('div', { class: 'bd-view', hidden: true },
    exportOpts,
    h('div', null,
      h('div', { class: 'row', style: 'justify-content:space-between; margin-bottom:6px; font-size:12px' }, xPct, xEta),
      h('div', { class: 'bigbar' }, xBar)),
    h('div', { class: 'stats' }, xItems.el, xPages.el, xDupes.el, xRetries.el),
    xLog.el,
    h('div', { class: 'row' }, exportBtn, exportStop, h('span', { style: 'flex:1' }), againBtn));
  xLog.add('Choose a catalog and Export, or use the Export CSV button on any row of the catalogs list.');

  function renderExport() {
    if (!exp) return;
    const known = exp.totalRows > 0;
    const s = exp.snapshot();
    xPct.textContent = known ? s.pct.toFixed(1) + '%' : '–';
    xBar.style.width = (known ? s.pct : 0).toFixed(1) + '%';
    const items = nf(exp.committed) + (known ? ' / ' + nf(exp.totalRows) : '') + ' items';
    if (exp.running) xEta.textContent = items + (known && s.rate > 0 ? ' · about ' + fmtDuration(s.eta) + ' left' : '');
    else if (exp.finished) xEta.textContent = items + ' · done';
    else xEta.textContent = items + ' · stopped';
    xItems.v.textContent = nf(exp.committed);
    xPages.v.textContent = nf(exp.pages);
    xDupes.v.textContent = nf(exp.dupes);
    xRetries.v.textContent = nf(exp.stats.retries);
    shell.runsChanged();
  }

  function syncExport() {
    const running = !!exp?.running;
    exportBtn.disabled = running || exportGuard.busy || !source.value();
    exportStop.disabled = !running;
    exportOpts.disabled = running || exportGuard.busy;
  }

  function newExport(name, pin) {
    const e = {
      label: 'Catalog export', catalogName: name, projectKey: pin.projectKey, projectName: pin.projectName,
      running: true, paused: false, stopRequested: false, finished: false, fatal: null, error: null, endToast: null,
      committed: 0, totalRows: 0, startTime: Date.now(), pages: 0, dupes: 0,
      stats: { sentOk: 0, failed: 0, retries: 0 },
      snapshot() { return Run.prototype.snapshot.call({ ...this, startOffset: 0 }); },
      stop() { this.stopRequested = true; syncExport(); },
      pause() {}, resume() {},
    };
    return e;
  }

  /** Export `name` (from the picker or a catalogs-index row) of the pinned project. */
  function startExport(name) {
    name = String(name || '').trim();
    if (!name) { shell.toast('Choose the catalog to export.', 'warn'); return Promise.resolve(); }
    if (exp?.running) { shell.toast('An export is already running.', 'warn'); return Promise.resolve(); }
    return exportGuard.run(() => runExport(name));
  }

  async function runExport(name) {
    const pin = await shell.pin({ quiet: false });
    if (!pin) return;
    if (source.value() === name && source.fromList() && catalogs.state.projectKey !== pin.projectKey) {
      shell.toast('The project changed since the catalogs were loaded. Reload the catalogs and choose the catalog again.', 'bad');
      catalogs.reset();
      return;
    }
    const pageSize = Math.max(1, Math.min(1000, parseInt(pageSizeIn.value, 10) || EXPORT_PAGE_SIZE));
    pageSizeIn.value = String(pageSize);
    const orderBy = orderByIn.value.trim();
    const rate = shell.values()[spec.rateKey];
    const limiter = new RateLimiter(rate);
    const path = catalogItemsPath(name);
    const e = newExport(name, pin);
    exp = e;
    shell.trackRun(e);
    syncExport();
    xLog.clear();
    xLog.add('Project: ' + pin.projectName + (pin.masked ? ' (key ' + pin.masked + ')' : ''));
    xLog.add('Source: GET ' + path + '?pageSize=' + pageSize + (orderBy ? '&orderBy=' + orderBy : '') + ' at ' + rate + ' req/s');
    renderExport();

    const collector = createExportCollector();
    let fetched = 0, failure = null;

    // One pass over the pages: adds only unseen items; ends on a short page, on reaching the
    // reported total (unique count), on Stop or on an error. → items this pass added.
    const sweep = async (sweepNo) => {
      let added = 0;
      for (let page = 1; ; page++) {
        if (e.stopRequested) return added;
        const t0 = Date.now();
        const res = await fetchCatalogItemsPage({ request: pin.request, path, page, pageSize, orderBy, limiter, signal: ctx.signal,
          onRetry: (line) => { e.stats.retries++; xLog.add(line, 'warn'); renderExport(); } });
        if (!res.ok) {
          failure = { ...classifyFailure(res), status: res.status, res };
          const hint = res.status === 400 ? ': try a smaller page size' + (orderBy ? ' or clear Order by' : '')
            : res.status === 404 ? ': no catalog named "' + name + '" in ' + pin.projectName
              : res.status === 0 && !failure.reason.startsWith('no_key') ? ': if pages are large, try a smaller page size' : '';
          xLog.add('Page ' + page + ' failed: ' + failure.summary + hint + '.', 'bad');
          return added;
        }
        if (!e.totalRows && res.total != null) {
          e.totalRows = res.total;
          xLog.add('Catalog reports ' + nf(e.totalRows) + ' items.');
        }
        fetched += res.items.length;
        const r = collector.add(res.items);
        added += r.added;
        e.pages++;
        e.dupes += r.dupes;
        e.committed = collector.rows.length;
        e.stats.sentOk = collector.rows.length;
        xLog.add((sweepNo > 1 ? 'Sweep ' + sweepNo + ' · ' : '') + 'Page ' + page + ': ' + nf(res.items.length) + ' items' +
          (r.dupes ? ', ' + nf(r.dupes) + ' already seen' : '') + ' in ' + ((Date.now() - t0) / 1000).toFixed(2) + 's',
        r.dupes && sweepNo === 1 ? 'warn' : 'ok');
        renderExport();
        // The nextPageUrl the docs describe isn't in the live response, so it isn't consulted.
        if (sweepDone({ pageLength: res.items.length, pageSize, unique: collector.rows.length, total: e.totalRows })) return added;
      }
    };

    try {
      for (let sweepNo = 1; sweepNo <= EXPORT_MAX_SWEEPS; sweepNo++) {
        const added = await sweep(sweepNo);
        if (failure || e.stopRequested) break;
        if (!(e.totalRows && collector.rows.length < e.totalRows)) break;
        if (sweepNo > 1 && added === 0) { xLog.add('Sweep ' + sweepNo + ' found nothing new, so stopping.', 'warn'); break; }
        if (sweepNo < EXPORT_MAX_SWEEPS) {
          xLog.add('Pass ' + sweepNo + ' ended with ' + nf(collector.rows.length) + ' of ' + nf(e.totalRows) + ' unique items (' +
            nf(e.dupes) + ' re-served across page boundaries). Re-sweeping the pages for the missing ' + nf(e.totalRows - collector.rows.length) + '…', 'warn');
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && !ctx.signal.aborted) {
        e.error = err;
        xLog.add('Export ended with an error: ' + (err?.message || err) + '. Nothing written.', 'bad');
        e.endToast = { message: 'Catalog export: ended with an error. Nothing was written.', tone: 'bad' };
      } else {
        e.stopRequested = true;
      }
    }

    e.running = false;
    const elapsed = (Date.now() - e.startTime) / 1000;
    const rows = collector.rows;
    if (e.error) {
      // reported above
    } else if (failure) {
      if (failure.status === 401 || failure.status === 403 || failure.reason === 'no_key') shell.handleAuthFailure(failure.res, pin);
      e.endToast = { message: 'Catalog export failed: ' + failure.summary + '. Nothing was written.', tone: 'bad' };
    } else if (e.stopRequested) {
      xLog.add('Stopped after ' + nf(rows.length) + ' items. Nothing written.', 'warn');
      e.endToast = { message: 'Catalog export stopped. Nothing was written.', tone: 'warn' };
    } else {
      e.finished = true;
      const columns = exportColumns(rows);
      const blob = new Blob(exportCsvChunks(rows, columns), { type: 'text/csv;charset=utf-8' });
      lastExport = { blob, name: exportFileName(name, tsName()) };
      xLog.add('Done. ' + nf(rows.length) + ' items, ' + nf(columns.length) + ' field' + (columns.length === 1 ? '' : 's') + ', ' +
        fmtBytes(blob.size) + ' in ' + fmtDuration(elapsed) + '.', 'ok');
      if (e.dupes) {
        xLog.add(nf(e.dupes) + ' item' + (e.dupes === 1 ? ' was' : 's were') + ' served more than once across page boundaries and deduplicated by ID (' +
          nf(fetched) + ' fetched → ' + nf(rows.length) + ' unique).', 'warn');
      }
      if (e.totalRows && rows.length < e.totalRows) {
        const missing = e.totalRows - rows.length;
        xLog.add('INCOMPLETE: Iterable reports ' + nf(e.totalRows) + ' items but only ' + nf(rows.length) + ' unique items could be retrieved after ' +
          EXPORT_MAX_SWEEPS + ' passes; ' + nf(missing) + ' missing. The catalog is probably being written to: try again when it is quiet, or set Order by to a field with a stable value.', 'bad');
        e.endToast = { message: 'Catalog export INCOMPLETE: ' + nf(missing) + ' of ' + nf(e.totalRows) + ' items could not be retrieved.', tone: 'bad' };
      } else if (e.totalRows && rows.length > e.totalRows) {
        xLog.add('Retrieved ' + nf(rows.length) + ' unique items against a reported ' + nf(e.totalRows) + '; items were probably added mid-export.', 'warn');
        e.endToast = { message: 'Exported ' + nf(rows.length) + ' items from ' + name + '.', tone: 'ok' };
      } else {
        e.endToast = { message: 'Exported ' + nf(rows.length) + ' items from ' + name + '.', tone: 'ok' };
      }
      ctx.dom.downloadBlob(lastExport.name, blob);
      againBtn.disabled = false;
    }
    renderExport();
    syncExport();
    shell.runEnded(e);
  }

  // ── Tab shell ─────────────────────────────────────────────────────────
  const modeSeg = segmented({
    ariaLabel: 'Catalogs mode', value: 'upload',
    options: [{ value: 'upload', label: 'Upload CSV' }, { value: 'export', label: 'Export to CSV' }],
    onChange: (v) => setMode(v),
  });
  modeSeg.classList.add('bd-mode');
  const el = h('div', { class: 'bd-view' }, modeSeg, uploadView, exportView);

  function setMode(m) {
    uploadView.hidden = m !== 'upload';
    exportView.hidden = m !== 'export';
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.value === m));
  }

  function syncButtons() {
    const r = st.run;
    const running = !!r?.running;
    const busy = running || starting.busy;
    const ready = uploadReady();
    runBtn.textContent = running ? (r.paused ? 'Resume' : 'Pause') : 'Upload';
    runBtn.disabled = running ? false : (!ready || !target.value() || starting.busy);
    stopBtn.disabled = !running;
    dryBtn.disabled = busy || !ready;
    opts.disabled = busy;
    chipF.setDisabled(busy);
    for (const b of resumeWrap.querySelectorAll('button')) b.disabled = busy;
  }

  const renderPickers = () => { target.render(); source.render(); };
  const unsubCatalogs = catalogs.subscribe(renderPickers);
  renderPickers();
  syncButtons();
  syncExport();

  // Load the names on first show once the project has a key (quietly: pin() toasts otherwise).
  let autoLoadedFor = null;
  function maybeAutoLoad() {
    if (el.hidden || catalogs.state.loaded || catalogs.state.loading) return;
    const k = shell.keyInfo();
    if (!k || !k.hasKey || k.error || autoLoadedFor === k.projectKey) return;
    autoLoadedFor = k.projectKey;
    catalogs.refresh();
  }
  const unsubStatus = shell.onStatus(maybeAutoLoad);

  // A run keeps the project it started with; a switch is reported, never applied.
  const unsubProject = shell.onProjectChange((next) => {
    for (const r of [st.run, exp]) {
      if (!r?.running || !next || next.key === r.projectKey || r.warnedProject === next.key) continue;
      r.warnedProject = next.key;
      (r === exp ? xLog : prog.log).add('The page switched to ' + next.name + '. This ' + (r === exp ? 'export keeps reading from ' : 'upload keeps sending to ') +
        r.projectName + ', where it started.', 'warn');
    }
  });

  return {
    id: 'catalogs',
    label: 'Catalogs',
    el,
    isRunning: () => !!st.run?.running || !!exp?.running,
    onShow: maybeAutoLoad,
    /** Export one catalog now (the catalogs-index row buttons). */
    exportCatalog(name) {
      setMode('export');
      source.set(name);
      return startExport(name);
    },
    destroy() { unsubCatalogs(); unsubStatus(); unsubProject(); pacing.destroy(); },
  };
}
