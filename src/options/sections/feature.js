// #feature/<id>: a form generated from meta.settings (fields without `hidden: true`), plus the
// feature's own settings-ui.js when meta.customSettings is true.
//
// settings-ui.js contract:
//   export function render(container, { values, defaults, save, reset, state, meta }) → cleanup?
//     values      current resolved values (schema defaults applied), a plain copy
//     defaults    schema defaults
//     save(v)     Promise; merges `v` into the feature's stored values (an `undefined` value
//                 deletes that key, so it falls back to the current default)
//     reset(keys?) Promise<values>; drops the stored values for `keys` (default: all of this
//                 feature's values) so the current defaults apply; resolves the new resolved
//                 values. No confirm dialog: the editor asks first if it needs to.
//     state       wb:state:<featureId>:* store: { get, set, remove, list }
//     meta        the feature's meta

import { h } from '../../core/dom.js';
import * as settings from '../../core/settings.js';
import { createState } from '../../core/state.js';
import { getMeta } from '../../features/registry.js';
import { settingsUis } from '../../features/optional.js';
import {
  button, field, input, select, switchInput, textarea, toast, confirmDialog, shortcutInput,
} from '../../ui/components.js';
import { groupSections, fieldValidateError } from '../../core/schema.js';
import { shortcutError } from '../../core/shortcut.js';
import { objectListEditor } from '../fields/object-list.js';
import { onPermissionsChanged } from '../../core/permissions.js';
import { heading, featureChips, featureAccess, setEnabledFromClick } from './common.js';

export async function render(main, route) {
  const meta = getMeta(route.arg);
  const s = await settings.load();
  const current = s.features[meta.id];

  // Optional hosts: the same access line and permission flow as the Features list.
  const access = featureAccess(meta);
  const enabled = switchInput({
    checked: current.enabled, label: `${meta.name} enabled`,
    onChange: (on) => setEnabledFromClick(meta, on, access),
  });
  main.append(
    ...heading(meta.name, meta.description),
    h('div', { class: 'row', style: `margin:-6px 0 ${access ? 6 : 18}px` },
      enabled, h('span', { style: 'font-size:13px' }, 'Enabled'),
      ...featureChips(meta)),
  );
  if (access) {
    access.el.style.margin = '0 0 18px';
    main.append(access.el);
    access.refresh();
  }

  let wasEnabled = current.enabled;
  const cleanups = [settings.subscribe((next) => {
    const on = next.features[meta.id].enabled;
    enabled.input.checked = on;
    if (access && on && !wasEnabled) access.refresh();
    wasEnabled = on;
  })];
  if (access) cleanups.push(onPermissionsChanged(() => access.refresh()));

  // Fields marked `hidden` are owned by the custom editor (they still carry defaults).
  const visible = (meta.settings || []).filter((f) => !f.hidden);
  if (visible.length) {
    main.append(autoForm(meta, visible, current.values));
  }

  if (meta.customSettings) {
    const container = h('div', { class: 'card', style: 'margin-top:16px' });
    main.append(container);
    const ui = settingsUis[meta.id];
    if (!ui || typeof ui.render !== 'function') {
      container.append(h('p', { class: 'wb-help', style: 'margin:0' }, 'This feature has no settings editor yet.'));
    } else {
      try {
        const c = ui.render(container, {
          values: JSON.parse(JSON.stringify(current.values)),
          defaults: settings.defaultValues(meta),
          save: async (values) => {
            await settings.setFeatureValues(meta.id, values);
            toast(`${meta.name} saved.`, { tone: 'ok', source: meta.name });
          },
          reset: async (keys) => {
            const next = await settings.resetFeatureValues(meta.id, Array.isArray(keys) ? keys : undefined);
            toast(`${meta.name} reset to defaults.`, { source: meta.name });
            return JSON.parse(JSON.stringify(next.features[meta.id].values));
          },
          state: createState(meta.id),
          meta,
        });
        if (typeof c === 'function') cleanups.push(c);
      } catch (e) {
        console.error(`[Loophole:options] ${meta.id} settings-ui failed`, e);
        container.append(h('p', { class: 'err' }, 'The settings editor for this feature failed to load.'));
      }
    }
  }

  if (!visible.length && !meta.customSettings) {
    main.append(h('p', { class: 'wb-help' }, 'This feature has no settings.'));
  }

  return () => cleanups.forEach((c) => { try { c(); } catch { /* ignore */ } });
}

// ── Generated form ───────────────────────────────────────────────────────

// Fields are grouped into titled cards by `section` (first-seen order); unsectioned fields share
// an untitled card. A section of 2+ booleans and nothing else gets "Turn all on / off" buttons
// and a two-column toggle grid. One Save / Reset covers every card.
function autoForm(meta, visibleFields, values) {
  const readers = []; // [{ field, read: () => { value } | { error }, err }]
  const renderField = (f) => {
    const { control, read, toggle, live } = controlFor(f, values[f.key]);
    const err = h('div', { class: 'err', hidden: true });
    readers.push({ field: f, read, err });
    if (live) {
      // Checked when the value is committed (blur / Enter), and re-checked while typing once an
      // error shows, so it clears as soon as the value is fixed. Save re-checks everything.
      const show = () => {
        const res = read();
        err.hidden = !res.error;
        err.textContent = res.error || '';
      };
      control.addEventListener('change', show);
      control.addEventListener('input', () => { if (!err.hidden) show(); });
    }
    let wrapped;
    if (f.type === 'objectList') {
      // Not field(): its label would point at the first item's input.
      wrapped = h('div', { class: 'wb-field' },
        h('div', { class: 'wb-label' }, f.label), control, f.help ? h('div', { class: 'wb-help' }, f.help) : null);
    } else {
      wrapped = field({ label: f.type === 'boolean' ? null : f.label, help: f.help, control });
    }
    wrapped.append(err);
    return { el: wrapped, toggle };
  };

  const save = async () => {
    const patch = {};
    let bad = false;
    for (const r of readers) {
      const res = r.read();
      r.err.hidden = !res.error;
      r.err.textContent = res.error || '';
      if (res.error) bad = true;
      else patch[r.field.key] = res.value;
    }
    if (bad) return;
    await settings.setFeatureValues(meta.id, patch);
    toast(`${meta.name} settings saved.`, { tone: 'ok', source: meta.name });
  };

  const reset = async () => {
    const ok = await confirmDialog({
      title: `Reset ${meta.name}?`, brand: meta.name, confirmLabel: 'Reset to defaults',
      body: h('p', { style: 'margin:0; font-size:13px; line-height:1.5' },
        meta.customSettings
          ? 'All of this feature’s settings, including the ones in the editor below, go back to their defaults.'
          : 'All of this feature’s settings go back to their defaults.'),
    });
    if (!ok) return;
    await settings.resetFeatureValues(meta.id);
    toast(`${meta.name} reset to defaults.`, { source: meta.name });
    window.dispatchEvent(new HashChangeEvent('hashchange')); // re-render with the defaults
  };

  const actions = h('div', { class: 'actions', style: 'justify-content:flex-start; margin-top:0' },
    button('Save', { variant: 'primary', onClick: save }),
    button('Reset to defaults', { variant: 'ghost', onClick: reset }));

  const groups = groupSections(visibleFields);
  if (groups.length === 1 && groups[0].title == null) {
    return h('div', { class: 'card form-card' }, groups[0].fields.map((f) => renderField(f).el), actions);
  }
  const cards = groups.map((g) => {
    const rendered = g.fields.map(renderField);
    const allBool = g.fields.length >= 2 && g.fields.every((f) => f.type === 'boolean');
    const setAll = (on) => rendered.forEach((r) => r.toggle?.(on));
    return h('section', { class: ['card', 'form-card', 'form-section', allBool && 'bool-section'], 'aria-label': g.title || undefined },
      g.title || allBool ? h('div', { class: 'section-h' },
        g.title ? h('h3', null, g.title) : h('span'),
        allBool ? h('div', { class: 'row' },
          button('Turn all on', { variant: 'ghost', size: 'sm', onClick: () => setAll(true) }),
          button('Turn all off', { variant: 'ghost', size: 'sm', onClick: () => setAll(false) })) : null) : null,
      allBool ? h('div', { class: 'bool-grid' }, rendered.map((r) => r.el)) : rendered.map((r) => r.el));
  });
  return h('div', { class: 'form-sections' }, cards, actions);
}

/** Build the control for one schema field. read() → { value } or { error }. */
function controlFor(f, value) {
  switch (f.type) {
    case 'boolean': {
      const sw = switchInput({ checked: !!value, label: f.label });
      return {
        control: h('div', { class: 'row' }, sw, h('span', { style: 'font-size:13px' }, f.label)),
        read: () => ({ value: sw.input.checked }),
        toggle: (on) => { sw.input.checked = on; },
      };
    }
    case 'number': {
      const el = input({ type: 'number', mono: true, value: String(value ?? ''), min: f.min, max: f.max, step: f.step ?? 'any' });
      return {
        control: el,
        read: () => {
          const n = Number(el.value);
          if (el.value.trim() === '' || !Number.isFinite(n)) return { error: 'Enter a number.' };
          if (f.min != null && n < f.min) return { error: `Must be at least ${f.min}.` };
          if (f.max != null && n > f.max) return { error: `Must be at most ${f.max}.` };
          return { value: n };
        },
      };
    }
    case 'string':
    case 'text': {
      const el = f.type === 'string'
        ? input({ value: value ?? '', mono: !!f.mono, placeholder: f.placeholder })
        : textarea({ value: value ?? '', mono: !!f.mono, rows: f.rows || 4, placeholder: f.placeholder });
      const read = () => {
        const error = fieldValidateError(f, el.value);
        return error ? { error } : { value: el.value };
      };
      return { control: el, read, live: typeof f.validate === 'function' };
    }
    case 'select': {
      const el = select({ options: f.options || [], value });
      return { control: el, read: () => ({ value: el.value }) };
    }
    case 'shortcut': {
      const el = shortcutInput({ value: value ?? '', ariaLabel: f.label, placeholder: f.placeholder });
      return {
        control: el,
        read: () => {
          const err = shortcutError(el.value);
          return err ? { error: err } : { value: el.value };
        },
      };
    }
    case 'objectList':
      return objectListEditor(f, value);
    case 'stringList':
      return listEditor(Array.isArray(value) ? value.map((v) => ({ value: v })) : [], false, f);
    case 'keyValueList':
      return listEditor(Array.isArray(value) ? value : [], true, f);
    default: {
      const el = h('p', { class: 'wb-help', style: 'margin:0' }, `Unsupported setting type "${f.type}".`);
      return { control: el, read: () => ({ value }) };
    }
  }
}

/**
 * Row editor for stringList (string[]) and keyValueList ([{ key, value }]).
 * Empty rows are dropped on save.
 */
function listEditor(items, pairs, f) {
  const list = h('div', { class: 'list-ed' });
  const rows = [];
  const addRow = (item = {}) => {
    const k = pairs ? input({ value: item.key ?? '', mono: true, placeholder: f.keyPlaceholder || 'Key', ariaLabel: 'Key' }) : null;
    const v = input({ value: item.value ?? '', mono: true, placeholder: f.placeholder || (pairs ? 'Value' : ''), ariaLabel: 'Value' });
    const row = h('div', { class: ['list-row', pairs && 'kv2'] }, k, v,
      h('button', { type: 'button', class: 'wb-x', 'aria-label': 'Remove', onClick: () => { row.remove(); rows.splice(rows.indexOf(entry), 1); } }, '×'));
    const entry = { k, v };
    rows.push(entry);
    list.insertBefore(row, addBtn);
  };
  const addBtn = button(pairs ? '+ Add pair' : '+ Add', { variant: 'ghost', size: 'sm', onClick: () => addRow() });
  addBtn.style.alignSelf = 'flex-start';
  list.append(addBtn);
  items.forEach(addRow);
  return {
    control: list,
    read: () => {
      if (pairs) {
        return { value: rows.map((r) => ({ key: r.k.value.trim(), value: r.v.value })).filter((r) => r.key) };
      }
      return { value: rows.map((r) => r.v.value.trim()).filter(Boolean) };
    },
  };
}

