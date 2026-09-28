// Options-page editor for quick search tags: add (label + one of nine gradients), rename, delete,
// drag to reorder (SortableJS), and tag order.
// Contract (src/options/sections/feature.js): render(container, { values, save, meta }) → cleanup.

import Sortable from 'sortablejs';
import { h, clear } from '../../core/dom.js';
import * as settingsStore from '../../core/settings.js';
import { button, chip, confirmDialog, field, input, select, toast } from '../../ui/components.js';
import {
  PRESET_GRADIENTS, gradientCss, makeTag, mergeTagEdits, nextPresetIndex, normaliseSortOrder, normaliseTags,
  presetAt, reorderTags, sortTags, MAX_TAG_LABEL,
} from './tags.js';

const STYLE_ID = 'wb-qs-editor-style';
const CSS = `
.qs-ed{display:flex; flex-direction:column; gap:16px; max-width:640px}
.qs-ed .card{display:flex; flex-direction:column; gap:12px}
.qs-ed .card h3{display:flex; align-items:center; gap:8px; margin:0}
.qs-sws{display:flex; flex-wrap:wrap; gap:8px}
.qs-sw{width:36px; height:26px; border-radius:6px; border:0; padding:0; cursor:pointer}
.qs-sw[aria-pressed="true"]{box-shadow:0 0 0 2px var(--wb-surface), 0 0 0 4px var(--wb-accent)}
.qs-list{display:flex; flex-direction:column; gap:6px}
.qs-row{display:grid; grid-template-columns:auto auto 1fr auto; gap:8px; align-items:center; padding:5px 8px; border:1px solid var(--wb-line); border-radius:8px; background:var(--wb-surface)}
.qs-grip{cursor:grab; color:var(--wb-faint); font-size:14px; line-height:1; user-select:none; padding:0 2px}
.qs-list.fixed .qs-grip{visibility:hidden}
.qs-dot{width:16px; height:16px; border-radius:50%}
.qs-ghost{opacity:.4}
.qs-empty{font-size:12.5px; color:var(--wb-muted); margin:0}
.qs-preview{display:flex; flex-wrap:wrap; gap:6px}
`;

export function render(container, { values, save, meta }) {
  let tags = normaliseTags(values.tags);
  let synced = tags;   // the stored list `tags` was last in step with (merge base for saves)
  let sortOrder = normaliseSortOrder(values.sortOrder);
  let preset = nextPresetIndex(tags);
  const cleanups = [];

  if (!document.getElementById(STYLE_ID)) {
    const style = h('style', { id: STYLE_ID }, CSS);
    document.head.append(style);
    cleanups.push(() => style.remove());
  }

  // The container arrives as a .card; we lay out our own cards inside it instead.
  container.classList.remove('card');
  container.classList.add('qs-ed');

  const persist = async (patch) => {
    try {
      await save(patch);
    } catch (e) {
      console.error('[Loophole:quick-search] save failed', e);
      toast('Couldn’t save your tags.', { tone: 'bad', source: meta.name });
    }
  };

  // Tags are merged by id against the latest stored list inside the read-modify-write, so a tag
  // saved from the template page while this editor is open isn't overwritten.
  const persistTags = async () => {
    const base = synced;
    const local = tags;
    let merged = null;
    try {
      await settingsStore.updateFeatureValues(meta.id, (latest) => {
        merged = mergeTagEdits(base, normaliseTags(latest.tags), local);
        return { tags: merged };
      });
    } catch (e) {
      console.error('[Loophole:quick-search] save failed', e);
      toast('Couldn’t save your tags.', { tone: 'bad', source: meta.name });
      return;
    }
    synced = merged;
    if (tags === local && JSON.stringify(merged) !== JSON.stringify(local)) {
      tags = merged;
      renderList();
    }
    toast(`${meta.name} saved.`, { tone: 'ok', source: meta.name });
  };

  // ── Add a tag ──────────────────────────────────────────────────────────
  const labelInput = input({
    placeholder: 'e.g. Newsletter, Promo, Welcome',
    onInput: () => { addErr.hidden = true; },
  });
  labelInput.maxLength = MAX_TAG_LABEL;
  labelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const addErr = h('div', { class: 'err', hidden: true });
  const swatches = h('div', { class: 'qs-sws', role: 'group', 'aria-label': 'Tag colour' },
    PRESET_GRADIENTS.map((g, i) => h('button', {
      type: 'button', class: 'qs-sw', 'aria-label': `Colour ${i + 1}`, 'aria-pressed': 'false',
      dataset: { i: String(i) }, style: { background: gradientCss(g) },
      onClick: () => { preset = i; paintSwatches(); },
    })));
  const paintSwatches = () => {
    for (const b of swatches.children) b.setAttribute('aria-pressed', String(Number(b.dataset.i) === preset));
  };
  paintSwatches();

  async function add() {
    const label = labelInput.value.trim();
    if (!label) {
      addErr.textContent = 'Enter the search text for this tag.';
      addErr.hidden = false;
      labelInput.focus();
      return;
    }
    tags = [...tags, makeTag(label, presetAt(preset), tags)];
    labelInput.value = '';
    addErr.hidden = true;
    preset = nextPresetIndex(tags);
    paintSwatches();
    renderList();
    await persistTags();
    labelInput.focus();
  }

  const labelField = field({
    label: 'Search text', control: labelInput,
    help: 'Clicking the tag types exactly this into the template search.',
  });
  labelField.append(addErr);

  const addCard = h('div', { class: 'card' },
    h('h3', null, 'Add a tag'),
    labelField,
    field({ label: 'Colour', control: swatches }),
    h('div', null, button('+ Add tag', { variant: 'primary', onClick: add })));

  // ── Your tags ──────────────────────────────────────────────────────────
  const count = chip('0');
  const orderSelect = select({
    options: meta.settings.find((f) => f.key === 'sortOrder')?.options || [],
    value: sortOrder,
    ariaLabel: 'Tag order',
    onChange: (v) => {
      sortOrder = normaliseSortOrder(v);
      renderList();
      persist({ sortOrder });
    },
  });
  const hint = h('div', { class: 'wb-help' });
  const preview = h('div', { class: 'qs-preview', 'aria-label': 'Preview' });
  const list = h('div', { class: 'qs-list' });

  const sortable = Sortable.create(list, {
    handle: '.qs-grip',
    animation: 150,
    ghostClass: 'qs-ghost',
    onEnd: () => {
      const ids = [...list.children].map((el) => el.dataset.id).filter(Boolean);
      tags = reorderTags(tags, ids);
      renderList();
      persistTags();
    },
  });
  cleanups.push(() => sortable.destroy());

  function renderList() {
    const custom = sortOrder === 'custom';
    sortable.option('disabled', !custom);
    list.classList.toggle('fixed', !custom);
    count.textContent = String(tags.length);
    hint.textContent = custom
      ? 'Drag the ⋮⋮ handle to change the order tags appear in.'
      : 'Switch the order to Custom to drag tags into your own order.';
    clear(list);
    clear(preview);
    const shown = sortTags(tags, sortOrder);
    if (!shown.length) {
      list.append(h('p', { class: 'qs-empty' }, 'No tags yet. Add one above, or use Save search on the template list.'));
      return;
    }
    for (const t of shown) {
      preview.append(h('span', { class: 'qs-tag', style: { background: gradientCss(t.colorGradient), cursor: 'default' } }, t.label));
      list.append(tagRow(t));
    }
  }

  function tagRow(t) {
    const name = input({ value: t.label, ariaLabel: `Rename ${t.label}` });
    name.maxLength = MAX_TAG_LABEL;
    const commit = () => {
      const label = name.value.trim();
      const cur = tags.find((x) => x.id === t.id);
      if (!cur) return;
      if (!label) { name.value = cur.label; return; }
      if (label === cur.label) return;
      tags = tags.map((x) => (x.id === t.id ? { ...x, label } : x));
      renderList();
      persistTags();
    };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.value = t.label; name.blur(); }
    });
    const del = h('button', {
      type: 'button', class: 'wb-x', 'aria-label': `Delete ${t.label}`, title: 'Delete',
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Delete tag?', brand: meta.name, confirmLabel: 'Delete', danger: true,
          body: h('p', { style: 'margin:0; font-size:13px; line-height:1.5' },
            `“${t.label}” will be removed from the quick search strip.`),
        });
        if (!ok) return;
        tags = tags.filter((x) => x.id !== t.id);
        renderList();
        persistTags();
      },
    }, '×');
    return h('div', { class: 'qs-row', dataset: { id: t.id } },
      h('span', { class: 'qs-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
      h('span', { class: 'qs-dot', style: { background: gradientCss(t.colorGradient) } }),
      name,
      del);
  }

  const listCard = h('div', { class: 'card' },
    h('h3', null, 'Your tags', count),
    field({ label: 'Order', control: orderSelect }),
    preview,
    list,
    hint);

  container.append(addCard, listCard);
  renderList();

  // Pick up changes made elsewhere (Save search on the template list, another options tab),
  // unless the user is mid-edit in this list.
  cleanups.push(settingsStore.subscribe((next) => {
    const v = next.features[meta.id]?.values || {};
    const nextTags = normaliseTags(v.tags);
    const nextSort = normaliseSortOrder(v.sortOrder);
    if (JSON.stringify(nextTags) === JSON.stringify(tags) && nextSort === sortOrder) return;
    if (list.contains(document.activeElement)) return;
    tags = nextTags;
    synced = nextTags;
    sortOrder = nextSort;
    orderSelect.value = sortOrder;
    renderList();
  }));

  return () => cleanups.forEach((c) => { try { c(); } catch { /* ignore */ } });
}
