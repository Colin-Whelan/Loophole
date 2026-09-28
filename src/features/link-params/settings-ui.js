// Options-page editor for the link parameter library (values.paramTypes).
// Contract (src/options/sections/feature.js):
//   render(container, { values, defaults, save(values), reset(keys?), state, meta }) → cleanup
//
// Edits a local draft; nothing is stored until Save. Reset deletes the stored paramTypes so the
// built-in defaults apply (and later default changes still reach the user). Older versions
// stored paramTypes: null for that; resolveParamTypes() still treats null as "use defaults".

import { h, clear, downloadBlob } from '../../core/dom.js';
import {
  button, input, field, segmented, chip, toast, confirmDialog,
} from '../../ui/components.js';
import {
  resolveParamTypes, defaultParamTypes, normalizeParamTypes, normalizeColor, splitTerms,
  toDraft, buildLibrary, NEW_CATEGORY_COLOR,
} from './library.js';

const CSS = `
.lp-ed .lede{margin:0 0 14px; color:var(--wb-muted); font-size:13px; line-height:1.5; max-width:64ch}
.lp-ed .code{font-family:var(--wb-mono); font-size:12px; background:var(--wb-sunken); padding:1px 4px; border-radius:3px}
.lp-ed .lp-types{display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px}
.lp-ed .segbtns button{font-family:var(--wb-mono)}
.lp-ed .lp-cards{display:flex; flex-direction:column; gap:12px}
.lp-ed .lp-param{display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end}
.lp-ed .lp-cat{display:grid; grid-template-columns:22px minmax(0,1fr) minmax(0,1.6fr) auto auto auto; gap:6px; align-items:center; margin-bottom:6px}
.lp-ed .lp-cat-h{font:600 10.5px var(--wb-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--wb-faint); margin-bottom:4px}
.lp-ed .lp-swatch{width:22px; height:22px; padding:0; border:1px solid var(--wb-line-strong); border-radius:4px; background:none; cursor:pointer}
.lp-ed .lp-swatch::-webkit-color-swatch-wrapper{padding:0}
.lp-ed .lp-swatch::-webkit-color-swatch{border:0; border-radius:3px}
.lp-ed .lp-swatch::-moz-color-swatch{border:0; border-radius:3px}
.lp-ed .lp-mv{border:0; background:transparent; color:var(--wb-muted); cursor:pointer; width:22px; height:24px; border-radius:4px; padding:0; font-size:12px}
.lp-ed .lp-mv:hover:not([disabled]){background:var(--wb-sunken); color:var(--wb-ink)}
.lp-ed .lp-mv[disabled]{opacity:.35; cursor:default}
.lp-ed .lp-foot{display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:14px}
.lp-ed .lp-foot .grow{flex:1}
.lp-ed .err{color:var(--wb-bad); font-size:12px; margin-top:8px; white-space:pre-line}
@media (max-width:640px){
  .lp-ed .lp-param{grid-template-columns:1fr}
  .lp-ed .lp-cat{grid-template-columns:22px 1fr auto auto auto}
  .lp-ed .lp-cat .terms{grid-column:1 / -1}
}
`;

const SOURCE = 'Link parameters';

export function render(container, { values, save, reset, state }) {
  let draft = toDraft(resolveParamTypes(values));
  let sel = 0;
  let dirty = false;

  const root = h('div', { class: 'lp-ed' });
  const typesBar = h('div', { class: 'lp-types' });
  const cards = h('div', { class: 'lp-cards' });
  const err = h('div', { class: 'err', hidden: true });
  const dirtyChip = chip('Unsaved changes', { tone: 'warn' });
  dirtyChip.hidden = true;
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: onImportFile });

  const markDirty = () => { dirty = true; dirtyChip.hidden = false; };
  const markClean = () => { dirty = false; dirtyChip.hidden = true; };

  root.append(
    h('style', null, CSS),
    h('p', { class: 'lede' },
      'The values offered by the Link params picker in the drag-and-drop editor, grouped by parameter and category. ',
      'Values can use Handlebars, such as ', h('span', { class: 'code' }, '{{now format="yyyyMMdd"}}'), '.'),
    typesBar,
    cards,
    err,
    h('div', { class: 'lp-foot' },
      button('Import JSON', { variant: 'ghost', size: 'sm', onClick: () => fileInput.click() }),
      button('Export JSON', { variant: 'ghost', size: 'sm', onClick: onExport }),
      button('Clear recents', { variant: 'ghost', size: 'sm', onClick: onClearRecents }),
      h('span', { class: 'grow' }),
      dirtyChip,
      button('Reset to defaults', { variant: 'ghost', onClick: onReset }),
      button('Save', { variant: 'primary', onClick: onSave })),
    fileInput,
  );
  container.append(root);

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderAll() {
    if (sel >= draft.length) sel = Math.max(0, draft.length - 1);
    renderTypes();
    renderCards();
  }

  function renderTypes() {
    clear(typesBar);
    if (draft.length) {
      typesBar.append(segmented({
        ariaLabel: 'Parameters',
        options: draft.map((t, i) => ({ value: String(i), label: t.key || '(unnamed)' })),
        value: String(sel),
        onChange: (v) => { sel = Number(v); renderCards(); },
      }));
    }
    typesBar.append(button('+ Add parameter', { variant: 'ghost', size: 'sm', onClick: addType }));
  }

  function renderCards() {
    clear(cards);
    const t = draft[sel];
    if (!t) return;

    const keyInput = input({
      value: t.key, mono: true, placeholder: 'utm_campaign', ariaLabel: 'Parameter name',
      onInput: (v) => { t.key = v.trim(); markDirty(); renderTypes(); catTitle.textContent = `${t.key || 'Parameter'} categories`; },
    });
    const labelInput = input({
      value: t.label, placeholder: t.key || 'Same as the name', ariaLabel: 'Tab label',
      onInput: (v) => { t.label = v; markDirty(); },
    });
    const removeBtn = button('Remove', {
      variant: 'danger', size: 'sm', disabled: draft.length <= 1, onClick: () => removeType(sel),
      title: draft.length <= 1 ? 'Keep at least one parameter' : undefined,
    });
    const moveL = h('button', {
      type: 'button', class: 'lp-mv', title: 'Move left', 'aria-label': 'Move parameter left', disabled: sel === 0,
      onClick: () => moveType(sel, -1),
    }, '◀');
    const moveR = h('button', {
      type: 'button', class: 'lp-mv', title: 'Move right', 'aria-label': 'Move parameter right', disabled: sel === draft.length - 1,
      onClick: () => moveType(sel, 1),
    }, '▶');

    cards.append(h('div', { class: 'card' },
      h('h3', null, 'Parameter'),
      h('div', { class: 'lp-param' },
        field({ label: 'Name in the link', control: keyInput }),
        field({ label: 'Tab label (optional)', control: labelInput }),
        h('div', { class: 'row', style: 'gap:2px; padding-bottom:4px' }, moveL, moveR, removeBtn))));

    const catTitle = h('h3', null, `${t.key || 'Parameter'} categories`);
    const catCard = h('div', { class: 'card' }, catTitle);
    if (t.categories.length) {
      catCard.append(h('div', { class: 'lp-cat lp-cat-h' },
        h('span'), h('span', null, 'Category'), h('span', { class: 'terms' }, 'Values (comma-separated)'),
        h('span'), h('span'), h('span')));
    } else {
      catCard.append(h('p', { class: 'wb-help', style: 'margin:0 0 8px' }, 'No categories yet. Values typed into the picker still work and show up under Recent.'));
    }
    t.categories.forEach((c, i) => catCard.append(categoryRow(t, c, i)));
    catCard.append(button('+ Add category', {
      variant: 'ghost', size: 'sm',
      onClick: () => {
        t.categories.push({ name: '', color: NEW_CATEGORY_COLOR, terms: [] });
        markDirty();
        renderCards();
        cards.querySelector('.lp-cat:last-of-type input[type="text"]')?.focus();
      },
    }));
    cards.append(catCard);
  }

  function categoryRow(t, c, i) {
    const color = h('input', {
      type: 'color', class: 'lp-swatch', value: normalizeColor(c.color), 'aria-label': 'Category colour', title: 'Category colour',
      onInput: (e) => { c.color = e.target.value; markDirty(); },
    });
    const name = input({
      value: c.name, placeholder: 'Category', ariaLabel: 'Category name',
      onInput: (v) => { c.name = v; markDirty(); },
    });
    const terms = input({
      value: c.terms.join(', '), mono: true, placeholder: 'hero, footer, body_cta', ariaLabel: 'Values',
      onInput: (v) => { c.terms = splitTerms(v); markDirty(); },
    });
    terms.classList.add('terms');
    const mv = (d, label, glyph, disabled) => h('button', {
      type: 'button', class: 'lp-mv', title: label, 'aria-label': label, disabled,
      onClick: () => {
        const j = i + d;
        [t.categories[i], t.categories[j]] = [t.categories[j], t.categories[i]];
        markDirty();
        renderCards();
      },
    }, glyph);
    return h('div', { class: 'lp-cat' },
      color, name, terms,
      mv(-1, 'Move up', '▲', i === 0),
      mv(1, 'Move down', '▼', i === t.categories.length - 1),
      h('button', {
        type: 'button', class: 'wb-x', 'aria-label': 'Remove category', title: 'Remove category',
        onClick: () => { t.categories.splice(i, 1); markDirty(); renderCards(); },
      }, '×'));
  }

  // ── Actions ────────────────────────────────────────────────────────────

  function addType() {
    const taken = new Set(draft.map((t) => t.key));
    let key = 'utm_campaign';
    for (let n = 2; taken.has(key); n++) key = `param_${n}`;
    draft.push({ key, label: '', categories: [{ name: 'General', color: NEW_CATEGORY_COLOR, terms: [] }] });
    sel = draft.length - 1;
    markDirty();
    renderAll();
    cards.querySelector('input')?.select();
  }

  async function removeType(i) {
    const t = draft[i];
    if (!t || draft.length <= 1) return;
    const ok = await confirmDialog({
      title: `Remove ${t.key || 'this parameter'}?`, brand: SOURCE, confirmLabel: 'Remove', danger: true,
      body: h('p', { style: 'margin:0; font-size:13px; line-height:1.5' },
        `Its ${t.categories.length} categor${t.categories.length === 1 ? 'y' : 'ies'} go too. Nothing is stored until you Save.`),
    });
    if (!ok) return;
    draft.splice(i, 1);
    markDirty();
    renderAll();
  }

  function moveType(i, d) {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    [draft[i], draft[j]] = [draft[j], draft[i]];
    sel = j;
    markDirty();
    renderAll();
  }

  function showErrors(errors) {
    err.hidden = !errors?.length;
    err.textContent = errors?.length ? errors.join('\n') : '';
  }

  async function onSave() {
    const built = buildLibrary(draft);
    showErrors(built.errors);
    if (built.errors) return;
    await save({ paramTypes: built.paramTypes });
    draft = toDraft(built.paramTypes);
    markClean();
    renderAll();
  }

  async function onReset() {
    const ok = await confirmDialog({
      title: 'Reset the link parameter library?', brand: SOURCE, confirmLabel: 'Reset to defaults', danger: true,
      body: h('p', { style: 'margin:0; font-size:13px; line-height:1.5' },
        'Your parameters, categories and values are replaced by the built-in examples. Export first if you want a copy.'),
    });
    if (!ok) return;
    await reset(['paramTypes']);
    draft = toDraft(defaultParamTypes());
    sel = 0;
    showErrors(null);
    markClean();
    renderAll();
  }

  function onExport() {
    const built = buildLibrary(draft);
    showErrors(built.errors);
    if (built.errors) return;
    downloadBlob('loophole-link-params.json', JSON.stringify(built.paramTypes, null, 2) + '\n', 'application/json');
  }

  async function onImportFile() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let text;
    try { text = await file.text(); } catch { text = ''; }
    const { paramTypes, notes } = normalizeParamTypes(text);
    if (!paramTypes) {
      toast(`Couldn't import ${file.name}: ${notes[0] || 'not a link parameter library.'}`, { tone: 'bad', source: SOURCE, timeoutMs: 6000 });
      return;
    }
    draft = toDraft(paramTypes);
    sel = 0;
    markDirty();
    showErrors(null);
    renderAll();
    const n = Object.keys(paramTypes).length;
    toast(`Loaded ${n} parameter${n === 1 ? '' : 's'} from ${file.name}. Review, then Save.`
      + (notes.length ? ` (${notes.length} item${notes.length === 1 ? '' : 's'} skipped)` : ''), { source: SOURCE, timeoutMs: 6000 });
  }

  async function onClearRecents() {
    await state.remove('recents');
    toast('Recent values cleared.', { source: SOURCE });
  }

  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);

  renderAll();

  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    root.remove();
  };
}
