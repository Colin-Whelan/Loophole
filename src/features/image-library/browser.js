// Reusable asset browser (Iterable's Creative Library): folders, breadcrumbs, search, sort, paging,
// new folder, upload, and choosing an image. No template-editor assumptions: index.js opens it in
// 'copy' mode from the editor button; a future BEE image picker can open it in 'pick' mode (run it
// in the top frame and hand the result to the bee half over ctx.frames).
//
//   openAssetBrowser(ctx, { mode: 'copy' | 'pick', onPick?, initialFolderId?, title? })
//     → Promise<image | null>   the chosen image (lib/iterable/assets.js normalizeImage shape),
//                               or null when closed without choosing.
//   copy  clicking an image copies its URL (flash + toast) and closes the browser.
//   pick  clicking an image calls onPick(image) and closes the browser.
//   initialFolderId  a folder id, or null for the root; omitted → the folder last opened in this
//                    project (ctx.state 'lastFolder:<projectKey>').
//
// Needs from ctx: http, ui, dom, state, log, signal, settings, saveSettings?, project?, holdMount?.

import { h, clear } from '../../core/dom.js';
import {
  ACCEPTED_UPLOAD_EXTENSIONS, FOLDER_NAME_MAX_LENGTH, SORT_BY, SORT_DIRECTIONS, createAssetFolder,
  fetchAssetFolder, validateFolderName,
} from '../../lib/iterable/assets.js';
import {
  DIRECTION_LABELS, ITEMS_PER_PAGE_OPTIONS, LEGACY_FOLDER_HINT, SORT_LABELS, countLabel, filterEntries,
  folderEntries, formatDimensions, formatFileSize, lastFolderStateName, legacyLastFolderStateNames, normaliseFolderId, pageWindow,
  pinnedProjectError,
  paginate, spatialMove, viewOptions,
} from './logic.js';
import { svgIcon } from './icons.js';
import { BROWSER_CSS } from './styles.js';
import { getMigrated } from '../../core/state.js';
import { prepareUploads, runUploads, uploadPanel } from './upload.js';

export const SOURCE = 'Image library';
const SEARCH_DEBOUNCE_MS = 300;
const COPY_CLOSE_MS = 600;

const errorText = (err) => (err && err.message) || 'Something went wrong.';

export function openAssetBrowser(ctx, { mode = 'copy', onPick, initialFolderId, title } = {}) {
  const view = viewOptions(ctx.settings);
  const life = new AbortController();
  const projectKey = () => ctx.project?.current?.()?.key || null;
  // The project the library shows (§5.2): every write re-checks it first. Not known yet at open
  // (project still loading) → pinned by the first folder that loads.
  let pinnedKey = projectKey();

  let folderId = null;       // what we asked for (null = root), so uploads/new folders target it
  let data = null;           // normalizeAssetFolder result for folderId
  let entries = [];
  let query = '';
  let page = 1;
  let loadSeq = 0;
  let loadCtrl = null;
  let uploading = false;
  let tiles = [];
  let focusIndex = 0;

  // ── Toolbar ───────────────────────────────────────────────────────────
  const crumbs = h('ol', { class: 'il-crumbs', 'aria-label': 'Folder path' });
  const fileInput = h('input', {
    type: 'file', multiple: true, accept: ACCEPTED_UPLOAD_EXTENSIONS, hidden: true, tabindex: '-1',
    onChange: (e) => {
      if (!e.isTrusted) return;
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      if (files.length) handleFiles(files);
    },
  });
  // Folder creation, uploads and URL copies act only on the person's own input (§7 trusted input).
  const newFolderBtn = ctx.ui.button([svgIcon('folderPlus'), 'New folder'], { size: 'sm', trusted: true, onClick: () => newFolder() });
  const uploadBtn = ctx.ui.button([svgIcon('upload'), 'Upload'], {
    size: 'sm', variant: 'primary', title: 'Upload images (or drop them on the library)', trusted: true, onClick: () => fileInput.click(),
  });
  const skip = ctx.ui.switchInput({
    checked: view.skipEditStep, label: 'Skip edit step',
    onChange: (on) => { view.skipEditStep = on; save({ skipEditStep: on }); },
  });
  skip.input.id = `il-skip-${Math.random().toString(36).slice(2)}`;
  const skipLabel = h('span', { class: 'il-skip', title: 'Upload files straight away with their original names' },
    skip, h('label', { for: skip.input.id }, 'Skip edit step'));

  let searchTimer = 0;
  const search = ctx.ui.input({ placeholder: 'Filter this folder', ariaLabel: 'Filter by name' });
  search.type = 'search';
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = search.value; page = 1; render(); }, SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && tiles.length) { e.preventDefault(); focusTile(0); }
  });

  const perPageSel = ctx.ui.select({
    ariaLabel: 'Items per page', value: String(view.perPage),
    options: ITEMS_PER_PAGE_OPTIONS.map((v) => ({ value: v, label: v })),
    onChange: (v) => { view.perPage = Number(v); page = 1; save({ itemsPerPage: v }); render(); },
  });
  const sortSel = ctx.ui.select({
    ariaLabel: 'Sort by', value: view.sortBy,
    options: SORT_BY.map((v) => ({ value: v, label: SORT_LABELS[v] || v })),
    onChange: (v) => { view.sortBy = v; page = 1; save({ sortBy: v }); load(folderId); },
  });
  const dirSel = ctx.ui.select({
    ariaLabel: 'Sort direction', value: view.sortDirection,
    options: SORT_DIRECTIONS.map((v) => ({ value: v, label: DIRECTION_LABELS[v] || v })),
    onChange: (v) => { view.sortDirection = v; page = 1; save({ sortDirection: v }); load(folderId); },
  });

  // ── Content ───────────────────────────────────────────────────────────
  const note = h('div', { class: 'il-note', hidden: true });
  const panel = uploadPanel(ctx);
  const main = h('div', { class: 'il-main' });
  const drop = h('div', { class: 'il-drop', hidden: true }, h('div', null, svgIcon('upload'), 'Drop images to upload here'));
  const count = h('span', { class: 'il-count', 'aria-live': 'polite' });
  const pages = h('nav', { class: 'il-pages', 'aria-label': 'Pages' });

  const root = h('div', { class: 'il' },
    h('div', { class: 'il-row' }, crumbs, newFolderBtn, uploadBtn, skipLabel, fileInput),
    h('div', { class: 'il-row' },
      h('div', { class: 'il-search' }, svgIcon('search'), search),
      h('span', { class: 'il-grow' }),
      h('label', { class: 'il-ctl' }, 'Show', perPageSel),
      h('label', { class: 'il-ctl' }, 'Sort', sortSel, dirSel)),
    note,
    panel.el,
    h('div', { class: 'il-stage' }, main, drop),
    h('div', { class: 'il-foot' }, count, h('span', { class: 'il-grow' }), pages));

  const dlg = ctx.ui.dialog({
    title: title || (mode === 'pick' ? 'Choose an image' : 'Creative Library'),
    source: SOURCE,
    size: 'xl',
    body: root,
    css: BROWSER_CSS,
  });

  const onAbort = () => dlg.close(null);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  dlg.closed.then(() => {
    life.abort();
    loadCtrl?.abort();
    clearTimeout(searchTimer);
    ctx.signal.removeEventListener('abort', onAbort);
  });

  // ── Settings / state ──────────────────────────────────────────────────
  function save(patch) {
    if (typeof ctx.saveSettings !== 'function') return;
    ctx.saveSettings(patch).catch((e) => ctx.log.warn('Could not save the view settings', e?.name || 'error'));
  }

  function remember(id) {
    const name = lastFolderStateName(projectKey());
    if (!name) return;
    ctx.state.set(name, id ?? null).catch((e) => ctx.log.warn('Could not remember the folder', e?.name || 'error'));
  }

  async function startFolder() {
    if (initialFolderId !== undefined) return { id: normaliseFolderId(initialFolderId), remembered: false };
    try {
      const pk = projectKey();
      const name = lastFolderStateName(pk);
      if (name) {
        // Moved from its pre-projectSlot name ('lastFolder:<projectKey>') on first read.
        const saved = await getMigrated(ctx.state, name, legacyLastFolderStateNames(pk), undefined);
        if (saved !== undefined) return { id: normaliseFolderId(saved), remembered: true };
      }
      const hint = normaliseFolderId(await ctx.state.get(LEGACY_FOLDER_HINT, null));
      if (hint !== null) return { id: hint, remembered: true, legacy: true };
    } catch (e) {
      ctx.log.warn('Could not read the last folder', e?.name || 'error');
    }
    return { id: null, remembered: false };
  }

  // ── Loading ───────────────────────────────────────────────────────────
  function showState(kind, ...content) {
    tiles = [];
    clear(main);
    clear(pages);
    main.append(h('div', { class: ['il-state', kind === 'error' && 'bad'], role: kind === 'error' ? 'alert' : null }, content));
  }

  async function load(id, { fromMemory = false, legacy = false } = {}) {
    loadCtrl?.abort();
    loadCtrl = new AbortController();
    const seq = ++loadSeq;
    showState('loading', h('div', { class: 'il-spin', 'aria-hidden': 'true' }), 'Loading…');
    count.textContent = '';
    try {
      const d = await fetchAssetFolder(ctx, {
        folderId: id, sortBy: view.sortBy, sortDirection: view.sortDirection, signal: loadCtrl.signal,
      });
      if (seq !== loadSeq || life.signal.aborted) return;
      if (!pinnedKey) pinnedKey = projectKey();
      const moved = id !== folderId || !data;
      folderId = id;
      data = d;
      entries = folderEntries(d);
      if (moved) { page = 1; focusIndex = 0; }
      renderCrumbs();
      render();
      remember(id);
      if (legacy) ctx.state.remove(LEGACY_FOLDER_HINT).catch(() => {});
    } catch (err) {
      if (seq !== loadSeq || life.signal.aborted || err?.name === 'AbortError') return;
      ctx.log.warn('Folder load failed', err?.code || err?.name || 'error', err?.status || '');
      if (fromMemory && id !== null) {
        // The imported hint is tried once: stale here, so it goes (this project's root is
        // remembered next).
        if (legacy) ctx.state.remove(LEGACY_FOLDER_HINT).catch(() => {});
        showNote('Your last folder couldn’t be opened, so the library opened at the top.');
        load(null);
        return;
      }
      showState('error', h('span', null, `Couldn’t load this folder. ${errorText(err)}`),
        h('div', { class: 'il-row' },
          ctx.ui.button('Retry', { size: 'sm', variant: 'primary', trusted: true, onClick: () => load(id) }),
          id !== null && ctx.ui.button('Go to the top', { size: 'sm', onClick: () => navigate(null) })));
    }
  }

  function navigate(id) {
    hideNote();
    query = '';
    search.value = '';
    load(id);
  }

  function showNote(text) { note.textContent = text; note.hidden = false; }
  function hideNote() { note.hidden = true; }

  function folderLabel() {
    if (!data || data.folder.isRoot) return 'the top of the library';
    return `“${data.folder.name}”`;
  }

  function parentId() {
    if (!data || data.folder.isRoot) return undefined;
    const a = data.ancestors;
    return a.length ? a[a.length - 1].id : null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function renderCrumbs() {
    clear(crumbs);
    const isRoot = !data || data.folder.isRoot;
    const item = (label, id, current) => h('li', null,
      h('button', {
        type: 'button', class: 'il-crumb', title: label,
        'aria-current': current ? 'location' : null,
        onClick: current ? null : () => navigate(id),
      }, label));
    const sep = () => h('span', { class: 'il-sep', 'aria-hidden': 'true' }, '›');
    crumbs.append(item('Library', null, isRoot));
    if (isRoot) return;
    const trail = data.ancestors.map((a) => [a.name || 'Untitled', a.id, false]);
    trail.push([data.folder.name || 'Untitled', folderId, true]);
    for (const [label, id, current] of trail) {
      crumbs.lastChild.append(sep());
      crumbs.append(item(label, id, current));
    }
  }

  function folderTile(entry) {
    return h('button', {
      type: 'button', class: 'il-folder', title: entry.name, tabindex: '-1',
      onClick: () => navigate(entry.id),
    }, svgIcon('folder'), h('span', null, entry.name || 'Untitled'));
  }

  function imageCard(entry) {
    const img = entry.image;
    const dims = formatDimensions(img.width, img.height);
    const size = formatFileSize(img.size);
    const thumb = h('div', { class: 'il-thumb' });
    const pic = h('img', { src: img.thumbnailUrl || img.url, alt: img.altText || '', loading: 'lazy', decoding: 'async' });
    pic.addEventListener('error', () => thumb.classList.add('broken'), { once: true });
    thumb.append(pic);
    const card = h('button', {
      type: 'button', class: 'il-card', tabindex: '-1',
      title: `${img.name}\n${mode === 'pick' ? 'Click to choose' : 'Click to copy the URL'}`,
      onClick: ctx.dom.trusted(() => choose(img, card)),
    },
    thumb,
    h('div', { class: 'il-info' },
      h('div', { class: 'il-name' }, img.name || 'Untitled'),
      h('div', { class: 'il-meta' }, [dims, size].filter(Boolean).join(' · ') || ' ')));
    return card;
  }

  function render() {
    if (!data) return;
    const filtered = filterEntries(entries, query);
    count.textContent = countLabel(filtered) + (query.trim() && entries.length ? ` of ${entries.length} items` : '');
    if (!filtered.length) {
      showState('empty', svgIcon('empty'), query.trim() ? 'No matching items.' : 'This folder is empty.');
      return;
    }
    const pg = paginate(filtered, page, view.perPage);
    page = pg.page;
    const folders = pg.items.filter((e) => e.kind === 'folder');
    const images = pg.items.filter((e) => e.kind === 'image');
    clear(main);
    tiles = [];
    if (folders.length) {
      const grid = h('div', { class: 'il-folders' }, folders.map(folderTile));
      main.append(h('section', { class: 'il-sec', 'aria-label': 'Folders' }, h('h3', { class: 'il-h' }, 'Folders'), grid));
      tiles.push(...grid.children);
    }
    if (images.length) {
      const grid = h('div', { class: 'il-images' }, images.map(imageCard));
      main.append(h('section', { class: 'il-sec', 'aria-label': 'Images' }, h('h3', { class: 'il-h' }, 'Images'), grid));
      tiles.push(...grid.children);
    }
    focusIndex = Math.min(focusIndex, tiles.length - 1);
    tiles.forEach((t, i) => { t.tabIndex = i === focusIndex ? 0 : -1; });
    main.scrollTop = 0;
    renderPages(pg.page, pg.totalPages);
  }

  function renderPages(current, total) {
    clear(pages);
    if (total <= 1) return;
    const go = (p) => { page = p; focusIndex = 0; render(); };
    const btn = (content, p, { label, disabled, current: cur } = {}) => h('button', {
      type: 'button', class: 'il-page', disabled: !!disabled, 'aria-label': label,
      'aria-current': cur ? 'page' : null, onClick: () => go(p),
    }, content);
    pages.append(btn(svgIcon('chevronLeft'), current - 1, { label: 'Previous page', disabled: current === 1 }));
    for (const p of pageWindow(current, total)) {
      pages.append(p === 'gap' ? h('span', { class: 'il-gap', 'aria-hidden': 'true' }, '…')
        : btn(String(p), p, { label: `Page ${p}`, current: p === current }));
    }
    pages.append(btn(svgIcon('chevronRight'), current + 1, { label: 'Next page', disabled: current === total }));
  }

  function focusTile(i) {
    if (!tiles[i]) return;
    tiles.forEach((t, j) => { t.tabIndex = j === i ? 0 : -1; });
    focusIndex = i;
    tiles[i].focus();
    tiles[i].scrollIntoView?.({ block: 'nearest' });
  }

  main.addEventListener('keydown', (e) => {
    const i = tiles.indexOf(e.target);
    if (i < 0) return;
    if (e.key === 'Backspace') {
      const p = parentId();
      if (p !== undefined) { e.preventDefault(); navigate(p); }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const rects = tiles.map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    focusTile(spatialMove(rects, i, e.key));
  });
  main.addEventListener('focusin', (e) => {
    const i = tiles.indexOf(e.target);
    if (i >= 0 && i !== focusIndex) {
      tiles.forEach((t, j) => { t.tabIndex = j === i ? 0 : -1; });
      focusIndex = i;
    }
  });

  // ── Choosing ──────────────────────────────────────────────────────────
  let chosen = false;
  async function choose(img, card) {
    if (chosen) return;
    if (mode === 'pick') {
      chosen = true;
      try { onPick?.(img); } catch (e) { ctx.log.warn('onPick threw', e?.name || 'error'); }
      dlg.close(img);
      return;
    }
    const ok = await ctx.ui.copyText(img.url);
    if (life.signal.aborted) return;
    ctx.ui.flashElement(card, ok ? { label: 'Copied', ms: COPY_CLOSE_MS + 600 } : { label: 'Copy failed', tone: 'bad', ms: 1500 });
    if (!ok) {
      ctx.ui.toast('Couldn’t copy the image URL. Your browser blocked the clipboard.', { tone: 'bad', source: SOURCE });
      return;
    }
    chosen = true;
    ctx.ui.toast('Image URL copied to the clipboard.', { tone: 'ok', source: SOURCE });
    setTimeout(() => dlg.close(img), COPY_CLOSE_MS);
  }

  // ── New folder ────────────────────────────────────────────────────────
  async function newFolder() {
    const parent = folderId;
    const where = folderLabel();
    const nameInput = ctx.ui.input({ placeholder: 'Folder name', ariaLabel: 'Folder name' });
    nameInput.maxLength = FOLDER_NAME_MAX_LENGTH;
    const err = h('div', { class: 'il-err', role: 'alert' });
    nameInput.addEventListener('input', () => { err.textContent = ''; });
    let busy = false;
    const sub = ctx.ui.dialog({
      title: 'New folder',
      source: SOURCE,
      css: BROWSER_CSS,
      body: h('div', { class: 'il-edit' },
        ctx.ui.field({ label: 'Name', control: nameInput, help: `Created in ${where}. Up to ${FOLDER_NAME_MAX_LENGTH} characters, without " ' \\ / or ,` }),
        err),
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
        {
          id: 'create', label: 'Create', variant: 'primary',
          onClick: async () => {
            if (busy) return false;
            const v = validateFolderName(nameInput.value);
            if (!v.valid) { err.textContent = v.error; nameInput.focus(); return false; }
            busy = true;
            createBtn.disabled = true;
            createBtn.textContent = 'Creating…';
            try {
              const pinErr = await pinnedProjectError(ctx.project, pinnedKey, 'created');
              if (pinErr) throw Object.assign(new Error(pinErr), { code: 'PROJECT' });
              await createAssetFolder(ctx, { parentId: parent, name: v.name, signal: life.signal });
              ctx.ui.toast(`Folder “${v.name}” created.`, { tone: 'ok', source: SOURCE });
              if (!life.signal.aborted && folderId === parent) load(folderId);
              return true;
            } catch (e) {
              if (e?.name === 'AbortError') return true;
              ctx.log.warn('Create folder failed', e?.code || e?.name || 'error', e?.status || '');
              err.textContent = errorText(e);
              busy = false;
              createBtn.disabled = false;
              createBtn.textContent = 'Create';
              return false;
            }
          },
        },
      ],
    });
    const createBtn = sub.el.querySelector('.foot .wb-btn.primary');
    nameInput.addEventListener('keydown', (e) => {
      // run() acts only for a trusted keydown, like a click on the (enabled) Create button.
      if (e.key === 'Enter') { e.preventDefault(); if (!createBtn.disabled) sub.run('create', e); }
    });
    nameInput.focus();
    const closeSub = () => sub.close(null);
    life.signal.addEventListener('abort', closeSub, { once: true });
    await sub.closed;
    life.signal.removeEventListener('abort', closeSub);
  }

  // ── Upload ────────────────────────────────────────────────────────────
  async function handleFiles(files) {
    if (uploading) {
      ctx.ui.toast('An upload is already running. Wait for it to finish.', { tone: 'warn', source: SOURCE });
      return;
    }
    uploading = true;
    uploadBtn.disabled = true;
    const dest = folderId;
    const label = folderLabel();
    try {
      const items = await prepareUploads(ctx, files, { folderLabel: label, skipEdit: view.skipEditStep, source: SOURCE });
      if (!items?.length || ctx.signal.aborted) return;
      const pinErr = await pinnedProjectError(ctx.project, pinnedKey, 'uploaded');
      if (pinErr) {
        ctx.log.warn('Upload refused: project not confirmed');
        if (!ctx.signal.aborted) ctx.ui.toast(pinErr, { tone: 'bad', source: SOURCE });
        return;
      }
      if (ctx.signal.aborted || life.signal.aborted) return;
      await runUploads(ctx, items, { folderId: dest, panel, source: SOURCE, folderLabel: label });
      if (!life.signal.aborted && folderId === dest) load(folderId);
    } catch (e) {
      ctx.log.warn('Upload flow failed', e?.name || 'error');
      if (!ctx.signal.aborted) ctx.ui.toast(`Upload stopped: ${errorText(e)}`, { tone: 'bad', source: SOURCE });
    } finally {
      uploading = false;
      uploadBtn.disabled = false;
    }
  }

  // Drag and drop anywhere on the dialog; the scrim swallows stray drops so the page never
  // navigates to a dropped file.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const panelEl = dlg.el;
  panelEl.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.hidden = false;
  });
  panelEl.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  panelEl.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  panelEl.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    drop.hidden = true;
    if (!e.isTrusted) return;   // a page-built DataTransfer can't start an upload
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) handleFiles(files);
  });
  const scrim = panelEl.parentElement;
  for (const type of ['dragover', 'drop']) {
    scrim?.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); });
  }

  // ── Start ─────────────────────────────────────────────────────────────
  search.focus();
  renderCrumbs();
  startFolder().then((start) => {
    if (!life.signal.aborted) load(start.id, { fromMemory: start.remembered, legacy: !!start.legacy });
  });

  return dlg.closed.then((r) => (r && typeof r === 'object' ? r : null));
}
