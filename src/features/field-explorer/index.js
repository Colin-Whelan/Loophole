// Field value explorer: on /segmentation, a floating "Field values" button opens a dialog with a
// field-name picker (autocomplete) and fetches ALL unique values for that user field via
// POST /lists/v2/fieldFacets, bypassing the ~1,200-value limit of Iterable's own autocomplete.
// Port of "Iterable Field Value Explorer" v1.0.0. Values can be PII — never logged, only shown in
// the dialog and put on the clipboard by explicit user action.

import { getUserFields, fieldFacets } from '../../lib/iterable/fields.js';
import { fieldComboItems, searchValues, summaryText } from './values.js';

const SOURCE = 'Field value explorer';

export function mount(ctx) {
  const { ui, dom, http, project, signal, log } = ctx;
  const { h } = dom;

  let settings = ctx.settings;
  let dialogOpen = false;

  const bar = ui.floatingBar({ label: 'Field value explorer', signal });
  const openBtn = ui.button('Field values', { variant: 'primary', size: 'sm', onClick: () => openDialog() });
  bar.el.append(ui.mark(), openBtn);
  bar.show(true);

  function openDialog() {
    if (dialogOpen) return;
    dialogOpen = true;

    let fields = null;
    let allValues = [];
    let apiTruncated = false;
    let loadSeq = 0;

    const status = h('div', { class: 'fe-status' }, 'Loading field list…');
    const combo = ui.combobox({
      source: (q) => (fields ? ui.filterItems(fields, q, 50) : []),
      placeholder: 'Start typing a field name…',
      ariaLabel: 'User field',
      mono: true,
      minChars: 0,
      maxResults: 50,
      onSelect: (item) => selectField(item.value),
    });
    const searchInput = ui.input({
      placeholder: 'Filter values…', ariaLabel: 'Filter values', onInput: (v) => renderValues(v),
    });
    searchInput.style.display = 'none';
    const list = h('div', { class: 'fe-list' });
    list.style.display = 'none';
    const count = h('span', { class: 'fe-count' });
    const copyMatchingBtn = ui.copyButton(() => currentMatching().join('\n'), { label: 'Copy matching', size: 'sm' });
    const copyAllBtn = ui.copyButton(() => allValues.join('\n'), { label: 'Copy all', variant: 'primary', size: 'sm' });
    copyMatchingBtn.style.display = 'none';
    copyAllBtn.style.display = 'none';
    const footer = h('div', { class: 'fe-footer' }, count, h('div', { class: 'fe-footer-btns' }, copyMatchingBtn, copyAllBtn));

    const css = `
      .wb.fe{display:flex; flex-direction:column; gap:10px}
      .fe-status{font-size:12px; color:var(--wb-muted)}
      .fe-list{max-height:340px; overflow:auto; border:1px solid var(--wb-line); border-radius:var(--wb-r)}
      .fe-row{padding:5px 10px; font:12px var(--wb-mono); border-bottom:1px solid var(--wb-line); word-break:break-all; cursor:pointer}
      .fe-row:last-child{border-bottom:none}
      .fe-row:hover{background:var(--wb-accent-soft)}
      .fe-row.fe-more{color:var(--wb-faint); font-style:italic; cursor:default}
      .fe-row.fe-more:hover{background:transparent}
      .fe-footer{display:flex; align-items:center; justify-content:space-between; gap:8px}
      .fe-footer-btns{display:flex; gap:8px}
      .fe-count{font-size:12px; color:var(--wb-muted); font-variant-numeric:tabular-nums}
    `;

    const body = h('div', { class: 'wb fe' },
      ui.field({ label: 'Field', control: combo }),
      status,
      searchInput,
      list,
      footer);

    const d = ui.dialog({
      title: 'Field value explorer', source: SOURCE, size: 'lg', body, css,
      actions: [{ id: 'close', label: 'Close' }],
    });
    d.closed.then(() => { dialogOpen = false; });

    function currentMatching() {
      return searchValues(allValues, searchInput.value, allValues.length).shown;
    }

    function renderValues(query) {
      const max = Number.isInteger(settings.maxRendered) && settings.maxRendered > 0 ? settings.maxRendered : 2000;
      const { shown, matchCount, truncated } = searchValues(allValues, query, max);
      dom.clear(list);
      for (const v of shown) {
        list.append(h('div', { class: 'fe-row', title: 'Click to copy', onClick: () => copyRow(v) }, v));
      }
      if (truncated) {
        list.append(h('div', { class: 'fe-row fe-more' }, `…and ${(matchCount - shown.length).toLocaleString()} more. Use the filter to narrow down.`));
      }
      count.textContent = summaryText(matchCount, allValues.length, { apiTruncated });
    }

    async function copyRow(v) {
      const ok = await ui.copyText(v);
      ui.toast(ok ? 'Copied' : "Couldn't copy", { tone: ok ? 'ok' : 'bad', source: SOURCE, timeoutMs: 1500 });
    }

    async function selectField(fieldName) {
      const seq = ++loadSeq;
      status.textContent = `Fetching all values for "${fieldName}"…`;
      searchInput.style.display = 'none';
      searchInput.value = '';
      list.style.display = 'none';
      copyMatchingBtn.style.display = 'none';
      copyAllBtn.style.display = 'none';
      count.textContent = '';
      allValues = [];
      try {
        const res = await fieldFacets({ http }, { field: fieldName, signal });
        if (seq !== loadSeq || signal.aborted) return;
        allValues = res.values;
        apiTruncated = res.truncated;
        status.textContent = `Found ${allValues.length.toLocaleString()} unique value${allValues.length === 1 ? '' : 's'} for "${fieldName}"`
          + (apiTruncated ? ' (API returned the maximum — there may be more)' : '');
        if (allValues.length > 0) {
          searchInput.style.display = '';
          list.style.display = '';
          copyMatchingBtn.style.display = '';
          copyAllBtn.style.display = '';
          renderValues('');
        }
      } catch (err) {
        if (err?.name === 'AbortError' || seq !== loadSeq) return;
        log.warn('fieldFacets failed', err?.message);
        status.textContent = `Error loading values: ${err?.message || err}`;
      }
    }

    (async () => {
      try {
        fields = fieldComboItems(await getUserFields({ http, project }, { signal }));
        if (signal.aborted) return;
        status.textContent = `${fields.length.toLocaleString()} field${fields.length === 1 ? '' : 's'} loaded. Start typing to search.`;
      } catch (err) {
        if (err?.name === 'AbortError') return;
        log.warn('getUserFields failed', err?.message);
        status.textContent = `Error loading fields: ${err?.message || err}`;
      }
    })();
  }

  const offAction = ctx.onAction('open', () => openDialog());
  const offSettings = ctx.onSettings((values) => { settings = values; });

  return () => {
    offAction?.();
    offSettings?.();
    bar.destroy();
  };
}
