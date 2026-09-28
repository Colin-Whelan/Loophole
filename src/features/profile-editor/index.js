// Profile editor: a small ghost "Edit" button beside each field key in the profile's JSON data
// view, and an "Add field" button in the page header. Editing uses the shared field editor
// (lib/iterable/field-editor.js): types from the project's field list, typed parsing, merge-nested
// toggle, save through POST /api/users/update with the vault key of the project pinned when the
// editor opened. The edit dialog adds the script's "Delete field" (now "Clear value": sets null,
// behind a confirm) and "Rollback to Original" ("Restore previous value", from this page
// session's history). Ported from the "Iterable Profile Editor" userscript (v1.1); its own
// per-space key manager is replaced by the Loophole key vault.
// Never logs identities or values.

import { profileIdFromPath, readProfileIdentity, PAGE_ACTIONS_SELECTOR } from '../../lib/iterable/profile-page.js';
import { getUser, userFieldValue } from '../../lib/iterable/users.js';
import { getUserFields } from '../../lib/iterable/fields.js';
import { linkSignal } from '../../core/dom.js';
import { renderFieldEditor, openFieldEditor, pickIdentity } from '../../lib/iterable/field-editor.js';
import {
  KEY_SELECTOR, LEAF_SELECTOR, VALUE_SELECTOR, BRANCH_SELECTOR, isEditableView, cleanKeyText, valueKind,
  scalarFromPage, resolveField, needsApiValue, createHistory, previewValue,
} from './logic.js';

const SCAN_DELAY_MS = 150;

const EDIT_CSS = `
.wb-btn.pe-edit{height:18px; padding:0 6px; margin:0 4px; font-size:11px; line-height:16px; opacity:.6; vertical-align:middle}
.wb-btn.pe-edit:hover, .wb-btn.pe-edit:focus-visible{opacity:1}
`;

const MODAL_CSS = `
.pe-body{display:flex; flex-direction:column; gap:12px}
.pe-src{font-size:12px; color:var(--wb-muted); margin:0}
.pe-note{font-size:12px; line-height:1.45; border-radius:4px; padding:7px 9px; background:var(--wb-raised); color:var(--wb-ink)}
.pe-note.bad{background:var(--wb-bad-soft); color:var(--wb-bad)}
.pe-actions{display:flex; justify-content:flex-end; gap:8px}
`;

/**
 * What a key element in Iterable's JSON view stands for. The DOM walk is the script's
 * extractFieldPath (closest branch → its first key, repeated upwards), plus each row's value kind
 * so keys inside arrays can be refused. → { segments: [{ key, kind }], kind, text }
 */
function readKey(keyEl) {
  const leaf = keyEl.closest(LEAF_SELECTOR);
  const valueEl = leaf?.querySelector(VALUE_SELECTOR) || null;
  const kind = valueEl ? valueKind([...valueEl.classList]) : 'unknown';
  const segments = [{ key: cleanKeyText(keyEl.textContent), kind }];
  let branch = keyEl.closest(BRANCH_SELECTOR);
  while (branch) {
    const headLeaf = branch.querySelector(':scope > ' + LEAF_SELECTOR);
    const headKey = headLeaf ? headLeaf.querySelector(KEY_SELECTOR) : branch.querySelector(KEY_SELECTOR);
    if (headKey !== keyEl) {
      const headVal = (headLeaf || headKey?.closest(LEAF_SELECTOR))?.querySelector(VALUE_SELECTOR);
      segments.unshift({ key: headKey ? cleanKeyText(headKey.textContent) : '', kind: headVal ? valueKind([...headVal.classList]) : 'unknown' });
    }
    branch = branch.parentElement?.closest(BRANCH_SELECTOR) || null;
  }
  return { segments, kind, text: valueEl ? valueEl.textContent : '' };
}

export function mount(ctx) {
  const { h } = ctx.dom;
  const { ui, log, signal } = ctx;
  const SOURCE = ctx.meta?.name || 'Profile editor';
  let settings = ctx.settings;
  const offSettings = ctx.onSettings((v) => { settings = v; });

  const history = createHistory();
  const byKey = new WeakMap();   // key element → { m, keyEl } | null (not editable)
  const mounts = new Set();
  let addMount = null;
  let busy = false;              // an editor (or its preparation) is open: one at a time
  let shell = null;              // the open edit dialog
  let keyDialog = null;          // the open "API key needed" dialog

  /** Success/info toasts follow the showNotifications setting; errors and warnings always show. */
  function notify(message, opts = {}) {
    const tone = opts.tone;
    if (tone !== 'bad' && tone !== 'warn' && !settings.showNotifications) return null;
    return ui.toast(message, { timeoutMs: 6000, ...opts, source: SOURCE });
  }
  const fail = (message) => ui.toast(message, { tone: 'bad', source: SOURCE, timeoutMs: 7000 });

  // ── Buttons ──────────────────────────────────────────────────────────────

  function attach(keyEl) {
    const info = readKey(keyEl);
    const field = resolveField(info.segments);
    if (!field.editable) { byKey.set(keyEl, null); return; }
    const m = ui.mountInline(keyEl, 'after');
    m.root.prepend(h('style', null, EDIT_CSS));
    m.el.style.display = 'inline-flex';
    m.el.style.verticalAlign = 'middle';
    const btn = ui.button('Edit', {
      variant: 'ghost', size: 'sm', className: 'pe-edit', title: `Edit ${field.path}`, trusted: true,
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); openEdit(keyEl); },
    });
    btn.setAttribute('aria-label', `Edit ${field.path}`);
    m.el.append(btn);
    const rec = { m, keyEl };
    byKey.set(keyEl, rec);
    mounts.add(rec);
  }

  function removeEditButtons() {
    for (const rec of mounts) { rec.m.destroy(); byKey.delete(rec.keyEl); }
    mounts.clear();
  }

  function removeAdd() {
    addMount?.destroy();
    addMount = null;
  }

  function ensureAddButton() {
    if (!profileIdFromPath(location.pathname)) { removeAdd(); return; }
    if (addMount?.host.isConnected) return;
    removeAdd();
    const actions = document.querySelector(PAGE_ACTIONS_SELECTOR);
    if (!actions) return;
    const m = ui.mountInline(actions, 'prepend');
    m.el.style.display = 'flex';
    m.el.style.alignItems = 'center';
    m.el.append(ui.injectedButton('Add field', {
      size: 'sm', title: 'Add a field to this user profile', trusted: true,
      onClick: (e) => { e.preventDefault(); e.stopPropagation(); openAdd(); },
    }));
    addMount = m;
  }

  function scan() {
    if (signal.aborted) return;
    ensureAddButton();
    if (!isEditableView(location.pathname)) { removeEditButtons(); return; }
    for (const rec of [...mounts]) {
      if (rec.m.host.isConnected && rec.keyEl.isConnected) continue;
      rec.m.destroy();
      mounts.delete(rec);
      byKey.delete(rec.keyEl);
    }
    for (const keyEl of document.querySelectorAll(KEY_SELECTOR)) {
      if (!byKey.has(keyEl)) attach(keyEl);
    }
  }

  // The script re-ran its setup 100 ms after any added nodes; same idea, coalesced.
  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer || signal.aborted) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, SCAN_DELAY_MS);
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  ctx.onUrlChange(scheduleScan);
  scan();

  // ── Shared preparation ───────────────────────────────────────────────────

  /** Identity, project and key, re-read on every open. → { who, profileId, project } | null */
  async function prepare() {
    const identity = readProfileIdentity({ onError: (e) => log.warn('could not read identifiers from the page', e?.message || e) });
    const who = pickIdentity(identity);
    if (!who) {
      fail("Couldn't read an email or User ID from the profile header. Has it finished loading?");
      return null;
    }
    await ctx.project.refresh();
    if (signal.aborted) return null;
    const project = ctx.project.current();
    if (!project) {
      fail("Couldn't detect which Iterable project this page is in. Reload the page, or check you're signed in.");
      return null;
    }
    const key = await ctx.api.keyStatus(project.key);
    if (signal.aborted) return null;
    if (!key.hasKey) { showNoKey(project, key); return null; }
    return { who, profileId: identity.profileId || '', project };
  }

  function showNoKey(project, key) {
    const body = h('div', { class: 'pe-body' },
      h('p', { style: 'margin:0; font-size:13px; line-height:1.5' }, key.error
        ? `Couldn't read the API key status for "${project.name}": ${key.error.message || 'unknown error'}`
        : `Profile edits are saved through Iterable's API, and no API key is saved for "${project.name}".`),
      !key.error && h('p', { class: 'wb-help', style: 'margin:0' }, 'Add a key in Loophole settings, then click Edit again.'));
    const actions = [{ id: 'close', label: 'Close', variant: key.error ? 'primary' : 'ghost' }];
    if (!key.error) {
      actions.push({
        id: 'keys', label: 'Add key', variant: 'primary',
        onClick: () => { ctx.openOptions('keys', { id: project.id || undefined, name: project.name, dataCenter: project.dataCenter }); },
      });
    }
    keyDialog = ui.dialog({ title: 'API key needed', source: SOURCE, body, actions });
    const d = keyDialog;
    d.closed.then(() => { if (keyDialog === d) keyDialog = null; });
  }

  async function loadFields(projectKey) {
    try {
      return await getUserFields({ http: ctx.http, projectKey }, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      log.warn('field list unavailable', err?.code || '', err?.status || 0);
      return [];
    }
  }

  /**
   * The field editor's beforeSave for everything written from an editor opened in `pinnedKey`:
   * re-check the page's project (project.refresh({ force: true })) right before the write, and
   * refuse it (nothing sent) when that fails or the project changed (§5.2 pinning rule).
   */
  function pinProject(pinnedKey) {
    return async () => {
      await ctx.project.refresh({ force: true });
      if (ctx.project.error?.()) return "Couldn't re-check which project this page is in, so nothing was saved. Reload the page and try again.";
      const now = ctx.project.current();
      if (!now || now.key !== pinnedKey) {
        return `The project changed to "${now?.name || 'unknown'}" since this editor opened, so nothing was saved. Close it and start again.`;
      }
      return null;
    };
  }

  // ── Edit dialog ──────────────────────────────────────────────────────────

  /** A ui.dialog for one edit; can't be dismissed while the editor is busy. */
  function openShell(title) {
    const ac = new AbortController();   // aborted on close: stops the value lookup
    const s = { isBusy: () => false, closed: false, signal: linkSignal(signal, ac.signal) };
    const d = ui.dialog({ title, source: SOURCE, body: h('div', { class: 'pe-body' }), css: MODAL_CSS, canDismiss: () => !s.isBusy() });
    s.body = d.body.firstChild;
    s.close = () => d.close(null);
    d.closed.then(() => {
      s.closed = true;
      ac.abort();
      if (shell === s) shell = null;
      busy = false;
    });
    shell = s;
    return s;
  }

  function note(tone, text) {
    return h('div', { class: ['pe-note', tone], role: tone === 'bad' ? 'alert' : 'status' }, text);
  }

  async function openEdit(keyEl) {
    if (busy) return;
    const info = readKey(keyEl);
    const field = resolveField(info.segments);
    if (!field.editable) return;
    const path = field.path;
    busy = true;
    let s = null;
    try {
      const prep = await prepare();
      if (!prep) return;
      const { who, profileId, project } = prep;
      const pk = project.key;
      s = openShell(`Edit ${path}`);
      s.body.append(h('p', { class: 'pe-src' }, 'Loading…'));

      const fieldsPromise = loadFields(pk);
      fieldsPromise.catch(() => {});   // only an unmount abort; awaited below
      const fromPage = scalarFromPage(info.kind, info.text);
      let current;
      let source;
      if (!needsApiValue(info.kind) && fromPage.ok && !history.wasWritten(pk, profileId, path)) {
        current = fromPage.value;
        source = 'Current value as shown on the page.';
      } else {
        // Objects/arrays only show as a tree on the page (the script's DOM rebuild returned {} /
        // partial arrays), and a field saved in this session may not be re-rendered yet: read it.
        let r;
        try {
          r = await getUser(ctx, { projectKey: pk, ...who, signal: s.signal });
        } catch (err) {
          if (err?.name === 'AbortError') return;
          r = { status: 'error', message: err?.message };
        }
        if (s.closed) return;
        if (r.status !== 'found') {
          const why = r.status === 'not-found'
            ? `The saved key for "${project.name}" can't find this user.`
            : `Couldn't load this user through the API${r.message ? ` (${r.message})` : ''}.`;
          s.body.replaceChildren(
            note('bad', `${why} ${path} can't be edited without its current value, so editing is unavailable right now.`),
            h('div', { class: 'pe-actions' }, ui.button('Close', { variant: 'primary', onClick: () => s.close() })));
          return;
        }
        current = userFieldValue(r.user, path);
        source = current === undefined ? 'Not set on this user (read from the API).' : 'Current value read from the API.';
      }
      let fields;
      try { fields = await fieldsPromise; } catch { return; }
      if (s.closed) return;
      renderEdit(s, { who, profileId, project, path, current, source, fields });
    } catch (err) {
      if (err?.name !== 'AbortError') log.warn('edit failed to open', err?.message || err);
      s?.close();
    } finally {
      if (!s || s.closed) busy = false;
    }
  }

  function renderEdit(s, { who, profileId, project, path, current, source, fields }) {
    const pk = project.key;
    const hasOriginal = history.hasOriginal(pk, profileId, path);
    const original = hasOriginal ? history.getOriginal(pk, profileId, path) : undefined;

    // Merge on for Clear and Restore, as the script's rollback did: a dotted path (a.b) then leaves
    // a's other keys alone. (The script's delete sent merge off, which replaces the whole parent.)
    const restore = hasOriginal && {
      label: 'Restore previous value',
      title: `Value before your first change in this session: ${previewValue(original)}`,
      onClick: async (api) => {
        api.setResult(null, 'Restoring…');
        await api.write({ value: original, mergeNestedObjects: true });
        log.info('field restored');
        history.forget(pk, profileId, path);
        notify(`Restored ${path}. Reload the profile in a moment to see it.`, { tone: 'ok' });
        api.close();
      },
    };
    const clear = {
      label: 'Clear value', className: 'fe-danger', title: `Set ${path} to null`,
      onClick: async (api) => {
        const ok = await ui.confirmDialog({
          title: `Clear ${path}?`, source: SOURCE, confirmLabel: 'Clear value', danger: true,
          message: `This sets ${path} to null for this user in "${project.name}". Until you leave this page, "Restore previous value" in this editor can put the current value back.`,
        });
        if (!ok || s.closed) return;
        api.setResult(null, 'Clearing…');
        await api.write({ value: null, mergeNestedObjects: true });
        log.info('field cleared');
        history.recordWrite(pk, profileId, path, current === undefined ? null : current);
        notify(`Cleared ${path}. Reload the profile in a moment to see it.`, { tone: 'ok' });
        api.close();
      },
    };

    const editorWrap = h('div');
    s.body.replaceChildren(h('p', { class: 'pe-src' }, source), editorWrap);
    const editor = renderFieldEditor(editorWrap, {
      ctx, identity: who, projectKey: pk, fields,
      initialField: path, currentValue: current, mergeNested: settings.mergeNested,
      createNewFields: 'new', beforeSave: pinProject(pk),
      secondaryActions: [restore, clear].filter(Boolean),
      onCancel: () => s.close(),
      onClose: () => s.close(),
      onSaved: (res) => {
        if (res.field === path) history.recordWrite(pk, profileId, path, current === undefined ? null : current);
        else history.markWritten(pk, profileId, res.field);
        notify(`Saved ${res.field}. Iterable applies updates asynchronously; reload the profile in a moment to see it.`, { tone: 'ok' });
        s.close();
      },
    });
    s.isBusy = () => editor.busy();
    editor.focus();
  }

  // ── Add field ────────────────────────────────────────────────────────────

  async function openAdd() {
    if (busy) return;
    busy = true;
    try {
      const prep = await prepare();
      if (!prep) return;
      const { who, profileId, project } = prep;
      const fields = await loadFields(project.key);
      if (signal.aborted) return;
      // The editor's own "Saved x." toast is replaced by one that says when the page shows it.
      const res = await openFieldEditor({
        ctx, title: 'Add field', brand: SOURCE, toast: false,
        identity: who, projectKey: project.key, fields, mergeNested: settings.mergeNested,
        createNewFields: 'new', beforeSave: pinProject(project.key),
      });
      if (res) {
        history.markWritten(project.key, profileId, res.field);
        notify(`Saved ${res.field}. Iterable applies updates asynchronously; reload the profile in a moment to see it.`, { tone: 'ok' });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') log.warn('add field failed to open', err?.message || err);
    } finally {
      busy = false;
    }
  }

  return () => {
    clearTimeout(scanTimer);
    observer.disconnect();
    offSettings?.();
    shell?.close();
    keyDialog?.close();
    removeEditButtons();
    removeAdd();
    history.clear();
  };
}
