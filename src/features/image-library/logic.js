// Pure helpers for the image library (no DOM): formatting, filtering, paging, keyboard movement
// across the tile grid, upload bookkeeping. Unit-tested in test/features/image-library.test.js.

import { SORT_BY, SORT_DIRECTIONS, isAcceptedImageType } from '../../lib/iterable/assets.js';
import { projectSlot } from '../../core/state.js';

export const ITEMS_PER_PAGE_OPTIONS = Object.freeze(['20', '30', '50', '100']);
export const DEFAULT_ITEMS_PER_PAGE = 30;
/** More files than this in one go asks for confirmation first. */
export const CONFIRM_UPLOAD_OVER = 10;
/** State name of the imported "last folder" from the userscript (project unknown, see import.js). */
export const LEGACY_FOLDER_HINT = 'legacyLastFolderId';

/**
 * Project pinning for writes (ARCHITECTURE §5.2): re-check the page's project right before an
 * upload or folder creation and refuse when it changed since the library opened in `pinnedKey`,
 * or can't be confirmed. `project` is ctx.project. `action` is the verb for the message
 * ('uploaded', 'created'). → message (nothing may be sent) or null.
 */
export async function pinnedProjectError(project, pinnedKey, action = 'sent') {
  const unsure = `Couldn't confirm which project this page is in, so nothing was ${action}. Reload the page and try again.`;
  if (!project || typeof project.refresh !== 'function' || !pinnedKey) return unsure;
  try {
    await project.refresh({ force: true });
  } catch {
    return unsure;
  }
  if (project.error?.()) return unsure;
  const now = project.current?.();
  if (!now?.key) return unsure;
  if (now.key !== pinnedKey) {
    return `The project changed to "${now.name || now.key}" since the library opened, so nothing was ${action}. Close the library and open it again.`;
  }
  return null;
}

export const SORT_LABELS = Object.freeze({
  UpdatedAt: 'Date updated', CreatedAt: 'Date created', Name: 'Name', Size: 'Size',
});
export const DIRECTION_LABELS = Object.freeze({ Descending: 'Descending', Ascending: 'Ascending' });

/** ctx.settings → the browser's view options, each value checked (bad values → defaults). */
export function viewOptions(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    sortBy: SORT_BY.includes(s.sortBy) ? s.sortBy : 'UpdatedAt',
    sortDirection: SORT_DIRECTIONS.includes(s.sortDirection) ? s.sortDirection : 'Descending',
    perPage: perPageNumber(s.itemsPerPage),
    skipEditStep: s.skipEditStep === true,
  };
}

/** '50' / 50 → 50 when it is one of the offered sizes, else 30. */
export function perPageNumber(v) {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return ITEMS_PER_PAGE_OPTIONS.includes(String(n)) ? n : DEFAULT_ITEMS_PER_PAGE;
}

/** 0 → "0 B", 812 → "812 B", 2048 → "2.0 KB" (the script's format, minus "812.0 B"). null/NaN → ''. */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return i === 0 ? `${Math.round(bytes)} B` : `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function formatDimensions(width, height) {
  return width > 0 && height > 0 ? `${width} × ${height}` : '';
}

/** "hero.final.png" → { base: 'hero.final', ext: '.png' }; ".env" / "noext" keep everything in base. */
export function splitFileName(name) {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? { base: s.slice(0, dot), ext: s.slice(dot) } : { base: s, ext: '' };
}

/** Edited base name + the original extension; a blank base falls back to the original name. */
export function finalAssetName(base, ext, originalName) {
  const b = String(base ?? '').trim();
  return b ? b + (ext || '') : String(originalName ?? '').trim();
}

/**
 * normalizeAssetFolder's result → one list, folders first (as the script renders them):
 * [{ kind: 'folder', id, name } | { kind: 'image', id, name, image }].
 */
export function folderEntries(data) {
  const folders = (data?.subfolders || []).map((f) => ({ kind: 'folder', id: f.id, name: f.name }));
  const images = (data?.images || []).map((img) => ({ kind: 'image', id: img.id, name: img.name, image: img }));
  return folders.concat(images);
}

/** Case-insensitive substring match on the name (the script's local filter). */
export function filterEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => String(e.name ?? '').toLowerCase().includes(q));
}

/** → { page (clamped, ≥ 1), totalPages (≥ 1 when there are items, else 0), items }. */
export function paginate(items, page, perPage) {
  const per = perPage > 0 ? perPage : DEFAULT_ITEMS_PER_PAGE;
  const totalPages = Math.ceil(items.length / per);
  const p = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), Math.max(1, totalPages));
  return { page: p, totalPages, items: items.slice((p - 1) * per, p * per) };
}

/**
 * Page buttons to show, as the script does: up to `max` pages around the current one, plus the
 * first and last with 'gap' markers where pages are skipped. [] for a single page.
 */
export function pageWindow(current, total, max = 5) {
  if (!(total > 1)) return [];
  let start = Math.max(1, current - Math.floor(max / 2));
  const end = Math.min(total, start + max - 1);
  if (end - start < max - 1) start = Math.max(1, end - max + 1);
  const out = [];
  if (start > 1) {
    out.push(1);
    if (start > 2) out.push('gap');
  }
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total) {
    if (end < total - 1) out.push('gap');
    out.push(total);
  }
  return out;
}

/** "3 folders · 42 images" (only the non-zero parts; '' when both are 0). */
export function countLabel(entries) {
  let folders = 0;
  let images = 0;
  for (const e of entries) {
    if (e.kind === 'folder') folders++;
    else images++;
  }
  const part = (n, one) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : '');
  return [part(folders, 'folder'), part(images, 'image')].filter(Boolean).join(' · ');
}

/**
 * Keyboard movement across tiles laid out in (possibly several) grids. rects: [{ x, y, w, h }] in
 * document order. Left/Right step through document order; Up/Down pick the nearest tile (by
 * horizontal centre) in the closest row above/below; Home/End go to the ends. Returns the new
 * index, or `index` when there is nowhere to go (-1 for an empty list).
 */
export function spatialMove(rects, index, key) {
  const n = rects.length;
  if (!n) return -1;
  const cur = rects[index];
  if (!cur) return 0;
  switch (key) {
    case 'Home': return 0;
    case 'End': return n - 1;
    case 'ArrowRight': return Math.min(index + 1, n - 1);
    case 'ArrowLeft': return Math.max(index - 1, 0);
    case 'ArrowDown':
    case 'ArrowUp': {
      const down = key === 'ArrowDown';
      const TOL = 2;
      let rowY = null;
      for (const r of rects) {
        if (down ? r.y > cur.y + TOL : r.y < cur.y - TOL) {
          if (rowY === null || (down ? r.y < rowY : r.y > rowY)) rowY = r.y;
        }
      }
      if (rowY === null) return index;
      const cx = cur.x + cur.w / 2;
      let best = index;
      let bestD = Infinity;
      rects.forEach((r, i) => {
        if (Math.abs(r.y - rowY) > TOL) return;
        const d = Math.abs(r.x + r.w / 2 - cx);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    default: return index;
  }
}

/** Split picked/dropped files into uploadable images and the rest (by MIME type, as the script). */
export function partitionUploadFiles(files) {
  const accepted = [];
  const rejected = [];
  for (const f of files || []) (f && isAcceptedImageType(f.type) ? accepted : rejected).push(f);
  return { accepted, rejected };
}

/**
 * Per-project state name for the last opened folder: `lastFolder:<projectSlot>` (core/state.js),
 * backup-restorable whatever the project key holds. null without a project.
 */
export function lastFolderStateName(projectKey) {
  const slot = projectSlot(projectKey);
  return slot ? `lastFolder:${slot}` : null;
}

/** The name older versions used (the raw project key; read once, then moved). */
export function legacyLastFolderStateNames(projectKey) {
  return typeof projectKey === 'string' && projectKey ? [`lastFolder:${projectKey}`] : [];
}

/**
 * A stored or imported folder id → a usable id or null (root). Folder ids are GraphQL Longs:
 * positive integers, sometimes serialised as strings.
 */
export function normaliseFolderId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,19}$/.test(v.trim())) {
    const n = Number(v.trim());
    if (n <= 0) return null;
    return Number.isSafeInteger(n) ? n : v.trim();
  }
  return null;
}

/** Upload outcome → the status text shown on its row and whether Iterable may still have it. */
export function uploadOutcome(err) {
  if (!err) return { status: 'done', text: 'Uploaded', unknown: false };
  if (err.name === 'AbortError') return { status: 'failed', text: 'Stopped: it may or may not have uploaded', unknown: true };
  if (err.code === 'NETWORK') return { status: 'failed', text: 'No response: it may have uploaded, check the folder', unknown: true };
  return { status: 'failed', text: err.message || 'Upload failed', unknown: false };
}

/** Summary toast text for a finished batch. */
export function uploadSummary({ done = 0, failed = 0, skipped = 0 } = {}) {
  const imgs = (n) => `${n} image${n === 1 ? '' : 's'}`;
  if (!failed && !skipped) return { tone: 'ok', text: `${imgs(done)} uploaded.` };
  const parts = [`${done} uploaded`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} not started`);
  return { tone: done ? 'warn' : 'bad', text: `${parts.join(', ')}.` };
}
