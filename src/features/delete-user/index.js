// Delete user: a red button in the profile header that opens a confirm popover showing the exact
// endpoint, project and masked key, cross-checks the user through both the saved key and the app
// session, and fires a two-step (arm, then confirm) DELETE. Ported from "Iterable Delete User".

import { sendWithRetry } from '../../core/retry.js';
import { checkPath } from '../../core/api-validation.js';
import { profileIdFromPath, readProfileIdentity, PAGE_ACTIONS_SELECTOR } from '../../lib/iterable/profile-page.js';
import { lookupUserPublic, lookupUserApp } from '../../lib/iterable/users.js';
import {
  pickKind, deletePath, apiHost, compareLookups, isDeleteSuccess, isUncertain, classifyDelete, ellipsize,
} from './logic.js';

// Iterable's own DOM, read-only. Every miss is non-fatal: no anchor means no button.
const ACTIONS_SELECTOR = PAGE_ACTIONS_SELECTOR;

const SOURCE = 'Delete user';
const BACKOFFS = [1000, 2000, 4000];
const ARM_SECONDS = 4;

const POP_CSS = `
.du-pop{position:fixed; right:auto; width:380px; max-width:calc(100vw - 16px); box-shadow:var(--wb-shadow)}
.du-body{display:flex; flex-direction:column; gap:10px}
.du-note{font-size:12px; line-height:1.45; border-radius:4px; padding:7px 9px; background:var(--wb-raised); color:var(--wb-ink)}
.du-note.ok{background:var(--wb-ok-soft); color:var(--wb-ok)}
.du-note.warn{background:var(--wb-warn-soft); color:var(--wb-warn)}
.du-note.bad{background:var(--wb-bad-soft); color:var(--wb-bad)}
.du-note .row{margin-top:6px}
.du-check{display:inline-flex; gap:6px; align-items:center; font-weight:600; cursor:pointer}
.du-check input{margin:0}
.du-actions{justify-content:flex-end}
`;

/**
 * { email, userId } read off the profile header at call time (never cached). Never throws.
 * The contact list has no per-field labels for the email (the userscript used the first titled
 * span too), so the lookup is scoped as tightly as the DOM allows: rows of the contact list only,
 * skipping the "User ID: …" row, title attribute first (the visible text may be truncated).
 * (lib/iterable/profile-page.js)
 */
function readUserRef(log) {
  const { email, userId } = readProfileIdentity({
    onError: (e) => log.warn('could not read identifiers from the page', e?.message || e),
  });
  return { email, userId };
}

export function mount(ctx) {
  const { h, clear, append } = ctx.dom;
  const { ui, log, signal } = ctx;
  let settings = ctx.settings;
  const offSettings = ctx.onSettings((v) => { settings = v; });

  let profileId = profileIdFromPath(location.pathname);
  let deletedFor = null;   // profileId whose user was deleted in this page session
  let header = null;       // { m, btn } — the inline button mount
  let pop = null;          // the open popover's state object, or null

  // ── Header button ────────────────────────────────────────────────────────

  function renderHeaderButton() {
    if (!header) return;
    const done = deletedFor && deletedFor === profileId;
    header.btn.disabled = !!done;
    header.btn.textContent = done ? 'User deleted' : 'Delete user';
    header.btn.setAttribute('aria-expanded', String(!!pop));
  }

  function removeHeader() {
    header?.m.destroy();
    header = null;
  }

  function ensureButton() {
    if (signal.aborted) return;
    if (!profileId) { removeHeader(); return; }
    if (header?.m.host.isConnected) return;
    const actions = document.querySelector(ACTIONS_SELECTOR);
    removeHeader();
    if (!actions) return;
    const m = ui.mountInline(actions, 'prepend');
    m.el.style.display = 'flex';
    m.el.style.alignItems = 'center';
    const btn = ui.button('Delete user', {
      variant: 'danger', size: 'sm', title: 'Delete this user through the Iterable API',
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); togglePopover(); },
    });
    m.el.append(btn);
    header = { m, btn };
    renderHeaderButton();
    // React re-rendered the header under an open popover: follow the new button.
    if (pop) positionPopover();
  }

  // React re-renders the header on its own (tab switches, data loads) and can take the button
  // with it: a new actions container gets a new button immediately (onElement), and any other DOM
  // change re-checks that our host is still attached (coalesced to one cheap check per task).
  ctx.dom.onElement(ACTIONS_SELECTOR, () => ensureButton(), { signal });
  let ensureQueued = false;
  const reattach = new MutationObserver(() => {
    if (ensureQueued) return;
    ensureQueued = true;
    queueMicrotask(() => { ensureQueued = false; ensureButton(); });
  });
  reattach.observe(document.body || document.documentElement, { childList: true, subtree: true });
  signal.addEventListener('abort', () => reattach.disconnect(), { once: true });

  // The router keeps us mounted when moving between profiles (§8.2 ctx.onUrlChange).
  ctx.onUrlChange(() => {
    const id = profileIdFromPath(location.pathname);
    if (id !== profileId) {
      profileId = id;
      deletedFor = null;
      closePopover({ force: true });
      removeHeader();
    }
    ensureButton();
  });
  ensureButton();

  // ── Popover ──────────────────────────────────────────────────────────────

  function togglePopover() {
    if (pop) { closePopover(); return; }
    openPopover();
  }

  function closePopover({ force = false } = {}) {
    if (!pop) return;
    if (pop.busy && !force) return;
    const p = pop;
    pop = null;
    p.ac.abort();
    p.disarm?.();
    p.overlay.destroy();
    renderHeaderButton();
  }

  function positionPopover() {
    if (!pop || !header?.btn.isConnected) return;
    const r = header.btn.getBoundingClientRect();
    const w = pop.panel.offsetWidth || 380;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    pop.panel.style.left = left + 'px';
    pop.panel.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 40)) + 'px';
  }

  async function openPopover() {
    const ref = readUserRef(log);
    const kind = pickKind(settings.defaultIdentifier, ref);
    if (!kind) {
      ui.toast("Couldn't read an email or User ID from the profile header. Has it finished loading?", { tone: 'bad', source: SOURCE, timeoutMs: 6000 });
      return;
    }

    const overlay = ui.mountOverlay('float');
    overlay.root.append(h('style', null, POP_CSS));
    const body = h('div', { class: 'du-body' });
    const panel = ui.panel({ title: 'Delete this user?', brand: SOURCE, onClose: () => closePopover(), body, className: 'del-pop du-pop' });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Delete this user?');
    overlay.el.append(panel);

    const ac = new AbortController();   // closePopover() aborts it
    const popSignal = ctx.dom.linkSignal(signal, ac.signal);   // … and so does unmount

    const state = {
      ref, kind, overlay, panel, body, ac, signal: popSignal,
      project: null, key: null, loading: true,
      check: null, checkSeq: 0, override: false,
      busy: false, result: null, disarm: null,
    };
    pop = state;
    renderHeaderButton();
    render(state);
    positionPopover();

    const listen = { signal: popSignal };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop === state && !state.busy) { e.stopPropagation(); closePopover(); }
    }, { ...listen, capture: true });
    window.addEventListener('scroll', positionPopover, { ...listen, capture: true, passive: true });
    window.addEventListener('resize', positionPopover, listen);
    // A key added, replaced or removed (options page, popup): pick it up without reopening, and
    // re-run the safety check if this project's key is different now.
    const offKeys = ctx.api.onKeysChanged(async () => {
      if (pop !== state || state.busy || !state.project || state.loading) return;
      const key = await ctx.api.keyStatus(state.project.key);
      if (pop !== state || state.busy) return;
      if (key.hasKey === !!state.key?.hasKey && key.masked === (state.key?.masked || '')) return;
      state.key = key;
      render(state);
      if (key.hasKey) runCheck(state);
    });
    popSignal.addEventListener('abort', offKeys, { once: true });

    await ctx.project.refresh();
    if (pop !== state) return;
    state.project = ctx.project.current();
    state.loading = false;
    if (!state.project) { render(state); return; }
    await loadKey(state);
  }

  async function loadKey(state) {
    const key = await ctx.api.keyStatus(state.project.key);
    if (pop !== state) return;
    state.key = key;
    render(state);
    if (key.hasKey) runCheck(state);
  }

  const identifier = (state) => (state.kind === 'email' ? state.ref.email : state.ref.userId);

  // ── Safety check: does the saved key see the same user the app does? ────

  async function runCheck(state) {
    const seq = ++state.checkSeq;
    const kind = state.kind;
    const value = identifier(state);
    const projectKey = state.project.key;
    state.check = { outcome: 'checking' };
    state.override = false;
    render(state);

    const apiSide = lookupUserPublic(ctx, { projectKey, kind, value, backoffs: BACKOFFS, signal: state.signal });
    const appSide = lookupUserApp(ctx, { kind, value, signal: state.signal });

    let result;
    try {
      const [api, app] = await Promise.all([apiSide, appSide]);
      result = compareLookups(api, app, { lookedUpBy: kind, profileId });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      result = { outcome: 'unknown', compared: [], mismatched: [], message: 'The check failed to run.' };
    }
    if (pop !== state || seq !== state.checkSeq) return;
    state.check = result;
    // Never log the identifier or the returned records: only the verdict.
    log.debug('safety check', kind, result.outcome, result.mismatched);
    render(state);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function note(tone, ...children) {
    return h('div', { class: ['du-note', tone], role: tone === 'bad' ? 'alert' : 'status' }, ...children);
  }

  function checkNote(state) {
    const c = state.check;
    if (!c) return null;
    const name = state.project?.name || 'this project';
    if (c.outcome === 'checking') return note(null, 'Checking the user with the saved key and with your app session…');
    if (c.outcome === 'match') {
      return note('ok', `The saved key sees this user the same way the app does (${c.independent.map((f) => (f === 'profileId' ? 'profile id' : f)).join(', ')} agree).`);
    }
    if (c.outcome === 'unknown') {
      return note('warn', `Couldn't cross-check this user. ${c.message || ''} You can still delete, but check the project and key first.`);
    }
    const why = c.outcome === 'not-found'
      ? `The saved key for ${name} can't find this user, but the app can.`
      : `The saved key for ${name} doesn't see this user the same way the app does (${c.mismatched.join(', ')} differ${c.mismatched.length === 1 ? 's' : ''}).`;
    const box = h('input', {
      type: 'checkbox', checked: state.override,
      onChange: (e) => { state.override = e.target.checked; render(state); },
    });
    return note('bad', why, ' It may belong to a different project.',
      h('div', { class: 'row' }, h('label', { class: 'du-check' }, box, 'Delete anyway')));
  }

  function canFire(state) {
    if (state.busy || state.loading || !state.project || !state.key?.hasKey) return false;
    if (state.result?.kind === 'deleted') return false;
    const o = state.check?.outcome;
    if (!o || o === 'checking') return false;
    if (o === 'not-found' || o === 'mismatch') return state.override;
    return true;
  }

  function render(state) {
    if (pop !== state) return;
    state.disarm?.();
    state.disarm = null;
    const { ref, project, key } = state;
    const value = identifier(state);
    const path = deletePath(state.kind, value);
    const prefix = state.kind === 'email' ? '/api/users/' : '/api/users/byUserId/';
    // The background picks the host from the project's data center; show the same one.
    const host = apiHost(project?.dataCenter || (location.hostname === 'app.eu.iterable.com' ? 'eu' : 'us'));
    const done = state.result?.kind === 'deleted';

    const seg = ui.segmented({
      ariaLabel: 'Identify by', value: state.kind,
      options: [{ value: 'email', label: 'email' }, { value: 'userId', label: 'userId' }],
      onChange: (v) => {
        if (v === state.kind || !ref[v]) return;
        state.kind = v;
        state.result = null;
        if (state.key?.hasKey) runCheck(state); else render(state);
      },
    });
    for (const b of seg.children) {
      const has = !!ref[b.dataset.value];
      b.disabled = !has || state.busy || done;
      if (!has) b.title = `No ${b.dataset.value} on this profile`;
    }

    const projectLabel = state.loading ? 'detecting…'
      : project ? `${project.name} · ${project.dataCenter.toUpperCase()}` : 'not detected';
    const keyLabel = !project ? '—' : !key ? 'checking…' : key.hasKey ? (key.masked || 'saved')
      : key.error ? 'unavailable' : 'none saved';

    const fire = ui.button('Delete user', { variant: 'danger', size: 'sm', disabled: !canFire(state) });
    const cancel = ui.button(done ? 'Close' : 'Cancel', { variant: 'ghost', size: 'sm', disabled: state.busy, onClick: () => closePopover() });
    if (state.busy) fire.textContent = 'Deleting…';
    else if (done) fire.textContent = 'Deleted';

    append(clear(state.body),
      h('div', { class: 'row' }, h('span', { class: 'wb-label', style: 'margin:0' }, 'Identify by'), seg),
      h('div', { class: 'endpoint', title: 'DELETE https://' + host + path }, 'DELETE https://' + host + prefix, h('b', null, ellipsize(path.slice(prefix.length), 160))),
      h('p', { class: 'wb-help', style: 'margin:0' }, state.kind === 'userId'
        ? 'If several profiles share this userId, Iterable deletes all of them.'
        : "The email endpoint doesn't work on userId-based projects."),
      ui.kv([['Project', projectLabel], ['API key', keyLabel]]),
      !state.loading && !project && note('bad', "Couldn't detect which Iterable project this page is in, so deleting is disabled. Reload the page, or check you're signed in."),
      project && key && !key.hasKey && key.error && note('bad', `Couldn't read the key status: ${key.error.message || 'unknown error'}`),
      project && key && !key.hasKey && !key.error && note('warn', `No API key is saved for "${project.name}".`,
        h('div', { class: 'row' }, ui.button('Add key', {
          size: 'sm',
          onClick: () => ctx.openOptions('keys', { id: project.id || undefined, name: project.name, dataCenter: project.dataCenter }),
        }))),
      project && key?.hasKey && !done && checkNote(state),
      state.result && note(state.result.tone, state.result.message),
      !done && h('p', { class: 'wb-help', style: 'margin:0' }, `This can't be undone. The first click arms the button for ${ARM_SECONDS} seconds; the second click deletes.`),
      h('div', { class: 'row du-actions' }, cancel, fire),
    );
    if (canFire(state)) {
      state.disarm = ui.armButton(fire, { seconds: ARM_SECONDS, armedLabel: 'Click again to delete', onConfirm: () => runDelete(state) });
    }
    positionPopover();
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  async function runDelete(state) {
    if (pop !== state || !canFire(state)) return;
    const kind = state.kind;
    const value = identifier(state);
    const path = deletePath(kind, value);
    const pinned = state.project;
    const forProfile = profileId;
    state.busy = true;
    state.result = null;
    render(state);

    const stop = (tone, message) => {
      state.busy = false;
      state.result = { tone, message };
      render(state);
    };

    // Pin the project: it must still be the one shown when the popover opened.
    await ctx.project.refresh({ force: true });
    const now = ctx.project.current();
    if (ctx.project.error?.()) {
      stop('bad', "Couldn't re-check which project this page is in, so nothing was deleted. Reload the page and try again.");
      return;
    }
    if (!now || now.key !== pinned.key) {
      stop('bad', `The project changed to "${now?.name || 'unknown'}" since this opened, so nothing was deleted. Close this and start again.`);
      return;
    }
    const pathErr = checkPath(path);
    if (pathErr) {
      stop('bad', `This identifier can't be sent to the API safely (${pathErr}). Nothing was deleted.`);
      return;
    }

    log.info(`deleting by ${kind} in ${pinned.key}`);
    let sawUncertain = false;
    // Not tied to ctx.signal on purpose: once confirmed, leaving the page must not abandon a
    // delete half-way through its retries. The outcome is always reported with a toast.
    const result = await sendWithRetry(() => ctx.api.request({ projectKey: pinned.key, method: 'DELETE', path }), {
      backoffs: BACKOFFS,
      isSuccess: isDeleteSuccess,
      onRetry: ({ attempt, retries, delayMs, status, response }) => {
        if (isUncertain(response)) sawUncertain = true;
        log.info(`delete attempt ${attempt} of ${retries} failed (status ${status}); retrying in ${delayMs} ms`);
      },
    });
    const verdict = classifyDelete(result, { sawUncertain });
    const who = ellipsize(value, 48);

    if (verdict.kind === 'deleted') {
      deletedFor = forProfile;
      renderHeaderButton();
      ui.toast(`Delete accepted for ${who} in ${pinned.name}.`, { tone: 'ok', source: SOURCE, timeoutMs: 6000 });
      if (pop === state) {
        state.busy = false;
        state.result = { kind: 'deleted', tone: 'ok', message: 'Accepted by Iterable. Deletes are processed asynchronously, so this page may keep showing the profile for a while. Reload in a minute to confirm.' };
        render(state);
      }
      return;
    }
    if (verdict.kind === 'unknown') {
      log.warn('delete outcome unknown after retries');
      ui.toast(verdict.message, { tone: 'warn', source: SOURCE, timeoutMs: 8000 });
      if (pop === state) stop('warn', verdict.message);
      return;
    }
    log.warn(`delete failed (status ${result.status})`);
    ui.toast(`Delete failed: ${verdict.message}`, { tone: 'bad', source: SOURCE, timeoutMs: 7000 });
    if (pop === state) stop('bad', verdict.message);
  }

  return () => {
    reattach.disconnect();
    offSettings?.();
    closePopover({ force: true });
    removeHeader();
  };
}
