// Generated editor for `objectList` settings (ARCHITECTURE §8.1): a list of items, each with the
// sub-fields declared in `field.fields`. Add, remove (with undo), drag or keyboard reorder, and
// per-field validation on Save.
//
// Layout: compact rows (one line per item, column headings above) when every sub-field is short
// (no `text`) and there are at most 3; otherwise one card per item. `field.layout: 'rows' |
// 'cards'` overrides the choice.

import Sortable from 'sortablejs';
import { h, clear } from '../../core/dom.js';
import { newItem, validateObjectList } from '../../core/schema.js';
import {
  button, input, select, switchInput, textarea, shortcutInput,
} from '../../ui/components.js';

let seq = 0;

/** → { control, read } where read() → { value } | { error } (like the other generated controls). */
export function objectListEditor(field, value) {
  const subs = field.fields || [];
  const itemLabel = field.itemLabel || 'Item';
  const layout = field.layout === 'rows' || field.layout === 'cards' ? field.layout
    : (subs.length <= 3 && subs.every((s) => s.type !== 'text') ? 'rows' : 'cards');
  const reorderable = field.reorderable !== false;
  const uid = `ol${++seq}`;

  const rows = []; // { el, base, controls: [{ sub, get, err, focus }], titleEl }
  const list = h('div', { class: ['ol-list', `ol-${layout}`] });
  const empty = h('div', { class: 'ol-empty' }, `No ${itemLabel.toLowerCase()}s yet.`);
  const undoBar = h('div', { class: 'ol-undo', hidden: true, role: 'status' });
  const addBtn = button(`+ Add ${itemLabel.toLowerCase()}`, { variant: 'ghost', size: 'sm', onClick: () => add() });
  addBtn.style.alignSelf = 'flex-start';

  const head = layout === 'rows'
    ? h('div', { class: 'ol-head', 'aria-hidden': 'true', style: { gridTemplateColumns: rowColumns() } },
      reorderable ? h('span') : null, subs.map((s) => h('span', null, s.label || s.key)), h('span'))
    : null;

  function rowColumns() {
    const cols = subs.map((s) => (s.type === 'boolean' ? 'auto' : s.type === 'number' ? 'minmax(70px,.5fr)' : 'minmax(0,1fr)'));
    return [reorderable ? 'auto' : null, ...cols, 'auto'].filter(Boolean).join(' ');
  }

  const titleOf = (row, i) => {
    const t = field.titleField ? row.controls.find((c) => c.sub.key === field.titleField)?.get() : '';
    return (typeof t === 'string' && t.trim()) ? t.trim() : `${itemLabel} ${i + 1}`;
  };
  const refresh = () => {
    empty.hidden = rows.length > 0;
    head && (head.hidden = rows.length === 0);
    addBtn.disabled = field.maxItems != null && rows.length >= field.maxItems;
    addBtn.title = addBtn.disabled ? `At most ${field.maxItems}` : '';
    rows.forEach((r, i) => {
      if (r.titleEl) r.titleEl.textContent = titleOf(r, i);
      r.grip?.setAttribute('aria-label', `Move ${titleOf(r, i)} (arrow keys)`);
      r.removeBtn.setAttribute('aria-label', `Remove ${titleOf(r, i)}`);
    });
  };

  function subControl(sub, v, rowId) {
    const id = `${uid}-${rowId}-${sub.key}`;
    const aria = sub.label || sub.key;
    switch (sub.type) {
      case 'boolean': {
        const sw = switchInput({ checked: !!v, label: aria, id });
        return { el: layout === 'rows' ? sw : h('div', { class: 'row' }, sw, h('span', { style: 'font-size:13px' }, aria)), get: () => sw.input.checked, focus: () => sw.input.focus(), id };
      }
      case 'number': {
        const el = input({ type: 'number', mono: true, value: v == null ? '' : String(v), min: sub.min, max: sub.max, step: sub.step ?? 'any', id, ariaLabel: aria, placeholder: sub.placeholder });
        return { el, get: () => (el.value.trim() === '' ? NaN : Number(el.value)), focus: () => el.focus(), id };
      }
      case 'text': {
        const el = textarea({ value: v ?? '', mono: !!sub.mono, rows: sub.rows || 4, placeholder: sub.placeholder, id, ariaLabel: aria });
        return { el, get: () => el.value, focus: () => el.focus(), id };
      }
      case 'select': {
        const el = select({ options: sub.options || [], value: v, id, ariaLabel: aria });
        return { el, get: () => el.value, focus: () => el.focus(), id };
      }
      case 'shortcut': {
        const el = shortcutInput({ value: v ?? '', id, ariaLabel: aria });
        return { el, get: () => el.value, focus: () => el.input.focus(), id };
      }
      default: { // string (and anything unknown, edited as text)
        const el = input({ value: v ?? '', mono: !!sub.mono, placeholder: sub.placeholder, id, ariaLabel: aria });
        if (field.titleField === sub.key) el.addEventListener('input', () => refresh());
        return { el, get: () => el.value.trim(), focus: () => el.focus(), id };
      }
    }
  }

  function buildRow(item) {
    const rowId = ++seq;
    const row = { base: { ...item }, controls: [] };
    const grip = reorderable ? h('button', {
      type: 'button', class: 'ol-grip', title: 'Drag to reorder',
      onKeydown: (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        move(row, e.key === 'ArrowUp' ? -1 : 1);
        grip.focus();
      },
    }, '⋮⋮') : null;
    const removeBtn = h('button', { type: 'button', class: 'wb-x', onClick: () => remove(row) }, '×');
    const cells = subs.map((sub) => {
      const c = subControl(sub, item[sub.key], rowId);
      const err = h('div', { class: 'err', hidden: true });
      row.controls.push({ sub, get: c.get, err, focus: c.focus });
      if (layout === 'rows') return h('div', { class: 'ol-cell' }, c.el, err);
      return h('div', { class: ['wb-field', sub.type === 'text' && 'wide'] },
        sub.type === 'boolean' ? null : h('label', { class: 'wb-label', for: c.id }, sub.label || sub.key),
        c.el, sub.help ? h('div', { class: 'wb-help' }, sub.help) : null, err);
    });
    if (layout === 'rows') {
      row.el = h('div', { class: 'ol-row', style: { gridTemplateColumns: rowColumns() } }, grip, cells, removeBtn);
    } else {
      row.titleEl = h('span', { class: 't' });
      row.el = h('div', { class: 'ol-card' },
        h('div', { class: 'ol-card-h' }, grip, row.titleEl, removeBtn),
        h('div', { class: 'ol-fields' }, cells));
    }
    row.grip = grip;
    row.removeBtn = removeBtn;
    return row;
  }

  function add(item = newItem(field), index = rows.length, focus = true) {
    const row = buildRow(item);
    rows.splice(index, 0, row);
    list.insertBefore(row.el, rows[index + 1]?.el || null);
    refresh();
    if (focus) row.controls[0]?.focus();
    return row;
  }

  let undoTimer = null;
  function remove(row) {
    const index = rows.indexOf(row);
    if (index < 0) return;
    const snapshot = currentItem(row);
    const title = titleOf(row, index);
    rows.splice(index, 1);
    row.el.remove();
    refresh();
    clearTimeout(undoTimer);
    clear(undoBar).append(
      h('span', null, `Removed ${title}.`),
      button('Undo', {
        variant: 'ghost', size: 'sm',
        onClick: () => {
          undoBar.hidden = true;
          add(snapshot, Math.min(index, rows.length));
        },
      }));
    undoBar.hidden = false;
    undoTimer = setTimeout(() => { undoBar.hidden = true; }, 10000);
    const near = rows[index] || rows[index - 1];
    if (near) near.removeBtn.focus(); else addBtn.focus();
  }

  function move(row, delta) {
    const i = rows.indexOf(row);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= rows.length) return;
    rows.splice(i, 1);
    rows.splice(j, 0, row);
    list.insertBefore(row.el, rows[j + 1]?.el || null);
    refresh();
  }

  const currentItem = (row) => {
    const item = { ...row.base };
    for (const c of row.controls) item[c.sub.key] = c.get();
    return item;
  };

  (Array.isArray(value) ? value : []).forEach((item) => add(item, rows.length, false));

  if (reorderable) {
    Sortable.create(list, {
      handle: '.ol-grip', animation: 150, ghostClass: 'ol-ghost',
      onEnd: () => {
        const order = [...list.children];
        rows.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
        refresh();
      },
    });
  }
  refresh();

  const control = h('div', { class: ['ol', `ol-is-${layout}`] }, head, list, empty, undoBar, addBtn);
  return {
    control,
    read() {
      const res = validateObjectList(field, rows.map(currentItem));
      rows.forEach((r, i) => {
        for (const c of r.controls) {
          const e = res.itemErrors.find((x) => x.index === i && x.key === c.sub.key);
          c.err.hidden = !e;
          c.err.textContent = e ? e.message : '';
        }
      });
      if (!res.ok) {
        const first = res.itemErrors[0];
        if (first) rows[first.index]?.controls.find((c) => c.sub.key === first.key)?.focus();
        return { error: res.listError || 'Fix the highlighted fields.' };
      }
      return { value: res.value };
    },
  };
}
