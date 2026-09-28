// Bulk data → Users tab: stream a CSV into users/bulkUpdate, or into lists/subscribe with full
// profile fields when "Add to list" is chosen. Ported from the "Iterable User Push" Push tab.

import { h, clear, append } from '../../core/dom.js';
import { readHeader, streamRows, countDataRows, rowToObject } from '../../core/csv.js';
import { RateLimiter } from '../../core/retry.js';
import { button, segmented, iconButton, input, confirmDialog, chip } from '../../ui/components.js';
import {
  detectKeyColumns, buildUser, inferValue, clearSetOf, isEmptyCell, countCleared, collectPartialFailures,
  usersBatchRequest, pushScope, describeScope, checkpointName, otherPushCheckpointNames, failuresCsv, retryCsv,
  createStartGuard, resumeBlocker,
  USER_FAILURE_COLUMNS, DRY_RUN_ROWS, nf, tsName,
} from './logic.js';
import { Run } from './engine.js';
import { sendBatch } from './requests.js';
import { fileChip, fileMeta, pacingFields, progressBlock, banner, switchRow, listPicker } from './ui.js';

export function createUsersTab(shell) {
  const { ctx } = shell;
  const st = {
    file: null, header: null, userIdCol: null, emailCol: null,
    run: null, pendingResume: null, prefer: 'userId',
    clearCols: new Set(), emptyCounts: Object.create(null), emptySampled: 0,
    fileToken: 0, resumeToken: 0, warnedProject: null,
  };
  // Start / Resume share one in-flight guard: set before the first await, so a second click
  // during the confirm dialog or the project/key check can't start a second run on one checkpoint.
  const starting = createStartGuard(() => syncButtons());

  // ── Elements ──────────────────────────────────────────────────────────
  const resumeWrap = h('div', { class: 'bd-view', hidden: true });
  const chipF = fileChip({ onFile: selectFile });

  const picker = listPicker(shell, { ariaLabel: 'Add to list', placeholder: 'None (profile sync only)', onChange: onListChange });
  const newListName = input({ placeholder: 'New list name', ariaLabel: 'New list name' });
  const newListRow = h('div', { class: 'bd-inline', hidden: true }, newListName,
    button('Create', { variant: 'primary', size: 'sm', trusted: true, onClick: createListFromPush }));
  const listHint = h('div', { class: 'bd-note' });
  const preferSeg = segmented({
    ariaLabel: 'Prefer key', value: 'userId',
    options: [{ value: 'userId', label: 'userId' }, { value: 'email', label: 'email' }],
    onChange: (v) => { st.prefer = v; },
  });
  const existing = switchRow('Existing users only');
  existing.el.hidden = true;
  const merge = switchRow('Merge nested objects', { onChange: updateClearUi });
  const clearSw = switchRow('Clear empty cells', { onChange: updateClearUi });
  const clearAll = h('input', { type: 'checkbox', onChange: (e) => {
    st.clearCols = new Set(e.target.checked ? dataFieldCols() : []);
    renderClearPicker();
    updateClearUi();
  } });
  const clearList = h('div', { class: 'bd-clearlist' });
  const clearNote = h('div', { class: 'bd-note', hidden: true }, 'No columns selected, so empty cells are left alone, exactly as if this were off.');
  const clearWarnAll = h('div', { class: 'bd-note bad', hidden: true }, 'Every field will be cleared wherever a cell is empty.');
  const clearNestedNote = h('div', { class: 'bd-note warn', hidden: true },
    'Caution: clearing a nested-object field while "Merge nested objects" is on has not been tested against the live API.');
  const clearPicker = h('div', { class: 'bd-sec', hidden: true },
    h('div', { class: 'bd-opt' }, h('span', { class: 'bd-h l' }, 'Columns to clear'),
      h('label', { class: 'bd-note', style: 'display:flex; gap:6px; align-items:center' }, clearAll, 'Select all')),
    clearList, clearNote, clearWarnAll, clearNestedNote);

  const opts = h('fieldset', { class: 'bd-sec' },
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Add to list'), picker.el,
      iconButton('reload', { label: 'Reload lists', trusted: true, onClick: () => shell.lists.refresh() }),
      button('+', { size: 'sm', title: 'New list', onClick: () => { newListRow.hidden = !newListRow.hidden; if (!newListRow.hidden) newListName.focus(); } })),
    newListRow,
    listHint,
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Prefer key'), preferSeg),
    existing.el,
    merge.el,
    clearSw.el,
    h('div', { class: 'bd-note' }, 'Empty cells normally leave the existing value alone. Turn this on to send an empty cell as ',
      h('code', null, 'null'), ', which clears that field on the profile.'),
    clearPicker);

  const pacing = pacingFields({ values: shell.values, save: shell.saveValues, subscribe: shell.subscribeValues });
  const prog = progressBlock();

  const runBtn = button('Start', { variant: 'primary', onClick: onRunButton, disabled: true, trusted: true });
  const stopBtn = button('Stop', { disabled: true, trusted: true, onClick: () => { st.run?.stop(); } });
  const dryBtn = button('Dry run', { variant: 'ghost', disabled: true, trusted: true, onClick: doDryRun });
  const failBtn = button('Download failures', { variant: 'ghost', size: 'sm', disabled: true, trusted: true, onClick: () => {
    if (st.run) ctx.dom.downloadBlob('failures_' + tsName() + '.csv', failuresCsv(st.run.failures, USER_FAILURE_COLUMNS), 'text/csv;charset=utf-8');
  } });
  const retryBtn = button('Retry CSV', { variant: 'ghost', size: 'sm', disabled: true, trusted: true, title: 'Every row of the batches that failed, in the original columns', onClick: () => {
    if (st.run) ctx.dom.downloadBlob('retry_' + tsName() + '.csv', retryCsv(st.header, st.run.retryRows), 'text/csv;charset=utf-8');
  } });
  const dryOut = h('details', { class: 'bd-dry', hidden: true });

  const el = h('div', { class: 'bd-view' },
    resumeWrap,
    chipF.el,
    opts,
    pacing.el,
    prog.el,
    h('div', { class: 'row' }, runBtn, stopBtn, dryBtn, h('span', { style: 'flex:1' }), failBtn, retryBtn),
    dryOut);

  prog.log.add('Ready. Choose a CSV with an email or userId column.');
  const unsubLists = shell.lists.subscribe(() => picker.revalidate());
  onListChange(picker.value);

  // ── File ──────────────────────────────────────────────────────────────
  async function selectFile(file) {
    if (st.run?.running || starting.busy) return;
    const token = ++st.fileToken;
    st.resumeToken++;
    Object.assign(st, { file, header: null, userIdCol: null, emailCol: null, run: null, pendingResume: null,
      clearCols: new Set(), emptyCounts: Object.create(null), emptySampled: 0 });
    dryOut.hidden = true;
    failBtn.disabled = true; retryBtn.disabled = true;
    failBtn.textContent = 'Download failures'; retryBtn.textContent = 'Retry CSV';
    prog.idle();
    renderClearPicker();
    resumeWrap.hidden = true;
    chipF.set(file, 'Reading header…');
    syncButtons();

    let header;
    try { header = await readHeader(file); } catch (err) {
      if (token === st.fileToken) chipF.set(file, 'Could not read the file: ' + (err?.message || err), true);
      return;
    }
    if (token !== st.fileToken) return;
    if (!header || !header.length) { chipF.set(file, 'This CSV is empty.', true); return; }
    const keys = detectKeyColumns(header);
    if (!keys.userIdCol && !keys.emailCol) {
      chipF.set(file, 'No email or userId column in the header. Columns: ' + header.join(', '), true);
      return;
    }
    Object.assign(st, { header, userIdCol: keys.userIdCol, emailCol: keys.emailCol });
    chipF.set(file, fileMeta(file, header, keys));
    prog.log.add('Selected ' + file.name + '.');
    renderClearPicker();
    updateClearUi();
    syncButtons();
  }

  // ── Lists picker ──────────────────────────────────────────────────────
  function onListChange(lid) {
    const l = lid ? shell.lists.byId(lid) : null;
    existing.el.hidden = !lid;
    clear(listHint);
    if (lid) {
      listHint.append('Profile fields and list membership in one call: ', h('code', null, 'POST /api/lists/subscribe'),
        ' to ', l ? l.name : 'list ' + lid, '.');
    } else {
      listHint.append('Profile sync only: ', h('code', null, 'POST /api/users/bulkUpdate'), '.');
    }
    refreshResume();
    syncButtons();
  }

  async function createListFromPush() {
    const name = newListName.value.trim();
    if (!name) { shell.toast('Give the list a name.', 'warn'); return; }
    const id = await shell.lists.create(name);
    if (id == null) return;
    newListName.value = '';
    newListRow.hidden = true;
    picker.value = id;
    onListChange(id);
  }

  // ── Clear-empty columns ───────────────────────────────────────────────
  // Deliberately column-scoped: a blanket "every empty cell is a null" over a sparse export
  // would wipe a field for every user in the file. Naming the columns is the guardrail.

  function dataFieldCols() {
    if (!st.header) return [];
    return st.header.filter((c) => c !== st.userIdCol && c !== st.emailCol);
  }

  /** The columns actually being cleared: [] whenever the feature is off. */
  function clearSelection() {
    if (!clearSw.input.checked) return [];
    return dataFieldCols().filter((c) => st.clearCols.has(c));
  }

  function renderClearPicker() {
    clear(clearList);
    const cols = dataFieldCols();
    if (!cols.length) {
      clearList.append(h('div', { class: 'empty' }, st.header ? 'This CSV has only key columns.' : 'Choose a CSV first.'));
      return;
    }
    const sampled = st.emptySampled || 0;
    for (const col of cols) {
      const n = sampled ? (st.emptyCounts[col] || 0) : 0;
      const allEmpty = sampled > 0 && n === sampled;
      const cb = h('input', { type: 'checkbox', checked: st.clearCols.has(col), onChange: (e) => {
        if (e.target.checked) st.clearCols.add(col); else st.clearCols.delete(col);
        updateClearUi();
      } });
      clearList.append(h('label', { class: allEmpty ? 'allempty' : null,
        title: allEmpty ? 'Empty in every sampled row: this would clear it for every user in the file' : null },
      cb, h('span', { class: 'nm' }, col),
      sampled > 0 && h('span', { class: 'ct' }, nf(n) + ' / ' + nf(sampled) + ' empty' + (allEmpty ? ' !' : ''))));
    }
  }

  function updateClearUi() {
    const on = clearSw.input.checked;
    clearPicker.hidden = !on;
    const cols = dataFieldCols();
    const sel = clearSelection();
    clearAll.checked = cols.length > 0 && sel.length === cols.length;
    clearAll.indeterminate = sel.length > 0 && sel.length < cols.length;
    clearNote.hidden = !(on && sel.length === 0);
    clearWarnAll.hidden = !(on && cols.length > 0 && sel.length === cols.length);
    clearNestedNote.hidden = !(on && sel.length > 0 && merge.input.checked);
    refreshResume();
  }

  // ── Resume ────────────────────────────────────────────────────────────
  function currentScope() {
    return pushScope({ listId: (picker.value || ''), clearCols: clearSelection() });
  }

  /** Offer a checkpoint for this file + target + clear set (all three are its identity). */
  async function refreshResume() {
    const token = ++st.resumeToken;
    st.pendingResume = null;
    clear(resumeWrap);
    resumeWrap.hidden = true;
    if (!st.file || !st.header || st.run?.running) return;
    const scope = currentScope();
    const name = checkpointName(scope, st.file);
    const ck = await ctx.state.get(name, null);
    if (token !== st.resumeToken) return;

    if (!ck || !ck.committedRows) {
      const others = otherPushCheckpointNames(await ctx.state.list(), st.file, scope);
      for (const o of others) {
        const data = await ctx.state.get(o.name, null);
        if (token !== st.resumeToken) return;
        if (!data || !(data.committedRows > 0)) continue;
        resumeWrap.append(banner({ tone: 'info', chipText: 'Note', chipTone: 'accent',
          text: 'This file has an unfinished run for a different target (' + describeScope(o.scope, data) + ', ' +
            nf(data.committedRows) + ' rows done). Choose that target again to continue it.' }));
        resumeWrap.hidden = false;
        break;
      }
      return;
    }

    st.pendingResume = { ck, name };
    let target = ck.listId ? 'list ' + ck.listId + (ck.listName ? ' (' + ck.listName + ')' : '') : 'profile sync only';
    if (Array.isArray(ck.clearCols) && ck.clearCols.length) target += ', clearing ' + ck.clearCols.join(', ');
    const when = ck.savedAt ? new Date(ck.savedAt).toLocaleString() : 'earlier';
    resumeWrap.append(banner({
      chipText: 'Paused run',
      text: st.file.name + ' stopped at row ' + nf(ck.committedRows) + ' of ' + nf(ck.totalRows) + ' → ' + target +
        (ck.projectName ? ' in ' + ck.projectName : '') + ', saved ' + when + '.',
      actions: [
        { label: 'Resume', onClick: () => guardedStart(ck) },
        { label: 'Start over', variant: 'ghost', onClick: async () => {
          if (starting.busy || st.run?.running) return;
          await ctx.state.remove(name);
          st.pendingResume = null;
          resumeWrap.hidden = true;
          prog.log.add('Saved progress discarded. The next run starts from row 1.');
        } },
      ],
    }));
    resumeWrap.hidden = false;
  }

  // ── Dry run ───────────────────────────────────────────────────────────
  async function doDryRun() {
    if (!st.file || !st.header || st.run?.running || starting.busy) return;
    const o = readOptions();
    dryBtn.disabled = true;
    clear(dryOut);
    dryOut.hidden = false;
    dryOut.open = true;
    dryOut.append(h('summary', null, 'Dry run: nothing is sent'),
      h('div', { class: 'bd-note', style: 'margin-top:8px' }, 'Reading the first ' + nf(DRY_RUN_ROWS) + ' rows and counting the file…'));

    const clearSet = clearSetOf(o.clearCols);
    const samples = [], clearedSamples = [];
    const colTypes = Object.create(null), emptyCounts = Object.create(null);
    let examined = 0, total = 0;
    try {
      await streamRows(st.file, (fields) => {
        if (examined >= DRY_RUN_ROWS) return 'stop';
        examined++;
        const obj = rowToObject(st.header, fields);
        const user = buildUser(obj, st.userIdCol, st.emailCol, o.preferKey, o.mergeNested, clearSet);
        if (user && samples.length < 3) samples.push(user);
        if (user && clearedSamples.length < 3 && countCleared(user) > 0) clearedSamples.push(user);
        for (const col of st.header) {
          if (col === st.userIdCol || col === st.emailCol) continue;
          if (isEmptyCell(obj[col])) emptyCounts[col] = (emptyCounts[col] || 0) + 1;
          const val = inferValue(obj[col]);
          if (val === undefined) continue;
          const t = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
          (colTypes[col] || (colTypes[col] = Object.create(null)))[t] = true;
        }
        return examined >= DRY_RUN_ROWS ? 'stop' : undefined;
      });
      total = await countDataRows(st.file);
    } catch (err) {
      clear(dryOut);
      dryOut.append(h('summary', null, 'Dry run failed'), h('div', { class: 'bd-note bad' }, String(err?.message || err)));
      dryBtn.disabled = false;
      return;
    }
    st.emptyCounts = emptyCounts;
    st.emptySampled = examined;
    renderClearPicker();
    updateClearUi();

    const nBatches = Math.ceil(total / o.batchSize);
    const estMin = o.rateLimit > 0 ? nBatches / o.rateLimit / 60 : 0;
    const l = o.listId ? shell.lists.byId(o.listId) : null;
    const lines = [];
    if (o.listId) {
      lines.push('endpoint:     POST /api/lists/subscribe');
      lines.push('target list:  ' + (l ? l.name : '?') + ' (id ' + o.listId + ')' + (o.updateExistingOnly ? '   updateExistingUsersOnly: true' : ''));
    } else {
      lines.push('endpoint:     POST /api/users/bulkUpdate (profile sync only)');
    }
    lines.push('key columns:  userId=' + (st.userIdCol || '-') + '   email=' + (st.emailCol || '-'));
    if (o.clearCols.length) {
      lines.push('clearing:     ' + o.clearCols.join(', '));
      lines.push('              (empty cells in these columns are sent as null)');
    }
    lines.push('total rows:   ' + nf(total));
    lines.push('batches:      ' + nf(nBatches) + ' × ' + nf(o.batchSize) + ' at ' + o.rateLimit + ' req/s');
    lines.push('estimated:    ' + estMin.toFixed(1) + ' minutes of request pacing (network time not included)');

    const dfCols = dataFieldCols();
    const rows = dfCols.slice().sort().map((c) => {
      const n = emptyCounts[c] || 0;
      const allEmpty = examined > 0 && n === examined;
      const types = colTypes[c] ? Object.keys(colTypes[c]).sort().join(', ') : '-';
      return h('tr', null,
        h('td', null, c, clearSet && clearSet.has(c) ? [' ', chip('clear', { tone: 'bad' })] : null),
        h('td', null, types),
        h('td', { class: allEmpty ? 'bad' : null }, nf(n) + ' / ' + nf(examined) + (allEmpty ? ' !' : '')));
    });
    const shown = (clearSet && clearedSamples.length) ? clearedSamples : samples;

    clear(dryOut);
    // core/dom append: flattens the arrays and skips the nulls below (Element.append would print them).
    append(dryOut,
      h('summary', null, 'Dry run: nothing was sent'),
      h('pre', null, lines.join('\n')),
      h('div', { class: 'bd-h', style: 'margin-top:10px' }, 'Inferred types, first ' + nf(examined) + ' rows'),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'column'), h('th', null, 'type'), h('th', null, 'empty'))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '3' }, 'No data columns, only keys.')))),
      h('div', { class: 'bd-h', style: 'margin-top:10px' }, 'Sample payloads (' + (o.listId ? 'subscribers[]' : 'users[]') + ' entries)'),
      shown.length ? shown.map((s) => h('pre', null, JSON.stringify(s, null, 2))) : h('div', { class: 'bd-note' }, 'No rows with a key in the sample.'),
      clearSet && !clearedSamples.length
        ? h('div', { class: 'bd-note' }, 'No empty cell in the cleared columns turned up in the first ' + nf(examined) + ' rows, so no null appears above.')
        : null);
    dryBtn.disabled = false;
  }

  // ── Run ───────────────────────────────────────────────────────────────
  function readOptions() {
    const v = shell.values();
    return {
      batchSize: v.batchSize,
      rateLimit: v.rateLimit,
      preferKey: st.prefer,
      mergeNested: merge.input.checked,
      listId: (picker.value || ''),
      updateExistingOnly: !!(picker.value || '') && existing.input.checked,
      clearCols: clearSelection(),   // [] when off or nothing ticked: deliberately the same
    };
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

  /** Clearing fields is irreversible, so a run (or resume) that clears goes through a confirm. */
  async function confirmAndStart(ck) {
    if (st.run?.running || !st.file || !st.header) return;
    const cols = clearSelection();
    if (cols.length) {
      const sampled = st.emptySampled || 0;
      const ok = await confirmDialog({
        title: 'Clear ' + cols.length + ' field' + (cols.length === 1 ? '' : 's') + '?',
        brand: 'Bulk data',
        danger: true,
        confirmLabel: 'Clear these fields and push',
        body: h('div', { class: 'bd-view', style: 'gap:8px' },
          h('div', null, 'Empty cells in these columns are sent as null, which clears the field on matching profiles. Iterable cannot undo this.'),
          h('div', { class: 'bd-clearlist' }, cols.map((c) => {
            const n = st.emptyCounts[c] || 0;
            return h('label', { class: sampled && n === sampled ? 'allempty' : null }, h('span', { class: 'nm' }, c),
              sampled > 0 && h('span', { class: 'ct' }, nf(n) + ' / ' + nf(sampled) + ' sampled empty'));
          })),
          !sampled && h('div', { class: 'bd-note' }, 'No dry run yet. Run one first to see how many cells this would clear.')),
      });
      if (!ok) return;
    }
    await startPush(ck);
  }

  async function startPush(ck) {
    if (st.run?.running || !st.file || !st.header) return;
    const pin = await shell.pin({ quiet: false });
    if (!pin) { syncButtons(); return; }
    const o = readOptions();
    if (o.listId && shell.lists.state.projectKey !== pin.projectKey) {
      shell.toast('The project changed since the lists were loaded. Reload the lists and choose the list again.', 'bad');
      shell.lists.reset();
      syncButtons();
      return;
    }
    if (resumeBlocker(ck, pin.projectKey)) {
      shell.toast(ck.projectKey
        ? 'This run was started in ' + (ck.projectName || 'another project') + '. Switch back to that project to resume it, or choose Start over.'
        : 'This saved run doesn’t record which project it was for, so it can’t be resumed safely. Choose Start over.', 'bad');
      syncButtons();
      return;
    }

    // Frozen at start, like the project: changing the options mid-run changes nothing.
    const listId = o.listId;
    const listName = listId ? (shell.lists.byId(listId)?.name || '') : '';
    const clearCols = o.clearCols;
    const clearSet = clearSetOf(clearCols);
    const scope = pushScope({ listId, clearCols });
    const ckName = checkpointName(scope, st.file);
    const limiter = new RateLimiter(o.rateLimit);
    const { header, userIdCol, emailCol } = st;
    st.pendingResume = null;
    resumeWrap.hidden = true;
    st.warnedProject = null;

    const run = new Run({
      file: st.file, header, batchSize: o.batchSize, signal: ctx.signal,
      buildItem: (obj) => buildUser(obj, userIdCol, emailCol, o.preferKey, o.mergeNested, clearSet),
      countCleared,
      skipRecord: () => ({ userId: '', email: '' }),
      idsOf: (obj) => ({ userId: userIdCol ? (obj[userIdCol] || '') : '', email: emailCol ? (obj[emailCol] || '') : '' }),
      sendBatch: (items, r) => {
        const req = usersBatchRequest(items, { listId, updateExistingOnly: o.updateExistingOnly });
        return sendBatch({ request: pin.request, path: req.path, body: req.body, limiter, signal: ctx.signal, run: r });
      },
      onBatchOk: (res, items, r) => {
        const p = collectPartialFailures(res.data);
        for (const rec of p.records) r.addFailureRecord({ row_number: '', userId: rec.userId, email: rec.email, reason: rec.reason, detail: '' });
        if (p.fail) r.addFailure('api_reported', p.fail);
        return { success: p.success, fail: p.fail };
      },
      checkpoints: { save: (d) => ctx.state.set(ckName, d), clear: () => ctx.state.remove(ckName) },
      checkpointMeta: { projectKey: pin.projectKey, projectName: pin.projectName, listId: listId || null, listName, clearCols },
      onLog: (m, c) => prog.log.add(m, c),
      onChange: (r) => { prog.render(r); syncButtons(); shell.runsChanged(); },
    });
    run.projectKey = pin.projectKey;
    run.projectName = pin.projectName;
    run.label = 'Users';
    st.run = run;
    shell.trackRun(run);

    dryOut.open = false;
    prog.log.clear();
    prog.log.add('Project: ' + pin.projectName + (pin.masked ? ' (key ' + pin.masked + ')' : ''));
    if (clearCols.length) {
      prog.log.add('Clearing empty cells in ' + clearCols.length + ' column' + (clearCols.length === 1 ? '' : 's') + ': ' +
        clearCols.join(', ') + '. Empty cells are sent as null and wipe the field.', 'warn');
    }
    prog.log.add(listId
      ? 'Target: POST /api/lists/subscribe → list ' + listId + (listName ? ' (' + listName + ')' : '') + (o.updateExistingOnly ? ', existing users only' : '')
      : 'Target: POST /api/users/bulkUpdate (profile sync only)');
    prog.log.add('Pacing: ' + o.rateLimit + ' req/s, ' + nf(o.batchSize) + ' rows per batch.');
    syncButtons();

    await run.start(ck ? (ck.committedRows || 0) : 0, ck ? ck.stats : null);

    failBtn.disabled = !run.failures.length;
    failBtn.textContent = run.failures.length ? 'Download failures (' + nf(run.failures.length) + ')' : 'Download failures';
    retryBtn.disabled = !run.retryRows.length;
    retryBtn.textContent = run.retryRows.length ? 'Retry CSV (' + nf(run.retryRows.length) + ')' : 'Retry CSV';
    shell.runEnded(run);
    syncButtons();
  }

  function syncButtons() {
    const r = st.run;
    const running = !!r?.running;
    const busy = running || starting.busy;
    const ready = !!(st.file && st.header && (st.userIdCol || st.emailCol));
    runBtn.textContent = running ? (r.paused ? 'Resume' : 'Pause') : 'Start';
    runBtn.disabled = running ? false : (!ready || starting.busy);
    stopBtn.disabled = !running;
    dryBtn.disabled = busy || !ready;
    opts.disabled = busy;
    chipF.setDisabled(busy);
    for (const b of resumeWrap.querySelectorAll('button')) b.disabled = busy;
  }

  // A run keeps the project it started with; a switch is reported, never applied.
  const unsubProject = shell.onProjectChange((next) => {
    const r = st.run;
    if (!r?.running || !next || next.key === r.projectKey || st.warnedProject === next.key) return;
    st.warnedProject = next.key;
    prog.log.add('The page switched to ' + next.name + '. This run keeps sending to ' + r.projectName + ', where it started.', 'warn');
  });

  return {
    id: 'users',
    label: 'Users',
    el,
    isRunning: () => !!st.run?.running,
    destroy() { unsubLists(); unsubProject(); pacing.destroy(); },
  };
}
