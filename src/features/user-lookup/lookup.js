// Pure helpers for the user-lookup feature. No DOM: unit tested directly.

/** Auto-detect email vs userId, same rule as the userscript: contains "@" → email. Empty → null. */
export function detectLookupKind(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return null;
  return s.includes('@') ? 'email' : 'userId';
}

/** Relative profile path (data-center agnostic; the browser resolves it against the current app host). */
export function profilePath(itblUserId) {
  return `/users/profiles/${encodeURIComponent(itblUserId)}`;
}

/** epoch ms / ISO-ish string → a readable local string, or the original text if it doesn't parse. */
export function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * A found user record (lib/iterable/users.js collectUserFields shape: email, userId, itblUserId,
 * signupDate, firstName, lastName, lastSeenDate — whichever are present) → [[label, value]] rows
 * for ui.kv, in the old lookup bar's order. Prefers itblUserId as the displayed "User ID" (it's
 * what the profile URL needs), falling back to userId. Display only: never log these.
 */
export function userKvRows(user) {
  const rows = [];
  if (!user || typeof user !== 'object') return rows;
  if (user.email) rows.push(['Email', user.email]);
  const id = user.itblUserId || user.userId;
  if (id) rows.push(['User ID', id]);
  if (user.firstName) rows.push(['First name', String(user.firstName)]);
  if (user.lastName) rows.push(['Last name', String(user.lastName)]);
  if (user.signupDate) rows.push(['Signup date', formatDate(user.signupDate)]);
  if (user.lastSeenDate) rows.push(['Last seen', formatDate(user.lastSeenDate)]);
  return rows;
}

/** The id to navigate/copy for a found user (itblUserId preferred), or null. */
export function profileIdOf(user) {
  const id = user && typeof user === 'object' ? user.itblUserId || user.userId : null;
  return id ? String(id) : null;
}

export const NO_PROFILE_ID_MESSAGE = 'Found this user, but the lookup returned no profile id to open.';

/**
 * What a lookup result leads to:
 *   { action: 'open', path }                 found with an id: go straight to the profile
 *   { action: 'preview', message, rows }     found, but no id to open: say why, show what came back
 *   { action: 'error', message }             not found / failed
 */
export function lookupOutcome(result) {
  if (!result || typeof result !== 'object') return { action: 'error', message: 'Lookup failed.' };
  if (result.status === 'found') {
    const id = profileIdOf(result.user);
    if (id) return { action: 'open', path: profilePath(id) };
    return { action: 'preview', message: NO_PROFILE_ID_MESSAGE, rows: userKvRows(result.user) };
  }
  if (result.status === 'not-found') return { action: 'error', message: 'No user found.' };
  return { action: 'error', message: result.message || 'Lookup failed.' };
}
