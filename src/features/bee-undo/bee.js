// Delete confirm + undo, editor-frame half (runs in the app.getbee.io plugin frame that an
// Iterable page embeds; companion of index.js, ARCHITECTURE §6.2).
//  - Auto-confirm: while `autoConfirmDelete` is on, click the primary button of BEE's
//    "Delete confirmation" dialog as soon as it appears (the script's selectors).
//  - Baseline: Iterable hands BEE the template with a postMessage `{ action: 'load' }`. The top
//    frame can't see that message, so this half reports it over the frame channel (and again
//    whenever the top half connects: delivery is live only).
//  - Cache sync: when the load is the one our undo posted (tagged), imitate BEE's onChange to the
//    Iterable page so its cached template (what Save writes) matches the restored stage.
//  - Claim: the top half posts a nonce to this frame's window; answering it over the channel
//    proves this peer is the editor frame (the top half ignores every other peer). The baseline
//    follows the claim.
//  - Undo / redo shortcut pressed while this frame has focus → `undo` / `redo` to the top half.

import { APP_ORIGINS } from '../../core/api-validation.js';
import { readLoad, readClaim, makeSyncChange, SNAPSHOT_MAX_CHARS } from './history.js';

const SEL = {
  deleteModal: '[role="alertdialog"][aria-label="Delete confirmation"]',
  confirmButton: '[data-qa="generic-modal-actions-primary"]',
};

export function mount(ctx) {
  const { signal, log, dom } = ctx;
  let enabled = ctx.settings.autoConfirmDelete === true;
  let last = null; // { json, loadedAt } | { tooBig: chars, loadedAt }: the latest load from Iterable
  const clicked = new WeakSet();

  // ── Auto-confirm ─────────────────────────────────────────────────────────

  function confirmIfDeleteModal() {
    if (!enabled || signal.aborted) return;
    const modal = document.querySelector(SEL.deleteModal);
    const btn = modal?.querySelector(SEL.confirmButton);
    if (!btn || clicked.has(btn)) return;
    clicked.add(btn);
    btn.click();
    log.debug('delete auto-confirmed');
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; confirmIfDeleteModal(); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  confirmIfDeleteModal();

  // ── Baseline + cache sync (BEE's own protocol) ───────────────────────────

  function sendBaseline() {
    if (!last) return;
    if (last.tooBig != null) {
      ctx.frames.send('baselineTooBig', { chars: last.tooBig, loadedAt: last.loadedAt });
      return;
    }
    try {
      ctx.frames.send('baseline', { json: last.json, loadedAt: last.loadedAt });
    } catch (e) {
      // Over the channel's cap once quotes are escaped: tell the top half it can't keep this one.
      log.debug('baseline too large for the frame channel', e?.message);
      last = { tooBig: last.json.length, loadedAt: last.loadedAt };
      ctx.frames.send('baselineTooBig', { chars: last.tooBig, loadedAt: last.loadedAt });
    }
  }

  function onMessage(e) {
    if (!e.isTrusted || e.source !== window.parent || !APP_ORIGINS.includes(e.origin)) return;
    const nonce = readClaim(e.data);
    if (nonce) {
      ctx.frames.send('claim', { nonce });
      sendBaseline(); // after the claim, so the top half takes it from this (now bound) peer
      return;
    }
    const load = readLoad(e.data);
    if (!load) return;
    let json;
    try { json = JSON.stringify(load.template); } catch { return; }
    if (typeof json !== 'string') return;
    if (load.own) {
      // Our undo/redo restore: sync Iterable's cached onChange JSON (tagged, so the top half skips it).
      try {
        window.parent.postMessage(makeSyncChange(json), e.origin);
        log.debug('Iterable cache synced after undo');
      } catch (err) {
        log.warn('could not sync Iterable after undo', err?.message);
      }
      return;
    }
    const loadedAt = Date.now();
    last = json.length > SNAPSHOT_MAX_CHARS ? { tooBig: json.length, loadedAt } : { json, loadedAt };
    log.debug('baseline captured', { chars: json.length });
    sendBaseline();
  }
  window.addEventListener('message', onMessage, { signal });

  // The baseline goes out when the top half's claim arrives (it challenges on every connect).

  // ── Settings + shortcut ──────────────────────────────────────────────────

  const shortcuts = { undo: { combo: null, ac: null }, redo: { combo: null, ac: null } };
  function bindShortcut(kind, combo) {
    const s = shortcuts[kind];
    if (combo === s.combo) return;
    s.combo = combo;
    s.ac?.abort();
    s.ac = new AbortController();
    dom.onShortcut(combo, () => { ctx.frames.send(kind, {}); }, { signal: dom.linkSignal(signal, s.ac.signal) });
  }
  function bindShortcuts(values) {
    bindShortcut('undo', values.undoShortcut);
    // Same rule as the top half: one combo for both is undo only.
    bindShortcut('redo', values.redoShortcut === values.undoShortcut ? '' : values.redoShortcut);
  }
  bindShortcuts(ctx.settings);

  ctx.onSettings((values) => {
    enabled = values.autoConfirmDelete === true;
    bindShortcuts(values);
    confirmIfDeleteModal();
  });

  return () => { shortcuts.undo.ac?.abort(); shortcuts.redo.ac?.abort(); };
}
