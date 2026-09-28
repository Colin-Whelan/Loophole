// UI components: each returns plain DOM elements styled by theme.css.
// Works both inside shadow roots (content scripts) and on extension pages (popup, options).

import { h, clear } from '../core/dom.js';
import { mountOverlay, layerOf } from './shadow.js';
import {
  formatShortcut, shortcutError, shortcutFromEvent, shortcutParts, normalizeShortcut, isMac,
} from '../core/shortcut.js';

const isExtensionPage = () => /^(chrome|moz)-extension:$/.test(location.protocol);

// ── Icons ────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  ],
  open: ['M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  close: ['M6 6l12 12M18 6L6 18'],
  reload: ['M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'],
};

export function icon(name) {
  const paths = ICON_PATHS[name] || ICON_PATHS.open;
  return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    paths.map((d) => h('path', {
      d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })));
}

/** The Workbench diamond mark. */
export function mark({ large = false } = {}) {
  return h('svg', { class: large ? 'mark lg' : 'mark', viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    h('rect', { x: '1', y: '1', width: '30', height: '30', rx: '7', fill: '#0d8a7e' }),
    h('path', { d: 'M16 6 L26 16 L16 26 L6 16 Z', fill: 'none', stroke: '#fff', 'stroke-width': '2.4', 'stroke-linejoin': 'round' }),
    h('path', { d: 'M16 11.5 L20.5 16 L16 20.5 L11.5 16 Z', fill: '#fff' }));
}

// ── Buttons ──────────────────────────────────────────────────────────────

/** variant: 'primary' | 'ghost' | 'danger' | undefined; size: 'sm' | undefined. */
export function button(label, { variant, size, onClick, disabled, title, type = 'button', className } = {}) {
  return h('button', {
    type, class: ['wb-btn', variant, size, className], disabled: !!disabled, title, onClick,
  }, label);
}

/** Teal-outlined button with the diamond, for placement inside Iterable's own toolbars. */
export function injectedButton(label, opts = {}) {
  return button(label, { ...opts, className: ['wb-inj', opts.className].filter(Boolean).join(' ') });
}

export function iconButton(name, { label, onClick, title } = {}) {
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: title || label, onClick }, icon(name));
}

// ── Form controls ────────────────────────────────────────────────────────

/** A toggle switch. Returns the <label>; the checkbox is `.input`. onChange(checked). */
export function switchInput({ checked = false, label, onChange, disabled, id } = {}) {
  const input = h('input', {
    type: 'checkbox', checked: !!checked, 'aria-label': label, disabled: !!disabled, id,
    onChange: (e) => onChange?.(e.target.checked),
  });
  const el = h('label', { class: 'wb-switch' }, input, h('span'));
  el.input = input;
  return el;
}

export function input({ value = '', mono, placeholder, type = 'text', onInput, onChange, id, ariaLabel, autocomplete = 'off', min, max, step } = {}) {
  return h('input', {
    class: ['wb-input', mono && 'mono'], type, value: value ?? '', placeholder, id, 'aria-label': ariaLabel,
    autocomplete, spellcheck: 'false', min, max, step,
    onInput: onInput && ((e) => onInput(e.target.value)),
    onChange: onChange && ((e) => onChange(e.target.value)),
  });
}

export function textarea({ value = '', mono, rows = 4, placeholder, onInput, id, ariaLabel } = {}) {
  return h('textarea', {
    class: ['wb-textarea', mono && 'mono'], rows, placeholder, id, 'aria-label': ariaLabel, spellcheck: 'false',
    value: value ?? '', onInput: onInput && ((e) => onInput(e.target.value)),
  });
}

/** options: [{ value, label }]. onChange(value). */
export function select({ options = [], value, onChange, id, ariaLabel } = {}) {
  const el = h('select', { class: 'wb-select', id, 'aria-label': ariaLabel, onChange: (e) => onChange?.(e.target.value) },
    options.map((o) => h('option', { value: o.value }, o.label ?? o.value)));
  if (value !== undefined) el.value = value;
  return el;
}

let fieldSeq = 0;
/** Label + control + optional help. Wires label[for] to the control when it has (or gets) an id. */
export function field({ label, help, control }) {
  const target = control.matches?.('input, select, textarea') ? control : control.querySelector?.('input, select, textarea');
  if (target && !target.id) target.id = 'wb-f' + (++fieldSeq);
  return h('div', { class: 'wb-field' },
    label && h('label', { class: 'wb-label', for: target?.id }, label),
    control,
    help && h('div', { class: 'wb-help' }, help));
}

/** Segmented buttons. options: [{ value, label }]. onChange(value). */
export function segmented({ options, value, onChange, ariaLabel }) {
  const el = h('div', { class: 'segbtns', role: 'group', 'aria-label': ariaLabel });
  const render = (v) => {
    for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === v));
  };
  for (const o of options) {
    el.append(h('button', {
      type: 'button', dataset: { value: o.value },
      onClick: () => { render(o.value); onChange?.(o.value); },
    }, o.label));
  }
  render(value);
  return el;
}

// ── Display ──────────────────────────────────────────────────────────────

/** tone: 'ok' | 'warn' | 'bad' | 'accent' | undefined. */
export function chip(text, { tone, dot = false } = {}) {
  return h('span', { class: ['wb-chip', tone] }, dot && h('span', { class: 'dot' }), text);
}

/** Panel with the standard header strip. Returns the panel; its body is `.body`. */
export function panel({ title, brand, onClose, body, className } = {}) {
  const b = h('div', { class: 'wb-pb' }, body);
  const el = h('div', { class: ['wb-panel', className] },
    h('div', { class: 'wb-ph' },
      h('span', { class: 't' }, title),
      brand && h('span', { class: 'brand' }, brand),
      onClose && h('button', { type: 'button', class: 'wb-x', 'aria-label': 'Close', onClick: onClose }, '×')),
    b);
  el.body = b;
  return el;
}

/**
 * tabs: [{ id, label }]. onSelect(id). Returns the tab strip; `.select(id)` switches.
 * flush (default true): the strip bleeds to the edges of the panel body it opens (negative
 * margins matching `.wb-pb` padding). false: an inset strip for anywhere else (inside a dialog's
 * content, a card, a flex column): no negative margins, no background band.
 */
export function tabs({ tabs: items, selected, onSelect, flush = true }) {
  const el = h('div', { class: ['wb-tabs', !flush && 'inset'], role: 'tablist' });
  const sel = (id) => {
    for (const b of el.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
  };
  for (const t of items) {
    el.append(h('button', { type: 'button', role: 'tab', dataset: { id: t.id }, onClick: () => { sel(t.id); onSelect?.(t.id); } }, t.label));
  }
  sel(selected ?? items[0]?.id);
  el.select = sel;
  return el;
}

/** Definition list. pairs: [[term, value], …] or an object. */
export function kv(pairs) {
  const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  return h('dl', { class: 'kv' }, entries.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

// ── Feedback ─────────────────────────────────────────────────────────────

let toastBox = null;
function getToastBox() {
  if (toastBox?.isConnected) return toastBox;
  if (isExtensionPage()) {
    toastBox = h('div', { class: 'wb-toasts', 'aria-live': 'polite' });
    document.body.append(toastBox);
  } else {
    const m = mountOverlay('toast');
    toastBox = h('div', { class: 'wb-toasts', 'aria-live': 'polite' });
    m.el.append(toastBox);
  }
  syncToastLift();
  return toastBox;
}

// ── Floating bars (bottom-right dock) ────────────────────────────────────
// Every floating bar goes into one shared dock at the bottom-right corner (float layer), stacked
// upwards. The toast stack sits at the same corner, so it is lifted by the dock's height
// (`--wb-toast-lift` on .wb-toasts): toasts and bars never overlap, whatever each feature does.

let dock = null;   // { m, box, ro }

function syncToastLift() {
  if (!toastBox) return;
  const hgt = dock?.box.isConnected ? Math.ceil(dock.box.getBoundingClientRect().height) : 0;
  toastBox.style.setProperty('--wb-toast-lift', hgt ? `${hgt + 8}px` : '0px');
}

function getDock() {
  if (dock?.m.host.isConnected) return dock;
  dock?.ro?.disconnect();
  const m = mountOverlay('float');
  const box = h('div', { class: 'wb-dock' });
  m.el.append(box);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(syncToastLift) : null;
  ro?.observe(box);
  dock = { m, box, ro };
  return dock;
}

/**
 * A floating toolbar in the shared bottom-right dock (content scripts only). Starts hidden.
 * Options: label (aria-label), className, signal (removes the bar on abort).
 * → { el, show(visible = true), destroy() }. Put the bar's buttons in `el`.
 */
export function floatingBar({ label = 'Workbench', className = '', signal } = {}) {
  const d = getDock();
  const el = h('div', { class: ['wb-fbar', className], role: 'toolbar', 'aria-label': label, hidden: true });
  d.box.append(el);
  let gone = false;
  const destroy = () => {
    if (gone) return;
    gone = true;
    el.remove();
    if (dock === d && !d.box.children.length) {
      d.ro?.disconnect();
      d.m.destroy();
      dock = null;
    }
    syncToastLift();
  };
  if (signal?.aborted) destroy();
  else signal?.addEventListener('abort', destroy, { once: true });
  return {
    el,
    show(visible = true) {
      if (gone || el.hidden === !visible) return;
      el.hidden = !visible;
      syncToastLift();
    },
    destroy,
  };
}

/** tone: 'ok' | 'warn' | 'bad' | undefined. source: feature name shown above the message. */
export function toast(message, { tone, source = 'Workbench', timeoutMs = 4000 } = {}) {
  const box = getToastBox();
  const el = h('div', { class: ['wb-toast', tone], role: tone === 'bad' ? 'alert' : 'status' },
    h('div', null, h('span', { class: 'src' }, source), h('span', { class: 'm' }, message)));
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  if (timeoutMs > 0) setTimeout(() => el.remove(), timeoutMs);
  return el;
}

const dialogStack = [];

/**
 * True when a keydown comes from a popup-owning control (role="combobox" or aria-haspopup) whose
 * popup is open (aria-expanded="true"). A plain disclosure button doesn't count.
 */
export function popupOpenAt(e) {
  const origin = (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
  if (!origin?.getAttribute || origin.getAttribute('aria-expanded') !== 'true') return false;
  return origin.getAttribute('role') === 'combobox' || origin.hasAttribute('aria-haspopup');
}

/**
 * Dialog on the modal layer (a scrim + panel). Returns a handle right away:
 *   { el, body, close(result), closed: Promise<result> }
 *   el      the dialog panel; body its scrolling `.wb-pb` (append more content any time)
 *   closed  resolves with the clicked action's id, the value passed to close(), or null when
 *           dismissed (close button, Escape, scrim click when `dismissible`)
 * Options:
 *   title, source (feature name in the mono brand slot; `brand` is an alias)
 *   size     'md' (480px, default) | 'lg' (~860px) | 'xl' (80vw × 80vh; the body fills it)
 *   body     node(s) or string
 *   actions  [{ id, label, variant, onClick? }] right-aligned in the footer; omit for none.
 *            onClick(handle) may return (or resolve) false to keep the dialog open.
 *   dismissible  default true; false ignores scrim clicks (Escape and × still close)
 *   canDismiss   optional () => boolean, asked before ×, Escape or a scrim click closes the
 *            dialog; false keeps it open (e.g. while a save is in flight). close() always works.
 *   css      feature CSS (string or array of strings) for this dialog's content. In Iterable it
 *            goes into the dialog's own shadow root (each dialog is a separate overlay mount, so
 *            a sub-dialog passes it again); on extension pages it rides inside the dialog and
 *            leaves with it, so prefix your selectors.
 * Only the top-most dialog reacts to Escape, and not while focus is in a combobox (or
 * aria-haspopup control) whose list is open: that Escape closes the list first.
 * Focus returns to where it was on close.
 */
export function dialog({
  title, source, brand, size = 'md', body, actions = [], dismissible = true, css, canDismiss,
} = {}) {
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const prevFocus = document.activeElement;
  let overlay = null;
  let done = false;
  const handle = { closed };
  const close = (result = null) => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    const i = dialogStack.indexOf(handle);
    if (i >= 0) dialogStack.splice(i, 1);
    if (overlay) overlay.destroy(); else scrim.remove();
    try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ }
    resolveClosed(result);
  };
  const dismiss = () => {
    if (canDismiss && !canDismiss()) return;
    close(null);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || dialogStack[dialogStack.length - 1] !== handle) return;
    if (popupOpenAt(e)) return;   // the control closes its own list; the next Escape closes us
    e.stopPropagation();
    e.preventDefault();
    dismiss();
  };
  const buttons = actions.map((a) => button(a.label, {
    variant: a.variant,
    onClick: async () => {
      if (a.onClick) {
        const keep = await a.onClick(handle);
        if (keep === false) return;
      }
      close(a.id);
    },
  }));
  const pb = h('div', { class: 'wb-pb' }, body);
  const label = source || brand;
  const el = h('div', { class: ['wb-panel', 'wb-modal', size !== 'md' && size], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'wb-ph' },
      h('span', { class: 't' }, title),
      label && h('span', { class: 'brand' }, label),
      h('button', { type: 'button', class: 'wb-x', 'aria-label': 'Close', onClick: () => dismiss() }, '×')),
    pb,
    buttons.length ? h('div', { class: 'foot' }, buttons) : null);
  const cssText = [].concat(css ?? []).filter((c) => typeof c === 'string' && c).join('\n');
  const scrim = h('div', { class: 'wb-scrim', onClick: (e) => { if (dismissible && e.target === scrim) dismiss(); } },
    cssText ? h('style', null, cssText) : null, el);
  if (isExtensionPage()) {
    document.body.append(scrim);
  } else {
    overlay = mountOverlay('modal');
    overlay.el.append(scrim);
  }
  Object.assign(handle, { el, body: pb, close });
  dialogStack.push(handle);
  document.addEventListener('keydown', onKey, true);
  (buttons[buttons.length - 1] || el.querySelector('.wb-x')).focus();
  return handle;
}

/**
 * Modal dialog. Resolves with the id of the action clicked, or null when dismissed
 * (close button, scrim click, Escape).
 * actions: [{ id, label, variant }] (rendered right-aligned in order). Also takes `size` and
 * `source` like dialog().
 */
export function modal({ title, brand, source, size, body, actions = [{ id: 'ok', label: 'OK', variant: 'primary' }] } = {}) {
  return dialog({ title, brand, source, size, body, actions }).closed;
}

/**
 * Confirm dialog → Promise<boolean>. `message` (plain text) or `body` (nodes).
 * danger: the confirm button uses the danger style.
 */
export async function confirmDialog({
  title, message, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, brand, source,
}) {
  const content = body ?? (message != null ? h('p', { style: 'margin:0; font-size:13px; line-height:1.5' }, message) : null);
  const r = await modal({
    title, brand, source, body: content,
    actions: [{ id: 'cancel', label: cancelLabel, variant: 'ghost' }, { id: 'ok', label: confirmLabel, variant: danger ? 'danger' : 'primary' }],
  });
  return r === 'ok';
}

/**
 * Arm-then-fire: the first click arms `btn` for `seconds` (label counts down), a second click
 * within that window calls onConfirm. Returns a function that disarms and detaches.
 */
export function armButton(btn, { seconds = 4, armedLabel = 'Click again to confirm', onConfirm } = {}) {
  const idle = btn.textContent;
  let timer = null, left = 0;
  const disarm = () => {
    clearInterval(timer); timer = null;
    btn.classList.remove('armed');
    btn.textContent = idle;
  };
  const onClick = (e) => {
    e.preventDefault();
    if (!timer) {
      left = seconds;
      btn.classList.add('armed');
      btn.textContent = `${armedLabel} (${left})`;
      timer = setInterval(() => {
        left--;
        if (left <= 0) disarm();
        else btn.textContent = `${armedLabel} (${left})`;
      }, 1000);
      return;
    }
    disarm();
    onConfirm?.();
  };
  btn.addEventListener('click', onClick);
  return () => { disarm(); btn.removeEventListener('click', onClick); };
}

// ── Clipboard ────────────────────────────────────────────────────────────

/**
 * Copy `text` to the clipboard → Promise<boolean> (true when it worked). Tries
 * navigator.clipboard, then a hidden-textarea execCommand('copy') fallback (pages whose
 * permissions policy blocks the async API, or no focus). Call it from a user gesture.
 */
export async function copyText(text) {
  const str = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch { /* fall back */ }
  const prevFocus = document.activeElement;
  const ta = h('textarea', {
    readonly: true, 'aria-hidden': 'true',
    style: 'position:fixed; top:0; left:-9999px; width:1px; height:1px; opacity:0',
  });
  ta.value = str;
  (document.body || document.documentElement).append(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, str.length);
    ok = document.execCommand('copy');
  } catch { ok = false; }
  ta.remove();
  try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ }
  return ok;
}

/**
 * Briefly swap a button's label ("Copied") and add the `flash` class, then restore it.
 * tone 'bad' shows the failure style. Safe to call again while a flash is showing.
 */
export function flash(btn, { label = 'Copied', ms = 1200, tone } = {}) {
  if (!btn) return;
  if (!btn._wbFlash) btn._wbFlash = { label: btn.textContent, timer: null };
  const st = btn._wbFlash;
  clearTimeout(st.timer);
  btn.textContent = label;
  btn.classList.add('flash');
  btn.classList.toggle('flash-bad', tone === 'bad');
  st.timer = setTimeout(() => {
    btn.textContent = st.label;
    btn.classList.remove('flash', 'flash-bad');
    btn._wbFlash = null;
  }, ms);
}

/**
 * flash() for anything that isn't a button (a card, a tile, a row): a temporary outline plus a
 * small label badge in its top-right corner ("Copied"), then back to normal. tone: 'ok'
 * (default) | 'bad'. label '' shows the outline only. The element's own content is untouched; a
 * statically positioned element is made `position: relative` while the badge shows. Safe to call
 * again while a flash is showing (restarts it).
 */
export function flashElement(el, { label = 'Copied', tone = 'ok', ms = 1200 } = {}) {
  if (!el) return;
  const prev = el._wbFlashEl;
  if (prev) { clearTimeout(prev.timer); prev.badge?.remove(); }
  const st = { timer: null, badge: null, pos: prev ? prev.pos : null };
  el._wbFlashEl = st;
  if (st.pos === null && getComputedStyle(el).position === 'static') {
    st.pos = el.style.position;
    el.style.position = 'relative';
  }
  el.classList.add('wb-flashed');
  el.classList.toggle('wb-flashed-bad', tone === 'bad');
  if (label) {
    st.badge = h('span', { class: ['wb-flash-badge', tone === 'bad' && 'bad'], 'aria-hidden': 'true' }, label);
    el.append(st.badge);
  }
  st.timer = setTimeout(() => {
    el.classList.remove('wb-flashed', 'wb-flashed-bad');
    st.badge?.remove();
    if (st.pos !== null) el.style.position = st.pos;
    el._wbFlashEl = null;
  }, ms);
}

/**
 * Button that copies `text` (a string, or a function returning one) and flashes "Copied" /
 * "Copy failed". Options: label ('Copy'), variant, size ('sm'), title.
 */
export function copyButton(text, { label = 'Copy', variant, size = 'sm', title } = {}) {
  const btn = button(label, {
    variant, size, title,
    onClick: async () => {
      const ok = await copyText(typeof text === 'function' ? text() : text);
      flash(btn, ok ? { label: 'Copied' } : { label: 'Copy failed', tone: 'bad' });
    },
  });
  return btn;
}

// ── Code block ───────────────────────────────────────────────────────────

/**
 * Monospace, scrollable code/text block with a copy button.
 * Options: code, maxHeight (px number or CSS length, default 320; 'none' to grow), wrap
 * (soft-wrap long lines, default false), copy (default true), label (caption in the bar).
 * Returns the element; `.setCode(text)` replaces the content, `.pre` is the <pre>.
 */
export function codeBlock({ code = '', maxHeight = 320, wrap = false, copy = true, label } = {}) {
  const codeEl = h('code', null, String(code ?? ''));
  const pre = h('pre', {
    class: ['wb-code-pre', wrap && 'wrap'], tabindex: '0',
    style: { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight },
  }, codeEl);
  const el = h('div', { class: 'wb-code' },
    (copy || label) && h('div', { class: 'wb-code-bar' },
      h('span', { class: 'lbl' }, label || ''),
      copy && copyButton(() => codeEl.textContent, { variant: 'ghost' })),
    pre);
  el.pre = pre;
  el.setCode = (text) => { codeEl.textContent = String(text ?? ''); };
  return el;
}

// ── Combobox ─────────────────────────────────────────────────────────────

let comboSeq = 0;

const normItem = (it) => (typeof it === 'string' ? { value: it, label: it } : { ...it, label: it.label ?? String(it.value) });

/** Filter static items: case-insensitive substring on label/value, prefix matches first. */
export function filterItems(items, query, max = Infinity) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = items.map(normItem);
  if (!q) return all.slice(0, max);
  const starts = [];
  const contains = [];
  for (const it of all) {
    const l = it.label.toLowerCase();
    const v = String(it.value).toLowerCase();
    if (l.startsWith(q) || v.startsWith(q)) starts.push(it);
    else if (l.includes(q) || v.includes(q)) contains.push(it);
  }
  return starts.concat(contains).slice(0, max);
}

/**
 * Text input with a filtered suggestion list (field-name pickers and the like).
 * Options:
 *   source      string[] | [{ value, label?, hint? }] (filtered here), or
 *               async (query, { signal }) => items (filters itself; debounced, stale requests
 *               aborted and ignored)
 *   value, placeholder, ariaLabel, mono, id
 *   maxResults  default 50
 *   minChars    characters typed before suggestions show (default 0: on focus)
 *   emptyText   default 'No matches' (null: hide the list instead)
 *   debounceMs  async sources only, default 150
 *   onSelect(item)  a suggestion was picked (Enter or click); the input already holds item.value
 *   onInput(text)   every keystroke
 * Keyboard: ↓/↑ move, Enter picks, Escape closes the list (without closing a surrounding
 * dialog). Free text is allowed: read `.value`.
 * Returns the wrapper; `.input` is the <input>, `.value` gets/sets the text, `.close()`.
 * The list is position:fixed, so a panel's overflow:hidden doesn't clip it; in an inline mount
 * inside Iterable (the navbar strip) it renders on the float overlay layer instead.
 */
export function combobox({
  source = [], value = '', placeholder, ariaLabel, mono = false, id, maxResults = 50, minChars = 0,
  emptyText = 'No matches', debounceMs = 150, onSelect, onInput,
} = {}) {
  const listId = `wb-cb${++comboSeq}`;
  const inputEl = h('input', {
    class: ['wb-input', mono && 'mono'], type: 'text', value, placeholder, id, 'aria-label': ariaLabel,
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', 'aria-controls': listId,
  });
  const list = h('ul', { class: 'wb-combo-list', role: 'listbox', id: listId, hidden: true });
  const el = h('div', { class: 'wb-combo' }, inputEl);
  let portal = null; // float overlay, when the combobox sits in an inline mount in the page
  let items = [];
  let active = -1;
  let open = false;
  let reqSeq = 0;
  let ctrl = null;
  let timer = null;

  const place = () => {
    if (!open) return;
    const r = inputEl.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    const want = Math.min(list.scrollHeight || 240, 260);
    const up = below < want + 8 && r.top > below;
    Object.assign(list.style, {
      left: `${Math.max(4, r.left)}px`, width: `${r.width}px`,
      top: up ? '' : `${r.bottom + 4}px`, bottom: up ? `${innerHeight - r.top + 4}px` : '',
    });
  };
  const onScroll = () => place();

  const mountList = () => {
    if (list.isConnected) return;
    if (!isExtensionPage() && !layerOf(el)) {
      portal = mountOverlay('float');
      portal.el.append(list);
    } else {
      el.append(list);
    }
  };

  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0 && list.children[i]) {
      inputEl.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView?.({ block: 'nearest' });
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  };

  const show = () => {
    mountList();
    if (!open) {
      open = true;
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
    }
    list.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
    place();
  };

  const close = () => {
    clearTimeout(timer);
    ctrl?.abort();
    reqSeq++;
    if (!open) return;
    open = false;
    list.hidden = true;
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    if (portal) { portal.destroy(); portal = null; }
  };

  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    inputEl.value = String(it.value);
    close();
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    onSelect?.(it);
  };

  const render = (state) => {
    clear(list);
    if (state === 'loading') {
      list.append(h('li', { class: 'wb-combo-note', role: 'presentation' }, 'Loading…'));
    } else if (state === 'error') {
      list.append(h('li', { class: 'wb-combo-note', role: 'presentation' }, 'Couldn’t load suggestions.'));
    } else if (!items.length) {
      if (emptyText == null) { close(); return; }
      list.append(h('li', { class: 'wb-combo-note', role: 'presentation' }, emptyText));
    } else {
      items.forEach((it, i) => {
        list.append(h('li', {
          role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false',
          onMousedown: (e) => e.preventDefault(), // keep focus in the input
          onClick: () => pick(i),
          onMousemove: () => { if (active !== i) setActive(i); },
        }, h('span', { class: ['v', mono && 'mono'] }, it.label), it.hint ? h('span', { class: 'hint' }, it.hint) : null));
      });
    }
    active = -1;
    show();
  };

  const refresh = () => {
    const q = inputEl.value;
    if (q.trim().length < minChars) { close(); return; }
    if (typeof source !== 'function') {
      items = filterItems(source, q, maxResults);
      render('items');
      return;
    }
    clearTimeout(timer);
    ctrl?.abort();
    const seq = ++reqSeq;
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      const { signal } = ctrl;
      if (!open) render('loading');
      try {
        const res = await source(q, { signal });
        if (seq !== reqSeq || signal.aborted) return;
        items = (Array.isArray(res) ? res : []).map(normItem).slice(0, maxResults);
        render('items');
      } catch {
        if (seq !== reqSeq || signal.aborted) return;
        items = [];
        render('error');
      }
    }, debounceMs);
  };

  inputEl.addEventListener('input', () => { onInput?.(inputEl.value); refresh(); });
  inputEl.addEventListener('focus', () => { if (minChars === 0) refresh(); });
  inputEl.addEventListener('blur', () => close());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { refresh(); return; }
      const n = items.length;
      if (!n) return;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    } else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  });

  el.input = inputEl;
  el.close = close;
  Object.defineProperty(el, 'value', { get: () => inputEl.value, set: (v) => { inputEl.value = v ?? ''; } });
  return el;
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────

/** Key caps for a shortcut string: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> (Mac: ⌘ ⇧ L). */
export function kbd(combo, { mac = isMac() } = {}) {
  const parts = shortcutParts(combo, { mac });
  const el = h('span', { class: 'wb-keys', role: 'img', 'aria-label': formatShortcut(combo, { mac }) || 'No shortcut' });
  parts.forEach((p, i) => {
    if (i && !mac) el.append(h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'));
    el.append(h('kbd', { class: 'wb-kbd', 'aria-hidden': 'true' }, p));
  });
  return el;
}

/**
 * Shortcut recorder: focus it and press a key combination. Stores the canonical form
 * ('Mod+Shift+L'; Mod = Ctrl, or ⌘ on Mac) and shows the platform form (Ctrl+Shift+L / ⌘⇧L).
 * Backspace/Delete clears, Escape cancels, Tab moves on. A bare key (or Shift+key) is refused
 * with a message. Options: value, onChange(canonical), ariaLabel, placeholder, id.
 * Returns the wrapper; `.value` gets/sets the canonical string, `.input` is the text box.
 */
export function shortcutInput({ value = '', onChange, ariaLabel = 'Shortcut', placeholder = 'Click, then press keys', id } = {}) {
  const mac = isMac();
  let current = normalizeShortcut(value) ?? '';
  const inputEl = h('input', {
    class: 'wb-input mono', type: 'text', readonly: true, id, 'aria-label': ariaLabel, placeholder,
    autocomplete: 'off', spellcheck: 'false',
  });
  const msg = h('div', { class: 'wb-help wb-shortcut-msg', hidden: true, 'aria-live': 'polite' });
  const clearBtn = h('button', {
    type: 'button', class: 'wb-x', 'aria-label': 'Clear shortcut', title: 'Clear',
    onClick: () => { set(''); inputEl.focus(); },
  }, '×');
  const el = h('div', { class: 'wb-shortcut' }, h('div', { class: 'wb-shortcut-row' }, inputEl, clearBtn), msg);

  const show = () => {
    inputEl.value = formatShortcut(current, { mac });
    clearBtn.hidden = !current;
  };
  const note = (text, bad = false) => {
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.classList.toggle('bad', bad);
  };
  const set = (v, fire = true) => {
    const next = normalizeShortcut(v) ?? '';
    const changed = next !== current;
    current = next;
    show();
    if (fire && changed) onChange?.(current);
  };

  inputEl.addEventListener('focus', () => note('Press a key combination. Esc cancels, Backspace clears.'));
  inputEl.addEventListener('blur', () => { show(); note(''); });
  inputEl.addEventListener('keydown', (e) => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return; // keep keyboard navigation
    e.preventDefault();
    e.stopPropagation();
    if (plain && e.key === 'Escape') { inputEl.blur(); return; }
    if (plain && (e.key === 'Backspace' || e.key === 'Delete')) { set(''); note('Cleared.'); return; }
    const combo = shortcutFromEvent(e, { mac });
    if (!combo) {
      // Only modifiers so far: preview what's held.
      const held = [e.ctrlKey && (mac ? '⌃' : 'Ctrl'), e.altKey && (mac ? '⌥' : 'Alt'),
        e.shiftKey && (mac ? '⇧' : 'Shift'), e.metaKey && (mac ? '⌘' : 'Win')].filter(Boolean);
      inputEl.value = mac ? `${held.join('')}…` : `${held.join('+')}+…`;
      return;
    }
    const err = shortcutError(combo, { mac });
    if (err) { show(); note(err, true); return; }
    set(combo);
    note(`Set to ${formatShortcut(combo, { mac })}.`);
  });
  inputEl.addEventListener('keyup', () => { if (inputEl.value.endsWith('…')) show(); });

  show();
  el.input = inputEl;
  Object.defineProperty(el, 'value', { get: () => current, set: (v) => set(v, false) });
  return el;
}

// ── Navbar strip (ui/navslot.js), re-exported so features get it through ctx.ui ──

export { navSlot, anchorFloat, NAVBAR } from './navslot.js';

export { clear };
