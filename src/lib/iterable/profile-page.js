// Readers for Iterable's user profile page (/users/profiles/<id>/…): which user is on screen.
// Shared by Delete user, Profile Editor, Dynamic Lists and Event copy. The DOM part is thin
// (readContactRows); the parsing is pure and unit-tested. Selectors and parsing were lifted from
// the "Iterable Delete User" userscript.

export const PROFILE_MARKER = '/users/profiles/';
export const CONTACT_LIST_SELECTOR = '[data-test="contact-details-list"]';
export const HEADER_CONTENT_SELECTOR = '[data-test="page-header-content"]';
export const PAGE_ACTIONS_SELECTOR = '[data-test="page-header-page-actions"]';

const USER_ID_LABEL_RE = /^\s*User ID:\s*(.+?)\s*$/i;

/**
 * The profile URL is /users/profiles/<iterable-internal-id>/…. That id is neither the email nor
 * the userId, so it is never used as an identifier; it tells us which profile we're on (Dynamic
 * Lists calls /users/profiles/<id>/getProfileDetails with it). It is plausibly the itblUserId
 * (unconfirmed, see docs/LIVE-CHECKLIST.md). → the segment, or '' off a profile page.
 */
export function profileIdFromPath(pathname) {
  const p = String(pathname || '');
  const at = p.indexOf(PROFILE_MARKER);
  if (at === -1) return '';
  const seg = p.slice(at + PROFILE_MARKER.length).split('/')[0].trim();
  // It is reused in request paths (getProfileDetails): refuse dot segments outright.
  return seg && seg !== '.' && seg !== '..' ? seg : '';
}

/** "User ID: 000001" → "000001"; anything else → null. */
export function extractUserId(text) {
  const m = USER_ID_LABEL_RE.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

/** First candidate that looks like an email (contains "@", no whitespace), else null. */
export function pickEmail(candidates) {
  for (const raw of candidates || []) {
    const c = String(raw == null ? '' : raw).trim();
    if (c && c.includes('@') && !/\s/.test(c)) return c;
  }
  return null;
}

/**
 * Read the email off the contact-details rows. rows = [{ text, titles: [title attr of each
 * span[title] in the row] }] in page order. The "User ID: …" row is skipped (a userId can look
 * like an email). Within a row, a title wins over the visible text, which may be truncated with an
 * ellipsis. → the email, or null.
 */
export function emailFromContactRows(rows) {
  const usable = (rows || []).filter((r) => r && extractUserId(r.text) == null);
  for (const r of usable) {
    const e = pickEmail(r.titles || []);
    if (e) return e;
  }
  return pickEmail(usable.map((r) => r.text));
}

/** The "User ID: …" row's value, or null. */
export function userIdFromContactRows(rows) {
  for (const r of rows || []) {
    const id = r && extractUserId(r.text);
    if (id) return id;
  }
  return null;
}

/**
 * DOM: the contact-details rows of the profile header (falling back to the whole header content)
 * → [{ text, titles }], or [] when the header isn't rendered yet. `root` needs querySelector.
 */
export function readContactRows(root = document) {
  const list = root.querySelector(CONTACT_LIST_SELECTOR) || root.querySelector(HEADER_CONTENT_SELECTOR);
  if (!list) return [];
  return Array.from(list.querySelectorAll('li'), (li) => ({
    text: li.textContent,
    titles: Array.from(li.querySelectorAll('span[title]'), (el) => el.getAttribute('title')),
  }));
}

/**
 * Who is on screen, read at call time (never cache it: React re-renders the header, and the
 * router keeps features mounted across profiles).
 * → { email, userId, profileId }; each is null ('' for profileId) when not shown. Never throws:
 * a DOM error is passed to onError and reads as "not shown".
 */
export function readProfileIdentity({ root = globalThis.document, pathname = globalThis.location?.pathname, onError } = {}) {
  const out = { email: null, userId: null, profileId: profileIdFromPath(pathname) };
  try {
    const rows = root ? readContactRows(root) : [];
    out.email = emailFromContactRows(rows);
    out.userId = userIdFromContactRows(rows);
  } catch (e) {
    onError?.(e);
  }
  return out;
}
