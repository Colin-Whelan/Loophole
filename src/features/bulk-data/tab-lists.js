// Bulk data → Lists tab: manage static lists (create, sizes, delete) and upload members to a
// list from a CSV (keys only, POST /api/lists/subscribe). Ported from the "Iterable User Push"
// Lists tab.

import { h, clear } from '../../core/dom.js';
import { readHeader } from '../../core/csv.js';
import { RateLimiter } from '../../core/retry.js';
import { button, select, segmented, input, modal } from '../../ui/components.js';
import {
  detectKeyColumns, buildSubscriber, collectPartialFailures, checkpointName, SUBSCRIBE_SCOPE,
  failuresCsv, retryCsv, USER_FAILURE_COLUMNS, fmtBytes, nf, tsName, createStartGuard, resumeBlocker,
} from './logic.js';
import { Run } from './engine.js';
import { sendBatch } from './requests.js';
import { fileChip, pacingFields, progressBlock, banner } from './ui.js';

export function createListsTab(shell) {
  const { ctx, lists } = shell;
  const st = { file: null, header: null, userIdCol: null, emailCol: null, run: null, pendingResume: null,
    prefer: 'userId', fileToken: 0, warnedProject: null };
  // Start / Resume share one in-flight guard, set before the first await (see createStartGuard).
  const starting = createStartGuard(() => syncButtons());

  // ── Static lists ──────────────────────────────────────────────────────
  const newName = input({ placeholder: 'New list name', ariaLabel: 'New list name' });
  const createBtn = button('Create', { variant: 'primary', size: 'sm', trusted: true, onClick: async () => {
    const name = newName.value.trim();
    if (!name) { shell.toast('Give the list a name.', 'warn'); return; }
    createBtn.disabled = true;
    const id = await lists.create(name);
    createBtn.disabled = false;
    if (id != null) newName.value = '';
  } });
  const refreshBtn = button('Reload lists', { size: 'sm', trusted: true, onClick: async () => {
    refreshBtn.disabled = true;
    await lists.refresh();
    refreshBtn.disabled = false;
  } });
  const sizesBtn = button('Load all sizes', { size: 'sm', trusted: true, onClick: async () => {
    sizesBtn.disabled = true;
    for (const l of lists.state.lists.slice()) {
      if (ctx.signal.aborted || !lists.state.loaded) break;
      await lists.loadSize(l.id);
    }
    sizesBtn.disabled = false;
  } });
  const listBox = h('div', { class: 'bd-lists' });

  function renderLists() {
    const s = lists.state;
    clear(listBox);
    sizesBtn.disabled = !s.loaded || !s.lists.length;
    if (s.loading) { listBox.append(h('div', { class: 'bd-empty' }, 'Loading…')); return; }
    if (s.error) { listBox.append(h('div', { class: 'bd-empty', style: 'color:var(--wb-bad)' }, s.error)); return; }
    if (!s.loaded) { listBox.append(h('div', { class: 'bd-empty' }, 'Not loaded yet. Choose Reload lists.')); return; }
    if (!s.lists.length) { listBox.append(h('div', { class: 'bd-empty' }, 'No lists in this project.')); return; }
    for (const l of s.lists) {
      const size = s.sizes.get(String(l.id));
      const sizeEl = size === undefined
        ? button('size', { variant: 'ghost', size: 'sm', trusted: true, onClick: () => lists.loadSize(l.id) })
        : h('span', { class: 'sz' }, size === 'loading' ? '…' : size === 'error' ? 'error' : nf(size));
      listBox.append(h('div', { class: 'li' },
        h('div', { class: 'nm' }, l.name, ' ', h('span', { class: 'id' }, String(l.id) + (l.listType ? ' · ' + l.listType : ''))),
        sizeEl,
        button('Delete', { variant: 'ghost', size: 'sm', trusted: true, onClick: () => confirmDelete(l) })));
    }
  }

  /** Permanent, so: pin the project, show the exact call, and make the user type the name. */
  async function confirmDelete(list) {
    const pin = await shell.pin({ quiet: false });
    if (!pin) return;
    if (lists.state.projectKey !== pin.projectKey) {
      shell.toast('The project changed since the lists were loaded. Reload the lists first.', 'bad');
      lists.reset();
      return;
    }
    // A list with an empty name would let an empty input pass, so fall back to its id.
    const byId = !String(list.name ?? '').trim();
    const expected = byId ? String(list.id) : list.name;
    const what = byId ? 'list id' : 'list name';
    const typed = input({ mono: true, placeholder: expected, ariaLabel: 'Type the ' + what + ' to confirm' });
    const answer = await modal({
      title: 'Delete list',
      brand: 'Bulk data',
      body: h('div', { class: 'bd-view', style: 'gap:10px' },
        h('div', null, 'This permanently deletes the list ', h('b', null, list.name), ' (id ', String(list.id), ') in ', h('b', null, pin.projectName), '.'),
        h('div', { class: 'endpoint' }, h('b', null, 'DELETE'), ' /api/lists/' + list.id),
        h('div', { class: 'wb-field' }, h('label', { class: 'wb-label' }, 'Type the ' + what + ' to confirm'), typed)),
      actions: [{ id: 'cancel', label: 'Cancel', variant: 'ghost' }, { id: 'delete', label: 'Delete list', variant: 'danger' }],
    });
    if (answer !== 'delete') return;
    if (!expected || typed.value !== expected) { shell.toast('The ' + what + ' didn’t match, so nothing was deleted.', 'warn'); return; }
    await lists.remove(list, pin);
  }

  // ── Member upload ─────────────────────────────────────────────────────
  const targetSel = select({ options: [], ariaLabel: 'Target list', onChange: syncButtons });
  const preferSeg = segmented({
    ariaLabel: 'Prefer key', value: 'userId',
    options: [{ value: 'userId', label: 'userId' }, { value: 'email', label: 'email' }],
    onChange: (v) => { st.prefer = v; },
  });
  const resumeWrap = h('div', { class: 'bd-view', hidden: true });
  const chipF = fileChip({ onFile: selectFile, emptyTitle: 'Drop the member CSV, or choose a file', emptyMeta: 'Only the email / userId column is used.' });
  const opts = h('fieldset', { class: 'bd-sec' },
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Target list'), targetSel),
    h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'Prefer key'), preferSeg));
  const pacing = pacingFields({ values: shell.values, save: shell.saveValues, subscribe: shell.subscribeValues });
  const prog = progressBlock();
  const runBtn = button('Start', { variant: 'primary', disabled: true, trusted: true, onClick: onRunButton });
  const stopBtn = button('Stop', { disabled: true, trusted: true, onClick: () => st.run?.stop() });
  const failBtn = button('Download failures', { variant: 'ghost', size: 'sm', disabled: true, trusted: true, onClick: () => {
    if (st.run) ctx.dom.downloadBlob('list_failures_' + tsName() + '.csv', failuresCsv(st.run.failures, USER_FAILURE_COLUMNS), 'text/csv;charset=utf-8');
  } });
  const retryBtn = button('Retry CSV', { variant: 'ghost', size: 'sm', disabled: true, trusted: true, onClick: () => {
    if (st.run) ctx.dom.downloadBlob('list_retry_' + tsName() + '.csv', retryCsv(st.header, st.run.retryRows), 'text/csv;charset=utf-8');
  } });

  const el = h('div', { class: 'bd-view' },
    h('div', { class: 'bd-h' }, 'Static lists'),
    h('div', { class: 'bd-inline' }, newName, createBtn),
    h('div', { class: 'row' }, refreshBtn, sizesBtn),
    listBox,
    h('div', { class: 'bd-h', style: 'margin-top:6px' }, 'Upload members to a list'),
    h('div', { class: 'bd-note' }, 'Keys only: every other column is ignored. To set profile fields too, use the Users tab with "Add to list".'),
    opts,
    resumeWrap,
    chipF.el,
    pacing.el,
    prog.el,
    h('div', { class: 'row' }, runBtn, stopBtn, h('span', { style: 'flex:1' }), failBtn, retryBtn));

  prog.log.add('Ready. Choose a target list and a CSV with an email or userId column.');

  function populateTarget() {
    const prev = targetSel.value;
    clear(targetSel);
    targetSel.append(h('option', { value: '' }, lists.state.loaded ? 'Choose a list' : 'Reload lists first'));
    for (const l of lists.state.lists) targetSel.append(h('option', { value: String(l.id) }, l.name + ' (' + l.id + ')'));
    targetSel.value = prev && lists.byId(prev) ? prev : '';
    syncButtons();
  }
  const unsubLists = lists.subscribe(() => { renderLists(); populateTarget(); });
  renderLists();
  populateTarget();

  async function selectFile(file) {
    if (st.run?.running || starting.busy) return;
    const token = ++st.fileToken;
    Object.assign(st, { file, header: null, userIdCol: null, emailCol: null, run: null, pendingResume: null });
    clear(resumeWrap);
    resumeWrap.hidden = true;
    failBtn.disabled = true; retryBtn.disabled = true;
    failBtn.textContent = 'Download failures'; retryBtn.textContent = 'Retry CSV';
    prog.idle();
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
    if (!keys.userIdCol && !keys.emailCol) { chipF.set(file, 'No email or userId column in the header.', true); return; }
    Object.assign(st, { header, userIdCol: keys.userIdCol, emailCol: keys.emailCol });
    const ignored = header.length - (keys.userIdCol ? 1 : 0) - (keys.emailCol ? 1 : 0);
    chipF.set(file, fmtBytes(file.size) + ' · key: ' + [keys.userIdCol && 'userId', keys.emailCol && 'email'].filter(Boolean).join(', ') +
      (ignored ? ' · ' + ignored + ' other column' + (ignored === 1 ? '' : 's') + ' ignored' : ''));
    prog.log.add('Selected ' + file.name + '.');
    syncButtons();

    const name = checkpointName(SUBSCRIBE_SCOPE, file);
    const ck = await ctx.state.get(name, null);
    if (token !== st.fileToken || !ck || !(ck.committedRows > 0)) return;
    st.pendingResume = { ck, name };
    resumeWrap.append(banner({
      chipText: 'Paused upload',
      text: file.name + ' stopped at row ' + nf(ck.committedRows) + ' of ' + nf(ck.totalRows) +
        (ck.listId ? ' → list ' + ck.listId + (ck.listName ? ' (' + ck.listName + ')' : '') : '') +
        (ck.projectName ? ' in ' + ck.projectName : '') + ', saved ' + (ck.savedAt ? new Date(ck.savedAt).toLocaleString() : 'earlier') + '.',
      actions: [
        { label: 'Resume', onClick: () => guardedUpload(ck) },
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

  function onRunButton() {
    const r = st.run;
    if (r?.running) { if (r.paused) r.resume(); else r.pause(); return; }
    if (starting.busy) return;
    if (st.pendingResume) { shell.toast('Choose Resume or Start over first.', 'warn'); return; }
    guardedUpload(null);
  }

  function guardedUpload(ck) {
    return starting.run(() => startUpload(ck));
  }

  async function startUpload(ck) {
    if (st.run?.running || !st.file || !st.header) return;
    // The original tool resumed a keys-only upload into whichever list was selected; it has to be
    // the list the run started with, so a checkpoint brings its own list.
    const listId = Number(ck?.listId || targetSel.value);
    if (!listId) { shell.toast('Choose a target list.', 'warn'); return; }
    const pin = await shell.pin({ quiet: false });
    if (!pin) { syncButtons(); return; }
    if (resumeBlocker(ck, pin.projectKey)) {
      shell.toast(ck.projectKey
        ? 'This upload was started in ' + (ck.projectName || 'another project') + '. Switch back to that project to resume it, or choose Start over.'
        : 'This saved upload doesn’t record which project it was for, so it can’t be resumed safely. Choose Start over.', 'bad');
      syncButtons();
      return;
    }
    if (ck) {
      // The checkpoint's list must be one of this project's lists: load them if needed.
      if (!lists.state.loaded || lists.state.projectKey !== pin.projectKey) await lists.refresh();
      const why = resumeBlocker(ck, pin.projectKey, {
        projectKey: lists.state.loaded ? lists.state.projectKey : null,
        ids: lists.state.lists.map((l) => l.id),
      });
      if (why) {
        shell.toast(why === 'list'
          ? 'List ' + ck.listId + ' isn’t in ' + pin.projectName + ' any more, so this upload can’t be resumed. Choose Start over.'
          : 'Couldn’t load this project’s lists to check list ' + ck.listId + '. Reload the lists and try Resume again.', 'bad');
        syncButtons();
        return;
      }
    }
    if (!ck && lists.state.projectKey !== pin.projectKey) {
      shell.toast('The project changed since the lists were loaded. Reload the lists and choose the list again.', 'bad');
      lists.reset();
      syncButtons();
      return;
    }
    const v = shell.values();
    const limiter = new RateLimiter(v.rateLimit);
    const listName = ck?.listName || lists.byId(listId)?.name || '';
    const { header, userIdCol, emailCol } = st;
    const preferKey = st.prefer;
    const ckName = checkpointName(SUBSCRIBE_SCOPE, st.file);
    st.pendingResume = null;
    resumeWrap.hidden = true;
    st.warnedProject = null;

    const run = new Run({
      file: st.file, header, batchSize: v.batchSize, signal: ctx.signal,
      buildItem: (obj) => buildSubscriber(obj, userIdCol, emailCol, preferKey),
      skipRecord: () => ({ userId: '', email: '' }),
      idsOf: (obj) => ({ userId: userIdCol ? (obj[userIdCol] || '') : '', email: emailCol ? (obj[emailCol] || '') : '' }),
      sendBatch: (items, r) => sendBatch({ request: pin.request, path: '/api/lists/subscribe', body: { listId, subscribers: items }, limiter, signal: ctx.signal, run: r }),
      onBatchOk: (res, items, r) => {
        const p = collectPartialFailures(res.data);
        for (const rec of p.records) r.addFailureRecord({ row_number: '', userId: rec.userId, email: rec.email, reason: rec.reason, detail: '' });
        if (p.fail) r.addFailure('api_reported', p.fail);
        return { success: p.success, fail: p.fail };
      },
      checkpoints: { save: (d) => ctx.state.set(ckName, d), clear: () => ctx.state.remove(ckName) },
      checkpointMeta: { projectKey: pin.projectKey, projectName: pin.projectName, listId, listName },
      onLog: (m, c) => prog.log.add(m, c),
      onChange: (r) => { prog.render(r); syncButtons(); shell.runsChanged(); },
    });
    run.projectKey = pin.projectKey;
    run.projectName = pin.projectName;
    run.label = 'Lists';
    st.run = run;
    shell.trackRun(run);

    prog.log.clear();
    prog.log.add('Project: ' + pin.projectName + (pin.masked ? ' (key ' + pin.masked + ')' : ''));
    prog.log.add('Target: POST /api/lists/subscribe → list ' + listId + (listName ? ' (' + listName + ')' : ''));
    prog.log.add('Pacing: ' + v.rateLimit + ' req/s, ' + nf(v.batchSize) + ' rows per batch.');
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
    const ready = !!(st.file && st.header && (st.userIdCol || st.emailCol) && (targetSel.value || st.pendingResume));
    runBtn.textContent = running ? (r.paused ? 'Resume' : 'Pause') : 'Start';
    runBtn.disabled = running ? false : (!ready || starting.busy);
    stopBtn.disabled = !running;
    opts.disabled = busy;
    chipF.setDisabled(busy);
    for (const b of resumeWrap.querySelectorAll('button')) b.disabled = busy;
  }

  const unsubProject = shell.onProjectChange((next) => {
    const r = st.run;
    if (!r?.running || !next || next.key === r.projectKey || st.warnedProject === next.key) return;
    st.warnedProject = next.key;
    prog.log.add('The page switched to ' + next.name + '. This upload keeps sending to ' + r.projectName + ', where it started.', 'warn');
  });

  return {
    id: 'lists',
    label: 'Lists',
    el,
    isRunning: () => !!st.run?.running,
    destroy() { unsubLists(); unsubProject(); pacing.destroy(); },
  };
}
