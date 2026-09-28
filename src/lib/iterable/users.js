// Iterable users: lookups (public API through the background, and the app's own session lookup),
// updates, and typed parsing of a field value typed by a person.
//   public:  GET /api/users/getByEmail?email=…, GET /api/users/byUserId/{userId},
//            POST /api/users/update                              (ctx.api.request, saved key)
//   app:     GET /users/profiles/getUserData?email=…|userId=…   (ctx.http.appFetch, session)
// Lookups were lifted from the Delete user feature; updateUser / parseFieldInput reconcile the
// "Iterable Profile Editor" and "Iterable - Live Preview Editor" (Push New Value) userscripts.

import { sendWithRetry, isOutcomeUnknown } from '../../core/retry.js';
import { checkPath } from '../../core/api-validation.js';
import { IterableError } from './errors.js';

export const UPDATE_USER_PATH = '/api/users/update';
const LOOKUP_BACKOFFS = [1000, 2000, 4000];
const UPDATE_BACKOFFS = [1000, 2000, 4000];

// ── Requests ───────────────────────────────────────────────────────────────

/**
 * Public-API lookup → { path, query? } for ctx.api.request.
 * Email goes in the query string (GET /api/users/getByEmail?email=), which sidesteps the
 * path-encoding questions an email with "/" or "+" raises; userId uses the path form
 * GET /api/users/byUserId/{userId}, encoded as one segment.
 */
export function publicLookupRequest(kind, value) {
  return kind === 'email'
    ? { path: '/api/users/getByEmail', query: { email: String(value) } }
    : { path: '/api/users/byUserId/' + encodeURIComponent(value) };
}

/** The app's own session-authenticated lookup (same one the Enhanced User Lookup Bar uses). */
export function appLookupPath(kind, value) {
  return '/users/profiles/getUserData?' + (kind === 'email' ? 'email=' : 'userId=') + encodeURIComponent(value);
}

// ── Normalising the two user-record shapes ─────────────────────────────────

/** The identity fields both lookups can return (top level or inside dataFields). Delete user
 *  cross-checks exactly these. */
export const USER_IDENTITY_FIELDS = Object.freeze(['email', 'userId', 'itblUserId', 'signupDate']);

/** Everything a found record carries: identity plus the display fields the old lookup bar showed
 *  (firstName, lastName, lastSeenDate), top level or inside dataFields. Names are PII: display
 *  only, never logged. */
export const USER_RECORD_FIELDS = Object.freeze([...USER_IDENTITY_FIELDS, 'firstName', 'lastName', 'lastSeenDate']);

/** obj[key], else obj.dataFields[key]; empty values (undefined / null / '') count as missing. */
export function pickUserField(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = obj[key];
  if (v !== undefined && v !== null && v !== '') return v;
  const df = obj.dataFields;
  if (df && typeof df === 'object') {
    const d = df[key];
    if (d !== undefined && d !== null && d !== '') return d;
  }
  return undefined;
}

/** → { email?, userId?, itblUserId?, signupDate?, firstName?, lastName?, lastSeenDate? }, only the
 *  fields present. */
export function collectUserFields(obj) {
  const out = {};
  for (const k of USER_RECORD_FIELDS) {
    const v = pickUserField(obj, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Interpret a public-API lookup response ({ ok, status, data, error } from ctx.api.request, after
 * retries). → { status: 'found', user } | { status: 'not-found' } | { status: 'error', message }.
 * user = collectUserFields(record). Iterable answers an unknown user with 200 and an empty object
 * (or no `user`), and sometimes 404.
 */
export function interpretPublicLookup(res) {
  if (!res) return { status: 'error', message: 'No response.' };
  if (res.ok) {
    const u = res.data && typeof res.data === 'object' ? res.data.user : null;
    if (u && typeof u === 'object') {
      const user = collectUserFields(u);
      return Object.keys(user).length ? { status: 'found', user } : { status: 'not-found' };
    }
    return { status: 'not-found' };
  }
  if (res.status === 404) return { status: 'not-found' };
  return { status: 'error', message: res.error?.message || `HTTP ${res.status || 0}` };
}

/**
 * Interpret the app lookup. Pass { data } for a 2xx body or { errorStatus, message } when
 * appFetch threw. The endpoint answers a miss with an `error` field (or 404).
 */
export function interpretAppLookup({ data, errorStatus, message } = {}) {
  if (errorStatus !== undefined) {
    if (errorStatus === 404) return { status: 'not-found' };
    return { status: 'error', message: message || `HTTP ${errorStatus}` };
  }
  if (data && typeof data === 'object') {
    if (data.error) return { status: 'not-found' };
    const user = collectUserFields(data);
    if (user.email || user.itblUserId || user.userId) return { status: 'found', user };
  }
  return { status: 'error', message: 'Unexpected response from the app.' };
}

// ── Lookups ────────────────────────────────────────────────────────────────

async function publicLookup(api, { projectKey, kind, value, signal, backoffs = LOOKUP_BACKOFFS }) {
  const req = publicLookupRequest(kind, value);
  if (req.path && checkPath(req.path)) return { unsafe: true };
  const res = await sendWithRetry(() => api.request({ projectKey, method: 'GET', path: req.path, query: req.query }), {
    backoffs,
    fatal: () => false,
    isSuccess: (r) => r.ok === true,
    signal,
  });
  return { res: res.response || res };
}

const UNSAFE_ID = { status: 'error', message: 'This identifier can’t be sent to the API safely.' };

/**
 * lookupUserPublic({ api }, { projectKey, kind: 'email' | 'userId', value, signal, backoffs })
 * → interpretPublicLookup's result. Uses the saved key of projectKey (ctx.api.request defaults to
 * the current project when projectKey is omitted). Retries NETWORK/TIMEOUT/429/5xx with 1/2/4 s
 * backoffs; rejects only with an AbortError.
 */
export async function lookupUserPublic({ api }, opts) {
  const r = await publicLookup(api, opts);
  return r.unsafe ? UNSAFE_ID : interpretPublicLookup(r.res);
}

/**
 * lookupUserApp({ http }, { kind, value, signal }) → interpretAppLookup's result, through the
 * signed-in session (no key). Rejects only with an AbortError.
 */
export async function lookupUserApp({ http }, { kind, value, signal } = {}) {
  try {
    const data = await http.appFetch(appLookupPath(kind, value), { signal });
    return interpretAppLookup({ data });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return interpretAppLookup({ errorStatus: Number.isInteger(err?.status) ? err.status : 0, message: err?.message });
  }
}

/**
 * identity { email } or { userId } (exactly one, non-empty) → { kind, value }. Throws
 * IterableError INVALID otherwise, so a call never silently picks one of two identifiers.
 */
export function identityOf({ email, userId } = {}) {
  const e = typeof email === 'string' ? email.trim() : '';
  const u = userId == null ? '' : String(userId).trim();
  if (e && u) throw new IterableError('Give either an email or a userId, not both.', { code: 'INVALID' });
  if (e) {
    if (!e.includes('@')) throw new IterableError('That email address doesn’t look valid.', { code: 'INVALID' });
    return { kind: 'email', value: e };
  }
  if (u) return { kind: 'userId', value: u };
  throw new IterableError('An email or userId is required.', { code: 'INVALID' });
}

/**
 * getUser({ api }, { projectKey, email | userId, signal }) → the full public-API record:
 * { status: 'found', user: { email, userId, dataFields, … } } | { status: 'not-found' }
 * | { status: 'error', message }. For reading a field's current value (Profile Editor, Live
 * Preview "Check field"). Throws IterableError INVALID for a bad identity, AbortError on abort.
 */
export async function getUser({ api }, { projectKey, email, userId, signal } = {}) {
  const { kind, value } = identityOf({ email, userId });
  const r = await publicLookup(api, { projectKey, kind, value, signal });
  if (r.unsafe) return UNSAFE_ID;
  const verdict = interpretPublicLookup(r.res);
  if (verdict.status !== 'found') return verdict;
  return { status: 'found', user: r.res.data.user };
}

/** Value at a dot path in a user record: top level first, then dataFields (a.b → dataFields.a.b). */
export function userFieldValue(user, path) {
  if (!user || typeof user !== 'object' || !path) return undefined;
  const walk = (obj) => {
    let cur = obj;
    for (const k of String(path).split('.')) {
      if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
      cur = cur[k];
    }
    return cur;
  };
  if (Object.prototype.hasOwnProperty.call(user, path)) return user[path];
  return walk(user.dataFields);
}

// ── Updates ────────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * "a.b.c" + value → { a: { b: { c: value } } } (the Profile Editor's setNestedProperty). A path
 * without dots is a plain top-level field. Throws INVALID on empty segments or reserved names.
 */
export function dataFieldsFor(path, value) {
  const keys = String(path ?? '').split('.');
  if (!path || keys.some((k) => !k.trim())) throw new IterableError('Field name is empty or has an empty part ("a..b").', { code: 'INVALID' });
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) throw new IterableError('That field name is reserved.', { code: 'INVALID' });
  const root = {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = (cur[k] = {});
  });
  return root;
}

/**
 * POST body for /api/users/update. identity: exactly one of email / userId (identityOf).
 * createNewFields is only sent when a boolean is given (the Profile Editor sent true; the Live
 * Preview pusher didn't send it).
 */
export function updateUserBody({ email, userId, dataFields, mergeNestedObjects = true, createNewFields } = {}) {
  const { kind, value } = identityOf({ email, userId });
  if (!dataFields || typeof dataFields !== 'object' || Array.isArray(dataFields)) {
    throw new IterableError('dataFields must be an object.', { code: 'INVALID' });
  }
  const body = { [kind]: value, dataFields, mergeNestedObjects: !!mergeNestedObjects };
  if (typeof createNewFields === 'boolean') body.createNewFields = createNewFields;
  return body;
}

/** Iterable's update succeeded only when the 2xx body says code: 'Success'. */
export function isUpdateSuccess(r) {
  return !!r && r.ok === true && !!r.data && typeof r.data === 'object' && r.data.code === 'Success';
}

/**
 * updateUser({ api }, { projectKey, email | userId, dataFields, mergeNestedObjects = true,
 *   createNewFields?, signal, backoffs })
 * → Iterable's body ({ code: 'Success', msg, params }).
 * Throws IterableError code 'API' with apiCode = wb:api's error.code (NO_KEY, BAD_REQUEST,
 * NETWORK, TIMEOUT, HTTP) or Iterable's body code (e.g. 'InvalidEmailAddressError'), `status`,
 * and outcomeUnknown = true when any attempt got no response (it may have been applied, even if
 * a later attempt failed definitely).
 * INVALID for a bad identity / dataFields (nothing sent). Retries NETWORK/TIMEOUT/429/5xx
 * (writing the same values again is harmless); 401/403/NO_KEY stop at once.
 * Never logs: the body holds PII.
 */
export async function updateUser({ api }, { projectKey, email, userId, dataFields, mergeNestedObjects = true, createNewFields, signal, backoffs = UPDATE_BACKOFFS } = {}) {
  const body = updateUserBody({ email, userId, dataFields, mergeNestedObjects, createNewFields });
  // Sticky: once any attempt got no response, the update may have been applied, whatever a
  // later attempt says (a definite 4xx then can't prove the first one didn't land).
  let uncertain = false;
  const send = async () => {
    const r = await api.request({ projectKey, method: 'POST', path: UPDATE_USER_PATH, body });
    if (isOutcomeUnknown(r)) uncertain = true;
    return r;
  };
  const result = await sendWithRetry(send, { backoffs, isSuccess: isUpdateSuccess, signal });
  if (result.ok) return result.data;
  const maybe = (msg) => (uncertain ? `${msg} An earlier attempt got no response, so the update may or may not have been applied.` : msg);
  const resp = result.response || {};
  const d = resp.data;
  if (resp.ok && d && typeof d === 'object') {
    const code = typeof d.code === 'string' ? d.code : 'UnexpectedResponse';
    const msg = typeof d.msg === 'string' && d.msg ? d.msg : 'Iterable did not confirm the update.';
    throw new IterableError(maybe(`${code}: ${msg}`), { code: 'API', apiCode: code, status: result.status, outcomeUnknown: uncertain });
  }
  if (resp.ok) {
    throw new IterableError(maybe('Iterable did not confirm the update.'), { code: 'API', apiCode: 'UnexpectedResponse', status: result.status, outcomeUnknown: uncertain });
  }
  const lastUnknown = isOutcomeUnknown(resp);
  const bodyMsg = d && typeof d === 'object' && typeof d.msg === 'string' && d.msg ? d.msg : '';
  const base = bodyMsg || result.error?.message || `HTTP ${result.status || 0}`;
  throw new IterableError(lastUnknown ? `${base} The update may or may not have been applied.` : maybe(base), {
    code: 'API',
    apiCode: (d && typeof d === 'object' && typeof d.code === 'string' && d.code) || result.error?.code || 'HTTP',
    status: result.status,
    outcomeUnknown: uncertain || lastUnknown,
  });
}

// ── Parsing a typed value ──────────────────────────────────────────────────

const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// Iterable's accepted date formats: "yyyy-MM-dd HH:mm:ss ZZ", "yyyy-MM-dd HH:mm:ss",
// "yyyy-MM-dd'T'HH:mm:ss.SSSZ" (ISO with zone) and "yyyy-MM-dd".
const DATE_RES = [
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: ?[+-]\d{2}:?\d{2}| ?Z)?$/,
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/,
];

const TOO_BIG = 'is too large to store exactly as a number (limit ±9007199254740991). Put it in quotes to save it as a string.';

function isSafeIntText(t) {
  const n = BigInt(t);
  return (n < 0n ? -n : n) <= MAX_SAFE;
}

/**
 * Integer literals (no fraction/exponent) outside strings in a JSON text whose magnitude exceeds
 * Number.MAX_SAFE_INTEGER; JSON.parse would silently round them. → the first one, or null.
 */
export function unsafeIntegerInJson(text) {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const tok = text.slice(i, j);
      if (INT_RE.test(tok) && !isSafeIntText(tok)) return tok;
      i = j - 1;
    }
  }
  return null;
}

/** A date string in one of Iterable's formats with a real calendar date. */
export function isIterableDateString(s) {
  if (typeof s !== 'string') return false;
  for (const re of DATE_RES) {
    const m = re.exec(s);
    if (!m) continue;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1) return false;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) return false;
    if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false;
    return true;
  }
  return false;
}

/** Type of an already-parsed JSON value, in Iterable's vocabulary. */
export function detectValueType(v) {
  if (v === null) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'long' : 'double' };
  if (typeof v === 'string') return { type: isIterableDateString(v) ? 'date' : 'string' };
  if (Array.isArray(v)) {
    if (!v.length) return { type: 'array', itemType: 'empty' };
    const types = new Set(v.map((x) => detectValueType(x).type));
    if (types.size === 2 && types.has('long') && types.has('double')) return { type: 'array', itemType: 'double' };
    return { type: 'array', itemType: types.size === 1 ? [...types][0] : 'mixed' };
  }
  return { type: 'object' };
}

/** "array" + itemType → "array of long" etc., for a type badge. */
export function describeType({ type, itemType } = {}) {
  if (type !== 'array') return type || '';
  return itemType === 'empty' ? 'empty array' : `array of ${itemType}`;
}

/** Iterable / Profile-Editor field type names → the parser's kinds. Unknown → null (auto). */
export function normalizeFieldType(fieldType) {
  const t = String(fieldType || '').trim().toLowerCase();
  if (!t) return null;
  if (['string', 'text', 'keyword'].includes(t)) return 'string';
  if (['long', 'integer', 'int'].includes(t)) return 'long';
  if (['double', 'float', 'decimal'].includes(t)) return 'double';
  if (t === 'number') return 'number';
  if (['boolean', 'bool'].includes(t)) return 'boolean';
  if (t === 'date') return 'date';
  if (['object', 'geo_location', 'geolocation'].includes(t)) return 'object';
  if (['nested', 'nested (array)', 'array'].includes(t)) return 'nested';
  return null;
}

const ok = (value, detected) => ({ ok: true, value, ...detected });
const fail = (error) => ({ ok: false, error });

function parseJson(t) {
  const big = unsafeIntegerInJson(t);
  if (big) return { error: `The number ${big.length > 24 ? big.slice(0, 22) + '…' : big} ${TOO_BIG}` };
  try { return { value: JSON.parse(t) }; } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
}

/** Auto-detection (no known field type): the Live Preview pusher's rules, made big-int safe. */
function autoParse(t) {
  if (INT_RE.test(t)) {
    if (!isSafeIntText(t)) return fail(`The number ${TOO_BIG}`);
    return ok(Number(t), { type: 'long' });
  }
  if (/^[[{"]/.test(t) || t === 'null') {
    const r = parseJson(t);
    if (r.error) {
      // A leading quote/bracket that isn't JSON is plain text, as in the pusher; the big-number
      // refusal still stands.
      if (r.error.includes(TOO_BIG)) return fail(r.error);
      return ok(t, { type: 'string' });
    }
    return ok(r.value, detectValueType(r.value));
  }
  const lower = t.toLowerCase();
  if (lower === 'true') return ok(true, { type: 'boolean' });
  if (lower === 'false') return ok(false, { type: 'boolean' });
  if (DEC_RE.test(t) && Number.isFinite(Number(t))) return ok(Number(t), { type: Number.isInteger(Number(t)) ? 'long' : 'double' });
  return ok(t, detectValueType(t));
}

function scalar(kind, t) {
  switch (kind) {
    case 'string': return ok(t, { type: 'string' });
    case 'long':
      if (!INT_RE.test(t)) return fail('Expected a whole number (e.g. 42).');
      if (!isSafeIntText(t)) return fail(`The number ${TOO_BIG}`);
      return ok(Number(t), { type: 'long' });
    case 'double':
    case 'number': {
      if (INT_RE.test(t) && !isSafeIntText(t)) return fail(`The number ${TOO_BIG}`);
      if (!DEC_RE.test(t) || !Number.isFinite(Number(t))) return fail('Expected a number (e.g. 42 or 3.14).');
      const n = Number(t);
      return ok(n, { type: kind === 'double' ? 'double' : (Number.isInteger(n) ? 'long' : 'double') });
    }
    case 'boolean': {
      const l = t.toLowerCase();
      if (l === 'true') return ok(true, { type: 'boolean' });
      if (l === 'false') return ok(false, { type: 'boolean' });
      return fail('Expected true or false.');
    }
    case 'date':
      if (INT_RE.test(t)) {
        if (!isSafeIntText(t)) return fail(`The number ${TOO_BIG}`);
        return ok(Number(t), { type: 'date' });   // epoch milliseconds
      }
      if (isIterableDateString(t)) return ok(t, { type: 'date' });
      return fail('Expected a date like 2024-05-01, 2024-05-01 13:45:00 +00:00, 2024-05-01T13:45:00Z, or epoch milliseconds.');
    default: return null;
  }
}

const ITEM_CHECKS = {
  string: (x) => typeof x === 'string',
  long: (x) => Number.isInteger(x),
  double: (x) => typeof x === 'number',
  number: (x) => typeof x === 'number',
  boolean: (x) => typeof x === 'boolean',
  date: (x) => Number.isInteger(x) || isIterableDateString(x),
};

/**
 * parseFieldInput(text, fieldType?) → { ok: true, value, type, itemType? } | { ok: false, error }
 *
 * type ∈ 'string' | 'long' | 'double' | 'boolean' | 'date' | 'object' | 'array' | 'null';
 * itemType (arrays) ∈ one of those, 'mixed' or 'empty'. Surrounding whitespace is trimmed.
 *
 * With a known fieldType (Iterable's: string, long, double, boolean, date, object, nested,
 * geo_location; the Profile Editor's 'number'), the text must fit it:
 *   string   the text as is ("quoted" JSON strings are unquoted); long: whole numbers; double /
 *   number   any number; boolean: true/false (any case); date: Iterable date formats or epoch ms
 *   (dates stay strings); object: a JSON object; nested: a JSON array.
 *   Scalar fields also take a JSON array of that type (Iterable types an array field by its
 *   elements, e.g. a string array is 'string'). JSON null is accepted for any type (it clears
 *   the field).
 * Without a fieldType (a new field), the type is detected: whole numbers → long, decimals →
 * double, true/false → boolean, JSON objects/arrays/strings/null, date strings → 'date' (still a
 * string value), anything else → string. Empty text → '' (string); callers decide whether an
 * empty value is allowed.
 * Big-int safety: an integer beyond ±2^53−1 is refused (anywhere in JSON too) instead of being
 * silently rounded.
 */
export function parseFieldInput(text, fieldType) {
  const t = String(text ?? '').trim();
  const kind = normalizeFieldType(fieldType);
  if (!kind) return t === '' ? ok('', { type: 'string' }) : autoParse(t);
  if (t === '') {
    return kind === 'string' ? ok('', { type: 'string' }) : fail('Enter a value.');
  }
  if (t === 'null') return ok(null, { type: 'null' });

  if (kind === 'object' || kind === 'nested') {
    const r = parseJson(t);
    if (r.error) return fail(r.error);
    const v = r.value;
    if (kind === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) return fail('Expected a JSON object, e.g. {"key": "value"}.');
    if (kind === 'nested' && !Array.isArray(v)) return fail('Expected a JSON array, e.g. [{"id": 1}].');
    return ok(v, detectValueType(v));
  }

  if (t.startsWith('[')) {
    const r = parseJson(t);
    if (r.error) return kind === 'string' ? ok(t, { type: 'string' }) : fail(r.error);
    if (!Array.isArray(r.value)) return fail('Expected an array.');
    const items = r.value;
    const bad = items.findIndex((x) => !ITEM_CHECKS[kind](x));
    if (bad !== -1) return fail(`Item ${bad + 1} of the array isn't a ${kind === 'long' ? 'whole number' : kind}.`);
    return ok(items, { type: 'array', itemType: items.length ? (kind === 'number' ? detectValueType(items).itemType : kind) : 'empty' });
  }

  if (kind === 'string' && t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v = JSON.parse(t);
      if (typeof v === 'string') return ok(v, { type: 'string' });
    } catch { /* not a JSON string: keep the text */ }
  }
  return scalar(kind, t);
}
