// Bulk data: drawer building blocks shared by the tabs (file chip, pacing fields, progress block,
// banners). Markup and classes follow the "Bulk data drawer" in design/workbench-mockup.html.

import { h, clear } from '../../core/dom.js';
import { mark, button, input, field, chip, switchInput } from '../../ui/components.js';
import { LOG_LINE_CAP, fmtBytes, fmtDuration, nf, PACING } from './logic.js';

/** Extra rules on top of theme.css, injected into the drawer's shadow root. */
export const DRAWER_CSS = `
.drawer{z-index:2}
.drawer > .wb-ph, .drawer > .bd-route{flex:none}
.drawer-body{min-height:0}
.bd-route{padding:8px 14px; border-bottom:1px solid var(--wb-line); background:var(--wb-accent-soft); font-size:12px; line-height:1.45; color:var(--wb-ink)}
.drawer .wb-ph .wb-chip{max-width:190px; overflow:hidden; text-overflow:ellipsis}
.drawer-body > .wb-tabs{margin:-14px -14px 0; position:sticky; top:-14px; z-index:1}
.bd-view{display:flex; flex-direction:column; gap:14px}
.bd-launch{position:fixed; top:40%; left:72px; display:flex; flex-direction:column; align-items:center; gap:8px;
  padding:10px 6px; background:var(--wb-surface); color:var(--wb-ink); border:1px solid var(--wb-line); border-left:0;
  border-radius:0 8px 8px 0; box-shadow:var(--wb-shadow); cursor:pointer; font:600 11px var(--wb-font); z-index:1}
.bd-launch:hover{border-color:var(--wb-accent); color:var(--wb-accent-strong)}
.bd-launch .lbl{writing-mode:vertical-rl; transform:rotate(180deg); letter-spacing:.04em; white-space:nowrap}
.bd-launch .pct{font:600 10px var(--wb-mono); color:var(--wb-accent-strong)}
.bd-launch .busy{width:7px; height:7px; border-radius:50%; background:var(--wb-ok)}
.bd-launch .busy.paused{background:var(--wb-warn)}
.file-chip.bd-drop{border-style:dashed; cursor:pointer}
.file-chip.bd-drop.over{border-color:var(--wb-accent); background:var(--wb-accent-soft)}
.file-chip .fmeta.bad{color:var(--wb-bad)}
.file-chip .fname{overflow-wrap:anywhere}
.bd-sec{display:flex; flex-direction:column; gap:10px; margin:0; padding:0; border:0; min-width:0}
.bd-sec[disabled]{opacity:.6}
.bd-h{font:600 10.5px var(--wb-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--wb-faint); margin:0}
.bd-opt{display:flex; align-items:center; gap:10px; font-size:12.5px}
.bd-opt > .l{flex:1; min-width:0; color:var(--wb-ink)}
.bd-opt .wb-select{width:auto; max-width:220px}
.bd-inline{display:flex; gap:6px; align-items:center}
.bd-inline .wb-input{flex:1}
.bd-clearlist{max-height:180px; overflow:auto; border:1px solid var(--wb-line); border-radius:6px; background:var(--wb-surface)}
.bd-clearlist label{display:flex; gap:8px; align-items:center; padding:4px 8px; font:12px var(--wb-mono); cursor:pointer}
.bd-clearlist label + label{border-top:1px solid var(--wb-line)}
.bd-clearlist .nm{flex:1; min-width:0; overflow-wrap:anywhere}
.bd-clearlist .ct{color:var(--wb-faint); font-size:11px; white-space:nowrap}
.bd-clearlist .allempty .nm, .bd-clearlist .allempty .ct{color:var(--wb-bad)}
.bd-clearlist .empty{padding:8px; color:var(--wb-faint); font-size:12px}
.bd-note{font-size:11.5px; color:var(--wb-muted); line-height:1.45}
.bd-note.bad{color:var(--wb-bad)} .bd-note.warn{color:var(--wb-warn)}
.bd-note code, .bd-code{font:11.5px var(--wb-mono)}
.resume.bad{background:var(--wb-bad-soft)}
.resume.info{background:var(--wb-accent-soft)}
.resume .txt{flex:1; min-width:0; overflow-wrap:anywhere}
.resume .acts{display:flex; gap:6px; flex-wrap:wrap}
.bd-extra{font-size:11.5px; color:var(--wb-muted); margin-top:-6px}
.wb .log > div{white-space:pre-wrap; overflow-wrap:anywhere}
.bd-dry{border:1px solid var(--wb-line); border-radius:8px; padding:10px 12px; background:var(--wb-raised)}
.bd-dry summary{cursor:pointer; font-weight:600; font-size:12.5px}
.bd-dry pre{font:11.5px/1.5 var(--wb-mono); background:var(--wb-sunken); border:1px solid var(--wb-line); border-radius:6px;
  padding:8px 10px; margin:8px 0 0; overflow:auto; max-height:260px; white-space:pre}
.bd-dry table{width:100%; border-collapse:collapse; font:11.5px var(--wb-mono); margin-top:8px}
.bd-dry th{text-align:left; color:var(--wb-faint); font-weight:600; padding:3px 6px; border-bottom:1px solid var(--wb-line)}
.bd-dry td{padding:3px 6px; border-bottom:1px solid var(--wb-line); overflow-wrap:anywhere}
.bd-dry td.bad{color:var(--wb-bad)}
.bd-lists{border:1px solid var(--wb-line); border-radius:8px; overflow:hidden}
.bd-lists .li{display:grid; grid-template-columns:1fr auto auto; gap:8px; align-items:center; padding:7px 10px; font-size:12.5px}
.bd-lists .li + .li{border-top:1px solid var(--wb-line)}
.bd-lists .nm{min-width:0; overflow-wrap:anywhere}
.bd-lists .id{font:11px var(--wb-mono); color:var(--wb-faint)}
.bd-lists .sz{font:12px var(--wb-mono); color:var(--wb-muted); white-space:nowrap}
.bd-empty{padding:10px; color:var(--wb-faint); font-size:12px}
.bd-mode{align-self:flex-start}
.bd-hint{font-size:11.5px; color:var(--wb-muted); line-height:1.45; margin-top:-4px}
.bd-hint.warn{color:var(--wb-warn)}
.bd-kv{display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12px}
.bd-kv dt{color:var(--wb-muted)} .bd-kv dd{margin:0; font-family:var(--wb-mono); overflow-wrap:anywhere}
`;

/** Time-stamped, capped run log (the mockup's `.log`). Never put row data or keys in here. */
export function runLog() {
  const el = h('div', { class: 'log', 'aria-live': 'polite' });
  const add = (msg, cls = '') => {
    const t = new Date().toTimeString().slice(0, 8);
    el.append(h('div', null, h('span', { class: 't' }, t), ' ', h('span', { class: cls || null }, msg)));
    while (el.childElementCount > LOG_LINE_CAP) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  };
  return { el, add, clear: () => clear(el) };
}

/**
 * Progress + stats + log block. render(run) paints a Run's numbers; idle(text) resets.
 * The small line under the tiles lists skipped rows (`skippedWhy` says why rows are skipped),
 * cleared fields, collapsed duplicate IDs and the current rate.
 */
export function progressBlock({ skippedWhy = 'no email or userId' } = {}) {
  const pct = h('span', { class: 'code' }, '0%');
  const eta = h('span', { class: 'wb-help', style: 'margin:0' }, 'Not started');
  const bar = h('i');
  const tile = (k) => {
    const v = h('div', { class: 'v' }, '0');
    return { el: h('div', { class: 'stat' }, h('div', { class: 'k' }, k), v), v };
  };
  const sent = tile('Sent'), batches = tile('Batches'), retries = tile('Retries'), failed = tile('Failed');
  const extra = h('div', { class: 'bd-extra', hidden: true });
  const log = runLog();
  const el = h('div', { class: 'bd-view' },
    h('div', null,
      h('div', { class: 'row', style: 'justify-content:space-between; margin-bottom:6px; font-size:12px' }, pct, eta),
      h('div', { class: 'bigbar' }, bar)),
    h('div', { class: 'stats' }, sent.el, batches.el, retries.el, failed.el),
    extra,
    log.el);

  return {
    el,
    log,
    idle(text = 'Not started') {
      pct.textContent = '0%';
      bar.style.width = '0%';
      eta.textContent = text;
      for (const t of [sent, batches, retries, failed]) t.v.textContent = '0';
      extra.hidden = true;
    },
    render(run) {
      const s = run.snapshot();
      pct.textContent = s.pct.toFixed(1) + '%';
      bar.style.width = s.pct.toFixed(1) + '%';
      const rows = nf(run.committed) + ' / ' + nf(run.totalRows) + ' rows';
      if (run.running && !run.totalRows) eta.textContent = 'Counting rows…';
      else if (run.running) eta.textContent = rows + (run.paused ? ' · paused' : ' · about ' + fmtDuration(s.eta) + ' left');
      else if (run.finished) eta.textContent = rows + ' · done';
      else eta.textContent = rows + ' · stopped, progress saved';
      sent.v.textContent = nf(run.stats.sentOk);
      batches.v.textContent = nf(run.batchNo);
      retries.v.textContent = nf(run.stats.retries);
      failed.v.textContent = nf(run.stats.failed);
      const bits = [];
      if (run.stats.skipped) bits.push(nf(run.stats.skipped) + ' skipped (' + skippedWhy + ')');
      if (run.stats.cleared) bits.push(nf(run.stats.cleared) + ' fields cleared');
      if (run.stats.collisions) bits.push(nf(run.stats.collisions) + ' duplicate IDs collapsed');
      if (run.running && s.rate > 0) bits.push(Math.round(s.rate).toLocaleString() + ' rows/s');
      extra.textContent = bits.join(' · ');
      extra.hidden = !bits.length;
    },
  };
}

/**
 * The file chip. Empty: a dashed drop target ("Drop a CSV here"). With a file: name + meta and a
 * Change button. onFile(file) is called for a pick or a drop.
 */
export function fileChip({ onFile, emptyTitle = 'Drop a CSV here, or choose a file', emptyMeta = 'Streamed row by row, so very large files are fine.' }) {
  const picker = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  const fname = h('div', { class: 'fname' });
  const fmeta = h('div', { class: 'fmeta' });
  const change = button('Choose file', { variant: 'ghost', size: 'sm', onClick: (e) => { e.stopPropagation(); picker.click(); } });
  const el = h('div', { class: 'file-chip bd-drop', role: 'button', tabindex: '0' },
    mark(), h('div', { style: 'flex:1; min-width:0' }, fname, fmeta), change, picker);
  let disabled = false;

  const open = () => { if (!disabled) picker.click(); };
  el.addEventListener('click', () => { if (el.classList.contains('bd-drop')) open(); });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); open(); } });
  el.addEventListener('dragover', (e) => { if (disabled) return; e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    if (!disabled && e.dataTransfer?.files?.length) onFile(e.dataTransfer.files[0]);
  });
  picker.addEventListener('change', () => {
    if (picker.files.length) onFile(picker.files[0]);
    picker.value = '';
  });

  const api = {
    el,
    empty() {
      el.classList.add('bd-drop');
      fname.textContent = emptyTitle;
      fmeta.textContent = emptyMeta;
      fmeta.classList.remove('bad');
      change.textContent = 'Choose file';
    },
    set(file, meta, bad = false) {
      el.classList.remove('bd-drop');
      fname.textContent = file.name;
      fmeta.textContent = meta;
      fmeta.classList.toggle('bad', !!bad);
      change.textContent = 'Change';
    },
    setDisabled(v) { disabled = !!v; change.disabled = disabled; },
  };
  api.empty();
  return api;
}

/** One-line file meta: size · columns · key columns. */
export function fileMeta(file, header, { userIdCol, emailCol }) {
  return fmtBytes(file.size) + ' · ' + header.length + ' columns · key: ' +
    [userIdCol && 'userId (' + userIdCol + ')', emailCol && 'email (' + emailCol + ')'].filter(Boolean).join(', ');
}

/**
 * Rate / batch inputs bound to the feature settings (the same values the options page edits).
 * `spec` is a PACING group (logic.js): which keys, which limits. Clamped on change and written
 * through `save`; follows outside changes via `subscribe`.
 */
export function pacingFields({ values, save, subscribe, spec = PACING.users, batchLabel = 'Rows per batch' }) {
  const { rateKey, batchKey } = spec;
  const rate = input({ value: String(values()[rateKey]), mono: true, type: 'number', min: '0.1', max: String(spec.maxRate), step: '0.1' });
  const batch = input({ value: String(values()[batchKey]), mono: true, type: 'number', min: '1', max: String(spec.maxBatch), step: '1' });
  rate.addEventListener('change', () => {
    const v = spec.clampRate(rate.value);
    rate.value = String(v);
    save({ [rateKey]: v });
  });
  batch.addEventListener('change', () => {
    const v = spec.clampBatch(batch.value);
    batch.value = String(v);
    save({ [batchKey]: v });
  });
  const unsub = subscribe((v) => {
    if (document.activeElement !== rate && rate.getRootNode().activeElement !== rate) rate.value = String(v[rateKey]);
    if (document.activeElement !== batch && batch.getRootNode().activeElement !== batch) batch.value = String(v[batchKey]);
  });
  const el = h('div', { class: 'grid2', style: 'grid-template-columns:1fr 1fr' },
    field({ label: 'Requests / second', control: rate }),
    field({ label: batchLabel, control: batch }));
  return { el, destroy: unsub };
}

/**
 * A `.resume` banner: tone '' (warn, as in the mockup) | 'bad' | 'info'.
 * actions: [{ label, variant, onClick }]
 */
export function banner({ tone = '', chipText, chipTone = 'warn', text, actions = [] }) {
  return h('div', { class: ['resume', tone] },
    chipText && chip(chipText, { tone: chipTone }),
    h('span', { class: 'txt' }, text),
    actions.length > 0 && h('span', { class: 'acts' }, actions.map((a) => button(a.label, { size: 'sm', variant: a.variant, onClick: a.onClick }))));
}

/** A labelled switch row (label left, switch right). */
export function switchRow(label, { checked = false, onChange } = {}) {
  const sw = switchInput({ checked, label, onChange });
  const el = h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, label), sw);
  return { el, input: sw.input };
}
