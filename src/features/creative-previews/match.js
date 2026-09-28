// Pure helpers: matching Creative Library grid cells to fetched assets, and folder-id parsing.
// Port of "Iterable Creative Library - Bigger Previews" v1.2.0's id-based cache lookup
// (`getAssetIdFromPreview` / `urlCache.get(id)`), extended with a name fallback (see index.js).

/** `data-test="preview-1234"` → `"1234"`. Only the leading `preview-` is stripped. */
export function assetIdFromPreview(dataTest) {
  return String(dataTest || '').replace(/^preview-/, '');
}

/**
 * `fetchAssetFolder`'s normalised `images` → { byId: Map<string, image>, byName: Map<string, image> }.
 * byName keys are lower-cased/trimmed; the first image with a given name wins (names aren't unique).
 */
export function indexAssets(images) {
  const byId = new Map();
  const byName = new Map();
  for (const a of images || []) {
    if (a == null) continue;
    if (a.id != null) byId.set(String(a.id), a);
    const name = typeof a.name === 'string' ? a.name.trim().toLowerCase() : '';
    if (name && !byName.has(name)) byName.set(name, a);
  }
  return { byId, byName };
}

/**
 * The matching rule: a grid cell's `data-test="preview-<id>"` id is looked up first (exact match,
 * as the userscript did); a cell whose id isn't in the fetched folder (stale grid, or an id space
 * the GraphQL response doesn't share) falls back to the row's visible name, matched
 * case-insensitively. Returns the image record, or null.
 */
export function resolveAsset({ byId, byName } = {}, { id, rowName } = {}) {
  if (id && byId?.has(id)) return byId.get(id);
  const name = typeof rowName === 'string' ? rowName.trim().toLowerCase() : '';
  if (name && byName?.has(name)) return byName.get(name);
  return null;
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
