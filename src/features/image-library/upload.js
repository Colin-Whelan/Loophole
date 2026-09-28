// Upload flow for the asset browser: pick/drop → filter → confirm big batches → optional edit step
// (name + alt text) → sequential uploads with per-file progress. Uploads are never retried
// (lib/iterable/assets.js): a repeat would create a duplicate asset.

import { h, clear } from '../../core/dom.js';
import { uploadImage } from '../../lib/iterable/assets.js';
import {
  CONFIRM_UPLOAD_OVER, finalAssetName, formatDimensions, formatFileSize, partitionUploadFiles,
  splitFileName, uploadOutcome, uploadSummary,
} from './logic.js';
import { BROWSER_CSS } from './styles.js';

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Files → upload items [{ file, originalName, base, ext, alt }] ready for runUploads, or null when
 * nothing is left to upload or the person cancelled. Shows the edit step unless skipEdit.
 */
export async function prepareUploads(ctx, files, { folderLabel, skipEdit, source }) {
  const { accepted, rejected } = partitionUploadFiles(files);
  if (!accepted.length) {
    ctx.ui.toast('No supported images selected (PNG, JPEG, GIF, WEBP or SVG).', { tone: 'bad', source });
    return null;
  }
  if (rejected.length) {
    ctx.ui.toast(`${plural(rejected.length, 'file')} skipped (unsupported format).`, { tone: 'warn', source });
  }
  if (accepted.length > CONFIRM_UPLOAD_OVER) {
    const ok = await ctx.ui.confirmDialog({
      title: `Upload ${accepted.length} images?`,
      source,
      message: `${accepted.length} images will be uploaded to ${folderLabel}, one at a time. Failed uploads are not retried.`,
      confirmLabel: `Upload ${accepted.length}`,
    });
    if (!ok || ctx.signal.aborted) return null;
  }
  const items = accepted.map((file) => ({ file, originalName: file.name, ...splitFileName(file.name), alt: '' }));
  if (skipEdit) return items;
  return editStep(ctx, items, { folderLabel, source });
}

/** The edit dialog: one row per file with a preview, name (extension kept) and alt text. */
async function editStep(ctx, items, { folderLabel, source }) {
  const urls = [];
  const rows = items.map((it) => {
    let url = '';
    try { url = URL.createObjectURL(it.file); urls.push(url); } catch { /* no preview */ }
    const meta = h('div', { class: 'il-emeta' }, [formatFileSize(it.file.size), it.originalName].filter(Boolean).join(' · '));
    const img = url ? h('img', { src: url, alt: '' }) : null;
    img?.addEventListener('load', () => {
      const dims = formatDimensions(img.naturalWidth, img.naturalHeight);
      if (dims) meta.textContent = [dims, formatFileSize(it.file.size), it.originalName].filter(Boolean).join(' · ');
    }, { once: true });
    const name = ctx.ui.input({ value: it.base, ariaLabel: `Name for ${it.originalName}` });
    const alt = ctx.ui.input({ value: it.alt, placeholder: 'Describe the image…', ariaLabel: `Alt text for ${it.originalName}` });
    const row = h('div', { class: 'il-erow' },
      h('div', { class: 'il-eprev' }, img),
      h('div', { class: 'il-efields' },
        ctx.ui.field({ label: 'Name', control: h('div', { class: 'il-namewrap' }, name, it.ext ? h('span', { class: 'il-ext' }, it.ext) : null) }),
        ctx.ui.field({ label: 'Alt text (optional)', control: alt }),
        meta));
    return { it, row, name, alt };
  });

  const n = items.length;
  const dlg = ctx.ui.dialog({
    title: `Upload ${plural(n, 'image')}`,
    source,
    size: 'lg',
    css: BROWSER_CSS,
    body: h('div', { class: 'il-edit' },
      h('p', { class: 'il-edit-intro' }, `To ${folderLabel}. A blank name keeps the file's original name.`),
      rows.map((r) => r.row)),
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'ghost' },
      { id: 'upload', label: n === 1 ? 'Upload' : `Upload all ${n}`, variant: 'primary' },
    ],
  });
  rows[0]?.name.focus();
  const stop = () => dlg.close(null);
  ctx.signal.addEventListener('abort', stop, { once: true });
  const result = await dlg.closed;
  ctx.signal.removeEventListener('abort', stop);
  for (const u of urls) URL.revokeObjectURL(u);
  if (result !== 'upload' || ctx.signal.aborted) return null;
  return rows.map(({ it, name, alt }) => ({ ...it, base: name.value, alt: alt.value.trim() }));
}

/**
 * Upload progress strip shown above the grid. → { el, start(items, label), set(i, outcome),
 * progress(doneCount), finish(summary), onStop(cb) }.
 */
export function uploadPanel(ctx) {
  const title = h('span', { class: 'il-up-t' });
  const fill = h('div', { class: 'il-fill' });
  const list = h('ul', { class: 'il-up-list' });
  let stopCb = null;
  const stopBtn = ctx.ui.button('Stop', {
    size: 'sm', variant: 'ghost', title: 'Stop after the current file', trusted: true,
    onClick: () => { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; stopCb?.(); },
  });
  const dismiss = ctx.ui.button('Dismiss', { size: 'sm', variant: 'ghost', onClick: () => { el.hidden = true; } });
  const el = h('div', { class: 'il-up', hidden: true, role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'il-up-head' }, title, stopBtn, dismiss),
    h('div', { class: 'il-track' }, fill),
    list);
  let lis = [];
  let total = 0;
  let label = '';
  const chip = (li, text, tone) => {
    const c = ctx.ui.chip(text, { tone });
    c.classList.add('st');
    li.querySelector('.st').replaceWith(c);
  };
  return {
    el,
    onStop(cb) { stopCb = cb; },
    start(items, folderLabel) {
      total = items.length;
      label = folderLabel;
      clear(list);
      el.classList.remove('has-bad');
      lis = items.map((it) => {
        const li = h('li', null, h('span', { class: 'fn', title: it.originalName }, finalAssetName(it.base, it.ext, it.originalName)), h('span', { class: 'st' }));
        list.append(li);
        chip(li, 'Waiting');
        return li;
      });
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      stopBtn.textContent = 'Stop';
      dismiss.hidden = true;
      el.hidden = false;
      this.progress(0);
    },
    uploading(i) {
      if (lis[i]) { chip(lis[i], 'Uploading…', 'accent'); lis[i].scrollIntoView?.({ block: 'nearest' }); }
    },
    set(i, outcome) {
      const li = lis[i];
      if (!li) return;
      if (outcome.status === 'done') chip(li, 'Uploaded', 'ok');
      else if (outcome.status === 'skipped') chip(li, 'Not started');
      else {
        chip(li, outcome.unknown ? 'Unknown' : 'Failed', outcome.unknown ? 'warn' : 'bad');
        li.append(h('span', { class: 'msg' }, outcome.text));
        el.classList.add('has-bad');
      }
    },
    progress(n) {
      fill.style.width = `${total ? Math.round((n / total) * 100) : 0}%`;
      title.textContent = `Uploading ${n} of ${total} to ${label}…`;
    },
    finish(text) {
      title.textContent = text;
      fill.style.width = '100%';
      stopBtn.hidden = true;
      dismiss.hidden = false;
    },
  };
}

/**
 * Upload items one by one into folderId (pinned for the whole batch). The in-flight request is
 * aborted only on unmount (ctx.signal); Stop lets the current file finish and skips the rest.
 * → { done, failed, skipped, unknown }.
 */
export async function runUploads(ctx, items, { folderId, panel, source, folderLabel }) {
  let stopped = false;
  panel?.onStop(() => { stopped = true; });
  panel?.start(items, folderLabel);
  const release = typeof ctx.holdMount === 'function' ? ctx.holdMount() : null;
  const tally = { done: 0, failed: 0, skipped: 0, unknown: 0 };
  try {
    for (let i = 0; i < items.length; i++) {
      if (stopped || ctx.signal.aborted) {
        tally.skipped++;
        panel?.set(i, { status: 'skipped' });
        continue;
      }
      const it = items[i];
      panel?.uploading(i);
      let err = null;
      try {
        await uploadImage(ctx, {
          folderId,
          file: it.file,
          assetName: finalAssetName(it.base, it.ext, it.originalName),
          altText: it.alt,
          signal: ctx.signal,
        });
      } catch (e) {
        err = e || new Error('Upload failed');
        ctx.log.warn('Upload failed', err.code || err.name || 'error', err.status || '');
      }
      const outcome = uploadOutcome(err);
      if (outcome.status === 'done') tally.done++;
      else tally.failed++;
      if (outcome.unknown) tally.unknown++;
      panel?.set(i, outcome);
      panel?.progress(i + 1);
    }
  } finally {
    release?.();
  }
  const sum = uploadSummary(tally);
  panel?.finish(sum.text);
  if (!ctx.signal.aborted) ctx.ui.toast(sum.text, { tone: sum.tone, source });
  ctx.log.debug(`Upload batch: ${tally.done} ok, ${tally.failed} failed, ${tally.skipped} skipped`);
  return tally;
}
