// Iterable snippets (FetchSnippets GraphQL query), from the "Iterable Snippet Viewer" userscript.

import { appGraphql } from './graphql.js';
import { IterableError } from './errors.js';

/** The script's page size (it fetched one page of 999 and stopped). */
export const SNIPPETS_PAGE_SIZE = 999;
/** Safety cap on pages fetched in one call (≈ 20 k snippets at the default page size). */
export const SNIPPETS_MAX_PAGES = 20;

export const FETCH_SNIPPETS_QUERY = `query FetchSnippets($pagination: Pagination, $search: String, $sort: Sort) {
                    fetchSnippets(pagination: $pagination, search: $search, sort: $sort) {
                        paginationInfo { count offset limit page __typename }
                        results {
                            id createdAt updatedAt updatedBy
                            updatedByUser { id fullName avatarUrl __typename }
                            projectId name creatorUserId
                            creatorUser { id fullName avatarUrl __typename }
                            content description positionalParameters __typename
                        }
                        __typename
                    }
                }`;

export function snippetsVariables({ offset = 0, limit = SNIPPETS_PAGE_SIZE, search = null } = {}) {
  return {
    pagination: { limit, offset },
    search: search || null,
    sort: { sortBy: 'UpdatedAt', sortDirection: 'Descending' },
  };
}

/**
 * fetchSnippets({ http }, { search, pageSize, maxPages, signal })
 * → { snippets, total, complete }
 *   snippets  the API's snippet records, as returned (id, name, content, description,
 *             positionalParameters, createdAt, updatedAt, updatedBy, updatedByUser, projectId,
 *             creatorUserId, creatorUser), newest update first, de-duplicated by id
 *   total     paginationInfo.count when the API sends it, else null
 *   complete  false when the result may be missing snippets: maxPages was hit, or a later page
 *             added nothing new (the API ignoring `offset`) while the total is unknown or unmet
 *
 * Pages of `pageSize` (999, the script's value) are fetched until a short page, the reported
 * total, or maxPages. Only offset 0 is proven against live Iterable; whether offsets beyond it
 * work is unverified, hence the no-progress guard.
 */
export async function fetchSnippets({ http }, { search = null, pageSize = SNIPPETS_PAGE_SIZE, maxPages = SNIPPETS_MAX_PAGES, signal } = {}) {
  const byId = new Map();
  const extra = [];   // snippets without an id (never expected; kept rather than dropped)
  let total = null;
  let complete = false;

  for (let page = 0; page < maxPages; page++) {
    const data = await appGraphql({ http }, {
      operationName: 'FetchSnippets',
      query: FETCH_SNIPPETS_QUERY,
      variables: snippetsVariables({ offset: page * pageSize, limit: pageSize, search }),
      signal,
    });
    const fs = data.fetchSnippets;
    if (!fs || typeof fs !== 'object' || !Array.isArray(fs.results)) {
      throw new IterableError('FetchSnippets: unexpected response shape.', { code: 'BAD_RESPONSE', status: 200 });
    }
    const count = fs.paginationInfo?.count;
    if (typeof count === 'number' && Number.isFinite(count)) total = count;

    let added = 0;
    for (const s of fs.results) {
      if (!s || typeof s !== 'object') continue;
      if (s.id == null) { extra.push(s); added++; continue; }
      const k = String(s.id);
      if (!byId.has(k)) { byId.set(k, s); added++; }
    }
    const have = byId.size + extra.length;
    if (fs.results.length < pageSize) { complete = true; break; }
    if (total != null && have >= total) { complete = true; break; }
    if (!added) break;   // offset ignored or no progress: stop, reported as incomplete
  }
  return { snippets: [...byId.values(), ...extra], total, complete };
}
