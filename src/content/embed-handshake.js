// Embed handshake for app.getbee.io frames whose embedder can't be told from ancestorOrigins /
// referrer (see classifyEmbedding and acceptEmbedHello in core/api-validation.js).
//   announceToBeeFrames  top side, content/app.js on the Iterable page
//   waitForEmbedHello    frame side, content/bee.js
// Kept out of the entry files so tests and a browser probe can drive them.

import { onElement } from '../core/dom.js';
import { acceptEmbedHello, BEE_ORIGINS, EMBED_HELLO, EMBED_HELLO_TIMEOUT_MS } from '../core/api-validation.js';

const BEE_ORIGIN = BEE_ORIGINS[0];
// content/bee.js may be injected a little after the frame's load event (document_idle) and listens
// for 10 s, so each announcement is a short burst.
const HELLO_BURST_MS = [0, 500, 2000, 5000];

/**
 * Tell app.getbee.io child frames that an Iterable app page embeds them (see acceptEmbedHello in
 * core/api-validation.js). content/bee.js only listens when it can't tell its embedder from
 * location.ancestorOrigins / document.referrer (Firefox, no-referrer <iframe>). The message carries
 * nothing secret, and the target origin is exactly app.getbee.io, so the browser drops it if the
 * frame has navigated anywhere else. Top frame only: bee.js also requires parent === top.
 */
export function announceToBeeFrames() {
  if (window.top !== window) return;
  const burst = (frame) => {
    for (const ms of HELLO_BURST_MS) setTimeout(() => sendEmbedHello(frame, location.href), ms);
  };
  onElement('iframe', (frame) => {
    frame.addEventListener('load', () => burst(frame)); // also on src changes / reloads
    burst(frame);
  });
}

/**
 * Post one embed-hello to `frame` if it points at app.getbee.io and has actually left the
 * embedder's origin. A frame whose document we can still read (about:blank before the BEE page
 * loads, or any same-origin page) is skipped: posting to it with a BEE target origin is dropped
 * by the browser anyway, and Chrome logs a "target origin does not match" error for each one. The
 * load listener and the retry burst cover the moment it becomes cross-origin. Returns true when a
 * message was posted.
 */
export function sendEmbedHello(frame, baseUrl) {
  let src;
  try { src = new URL(frame.src, baseUrl); } catch { return false; }
  if (src.origin !== BEE_ORIGIN) return false;
  const win = frame.contentWindow;
  if (!win) return false; // detached
  try {
    void win.location.href; // readable only while same-origin with us
    return false;
  } catch { /* cross-origin: the BEE document (or somewhere else; the target origin guards that) */ }
  try { win.postMessage({ ...EMBED_HELLO }, BEE_ORIGIN); return true; } catch { return false; }
}

/**
 * Listen on `win` for the Iterable top page's embed-hello. Calls exactly one of onAccept(origin)
 * (first accepted message) or onTimeout() (nothing accepted within timeoutMs), and removes the
 * listener either way. Never accepts on timeout. Returns a cancel function (no callback).
 */
export function waitForEmbedHello({ win, onAccept, onTimeout, timeoutMs = EMBED_HELLO_TIMEOUT_MS }) {
  let done = false;
  let timer = 0;
  const finish = () => {
    done = true;
    win.removeEventListener('message', onMessage);
    clearTimeout(timer);
  };
  function onMessage(event) {
    if (done) return;
    // A page-dispatched (synthetic) MessageEvent can claim any origin and source; only a real
    // postMessage delivery is evidence of who sent it.
    if (event?.isTrusted !== true) return;
    let parent = null;
    let top = null;
    try { parent = win.parent; top = win.top; } catch { return; }
    if (!acceptEmbedHello({ data: event.data, origin: event.origin, source: event.source, self: win, parent, top })) return;
    finish();
    onAccept(event.origin);
  }
  win.addEventListener('message', onMessage);
  timer = setTimeout(() => {
    if (done) return;
    finish();
    onTimeout();
  }, timeoutMs);
  return () => { if (!done) finish(); };
}
