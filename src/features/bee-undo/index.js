// Delete confirm + undo, top half (app.iterable.com template editor). Companion: bee.js.
//  - Beside the editor's fullscreen action bar (after its Details button, where the script put
//    them): an "Auto-confirm delete" switch (writes the setting both halves read), "Undo (N)" and,
//    after an undo, "Redo (N)" (hidden again once a new change clears the redo steps).
//  - History: every BEE → Iterable `onChange` message (BEE's own protocol, read here directly)
//    is a snapshot; the bee half reports each template load as the baseline. Memory only.
//  - Undo: post BEE's own `{ action: 'load' }` (tagged) to the plugin frame with the previous
//    snapshot; the bee half then re-syncs Iterable's cached JSON. BEE's own onChange for that
//    reload is ignored for a short grace period. Redo is the same restore, the other way.
//  - Editor peer: any app.getbee.io child frame can join the frame channel, so history is bound
//    to the one peer that proves it is the editor frame: we post a random nonce straight to the
//    editor <iframe>'s window (BEE's origin only) and accept the peer that sends it back as
//    `claim`. Every other channel message is taken from that peer only.

import { isChildFrame } from '../../core/frames.js';
import { BEE_ORIGINS } from '../../core/api-validation.js';
import {
  createHistory, onChangeJson, makeLoadMessage, makeClaimMessage, templateIdFrom, undoLabel, redoLabel,
} from './history.js';

const BEE_ORIGIN = BEE_ORIGINS[0];
const SEL = {
  actionBarAnchor: '[data-test="fullscreen-action-bar"] [data-test="template-editor-details-button"]',
  beeFrame: '#beePluginContainer__bee-plugin-frame',
};
const MARK_ATTR = 'data-wb-bee-undo';

const CSS = `
.bu{display:inline-flex; align-items:center; gap:12px; margin-left:12px; vertical-align:middle; font-size:13px; white-space:nowrap}
.bu-toggle{display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; color:var(--wb-ink)}
.bu-toggle label{cursor:pointer}
.bu .wb-inj:disabled{opacity:.45; cursor:default}
.bu [hidden]{display:none!important}
`;

export function mount(ctx) {
  const { ui, dom, signal, log } = ctx;
  const h = dom.h;
  const mountedAt = Date.now();
  const history = createHistory({ limit: ctx.settings.historyLimit });
  let autoConfirm = ctx.settings.autoConfirmDelete === true;
  let templateId = templateIdFrom(location.search);
  let controls = null; // { m, anchor, sw, undoBtn, redoBtn }
  const shortcuts = { undo: { combo: null, ac: null }, redo: { combo: null, ac: null } };

  // ── Frame channel (register synchronously, §6.2) ─────────────────────────

  let editorPeer = null; // the channel peer proven to be the editor frame (claim below)
  let claimNonce = null; // outstanding challenge while no editor peer is bound

  /** Handler that runs only for messages from the bound editor peer. */
  const fromEditor = (cb) => (payload, { peer }) => {
    if (editorPeer == null || peer !== editorPeer) { log.debug('ignored a frame message from a peer that is not the editor'); return; }
    cb(payload);
  };
  const editorConnected = () => editorPeer != null && ctx.frames.peers().includes(editorPeer);

  function challenge() {
    if (editorPeer != null) return;
    const win = beeFrame()?.contentWindow;
    if (!win) return;
    claimNonce ??= crypto.randomUUID();
    try { win.postMessage(makeClaimMessage(claimNonce), BEE_ORIGIN); } catch (err) { log.debug('could not challenge the editor frame', err?.message); }
  }

  ctx.frames.on('claim', ({ nonce }, { peer }) => {
    if (editorPeer != null || !claimNonce || nonce !== claimNonce) return;
    editorPeer = peer;
    claimNonce = null;
    log.debug(`editor frame is peer ${peer}`);
    render();
  });

  ctx.frames.on('baseline', fromEditor(({ json, loadedAt }) => {
    if (loadedAt < mountedAt) {
      // Loaded before this mount (feature switched on, script restarted): edits may have happened
      // since that we never saw, so this baseline can't be trusted as the step before them.
      log.debug('ignored a baseline from before this page mount');
      return;
    }
    const r = history.baseline(json, loadedAt);
    log.debug(`baseline: ${r}`, { chars: json.length, steps: history.steps });
    render();
  }));
  ctx.frames.on('baselineTooBig', fromEditor(({ chars, loadedAt }) => {
    if (loadedAt < mountedAt) return;
    history.baselineTooBig();
    log.info(`template too large for undo history (${chars} characters)`);
    render();
  }));
  ctx.frames.on('undo', fromEditor(() => restore('undo')));
  ctx.frames.on('redo', fromEditor(() => restore('redo')));
  ctx.frames.onPeer(({ peer, connected }) => {
    if (!connected && peer === editorPeer) {
      editorPeer = null;
      history.clear(); // the editor that history described is gone (reloaded or closed)
      log.debug('editor frame disconnected; history cleared');
    }
    challenge(); // a new frame, or the one that replaced the editor, may be it (no-op once bound)
    render();
  });

  // ── BEE's onChange (Iterable page ← plugin frame) ────────────────────────

  function onMessage(e) {
    if (!e.isTrusted || e.origin !== BEE_ORIGIN || !isChildFrame(window, e.source)) return;
    const frame = beeFrame();
    if (!frame || frame.contentWindow !== e.source) return;
    const json = onChangeJson(e.data);
    if (json == null) return;
    const r = history.record(json, Date.now());
    if (r === 'too-big') log.info(`editor change too large for undo history (${json.length} characters)`);
    if (r === 'recorded' || r === 'too-big') render();
  }
  window.addEventListener('message', onMessage, { signal });

  // Only the identified editor iframe (Iterable's BEE plugin container). No fallback to "the first
  // app.getbee.io iframe": that could be another BEE frame, which would then receive the claim
  // nonce and could bind itself as the editor. Not found → no claim, no history (ARCHITECTURE §6.2).
  function beeFrame() {
    const byId = document.querySelector(SEL.beeFrame);
    return byId instanceof HTMLIFrameElement ? byId : null;
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────

  const RESTORE = {
    undo: { steps: () => history.steps, peek: () => history.peekUndo(), commit: (t) => history.commitUndo(t), discard: () => history.discardUndoTarget() },
    redo: { steps: () => history.redoSteps, peek: () => history.peekRedo(), commit: (t) => history.commitRedo(t), discard: () => history.discardRedoTarget() },
  };

  function restore(kind) {
    const r = RESTORE[kind];
    const Kind = kind === 'undo' ? 'Undo' : 'Redo';
    if (!r.steps()) { log.debug(`nothing to ${kind}`); return; }
    if (!editorConnected()) {
      // Without the editor half nothing re-syncs Iterable's cached JSON after the restore, and a
      // Save would write the stale template, so refuse rather than half-restore.
      ui.toast(`${Kind} needs the editor to finish connecting. Try again in a moment.`, { tone: 'warn', source: 'Delete confirm + undo' });
      return;
    }
    const frame = beeFrame();
    if (!frame?.contentWindow) { log.warn('editor frame not found'); return; }
    let template;
    try {
      template = JSON.parse(r.peek());
    } catch {
      r.discard();
      log.warn(`a ${kind} snapshot could not be read and was dropped`);
      ui.toast(`That ${kind} step could not be read and was skipped.`, { tone: 'bad', source: 'Delete confirm + undo' });
      render();
      return;
    }
    r.commit(Date.now());
    try {
      frame.contentWindow.postMessage(makeLoadMessage(template), BEE_ORIGIN);
    } catch (err) {
      log.warn('could not post the restore to the editor', err?.message);
    }
    log.debug(`${kind} done (${history.steps} undo, ${history.redoSteps} redo left)`);
    render();
  }

  // ── Controls beside the action bar ───────────────────────────────────────

  function buildControls(anchor) {
    const m = ui.mountInline(anchor, 'after', { display: 'inline-flex' });
    m.host.setAttribute(MARK_ATTR, '');
    m.root.append(h('style', null, CSS));
    const sw = ui.switchInput({
      checked: autoConfirm,
      label: 'Auto-confirm delete',
      id: 'bu-auto',
      onChange: (checked) => {
        autoConfirm = checked;
        ctx.saveSettings({ autoConfirmDelete: checked }).catch((err) => {
          log.warn('could not save the auto-confirm setting', err?.message);
          ui.toast('Could not save the auto-confirm setting.', { tone: 'bad', source: 'Delete confirm + undo' });
        });
      },
    });
    // Restoring loads a snapshot into BEE: trusted clicks / shortcuts only (§7 trusted input).
    const undoBtn = ui.injectedButton(undoLabel(0), { size: 'sm', trusted: true, onClick: () => restore('undo') });
    const redoBtn = ui.injectedButton(redoLabel(0), { size: 'sm', trusted: true, onClick: () => restore('redo') });
    redoBtn.hidden = true;
    m.el.append(h('span', { class: 'bu' },
      h('span', { class: 'bu-toggle', title: 'Skip the “Delete” confirmation in the editor' },
        sw, h('label', { for: 'bu-auto' }, 'Auto-confirm delete')),
      undoBtn, redoBtn));
    return { m, anchor, sw, undoBtn, redoBtn };
  }

  function render() {
    if (!controls) return;
    const { sw, undoBtn, redoBtn } = controls;
    if (sw.input.checked !== autoConfirm) sw.input.checked = autoConfirm;
    const steps = history.steps;
    const redoSteps = history.redoSteps;
    const connected = editorConnected();
    const keyOf = (kind) => (shortcuts[kind].combo ? ` (${dom.formatShortcut(shortcuts[kind].combo)})` : '');
    undoBtn.textContent = undoLabel(steps);
    undoBtn.disabled = steps === 0 || !connected;
    undoBtn.title = history.tooBig ? 'This template is too large to keep undo snapshots'
      : !connected ? 'Waiting for the editor to connect'
        : steps ? `Undo the last editor change${keyOf('undo')}` : 'Nothing to undo yet';
    redoBtn.textContent = redoLabel(redoSteps);
    redoBtn.hidden = redoSteps === 0;
    redoBtn.disabled = !connected;
    redoBtn.title = connected ? `Redo the last undone change${keyOf('redo')}` : 'Waiting for the editor to connect';
  }

  function ensureControls() {
    if (signal.aborted) return;
    const anchor = document.querySelector(SEL.actionBarAnchor);
    if (controls && controls.m.host.isConnected && controls.anchor === anchor) return;
    controls?.m.destroy();
    controls = null;
    if (!anchor) return;
    controls = buildControls(anchor);
    render();
  }

  // React re-renders the action bar: re-inject when our controls or their anchor go away.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; ensureControls(); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureControls();

  // ── Shortcut, settings, template changes ─────────────────────────────────

  function bindShortcut(kind, combo) {
    const s = shortcuts[kind];
    if (combo === s.combo) return;
    s.combo = combo;
    s.ac?.abort();
    s.ac = new AbortController();
    dom.onShortcut(combo, () => restore(kind), { signal: dom.linkSignal(signal, s.ac.signal) });
  }
  function bindShortcuts(values) {
    bindShortcut('undo', values.undoShortcut);
    // One combo for both would undo and redo at once: the undo binding wins.
    bindShortcut('redo', values.redoShortcut === values.undoShortcut ? '' : values.redoShortcut);
  }
  bindShortcuts(ctx.settings);

  ctx.onSettings((values) => {
    autoConfirm = values.autoConfirmDelete === true;
    history.setLimit(values.historyLimit);
    bindShortcuts(values);
    render();
  });

  ctx.onUrlChange(() => {
    const id = templateIdFrom(location.search);
    if (id === templateId) return;
    templateId = id;
    history.clear();
    log.debug('template changed; history cleared');
    render();
  });

  return () => {
    observer.disconnect();
    shortcuts.undo.ac?.abort();
    shortcuts.redo.ac?.abort();
    controls?.m.destroy();
    controls = null;
    history.clear();
  };
}
