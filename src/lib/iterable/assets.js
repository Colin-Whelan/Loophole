// Iterable asset library (Creative Library / image picker): folders, images, uploads.
// Query text, variables and the upload body are the ones the "Iterable Image Path Selector" and
// "Iterable Creative Library - Bigger Previews" userscripts use in production.

import { appGraphql } from './graphql.js';
import { IterableError, wrapFetchError } from './errors.js';

export const UPLOAD_PATH = '/i/assetManager/images';

/** The script's "fetch everything, page locally" limit. */
export const FETCH_ALL_LIMIT = 9999;
export const ROOT_FOLDER_NAME = '__root__';

export const SORT_BY = Object.freeze(['UpdatedAt', 'CreatedAt', 'Name', 'Size']);
export const SORT_DIRECTIONS = Object.freeze(['Descending', 'Ascending']);
/** Default image filter inside a folder (the root is queried unfiltered, as the script does). */
export const IMAGE_MIME_TYPES = Object.freeze(['PNG', 'JPEG', 'GIF', 'WEBP', 'SVG']);
export const ACCEPTED_UPLOAD_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
export const ACCEPTED_UPLOAD_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp,.svg';

export const FOLDER_NAME_MAX_LENGTH = 100;
const FOLDER_NAME_BLOCKED_CHARS = ['"', "'", '\\', '/', ','];

export const FETCH_ASSET_FOLDER_QUERY = `query FetchAssetFolderQuery($assetFilterInfo: ImageFilterInfoInput, $pagination: Pagination, $search: String, $folderId: Long, $recursive: Boolean, $sort: Sort) {
                assetFolder(
                    assetFilterInfo: $assetFilterInfo
                    pagination: $pagination
                    search: $search
                    folderId: $folderId
                    recursive: $recursive
                    sort: $sort
                ) {
                    info { count limit offset page __typename }
                    name
                    id
                    content {
                        ... on AssetSubfolder {
                            __typename
                            id
                            name
                        }
                        ... on ImageAsset {
                            __typename
                            id
                            projectId
                            assetName
                            altText
                            assetType
                            createdAt
                            updatedAt
                            url
                            size
                            height
                            width
                            mimeType
                        }
                        __typename
                    }
                    ancestors { id name __typename }
                    __typename
                }
            }`;

export const CREATE_ASSET_FOLDER_MUTATION = `mutation CreateAssetFolder($name: String!, $locationId: Long) {
                        createAssetFolder(name: $name, locationId: $locationId)
                    }`;

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Variables for FetchAssetFolderQuery. Without `perPage` this is exactly the script's request
 * (offset 0, limit 9999: everything, paged locally). With `perPage`, `page` (1-based) becomes
 * offset/limit; server-side offsets other than 0 are unverified against live Iterable.
 * mimeTypes: undefined → the script's rule (images-only filter inside a folder, none at the root);
 * null → no filter; an array → that filter.
 */
export function assetFolderVariables({ folderId = null, sortBy = 'UpdatedAt', sortDirection = 'Descending', page, perPage, mimeTypes, search = '' } = {}) {
  const id = folderId === undefined || folderId === '' ? null : folderId;
  const paged = Number.isInteger(perPage) && perPage > 0;
  const limit = paged ? perPage : FETCH_ALL_LIMIT;
  const p = Number.isInteger(page) && page > 1 ? page : 1;
  const offset = paged ? (p - 1) * limit : 0;
  const mimeType = mimeTypes === undefined ? (id !== null ? [...IMAGE_MIME_TYPES] : null) : mimeTypes;
  return {
    folderId: id,
    recursive: false,
    pagination: { offset, limit },
    search: search || '',
    assetFilterInfo: { createdByUserId: null, updatedByUserId: null, mimeType, size: null },
    sort: { sortBy: SORT_BY.includes(sortBy) ? sortBy : 'UpdatedAt', sortDirection: SORT_DIRECTIONS.includes(sortDirection) ? sortDirection : 'Descending' },
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** One ImageAsset → the normalised image record. */
export function normalizeImage(a) {
  const url = str(a.url);
  return {
    id: a.id,
    name: str(a.assetName ?? a.name),
    url,
    // The query has no thumbnail field; Iterable's own grid shows the full image scaled down.
    thumbnailUrl: url,
    width: num(a.width),
    height: num(a.height),
    size: num(a.size),
    mimeType: str(a.mimeType),
    createdAt: a.createdAt ?? null,
    updatedAt: a.updatedAt ?? null,
    altText: str(a.altText),
  };
}

const isImage = (c) => c && (c.__typename === 'ImageAsset' || (c.__typename == null && c.url && (c.assetName || c.name)));
const isFolder = (c) => c && c.__typename === 'AssetSubfolder';

/**
 * `data.assetFolder` → { folder: { id, name, isRoot }, ancestors: [{ id, name }] (root to parent,
 * the "__root__" entry left out, as the script's breadcrumbs do), subfolders: [{ id, name }],
 * images: [normalizeImage], total, info }.
 * total: info.count when the API sends a number, else the number of items returned.
 */
export function normalizeAssetFolder(af) {
  if (!af || typeof af !== 'object') throw new IterableError('The asset folder response was empty.', { code: 'BAD_RESPONSE', status: 200 });
  const content = Array.isArray(af.content) ? af.content.filter(Boolean) : [];
  const subfolders = content.filter(isFolder).map((c) => ({ id: c.id, name: str(c.name) }));
  const images = content.filter(isImage).map(normalizeImage);
  const ancestors = (Array.isArray(af.ancestors) ? af.ancestors : [])
    .filter((a) => a && a.name !== ROOT_FOLDER_NAME)
    .map((a) => ({ id: a.id, name: str(a.name) }));
  const info = af.info && typeof af.info === 'object' ? {
    count: num(af.info.count), limit: num(af.info.limit), offset: num(af.info.offset), page: num(af.info.page),
  } : null;
  const isRoot = af.id == null || af.name === ROOT_FOLDER_NAME;
  return {
    folder: { id: af.id ?? null, name: isRoot ? '' : str(af.name), isRoot },
    ancestors,
    subfolders,
    images,
    total: info?.count ?? subfolders.length + images.length,
    info,
  };
}

/** The script's folder-name rule → { valid: true, name } (trimmed) | { valid: false, error }. */
export function validateFolderName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed.length) return { valid: false, error: 'Folder name cannot be empty' };
  if (trimmed.length > FOLDER_NAME_MAX_LENGTH) return { valid: false, error: `Folder name cannot exceed ${FOLDER_NAME_MAX_LENGTH} characters` };
  for (const ch of FOLDER_NAME_BLOCKED_CHARS) {
    if (trimmed.includes(ch)) return { valid: false, error: `Folder name cannot contain "${ch}"` };
  }
  return { valid: true, name: trimmed };
}

/** "data:image/png;base64,AAAA" → "AAAA" (any image type); other strings are returned as is. */
export function stripDataUrlPrefix(base64) {
  return String(base64 ?? '').replace(/^data:image\/[^;]+;base64,/, '');
}

export function isAcceptedImageType(mimeType) {
  return ACCEPTED_UPLOAD_MIME_TYPES.includes(String(mimeType || '').toLowerCase());
}

/**
 * POST body for /i/assetManager/images, as the script sends it. altText only when non-blank.
 * Throws IterableError INVALID on a missing name, source or dimensions.
 */
export function uploadBody({ folderId, name, base64, width, height, assetName, altText }) {
  const finalName = String(assetName ?? name ?? '').trim();
  const source = stripDataUrlPrefix(base64);
  if (!finalName) throw new IterableError('An asset name is required.', { code: 'INVALID' });
  if (!source) throw new IterableError('The image has no data.', { code: 'INVALID' });
  if (!(width > 0) || !(height > 0)) throw new IterableError('Image width and height are required.', { code: 'INVALID' });
  const body = { assetName: finalName, height, width, source, destinationFolderId: folderId ?? null };
  const alt = typeof altText === 'string' ? altText.trim() : '';
  if (alt) body.altText = alt;
  return body;
}

// ── Calls ──────────────────────────────────────────────────────────────────

/**
 * fetchAssetFolder({ http }, { folderId, sortBy, sortDirection, page, perPage, mimeTypes, search,
 * signal }) → normalizeAssetFolder's shape. folderId null/undefined = the library root.
 */
export async function fetchAssetFolder({ http }, opts = {}) {
  const data = await appGraphql({ http }, {
    operationName: 'FetchAssetFolderQuery',
    query: FETCH_ASSET_FOLDER_QUERY,
    variables: assetFolderVariables(opts),
    signal: opts.signal,
  });
  return normalizeAssetFolder(data.assetFolder);
}

/**
 * createAssetFolder({ http }, { parentId, name, signal }) → { id, name }. The name is validated
 * (and trimmed) first; an invalid one throws IterableError INVALID with the rule's message.
 * Not retried: a repeat would create a second folder.
 */
export async function createAssetFolder({ http }, { parentId = null, name, signal } = {}) {
  const v = validateFolderName(name);
  if (!v.valid) throw new IterableError(v.error, { code: 'INVALID' });
  const data = await appGraphql({ http }, {
    operationName: 'CreateAssetFolder',
    query: CREATE_ASSET_FOLDER_MUTATION,
    variables: { name: v.name, locationId: parentId ?? null },
    signal,
  });
  return { id: data.createAssetFolder ?? null, name: v.name };
}

/** Browser only: File → { name, base64 (data URL), width, height, size, type }. */
export async function readImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new IterableError('Failed to read file', { code: 'INVALID' }));
    r.readAsDataURL(file);
  });
  const { width, height } = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new IterableError('Failed to load image', { code: 'INVALID' }));
    img.src = dataUrl;
  });
  return { name: file.name, base64: dataUrl, width, height, size: file.size, type: file.type };
}

/**
 * uploadImage({ http }, { folderId, file, assetName, altText, signal }) or
 * uploadImage({ http }, { folderId, name, base64, width, height, assetName, altText, signal })
 * → Iterable's response body (shape unverified; treat as opaque).
 * A File is read in the browser (readImageFile) and must be PNG/JPEG/GIF/WEBP/SVG.
 * Not retried: a repeat would upload a duplicate asset.
 */
export async function uploadImage({ http }, { folderId = null, file, name, base64, width, height, assetName, altText, signal } = {}) {
  let img = { name, base64, width, height };
  if (file) {
    if (file.type && !isAcceptedImageType(file.type)) {
      throw new IterableError('Unsupported image type (use PNG, JPEG, GIF, WEBP or SVG).', { code: 'INVALID' });
    }
    img = await readImageFile(file);
  }
  const body = uploadBody({ folderId, ...img, assetName, altText });
  try {
    return await http.appFetch(UPLOAD_PATH, { method: 'POST', body, headers: { Accept: 'application/json, text/plain, */*' }, signal });
  } catch (err) {
    throw wrapFetchError(err, 'Image upload');
  }
}
