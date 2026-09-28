// Pure helpers: matching Creative Library grid cells to fetched assets, and folder-id parsing.
// Port of "Iterable Creative Library - Bigger Previews" v1.2.0's id-based cache lookup
// (`getAssetIdFromPreview` / `urlCache.get(id)`).

/** `data-test="preview-1234"` → `"1234"`. Only the leading `preview-` is stripped. */
export function assetIdFromPreview(dataTest) {
  return String(dataTest || '').replace(/^preview-/, '');
}

/**
 * `fetchAssetFolder`'s normalised `images` → { byId: Map<string, image> }.
 * Images are matched by id only: names aren't unique, so a name match could hand out another
 * asset's URL.
 */
export function indexAssets(images) {
  const byId = new Map();
  for (const a of images || []) {
    if (a == null || a.id == null || a.id === '') continue;
    byId.set(String(a.id), a);
  }
  return { byId };
}

/**
 * A grid cell's `data-test="preview-<id>"` id looked up exactly, as the userscript did. No name
 * fallback: a cell whose id isn't in the fetched folder (stale grid) resolves to null, and the
 * caller reloads the folder once before reporting "Not found". Returns the image record or null.
 */
export function resolveAsset({ byId } = {}, { id } = {}) {
  const key = id == null ? '' : String(id);
  return key && byId?.has(key) ? byId.get(key) : null;
}

/**
 * `location.search` → the `folderId` query param as an integer, or null (library root / not
 * present). Mirrors the userscript's `getFolderIdFromUrl`, but null is a valid folder (the root),
 * not a failure: index.js fetches the root folder too.
 */
export function folderIdFromSearch(search) {
  const m = String(search || '').match(/folderId=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
