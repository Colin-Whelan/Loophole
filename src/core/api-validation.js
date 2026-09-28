// Pure validation / parsing helpers shared by the background API proxy, the key vault and tests.
// No chrome.*, no DOM, no side effects — everything here runs in plain Node.
//
// Contract: docs/ARCHITECTURE.md §5.1 (projectKey), §6 (wb:api rules), §9 (security rules).

// ---------------------------------------------------------------------------
// Data centers
// ---------------------------------------------------------------------------

/** Data center → Iterable REST API host. The only hosts the proxy will ever talk to. */
export const API_HOSTS = Object.freeze({
  us: 'api.iterable.com',
  eu: 'api.eu.iterable.com',
});

export function isDataCenter(dc) {
  return dc === 'us' || dc === 'eu';
}

// ---------------------------------------------------------------------------
// Project keys:  <dc>:<projectId>   or   <dc>:name:<projectName>
// ---------------------------------------------------------------------------

// Iterable project ids are numeric today; allow a slightly wider token so a future id format
// doesn't break storage, while keeping ':' and anything URL/HTML-significant out.
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PROJECT_NAME_MAX = 200;
const PROJECT_KEY_MAX = 3 + 5 + PROJECT_NAME_MAX;

// C0 controls, DEL, C1 controls, plus bidi overrides/isolates and line/para separators — these
// make a name render as something other than what it is (spoofing in key pickers / confirms).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

/**
 * Validate a display name (project name). Returns the trimmed name, or null if unusable.
 * Empty is allowed only when `allowEmpty` is set.
 */
export function cleanName(name, { allowEmpty = false } = {}) {
  if (name == null) return allowEmpty ? '' : null;
  if (typeof name !== 'string' && typeof name !== 'number') return null;
  const s = String(name).trim();
  if (!s) return allowEmpty ? '' : null;
  if (s.length > PROJECT_NAME_MAX) return null;
  if (UNSAFE_TEXT_RE.test(s)) return null;
  return s;
}

/**
 * Parse a projectKey. Returns { dataCenter, id } | { dataCenter, name } | null.
 * Strict: exact lowercase data center, no surrounding whitespace.
 */
export function parseProjectKey(pk) {
  if (typeof pk !== 'string' || pk.length < 4 || pk.length > PROJECT_KEY_MAX) return null;
  const dc = pk.slice(0, 2);
  if (!isDataCenter(dc) || pk[2] !== ':') return null;
  const rest = pk.slice(3);
  if (rest.startsWith('name:')) {
    const raw = rest.slice(5);
    const name = cleanName(raw);
    // Must round-trip exactly: no leading/trailing whitespace hidden inside a key.
    if (name === null || name !== raw) return null;
    return { dataCenter: dc, name };
  }
  if (!PROJECT_ID_RE.test(rest)) return null;
  return { dataCenter: dc, id: rest };
}

/**
 * Build a projectKey. Prefers the id (projects can be renamed). Returns null if the inputs
 * can't produce a well-formed key.
 */
export function makeProjectKey({ dataCenter, id, name } = {}) {
  if (!isDataCenter(dataCenter)) return null;
  if (id != null && id !== '') {
    const sid = String(id);
    return PROJECT_ID_RE.test(sid) ? dataCenter + ':' + sid : null;
  }
  const n = cleanName(name);
  return n === null ? null : dataCenter + ':name:' + n;
}

/**
 * Map a legacy userscript key ('18244', 'name:Foo', or a number) to a projectKey
 * ('us:18244', 'us:name:Foo'). The userscripts only ever ran against the US app.
 * Already-modern keys pass through unchanged. Returns null if unmappable.
 */
export function legacyProjectKey(legacyKey) {
  if (typeof legacyKey === 'number') {
    return Number.isSafeInteger(legacyKey) && legacyKey >= 0
      ? makeProjectKey({ dataCenter: 'us', id: String(legacyKey) }) : null;
  }
  if (typeof legacyKey !== 'string') return null;
  if (parseProjectKey(legacyKey)) return legacyKey;
  if (legacyKey.startsWith('name:')) {
    const raw = legacyKey.slice(5);
    const n = cleanName(raw);
    return n === null ? null : 'us:name:' + n;
  }
  return PROJECT_ID_RE.test(legacyKey) ? 'us:' + legacyKey : null;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const API_KEY_MIN = 16;
export const API_KEY_MAX = 512;
// Iterable keys are 32 lowercase hex today. Accept the RFC 7235 token68 alphabet (hex, base64,
// base64url, JWT-ish) so a future format still fits, but nothing that could be whitespace, a
// control char, a quote, a header separator or non-ASCII (fetch would reject non-ByteStrings).
const API_KEY_RE = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Validate a pasted API key. Returns { ok: true, value } with the trimmed key, or
 * { ok: false, message }. The message never echoes the input.
 */
export function validateApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'API key must be text.' };
  const k = raw.trim();
  if (!k) return { ok: false, message: 'API key is empty.' };
  if (k.length < API_KEY_MIN) return { ok: false, message: 'API key is too short to be an Iterable key.' };
  if (k.length > API_KEY_MAX) return { ok: false, message: 'API key is too long to be an Iterable key.' };
  if (!API_KEY_RE.test(k)) {
    return { ok: false, message: 'API key contains spaces, quotes or other characters an Iterable key never has.' };
  }
  return { ok: true, value: k };
}

const MASK_DOTS = '\u2022'.repeat(8);
/** Reveal at most 8 characters and only when at least 12 stay hidden. */
const MASK_REVEAL_MIN_LEN = 20;

/** first 4 + '…' + last 4; short (or non-string) keys are fully masked. */
export function maskKey(k) {
  const s = typeof k === 'string' ? k : '';
  if (s.length < MASK_REVEAL_MIN_LEN) return s ? MASK_DOTS : '';
  return s.slice(0, 4) + '\u2026' + s.slice(-4);
}

// ---------------------------------------------------------------------------
// wb:api payload validation
// ---------------------------------------------------------------------------

export const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const PATH_MAX = 2048;
export const URL_MAX = 8192;
export const QUERY_MAX_KEYS = 100;
export const QUERY_MAX_ARRAY = 100;
export const QUERY_VALUE_MAX = 4096;
/** 5 MiB of UTF-8 JSON. Iterable's bulk endpoints cap well below this. */
export const BODY_MAX_BYTES = 5 * 1024 * 1024;

// RFC 3986 pchar minus nothing, plus '/'. Excludes '?', '#', '\\', whitespace, controls, non-ASCII.
const PATH_CHARS_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]+$/;
const PCT_TRIPLET_RE = /%(?![0-9A-Fa-f]{2})/;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const ASCII_TRIPLET_RE = /%([0-7][0-9A-Fa-f])/g;

/**
 * Every decoding a server might apply to a path segment, for the dot-segment / control-char
 * checks. The first layer is what callers produced with encodeURIComponent, so it must be valid
 * (throws otherwise). Deeper layers are decoded leniently: only %XX triplets for ASCII bytes are
 * decoded, and a literal '%' left over by the first layer (a userId "100%" arrives as "100%25")
 * stays literal. That still unwraps %252e → %2e → '.' and %252F → '/', which are the only
 * encodings that matter here (dots, separators and control characters are all ASCII).
 * Bounded; throws when still changing after 5 layers.
 */
function fullyDecode(s) {
  let cur = decodeURIComponent(s);
  for (let i = 0; i < 5; i++) {
    const next = cur.replace(ASCII_TRIPLET_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === cur) return cur;
    cur = next;
  }
  // Still changing after 5 rounds: nobody legitimately encodes that deep.
  throw new URIError('excessive encoding');
}

/**
 * Validate an API path. Returns null if fine, else a human reason.
 * Rules: starts with /api/, relative (no scheme/host), only URL path characters, no query or
 * fragment, no backslashes, no empty segments, no '.'/'..' segments — including after any depth
 * of percent-decoding and after treating decoded '/' or '\' as separators — and no decoded
 * control characters.
 */
export function checkPath(path) {
  if (typeof path !== 'string') return 'path must be a string';
  if (path.length > PATH_MAX) return 'path is too long';
  if (!path.startsWith('/api/')) return 'path must start with /api/';
  if (!PATH_CHARS_RE.test(path)) return 'path contains characters that are not allowed (query, fragment, backslash, whitespace or non-ASCII)';
  if (PCT_TRIPLET_RE.test(path)) return 'path has malformed percent-encoding';
  if (path.includes('//')) return 'path has an empty segment';
  const segments = path.slice(1).split('/');
  for (const seg of segments) {
    let decoded;
    try { decoded = fullyDecode(seg); } catch { return 'path has malformed percent-encoding'; }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(decoded)) return 'path contains control characters';
    for (const sub of decoded.split(/[/\\]/)) {
      if (sub === '.' || sub === '..') return 'path must not contain dot segments';
    }
  }
  return null;
}

function checkQuery(query) {
  if (query == null) return { ok: true, value: null };
  if (!isPlainObject(query)) return { ok: false, message: 'query must be a plain object' };
  const keys = Object.keys(query);
  if (keys.length > QUERY_MAX_KEYS) return { ok: false, message: 'query has too many keys' };
  const params = new URLSearchParams();
  const addOne = (k, v) => {
    if (v == null) return true; // skipped
    if (typeof v === 'string') {
      if (v.length > QUERY_VALUE_MAX) return false;
      params.append(k, v);
      return true;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
      params.append(k, String(v));
      return true;
    }
    if (typeof v === 'boolean') { params.append(k, v ? 'true' : 'false'); return true; }
    return false;
  };
  for (const k of keys) {
    if (!k || k.length > 256) return { ok: false, message: 'query key is empty or too long' };
    const v = query[k];
    if (Array.isArray(v)) {
      // Repeated params (e.g. onlyFields=a&onlyFields=b). Still flat: primitives only.
      if (v.length > QUERY_MAX_ARRAY) return { ok: false, message: `query "${k}" has too many values` };
      for (const item of v) {
        if (!addOne(k, item)) return { ok: false, message: `query "${k}" must hold only strings, finite numbers or booleans` };
      }
    } else if (!addOne(k, v)) {
      return { ok: false, message: `query "${k}" must be a string, finite number, boolean or a flat array of those` };
    }
  }
  return { ok: true, value: params };
}

function checkBody(body, method) {
  if (body === undefined || body === null) return { ok: true, value: null };
  if (method === 'GET') return { ok: false, message: 'GET requests cannot have a body' };
  if (!isPlainObject(body) && !Array.isArray(body)) return { ok: false, message: 'body must be a JSON object or array' };
  let json;
  try { json = JSON.stringify(body); } catch { return { ok: false, message: 'body is not JSON-serializable' }; }
  if (typeof json !== 'string') return { ok: false, message: 'body is not JSON-serializable' };
  // Cheap upper bound first (UTF-8 is at most 3 bytes per UTF-16 unit), exact count only if needed.
  if (json.length * 3 > BODY_MAX_BYTES && new TextEncoder().encode(json).length > BODY_MAX_BYTES) {
    return { ok: false, message: `body is larger than ${BODY_MAX_BYTES / 1024 / 1024} MiB` };
  }
  return { ok: true, value: json };
}

/**
 * Build the final URL for a validated path on a data center's API host, and verify the URL
 * parser didn't normalize anything away. Returns the URL string or null.
 */
export function buildApiUrl(dataCenter, path, params) {
  const host = API_HOSTS[dataCenter];
  if (!host || !Object.hasOwn(API_HOSTS, dataCenter)) return null;
  if (checkPath(path) !== null) return null;
  const qs = params && [...params.keys()].length ? '?' + params.toString() : '';
  let u;
  try { u = new URL('https://' + host + path + qs); } catch { return null; }
  if (u.protocol !== 'https:' || u.host !== host || u.username || u.password || u.port) return null;
  if (u.pathname !== path) return null; // parser normalized something: refuse rather than guess
  const out = u.href;
  return out.length > URL_MAX ? null : out;
}

/**
 * Validate a wb:api message payload. Returns
 *   { ok: true, value: { projectKey, dataCenter, method, path, url, bodyJson, timeoutMs } }
 * or { ok: false, message }.
 */
export function validateApiRequest(msg) {
  if (!isPlainObject(msg)) return { ok: false, message: 'request must be an object' };
  const { projectKey, method: rawMethod, path, query, body, timeoutMs: rawTimeout } = msg;

  const pk = parseProjectKey(projectKey);
  if (!pk) return { ok: false, message: 'projectKey is missing or malformed' };

  const method = typeof rawMethod === 'string' ? rawMethod.toUpperCase() : rawMethod == null ? 'GET' : null;
  if (!METHODS.includes(method)) return { ok: false, message: `method must be one of ${METHODS.join(', ')}` };

  const pathErr = checkPath(path);
  if (pathErr) return { ok: false, message: pathErr };

  const q = checkQuery(query);
  if (!q.ok) return { ok: false, message: q.message };

  const b = checkBody(body, method);
  if (!b.ok) return { ok: false, message: b.message };

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout != null) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout)) {
      return { ok: false, message: 'timeoutMs must be a finite number' };
    }
    timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(rawTimeout)));
  }

  const url = buildApiUrl(pk.dataCenter, path, q.value);
  if (!url) return { ok: false, message: 'path/query could not be turned into a safe URL' };

  return {
    ok: true,
    value: { projectKey, dataCenter: pk.dataCenter, method, path, url, bodyJson: b.value, timeoutMs },
  };
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds from `nowMs`.
 * Returns a non-negative integer (capped at 24 h), or undefined when absent/unparseable.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) {
    const ms = Number(v) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, RETRY_AFTER_MAX_MS) : RETRY_AFTER_MAX_MS;
  }
  // HTTP-date. Require the GMT suffix every valid form has, so Date.parse's leniency
  // ("1.5" → a date in 2001) can't turn junk into a delay.
  if (!/GMT$/i.test(v) || !/[A-Za-z]{3}/.test(v)) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(t - nowMs)));
}

// ---------------------------------------------------------------------------
// Sender classification (who is allowed to send which message)
// ---------------------------------------------------------------------------

export const APP_ORIGINS = Object.freeze(['https://app.iterable.com', 'https://app.eu.iterable.com']);
export const BEE_ORIGINS = Object.freeze(['https://app.getbee.io']);
/**
 * Sign-in hosts (optional host permissions; frame:'auth' features). A content script only runs
 * there when the user enabled such a feature and granted the host (ARCHITECTURE §4, §9).
 * scripts/build.mjs refuses a frame:'auth' feature whose origins aren't listed here.
 */
export const AUTH_ORIGINS = Object.freeze(['https://auth.iterable.com']);

/**
 * Classify how this app.getbee.io frame is embedded, for content/bee.js. Fails closed.
 *   ancestorOrigins  [...location.ancestorOrigins] (parent first, top last) or null when the
 *                    browser has no Location.ancestorOrigins (Chrome has it; Firefox since at
 *                    least 156, content scripts included)
 *   referrer         document.referrer
 *   isTop            window === window.top
 * Returns
 *   'iterable'  every ancestor is a real app/BEE origin and the top-most is an Iterable app
 *               origin; or, with no ancestor origins at all, the referrer's origin is an app origin.
 *   'other'     a top-level page, or a definite non-Iterable embedder: some ancestor is a real
 *               origin outside app/BEE, the top-most is a real non-app origin, or the referrer has
 *               a real origin outside app/BEE. Never start.
 *   'unknown'   can't tell: the ancestors that aren't app/BEE are opaque ("null" — Firefox reports
 *               that for an <iframe referrerpolicy="no-referrer">) and the referrer is empty or
 *               app/BEE; or there are no ancestor origins and the referrer is empty, unparseable
 *               or app.getbee.io (the frame navigated itself). bee.js then waits for the
 *               acceptEmbedHello handshake; it never starts on 'unknown' alone.
 * The referrer never turns opaque ancestors into 'iterable' (it names whoever navigated the frame,
 * weaker evidence than the browser's ancestor list); it can only rule an embedding out.
 */
export function classifyEmbedding({ ancestorOrigins, referrer, isTop }) {
  if (isTop !== false) return 'other';
  const opaque = (o) => typeof o !== 'string' || o === '' || o === 'null';
  const known = (o) => APP_ORIGINS.includes(o) || BEE_ORIGINS.includes(o);
  let refOrigin = null;
  if (typeof referrer === 'string' && referrer) {
    try { refOrigin = new URL(referrer).origin; } catch { refOrigin = null; }
    if (opaque(refOrigin)) refOrigin = null;
  }
  if (Array.isArray(ancestorOrigins) && ancestorOrigins.length) {
    const top = ancestorOrigins[ancestorOrigins.length - 1];
    if (ancestorOrigins.some((o) => !opaque(o) && !known(o))) return 'other';
    if (!opaque(top) && !APP_ORIGINS.includes(top)) return 'other'; // e.g. top-most is app.getbee.io
    if (!ancestorOrigins.some(opaque)) return 'iterable';
    return refOrigin && !known(refOrigin) ? 'other' : 'unknown';
  }
  if (!refOrigin) return 'unknown';
  if (APP_ORIGINS.includes(refOrigin)) return 'iterable';
  return BEE_ORIGINS.includes(refOrigin) ? 'unknown' : 'other';
}

/** True only for a definite Iterable embedding (classifyEmbedding === 'iterable'). */
export function isEmbeddedByIterable(input) {
  return classifyEmbedding(input) === 'iterable';
}

// Handshake for the 'unknown' case (content/embed-handshake.js: announceToBeeFrames, waitForEmbedHello).
export const EMBED_HELLO = Object.freeze({ wb: 'embed-hello', v: 1 });
export const EMBED_HELLO_TIMEOUT_MS = 10_000;

/**
 * Should a bee frame in the 'unknown' case accept this window 'message' event as proof that its
 * parent is an Iterable app page? `self` / `parent` / `top` are the frame's window,
 * window.parent and window.top.
 * Safe because event.origin is set by the browser to the sender document's origin and cannot be
 * forged by page script: a non-Iterable embedder can post the same data, but its origin won't be an
 * app origin. Requiring source === parent pins the sender to the document directly embedding this
 * frame (not a sibling, child or popup that happens to be an Iterable page), and parent === top
 * keeps the old rule that the top-most page is Iterable (an Iterable page framed by some other
 * site is not its own top, so it can't vouch; content/app.js only runs in, and announces from,
 * the top frame anyway). The Iterable page itself could send the message without our content
 * script, but it is an allowed embedder anyway.
 */
export function acceptEmbedHello({ data, origin, source, self, parent, top }) {
  if (!parent || source == null || source !== parent || parent === self || parent !== top) return false;
  if (typeof origin !== 'string' || !APP_ORIGINS.includes(origin)) return false;
  return !!data && typeof data === 'object' && data.wb === EMBED_HELLO.wb && data.v === EMBED_HELLO.v;
}

/**
 * Classify a runtime.onMessage sender.
 *   'extension' — one of our own pages (popup, options, background)
 *   'app'       — our content script on an Iterable app host
 *   'bee'       — our content script in an app.getbee.io frame (third-party origin)
 *   'auth'      — our content script on a sign-in host (auth.iterable.com; optional permission)
 *   null        — anything else (reject)
 * `extensionBaseUrl` is chrome.runtime.getURL('') (ends with '/').
 */
export function classifySender(sender, { runtimeId, extensionBaseUrl }) {
  if (!sender || typeof sender !== 'object') return null;
  if (!runtimeId || sender.id !== runtimeId) return null;

  const url = typeof sender.url === 'string' ? sender.url : '';
  // Non-special schemes (chrome-extension:, moz-extension:) have an opaque URL.origin in some
  // engines, so compare by prefix. extensionBaseUrl ends with '/', so no prefix confusion.
  if (extensionBaseUrl && extensionBaseUrl.endsWith('/') && url.startsWith(extensionBaseUrl)) {
    return 'extension';
  }

  // Content scripts always have a tab.
  if (!sender.tab) return null;
  let origin = typeof sender.origin === 'string' ? sender.origin : null;
  if (!origin || origin === 'null') {
    try { origin = new URL(url).origin; } catch { return null; }
  }
  // If both are present they must agree (defense against a confused sender record).
  if (url) {
    let urlOrigin = null;
    try { urlOrigin = new URL(url).origin; } catch { /* about:blank etc. */ }
    if (urlOrigin && urlOrigin !== 'null' && urlOrigin !== origin) return null;
  }
  if (APP_ORIGINS.includes(origin)) return 'app';
  if (BEE_ORIGINS.includes(origin)) return 'bee';
  if (AUTH_ORIGINS.includes(origin)) return 'auth';
  return null;
}

/**
 * Which sender kinds may send which message types. Anything not listed is refused.
 *
 * app.getbee.io is Beefree's origin, not Iterable's: none of the legacy scripts that ran there
 * used an API key, so BEE frames get no API access and no key status by default (least
 * privilege). Add 'bee' to a row only when a feature there genuinely needs it.
 * Sign-in pages ('auth') get even less: they may only open the options page. Nothing that
 * touches keys or the API, ever: a login page is the last place a key should be reachable from.
 */
export const SENDER_POLICY = Object.freeze({
  'wb:api': Object.freeze(['extension', 'app']),
  'wb:keys:status': Object.freeze(['extension', 'app']),
  'wb:keys:test': Object.freeze(['extension']),
  'wb:open-options': Object.freeze(['extension', 'app', 'bee', 'auth']),
});

export function senderAllowed(type, senderKind) {
  if (!senderKind || !Object.hasOwn(SENDER_POLICY, type)) return false;
  return SENDER_POLICY[type].includes(senderKind);
}

// ---------------------------------------------------------------------------
// Options-page deep links
// ---------------------------------------------------------------------------

const SECTION_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Build the fragment for options.html: '#<section>' or '#<section>?<urlencoded params>'.
 * Missing section → '' (open the page at its default). Returns null for a malformed section or
 * params. Params without a section are refused (nothing to attach them to).
 */
export function buildOptionsHash(section, params) {
  if (section == null || section === '') return params == null ? '' : null;
  const s = section;
  if (typeof s !== 'string' || !SECTION_RE.test(s)) return null;
  if (params == null) return '#' + s;
  if (!isPlainObject(params)) return null;
  const keys = Object.keys(params);
  if (keys.length > 20) return null;
  const sp = new URLSearchParams();
  for (const k of keys) {
    const v = params[k];
    if (!k || k.length > 64) return null;
    if (v == null) continue;
    if (typeof v === 'string') { if (v.length > 512) return null; sp.append(k, v); }
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') sp.append(k, String(v));
    else return null;
  }
  const qs = sp.toString();
  return '#' + s + (qs ? '?' + qs : '');
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Replace every occurrence of `secret` (and its JSON '\/'-escaped form) in `text`. */
export function redactSecret(text, secret) {
  if (typeof text !== 'string' || typeof secret !== 'string' || secret.length < 8) return text;
  let out = text;
  const mask = maskKey(secret);
  for (const variant of new Set([secret, secret.replace(/\//g, '\\/')])) {
    if (out.includes(variant)) out = out.split(variant).join(mask);
  }
  return out;
}

/** Short human summary for a non-2xx Iterable response. Never includes request data. */
export function describeHttpError(status, data) {
  let detail = '';
  if (data && typeof data === 'object') {
    const code = typeof data.code === 'string' ? data.code : '';
    const msg = typeof data.msg === 'string' ? data.msg : '';
    detail = [code, msg].filter(Boolean).join(': ');
  } else if (typeof data === 'string') {
    detail = data;
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  return 'HTTP ' + status + (detail ? ' \u2014 ' + detail : '');
}

/** Human message for a key test result (wb:keys:test). */
export function describeKeyTest({ ok, status, errorCode, dataCenter }) {
  const host = API_HOSTS[dataCenter] || 'the Iterable API';
  if (ok) return `Key works (${host} answered ${status}).`;
  if (errorCode === 'NO_KEY') return 'No key saved for this project.';
  if (errorCode === 'TIMEOUT') return `${host} didn't answer in time. Try again.`;
  if (errorCode === 'NETWORK') {
    return `Couldn't reach ${host}. Check your connection` +
      ' (in Firefox, also check the extension has been granted access to Iterable sites).';
  }
  if (status === 401) {
    return 'Iterable rejected this key (401). Check it was copied in full, is not disabled, and belongs to a ' +
      (dataCenter === 'eu' ? 'EU' : 'US') + '-data-center project.';
  }
  if (status === 403) {
    return 'Iterable recognised the key but refused the request (403). Use a server-side key \u2014 ' +
      'mobile and JavaScript keys can\u2019t call these endpoints.';
  }
  if (status === 429) return 'Iterable is rate-limiting this key (429). Try again in a minute.';
  if (status >= 500) return `Iterable had a server error (${status}). Try again later.`;
  return `Unexpected response from Iterable (HTTP ${status}).`;
}
