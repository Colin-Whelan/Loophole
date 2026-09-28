// Shared "edit one profile field" UI, used by the Profile Editor and Live Preview's pusher.
// Built from the Profile Editor's edit / add-field modals and the Live Preview "Push New Value"
// modal: field name with suggestions from the schema, type badge, current value, value box with
// live type detection (parseFieldInput), merge-nested toggle, Save → POST /api/users/update.
// Hosts can add beforeSave (re-check the project before a write), secondary actions (the
// editor is locked while one runs) and createNewFields. Never logs identities or values.

import { parseFieldInput, updateUser, dataFieldsFor, describeType, identityOf } from './users.js';
import { findField } from './fields.js';
import { IterableError } from './errors.js';

export const NEW_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const CSS = `
.fe{display:flex; flex-direction:column; gap:12px; min-width:0}
.fe .fe-who{font-size:12px; color:var(--wb-muted)}
.fe .fe-who b{font-family:var(--wb-mono); font-weight:600; color:var(--wb-ink); word-break:break-all}
.fe .fe-row{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.fe .fe-status{font-size:12px; min-height:16px}
.fe .fe-status.bad{color:var(--wb-bad)}
.fe .fe-status.warn{color:var(--wb-warn)}
.fe .fe-status.ok{color:var(--wb-ok)}
.fe .fe-cur{margin:0; max-height:160px; overflow:auto; padding:6px 8px; border:1px solid var(--wb-line); border-radius:4px; background:var(--wb-raised); font:12px/1.45 var(--wb-mono); white-space:pre-wrap; word-break:break-word}
.fe .fe-actions{display:flex; justify-content:flex-end; gap:8px}
.fe .fe-more{display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-top:1px solid var(--wb-line); padding-top:10px}
.fe .fe-more .lbl{font-size:12px; color:var(--wb-muted); margin-right:auto}
.fe .wb-btn.fe-danger{color:var(--wb-bad)}
.fe .wb-btn.fe-danger:hover{background:var(--wb-bad-soft); color:var(--wb-bad)}
.fe .fe-note{font-size:12px; line-height:1.45; border-radius:4px; padding:7px 9px}
.fe .fe-note.ok{background:var(--wb-ok-soft); color:var(--wb-ok)}
.fe .fe-note.warn{background:var(--wb-warn-soft); color:var(--wb-warn)}
.fe .fe-note.bad{background:var(--wb-bad-soft); color:var(--wb-bad)}
`;

let seq = 0;

/** A value → the text the editor starts with (objects/arrays pretty JSON, strings raw). */
export function formatForEditing(value) {
  if (value === undefined) return '';
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
  if (value === null) return 'null';
  return String(value);
}

/** Which identifier to send: userId when both are known (safe on every project type). */
export function pickIdentity(identity = {}) {
  const userId = identity.userId == null ? '' : String(identity.userId).trim();
  const email = typeof identity.email === 'string' ? identity.email.trim() : '';
  if (userId) return { userId };
  if (email) return { email };
  return null;
}

/**
 * The editor's pure state: what the badge, status and Save button show.
 * → { name, known: field | null, nameError, parsed (parseFieldInput result | null), canSave, hint }
 */
export function evaluateEditor({ fieldName, text, fields }) {
  const name = String(fieldName ?? '').trim();
  const known = name ? findField(fields, name) : null;
  let nameError = '';
  if (!name) nameError = 'Enter a field name.';
  else if (!known && !NEW_FIELD_NAME_RE.test(name)) {
    nameError = 'New field names start with a letter or underscore and use only letters, numbers and underscores (dots for nested fields).';
  }
  const raw = String(text ?? '');
  let parsed = null;
  let hint = '';
  if (raw.trim() === '') hint = 'Enter a value (type "" for an empty string, null to clear the field).';
  else parsed = parseFieldInput(raw, known?.type);
  const canSave = !nameError && !!parsed?.ok;
  return { name, known, nameError, parsed, canSave, hint };
}

/**
 * createNewFields for a write: `mode` true → always true; 'new' → true only when `fieldName`
 * isn't in the project's field list (adding a field, as the Profile Editor script did); anything
 * else → undefined (not sent: Iterable's default applies).
 */
export function createNewFieldsFor(mode, fieldName, fields) {
  if (mode === true) return true;
  if (mode === 'new') return findField(fields, String(fieldName ?? '').trim()) ? undefined : true;
  return undefined;
}

/**
 * One guarded profile write: `beforeSave` first (a returned message refuses it: nothing is
 * sent), then POST /api/users/update through updateUser.
 *   ctx          { api } (plus anything beforeSave needs)
 *   who          { email } | { userId } (pickIdentity)
 *   field/value  the dotted field path and its (already parsed) value
 * → Iterable's response. Throws IterableError INVALID with the beforeSave message, or whatever
 * updateUser throws.
 */
export async function writeField(ctx, {
  projectKey, who, field, value, mergeNestedObjects = true, createNewFields, fields = [], beforeSave, signal,
}) {
  identityOf(who || {});
  const dataFields = dataFieldsFor(field, value);
  if (beforeSave) {
    let refusal;
    try {
      refusal = await beforeSave({ field, value, dataFields });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      refusal = err?.message || 'The update was refused before sending.';
    }
    if (refusal) throw new IterableError(String(refusal), { code: 'INVALID' });
  }
  return updateUser(ctx, {
    projectKey, ...who, dataFields, mergeNestedObjects,
    createNewFields: createNewFieldsFor(createNewFields, field, fields),
    signal,
  });
}

/**
 * The editor's lock: one Save or secondary action at a time. run(fn) → Promise that resolves
 * after fn settles (fn's value, or undefined on error); while it runs `busy` is true. fn's error
 * becomes `result` ({ tone: 'warn' when the outcome is unknown, else 'bad', message }); an
 * AbortError is silent. onChange() after every busy / result change.
 */
export function createActionLock(onChange = () => {}) {
  const lock = {
    busy: false,
    result: null,
    setResult(tone, message) {
      lock.result = message ? { tone: tone || null, message: String(message) } : null;
      onChange();
    },
    async run(fn) {
      if (lock.busy) return undefined;
      lock.busy = true;
      lock.result = null;
      onChange();
      try {
        return await fn();
      } catch (err) {
        if (err?.name !== 'AbortError') {
          lock.result = { tone: err?.outcomeUnknown ? 'warn' : 'bad', message: err?.message || 'The update failed.' };
        }
        return undefined;
      } finally {
        lock.busy = false;
        onChange();
      }
    },
  };
  return lock;
}

/**
 * renderFieldEditor(container, props) → { el, destroy, focus, busy() }
 * props:
 *   ctx           the feature's ctx (dom, ui, api, log)
 *   identity      { email?, userId? } of the profile being edited; userId is used when both are given
 *   projectKey    the project to write to (pin it: ctx.project.current().key at open time)
 *   fields        getUserFields() result, for suggestions and type checks ([] is fine)
 *   initialField  preselected field name (editing an existing field)
 *   currentValue  that field's current value (shown, and used as the starting text)
 *   mergeNested   initial state of the merge toggle (default true, "safer")
 *   createNewFields  true: send createNewFields: true on every write; 'new': only when the field
 *                 isn't in `fields` (adding a field); omitted: not sent (Iterable's default)
 *   beforeSave    async ({ field, value, dataFields }) => null | message. Runs right before every
 *                 write (Save and secondary actions' api.write); a message is shown and nothing
 *                 is sent. Use it to re-check the project (§5.2 pinning rule).
 *   secondaryActions  [{ label, variant?, className?, title?, onClick(api) }] in an "Other
 *                 actions" row ('fe-danger' className: red text). While onClick runs (it may be
 *                 async) the whole editor is locked.
 *                 api: { field (initialField), identity, projectKey,
 *                        write({ field?, value, mergeNestedObjects = true, createNewFields? })
 *                          → response (beforeSave first; throws on refusal / failure),
 *                        setResult(tone, message), close(result) }
 *                 A throw from onClick is shown like a failed save.
 *   onSaved({ field, value, type, response })   after Iterable confirms a Save
 *   onCancel()    Cancel clicked (omit to hide the button)
 *   onClose(result)  what api.close(result) calls (the host closes its dialog)
 * Renders into `container` (typically inside a shadow root). Save is disabled until the name and
 * value are valid for the field's known type (or auto-detected for a new field).
 */
export function renderFieldEditor(container, props) {
  const {
    ctx, identity, projectKey, fields = [], initialField = '', currentValue, mergeNested = true,
    createNewFields, beforeSave, secondaryActions = [], onSaved, onCancel, onClose,
  } = props;
  const { h } = ctx.dom;
  const { ui } = ctx;
  const id = ++seq;
  const who = pickIdentity(identity);
  const initial = String(initialField).trim();

  let merge = !!mergeNested;
  let saving = false;
  const lock = createActionLock(() => update());

  const datalist = h('datalist', { id: `fe-fields-${id}` },
    fields.map((f) => h('option', { value: f.name, label: f.type || '' })));
  const nameInput = ui.input({ value: initialField, mono: true, placeholder: 'e.g. favoriteColor or profile.city', ariaLabel: 'Field name', onInput: () => update() });
  nameInput.id = `fe-name-${id}`;
  nameInput.setAttribute('list', datalist.id);
  const typeBadge = h('span', { class: 'fe-type' });
  const nameStatus = h('div', { class: 'fe-status', 'aria-live': 'polite' });

  const curWrap = h('div', { class: 'wb-field', hidden: true },
    h('div', { class: 'wb-label' }, 'Current value'), h('pre', { class: 'fe-cur' }));
  const valueBox = ui.textarea({
    value: formatForEditing(currentValue), mono: true, rows: currentValue !== null && typeof currentValue === 'object' ? 8 : 3,
    placeholder: '[1, 2, 3]  or  {"key": "val"}  or  "hello"  or  42  or  true', ariaLabel: 'New value', onInput: () => update(),
  });
  valueBox.id = `fe-value-${id}`;
  const detected = h('span', { class: 'fe-detected' });
  const valueStatus = h('div', { class: 'fe-status', 'aria-live': 'polite' });
  const mergeSwitch = ui.switchInput({ checked: merge, label: 'Merge nested objects', onChange: (v) => { merge = v; } });
  const resultBox = h('div', { role: 'status' });

  // Save and the other actions write through the API key: trusted clicks only (ARCHITECTURE §7).
  const saveBtn = ui.button('Save', { variant: 'primary', trusted: true, onClick: () => save() });
  const cancelBtn = onCancel ? ui.button('Cancel', { variant: 'ghost', onClick: () => { if (!lock.busy) onCancel(); } }) : null;

  const api = Object.freeze({
    field: initial,
    identity: who,
    projectKey,
    write: ({ field = initial, value, mergeNestedObjects = true, createNewFields: cnf = createNewFields } = {}) =>
      writeField(ctx, { projectKey, who, field, value, mergeNestedObjects, createNewFields: cnf, fields, beforeSave, signal: ctx.signal }),
    setResult: (tone, message) => lock.setResult(tone, message),
    close: (result) => onClose?.(result),
  });
  const actionBtns = secondaryActions.map((a) => ui.button(a.label, {
    variant: a.variant || 'ghost', size: 'sm', className: a.className, title: a.title, trusted: true,
    onClick: () => lock.run(() => a.onClick(api)),
  }));

  const whoLabel = who ? (who.userId != null ? `userId ${who.userId}` : who.email) : 'no user identified';
  const el = h('div', { class: 'fe' },
    h('style', null, CSS),
    datalist,
    h('div', { class: 'fe-who' }, 'Updating ', h('b', null, whoLabel), projectKey ? ` in ${projectKey}` : ''),
    h('div', { class: 'wb-field' },
      h('label', { class: 'wb-label', for: nameInput.id }, 'Field'),
      h('div', { class: 'fe-row' }, nameInput, typeBadge),
      nameStatus),
    curWrap,
    h('div', { class: 'wb-field' },
      h('div', { class: 'fe-row' }, h('label', { class: 'wb-label', for: valueBox.id, style: 'margin:0' }, 'New value'), detected),
      valueBox,
      valueStatus),
    h('div', { class: 'fe-row' }, mergeSwitch, h('span', { class: 'wb-help', style: 'margin:0' }, 'Merge nested objects (safer): keeps sibling keys of an object field.')),
    actionBtns.length ? h('div', { class: 'fe-more' }, h('span', { class: 'lbl' }, 'Other actions'), actionBtns) : null,
    resultBox,
    h('div', { class: 'fe-actions' }, cancelBtn, saveBtn));
  nameInput.style.flex = '1';
  nameInput.style.minWidth = '0';
  container.append(el);

  function setStatus(node, tone, text) {
    node.className = 'fe-status' + (tone ? ' ' + tone : '');
    node.textContent = text || '';
  }

  function update() {
    const busy = lock.busy;
    const s = evaluateEditor({ fieldName: nameInput.value, text: valueBox.value, fields });
    typeBadge.replaceChildren(s.name
      ? (s.known ? ui.chip(s.known.type ? `type: ${s.known.type}` : 'known field', { tone: 'accent' }) : ui.chip('new field', { tone: 'warn' }))
      : '');
    if (s.nameError && s.name) setStatus(nameStatus, 'bad', s.nameError);
    else if (s.name && !s.known) setStatus(nameStatus, 'warn', 'Not in this project’s field list: saving creates it, typed from the value.');
    else setStatus(nameStatus, '', '');

    const showCur = currentValue !== undefined && s.name === initial;
    curWrap.hidden = !showCur;
    if (showCur) curWrap.querySelector('pre').textContent = formatForEditing(currentValue);

    detected.replaceChildren(s.parsed?.ok ? ui.chip(describeType(s.parsed) === 'null' ? 'null (clears the field)' : describeType(s.parsed)) : '');
    if (s.parsed && !s.parsed.ok) setStatus(valueStatus, 'bad', s.parsed.error);
    else if (s.hint) setStatus(valueStatus, '', s.hint);
    else setStatus(valueStatus, '', '');

    const r = lock.result;
    resultBox.replaceChildren(r ? h('div', { class: ['fe-note', r.tone] }, r.message) : '');
    saveBtn.disabled = busy || !s.canSave || !who;
    saveBtn.textContent = busy && saving ? 'Saving…' : 'Save';
    nameInput.disabled = busy;
    valueBox.disabled = busy;
    mergeSwitch.input.disabled = busy;
    if (cancelBtn) cancelBtn.disabled = busy;
    for (const b of actionBtns) b.disabled = busy || !who;
    return s;
  }

  function save() {
    const s = update();
    if (lock.busy || !s.canSave || !who) return;
    saving = true;
    let saved = null;
    lock.run(async () => {
      try {
        const response = await writeField(ctx, {
          projectKey, who, field: s.name, value: s.parsed.value, mergeNestedObjects: merge,
          createNewFields, fields, beforeSave, signal: ctx.signal,
        });
        ctx.log.info('field update accepted');
        saved = { field: s.name, value: s.parsed.value, type: s.parsed.type, response };
      } catch (err) {
        if (err?.name !== 'AbortError' && err?.code !== 'INVALID') {
          ctx.log.warn('field update failed', err?.code || '', err?.apiCode || '', err?.status || 0);
        }
        throw err;
      } finally {
        saving = false;
      }
    }).then(() => {
      if (!saved) return;
      lock.setResult('ok', `Saved ${saved.field}. Iterable applies updates asynchronously; reload the profile in a moment to see it.`);
      onSaved?.(saved);
    });
  }

  update();
  return {
    el,
    busy: () => lock.busy,
    focus() { (initialField ? valueBox : nameInput).focus(); },
    /** Put `name` in the Field box (as if typed) and move focus to the value. No-op while busy. */
    setField(name) {
      if (lock.busy) return false;
      nameInput.value = String(name ?? '');
      update();
      valueBox.focus();
      return true;
    },
    destroy() { el.remove(); },
  };
}

/**
 * openFieldEditor(props) → Promise<{ field, value, type, response } | null>
 * The editor in a ui.dialog (modal layer). Same props as renderFieldEditor plus `title`, `brand`
 * and `toast` (default true: a "Saved <field>." toast after a save; false leaves it to the
 * caller). Resolves after a confirmed save (the dialog closes), with what a secondary action
 * passed to api.close(result), or null when dismissed (×, Cancel, Escape, scrim click). It can't
 * be dismissed while a save or action runs; an unmount (ctx.signal) closes it.
 */
export function openFieldEditor(props) {
  const { ctx, title = 'Edit profile field', brand = ctx.meta?.name, toast = true } = props;
  const { h } = ctx.dom;
  const { ui } = ctx;
  return new Promise((resolve) => {
    if (ctx.signal?.aborted) { resolve(null); return; }
    let editor = null;
    let outcome = null;
    const body = h('div');
    const d = ui.dialog({ title, source: brand, body, canDismiss: () => !editor?.busy() });
    const onAbort = () => d.close(null);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    d.closed.then(() => {
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    });
    editor = renderFieldEditor(body, {
      ...props,
      onCancel: () => d.close(null),
      onClose: (result) => { outcome = result ?? null; d.close(null); },
      onSaved: (res) => {
        if (toast) ui.toast(`Saved ${res.field}.`, { tone: 'ok', source: brand || 'Loophole' });
        props.onSaved?.(res);
        outcome = res;
        d.close(null);
      },
    });
    editor.focus();
  });
}
