// User lookup: a mono input + Find button in the shared Loophole navbar strip (ARCHITECTURE
// §7.2). A found user opens their profile straight away (relative /users/profiles/<id>, as the
// old "Open profile" button did); errors, and a found record without a profile id, show in a
// small card anchored under the input on the float layer (closes on Escape / outside click /
// navigation). Ported from "Enhanced User Lookup Bar": kept the auto-detection of email vs
// userId and the session-authenticated lookup (lib/iterable/users.js lookupUserApp — no API key).

import { lookupUserApp } from '../../lib/iterable/users.js';
import { linkSignal } from '../../core/dom.js';
import { detectLookupKind, lookupOutcome } from './lookup.js';

export function mount(ctx) {
  const {
    ui, dom, http, signal, log,
  } = ctx;
  const item = ui.navSlot({ featureId: ctx.featureId, order: 20, signal });

  let settings = ctx.settings;
  let popup = null;
  let controller = null;

  const inputEl = dom.h('input', {
    'aria-label': 'Look up a user by email or userId',
    placeholder: 'email or userId',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const kindEl = dom.h('span', { class: 'kind' });
  const findBtn = dom.h('button', { type: 'submit' }, 'Find');
  const form = dom.h('form', {
    class: 'wb-lookup',
    autocomplete: 'off',
    onSubmit: (e) => { e.preventDefault(); if (e.isTrusted) runLookup(); },
  }, inputEl, kindEl, findBtn);
  item.append(form);

  function updateKind() {
    kindEl.textContent = detectLookupKind(inputEl.value) || '';
  }
  inputEl.addEventListener('input', updateKind);
  updateKind();

  function closePopup() {
    popup?.destroy();
    popup = null;
  }

  function showPanel({ title, body }) {
    closePopup();
    popup = ui.anchorFloat(form, ui.panel({
      title, brand: 'Lookup', onClose: closePopup, body,
    }), { signal, onDismiss: () => { popup = null; } });
  }

  function showError(message) {
    showPanel({ title: 'Lookup', body: dom.h('p', { class: 'wb-help', style: { color: 'var(--wb-bad)' } }, message) });
  }

  function showPreview(message, rows) {
    showPanel({
      title: 'User found',
      body: dom.h('div', null, dom.h('p', { class: 'wb-help', style: { marginTop: 0 } }, message), rows.length ? ui.kv(rows) : null),
    });
  }

  async function runLookup() {
    const raw = inputEl.value.trim();
    if (!raw) { showError('Enter an email address or userId.'); return; }
    const kind = detectLookupKind(raw);
    controller?.abort();
    controller = new AbortController();
    const lookupSignal = linkSignal(signal, controller.signal);
    findBtn.disabled = true;
    findBtn.textContent = 'Finding…';
    try {
      const result = await lookupUserApp({ http }, { kind, value: raw, signal: lookupSignal });
      if (lookupSignal.aborted) return;
      const out = lookupOutcome(result);
      if (out.action === 'open') { closePopup(); location.assign(out.path); }
      else if (out.action === 'preview') showPreview(out.message, out.rows);
      else showError(out.message);
    } catch (e) {
      if (e?.name !== 'AbortError') {
        log.warn('lookup failed', e?.message);
        showError('Lookup failed.');
      }
    } finally {
      if (!signal.aborted) {
        findBtn.disabled = false;
        findBtn.textContent = 'Find';
      }
    }
  }

  let stopShortcut = () => {};
  function bindShortcut() {
    stopShortcut();
    stopShortcut = dom.onShortcut(settings.focusShortcut, () => {
      inputEl.focus();
      inputEl.select();
    }, { signal });
  }
  bindShortcut();

  const offUrl = ctx.onUrlChange(() => closePopup());
  const offSettings = ctx.onSettings((values) => {
    const rebind = values.focusShortcut !== settings.focusShortcut;
    settings = values;
    if (rebind) bindShortcut();
  });

  return () => {
    offUrl?.();
    offSettings?.();
    stopShortcut();
    controller?.abort();
    closePopup();
  };
}
