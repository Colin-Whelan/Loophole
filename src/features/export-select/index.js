// Export field picker: Select all / Deselect all / Invert above the field list in segmentation's
// "Export to CSV" dialog, plus a live "Selected X of Y" count. Port of "Iterable Export CSV - Bulk
// Select" v1.2.0. Every action applies to the rows matching the dialog's own search box, and
// userId / email are never unchecked. The planning lives in plan.js; this file reads the rows and
// clicks Iterable's checkboxes one at a time, yielding between clicks so React keeps up.

import { countSelection, fieldIdFromTestAttr, formatCount, LOCKED_FIELDS, planSelection, ROW_PREFIX } from './plan.js';

// Selectors proven by the userscript.
const SEL = {
  modal: '[data-test="modal-segmentation-export-to-csv"]',
  modalBody: '[data-test="modal-body"]',
  searchInput: 'input[placeholder="Search items"]',
  searchWrapper: '.sc-aFOIO', // styled-components wrapper around the search box
  fieldRow: '[data-test^="export-to-csv-field-"]',
  checkbox: '[data-test="checkbox"]',
  label: 'label p',
};

const EXTRA_CSS = `
.wb.es{display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--wb-line)}
.es-count{margin-left:auto; font-size:12px; color:var(--wb-muted); font-variant-numeric:tabular-nums; white-space:nowrap}
`;

const isChecked = (cb) => cb?.getAttribute('data-state') === 'checked';

function readFields(modal) {
  return Array.from(modal.querySelectorAll(SEL.fieldRow), (row) => ({
    id: fieldIdFromTestAttr(row.getAttribute('data-test')),
    label: row.querySelector(SEL.label)?.textContent ?? '',
    checked: isChecked(row.querySelector(SEL.checkbox)),
    // Iterable's search hides the rows it filters out.
    visible: row.offsetParent !== null,
  }));
}

const searchText = (modal) => modal.querySelector(SEL.searchInput)?.value ?? '';

const rowById = (modal, id) => modal.querySelector(`[data-test="${ROW_PREFIX}${CSS.escape(id)}"]`);

const yieldToReact = () => new Promise((r) => setTimeout(r, 0));

export function mount(ctx) {
  const { h } = ctx.dom;
  const { injectedButton } = ctx.ui;

  let cur = null; // { modal, mount, count, buttons, ac }
  let busy = false;

  function renderCount() {
    if (!cur) return;
    cur.count.textContent = formatCount(countSelection(readFields(cur.modal), searchText(cur.modal)));
  }

  async function run(op) {
    if (!cur || busy) return;
    const { modal } = cur;
    const plan = planSelection(readFields(modal), op, searchText(modal));
    busy = true;
    setBusy(true);
    let changed = 0;
    try {
      for (const { id, checked } of plan) {
        if (ctx.signal.aborted || !modal.isConnected) break;
        const cb = rowById(modal, id)?.querySelector(SEL.checkbox);
        if (!cb || isChecked(cb) === checked) continue;
        cb.click();
        changed++;
        await yieldToReact();
      }
    } finally {
      busy = false;
      setBusy(false);
    }
    ctx.log.debug(`${op}: changed ${changed} row(s)`);
    renderCount();
  }

  function setBusy(on) {
    for (const b of cur?.buttons || []) b.disabled = on;
  }

  function makeButton(label, title, op) {
    return injectedButton(label, {
      size: 'sm',
      title,
      onClick: (e) => {
        // The dialog must not see these clicks (the userscript stopped them too).
        e.preventDefault();
        e.stopPropagation();
        run(op).catch((err) => ctx.log.error(`${op} failed`, err));
      },
    });
  }

  function attach(modal) {
    // Insert below the search box, above the field list.
    const body = modal.querySelector(SEL.modalBody);
    if (!body) return;
    const searchWrapper = body.querySelector(SEL.searchInput)?.closest(SEL.searchWrapper);
    const m = searchWrapper
      ? ctx.ui.mountInline(searchWrapper, 'after', { className: 'es', display: 'block' })
      : ctx.ui.mountInline(body, 'prepend', { className: 'es', display: 'block' });
    m.root.prepend(h('style', null, EXTRA_CSS));

    const buttons = [
      makeButton('Select all', 'Check every row matching the current search', 'select'),
      makeButton('Deselect all', `Uncheck every row matching the current search (${LOCKED_FIELDS.join(', ')} are locked)`, 'deselect'),
      makeButton('Invert', 'Invert selection for filtered rows', 'invert'),
    ];
    const count = h('span', { class: 'es-count', 'aria-live': 'polite' });
    m.el.append(...buttons, count);

    // Keep the count live: checkbox state, rows shown/hidden by the search, typing in the search.
    const ac = new AbortController();
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; renderCount(); });
    };
    const obs = new MutationObserver(schedule);
    obs.observe(modal, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'style', 'class', 'hidden'] });
    ac.signal.addEventListener('abort', () => obs.disconnect(), { once: true });
    modal.addEventListener('input', schedule, { capture: true, signal: ac.signal });

    cur = { modal, mount: m, count, buttons, ac };
    renderCount();
    ctx.log.debug('controls injected');
  }

  function detach() {
    if (!cur) return;
    cur.ac.abort();
    cur.mount.destroy();
    cur = null;
  }

  // The dialog opens and closes without page loads: follow it, and re-attach if React drops us.
  function ensure() {
    const modal = document.querySelector(SEL.modal);
    if (cur && (cur.modal !== modal || !cur.mount.host.isConnected)) detach();
    if (modal && !cur) attach(modal);
  }
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!ctx.signal.aborted) ensure(); });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensure();

  return () => {
    obs.disconnect();
    detach();
  };
}
