// Creative Library previews: bigger grid thumbnails/rows, a full-size hover preview, and
// click-to-copy the asset's public URL. Port of "Iterable Creative Library - Bigger Previews"
// v1.2.0.
//
// The userscript patched window.fetch at document-start to harvest every GraphQL asset response
// as it flew by. Loophole never patches fetch (ARCHITECTURE §9 - only the page-RPC/frame-channel
// rules cover injecting into the page, and there is no case for rewriting page globals). Instead
// this resolves the current folder's assets on demand with lib/iterable/assets.js
// `fetchAssetFolder`, cached in memory per folder id and refetched whenever the folder changes
// (`ctx.onUrlChange`, since /creativeLibrary itself never changes route and the router wouldn't
// remount us on a `?folderId=` change).
//
// Matching rule (see match.js `resolveAsset`): a grid cell (`[data-test="preview-<id>"]`) is
// looked up by that id only, exactly like the userscript's `urlCache.get(id)`. If the id isn't in
// the fetched folder (the grid is ahead of our fetch, or a new upload), a click reloads the folder
// once and then shows "Not found". Names are never used to resolve a URL: they aren't unique, so
// a name match could copy another asset's URL.

import { fetchAssetFolder } from '../../lib/iterable/assets.js';
import { assetIdFromPreview, folderIdFromSearch, indexAssets, resolveAsset } from './match.js';

const SELECTORS = Object.freeze({
  row: '[data-test="grid-row"]',
  preview: '[data-test^="preview-"]',
});

// Namespaced id for the one <style> element we inject into the host page's <head>. Iterable's own
// grid can only be restyled by targeting its markup directly (ARCHITECTURE has no shadow-DOM
// escape hatch for that); this is the sole exception to "everything injected lives in a shadow
// root" and is scoped to exactly the two selectors above.
const HOST_STYLE_ID = 'wb-creative-previews-grid-style';

const OVERLAY_CSS = `
.cp-hover{position:fixed; pointer-events:none; display:none; background:var(--wb-surface);
  border:1px solid var(--wb-line); border-radius:var(--wb-r-lg); box-shadow:var(--wb-shadow);
  padding:8px}
.cp-hover img{display:block; width:auto; height:auto; border-radius:var(--wb-r); background:var(--wb-sunken)}
.cp-hover .cp-label{font:11px var(--wb-font); color:var(--wb-muted); margin-top:6px;
  text-align:center; word-break:break-all; max-width:inherit}
.cp-flash{position:fixed; pointer-events:none; display:none; align-items:center; justify-content:center;
  border-radius:var(--wb-r); font:600 12.5px var(--wb-font); color:#fff; text-align:center; padding:4px}
.cp-flash.ok{background:rgba(16,163,74,.92)}
.cp-flash.bad{background:rgba(220,38,38,.92)}
`;

function hostGridCss({ thumbSize, rowHeight }) {
  return `
${SELECTORS.row}{ min-height:${rowHeight}px !important; align-items:center !important; }
${SELECTORS.preview}{
  width:${thumbSize}px !important; height:${thumbSize}px !important;
  min-width:${thumbSize}px !important; min-height:${thumbSize}px !important;
  background-size:contain !important; background-repeat:no-repeat !important;
  background-position:center !important; background-color:#f4f4f5 !important;
  border:1px solid #e4e4e7 !important; border-radius:6px !important;
  cursor:pointer !important; flex-shrink:0 !important; position:relative !important;
  transition:transform .12s ease, box-shadow .12s ease !important;
}
${SELECTORS.preview}:hover{
  transform:scale(1.04) !important; box-shadow:0 2px 12px rgba(0,0,0,.15) !important;
}
`;
}

function thumbUrlFromBackground(previewEl) {
  const bg = getComputedStyle(previewEl).backgroundImage;
  const m = bg.match(/url\(["']?(.+?)["']?\)/);
  return m ? m[1] : null;
}

export function mount(ctx) {
  const { h } = ctx.dom;
  let values = ctx.settings;

  // folderId (number | null) -> { status: 'idle' | 'loading' | 'ready' | 'error', index, promise }
  const cache = new Map();

  // ── Host-page grid styling (namespaced, removed on unmount) ────────────────
  const styleEl = h('style', { id: HOST_STYLE_ID });
  document.head.append(styleEl);
  function applyHostStyle() { styleEl.textContent = hostGridCss(values); }
  applyHostStyle();

  // ── Our own UI: hover preview + copy flash, shadow-rooted on the float layer ────────────────
  const overlay = ctx.ui.mountOverlay('float', { className: 'cp' });
  overlay.root.append(h('style', null, OVERLAY_CSS));
  const hoverImg = h('img', { alt: '' });
  const hoverLabel = h('div', { class: 'cp-label' });
  const hoverPanel = h('div', { class: 'cp-hover' }, hoverImg, hoverLabel);
  const flashBadge = h('div', { class: 'cp-flash' });
  overlay.el.append(hoverPanel, flashBadge);

  function applyHoverSize() {
    const { hoverSize } = values;
    hoverPanel.style.maxWidth = `${hoverSize}px`;
    hoverPanel.style.maxHeight = `${hoverSize + 40}px`;
    hoverImg.style.maxWidth = `${hoverSize - 16}px`;
    hoverImg.style.maxHeight = `${hoverSize - 16}px`;
  }
  applyHoverSize();

  // ── Per-folder asset cache ──────────────────────────────────────────────────
  function currentFolderId() {
    return folderIdFromSearch(location.search);
  }

  function entryFor(folderId) {
    let entry = cache.get(folderId);
    if (!entry) {
      entry = { status: 'idle', index: { byId: new Map() }, promise: null };
      cache.set(folderId, entry);
    }
    return entry;
  }

  function loadFolder(folderId, { force = false } = {}) {
    const entry = entryFor(folderId);
    if (entry.promise && !force) return entry.promise;
    entry.status = 'loading';
    entry.promise = fetchAssetFolder({ http: ctx.http }, { folderId: folderId ?? undefined, signal: ctx.signal })
      .then((res) => {
        entry.index = indexAssets(res.images);
        entry.status = 'ready';
        return entry.index;
      })
      .catch((err) => {
        entry.status = 'error';
        if (err?.name !== 'AbortError') ctx.log.warn('failed to fetch folder assets', err);
        throw err;
      });
    return entry.promise;
  }

  function ensureFolderLoaded(folderId) {
    const entry = entryFor(folderId);
    if (entry.status === 'idle') loadFolder(folderId).catch(() => {});
  }

  function assetForPreview(previewEl, folderId) {
    const entry = cache.get(folderId);
    if (!entry || entry.status !== 'ready') return null;
    const id = assetIdFromPreview(previewEl.getAttribute('data-test'));
    return resolveAsset(entry.index, { id });
  }

  // ── Hover preview ────────────────────────────────────────────────────────
  let hoverTimer = null;

  function positionHover(e) {
    if (hoverPanel.style.display !== 'block') return;
    const padding = 16;
    const rect = hoverPanel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX + 20;
    let y = e.clientY + 20;
    if (x + rect.width + padding > vw) x = e.clientX - rect.width - 20;
    if (y + rect.height + padding > vh) y = vh - rect.height - padding;
    if (y < padding) y = padding;
    if (x < padding) x = padding;
    hoverPanel.style.left = `${x}px`;
    hoverPanel.style.top = `${y}px`;
  }

  function showHover(previewEl, e) {
    if (!values.hoverPreview) return;
    const asset = assetForPreview(previewEl, currentFolderId());
    const url = asset?.url || thumbUrlFromBackground(previewEl);
    if (!url) return;
    hoverImg.src = url;
    hoverLabel.textContent = asset?.name || '';
    hoverPanel.style.display = 'block';
    positionHover(e);
  }

  function hideHover() {
    hoverPanel.style.display = 'none';
  }

  // ── Click-to-copy ────────────────────────────────────────────────────────
  function showFlash(previewEl, tone, label) {
    const rect = previewEl.getBoundingClientRect();
    flashBadge.className = `cp-flash ${tone}`;
    flashBadge.textContent = label;
    flashBadge.style.left = `${rect.left}px`;
    flashBadge.style.top = `${rect.top}px`;
    flashBadge.style.width = `${rect.width}px`;
    flashBadge.style.height = `${rect.height}px`;
    flashBadge.style.display = 'flex';
    clearTimeout(showFlash._t);
    showFlash._t = setTimeout(() => { flashBadge.style.display = 'none'; }, 900);
  }

  async function copyUrl(previewEl) {
    const folderId = currentFolderId();
    ensureFolderLoaded(folderId);
    let asset = assetForPreview(previewEl, folderId);
    if (!asset) {
      // An id miss (stale grid, a new upload): reload the folder once, then give up. Never match
      // by name, which could copy another asset's URL.
      try { await loadFolder(folderId, { force: true }); } catch { /* handled below */ }
      asset = assetForPreview(previewEl, folderId);
    }
    if (!asset?.url) {
      showFlash(previewEl, 'bad', 'Not found');
      return;
    }
    const ok = await ctx.ui.copyText(asset.url);
    showFlash(previewEl, ok ? 'ok' : 'bad', ok ? 'URL copied!' : 'Copy failed');
  }

  // ── Event handlers (capture, so we intercept before Iterable opens its detail modal) ────────
  function onMouseOver(e) {
    const preview = e.target.closest(SELECTORS.preview);
    if (!preview) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHover(preview, e), values.hoverDelay);
  }
  function onMouseOut(e) {
    if (!e.target.closest(SELECTORS.preview)) return;
    clearTimeout(hoverTimer);
    hideHover();
  }
  function onMouseMove(e) {
    positionHover(e);
  }
  function onClick(e) {
    // Iterable's own preview elements are page DOM: a page's synthetic click must not copy.
    if (!e.isTrusted) return;
    const preview = e.target.closest(SELECTORS.preview);
    if (!preview) return;
    e.preventDefault();
    e.stopPropagation();
    copyUrl(preview);
  }

  document.addEventListener('mouseover', onMouseOver, { signal: ctx.signal });
  document.addEventListener('mouseout', onMouseOut, { signal: ctx.signal });
  document.addEventListener('mousemove', onMouseMove, { signal: ctx.signal });
  document.addEventListener('scroll', hideHover, { capture: true, signal: ctx.signal });
  document.addEventListener('click', onClick, { capture: true, signal: ctx.signal });

  // Warm the cache for the folder we land on, and whenever the SPA navigates to another one.
  ensureFolderLoaded(currentFolderId());
  let lastFolderId = currentFolderId();
  const offUrl = ctx.onUrlChange(() => {
    const folderId = currentFolderId();
    if (folderId === lastFolderId) return;
    lastFolderId = folderId;
    hideHover();
    ensureFolderLoaded(folderId);
  });

  const offSettings = ctx.onSettings((v) => {
    values = v;
    applyHostStyle();
    applyHoverSize();
  });

  return () => {
    offUrl?.();
    offSettings?.();
    overlay.destroy();
    styleEl.remove();
    clearTimeout(hoverTimer);
    clearTimeout(showFlash._t);
  };
}
