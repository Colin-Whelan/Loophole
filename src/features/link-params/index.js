// Link parameters: a "Link params" picker next to the link field in the BEE (drag-and-drop)
// editor, in three places:
//   1. the Action panel of a button/image (div[data-qa="sidebar-section-action"])
//   2. TinyMCE's text-link dialog (.tox-dialog[id^="tox_dialog_CustomDialogForLink"])
//   3. the "Insert link" modal of live text blocks (BEE's own LinkModal, not TinyMCE)
// Runs with frame:'bee' inside app.getbee.io iframes: no project, no API; only openOptions.

import {
  resolveParamTypes, addOrReplaceParam, getParam, addRecent, normalizeRecents, normalizeColor,
  paramUnsupportedReason, MAX_TERM_LENGTH,
} from './library.js';

const SEL = {
  actionPanel: 'div[data-qa="sidebar-section-action"]',
  // The script's container; the hashed class may change between BEE builds, so fall back.
  buttonContainers: [
    '.href-container.BeeLink_hrefContainer__Nfygl',
    '.href-container[class*="BeeLink_hrefContainer"]',
    '[class*="BeeLink_hrefContainer"]',
  ],
  urlInput: '.href-container--cs input[type="text"]',
  textLinkDialog: '.tox-dialog[id^="tox_dialog_CustomDialogForLink"]',
  // Hashed CSS-module classes (LinkModal_wrapper__RO4bS …): match on the stable prefix.
  linkModal: '[class*="LinkModal_wrapper"]',
  linkModalUrl: '[class*="LinkFormTab_linkUrl"]',
};

const MARK_ATTR = 'data-wb-link-params';
const PANEL_WIDTH = 340;
const RECENTS_KEY = 'recents';
// Typing in the picker must not reach BEE's own editor listeners (Backspace / Ctrl+Z shortcuts
// bound on document would otherwise see the keys as coming from the shadow host).
const ISOLATED_EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'copy'];
const UNSUPPORTED_NOTE = {
  mailto: 'This is a mailto: link. Link parameters only apply to web links.',
  tel: 'This is a tel: link. Link parameters only apply to web links.',
  sms: 'This is an sms: link. Link parameters only apply to web links.',
  anchor: 'This is an in-page #anchor link. Link parameters only apply to web links.',
};

const CSS = `
.lp-host-tox{display:block; margin-top:6px}
.lp-float{position:fixed; width:${PANEL_WIDTH}px; display:flex; flex-direction:column; font-family:var(--wb-font); color:var(--wb-ink)}
.lp-float > .wb-pb{display:flex; flex-direction:column; min-height:0; flex:1; padding-bottom:0}
.lp-float .wb-tabs{flex:none; flex-wrap:wrap}
.lp-scroll{overflow:auto; min-height:0; flex:1; padding-bottom:12px}
.lp-float .bub{--c:var(--wb-line-strong); background:color-mix(in srgb, var(--c) 12%, var(--wb-surface)); border-color:color-mix(in srgb, var(--c) 60%, var(--wb-line-strong)); color:var(--wb-ink)}
.lp-float .bub:hover{background:color-mix(in srgb, var(--c) 26%, var(--wb-surface)); border-color:var(--c)}
.lp-float .bub.on{background:var(--wb-accent); color:var(--wb-on-accent); border-color:var(--wb-accent)}
.lp-float .bub.recent{border-style:dashed}
.lp-float .bub-cat h5 i{border:1px solid rgba(0,0,0,.12)}
.lp-custom{display:flex; gap:6px; margin-top:12px}
.lp-custom .wb-input{flex:1; min-width:0}
.lp-result{margin-top:12px}
.lp-foot{display:flex; justify-content:space-between; align-items:center; gap:8px; margin:0 -12px; padding:8px 12px; border-top:1px solid var(--wb-line); background:var(--wb-raised); flex:none}
.lp-foot .wb-help{margin:0}
.lp-empty{font-size:12px; color:var(--wb-muted); margin:0}
`;

export function mount(ctx) {
  const { ui, dom, signal, log } = ctx;
  const h = dom.h;

  let library = resolveParamTypes(ctx.settings);
  let activeType = Object.keys(library)[0] || null;
  let recents = {};
  const mounts = new Set(); // inline button mounts
  let open = null; // { overlay, anchor, findInput, render, reposition }

  ctx.state.get(RECENTS_KEY, {}).then((r) => { recents = normalizeRecents(r); }).catch(() => {});

  const addStyle = (root) => root.append(h('style', null, CSS));

  // ── Injection ──────────────────────────────────────────────────────────

  function injectInto(container, findInput, { tox = false } = {}) {
    if (container.querySelector(`:scope > wb-host[${MARK_ATTR}]`)) return;
    const m = ui.mountInline(container, 'append', {
      display: tox ? 'block' : 'inline-block',
      className: tox ? 'lp-host-tox' : '',
    });
    m.host.setAttribute(MARK_ATTR, '');
    addStyle(m.root);
    const btn = ui.injectedButton('Link params ▾', { size: 'sm' });
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (open?.anchor === btn) close();
      else openPicker(btn, m.host, findInput);
    });
    m.el.append(btn);
    m.btn = btn;
    mounts.add(m);
    log.debug('button injected', tox ? '(link dialog)' : '(action panel)');
  }

  function checkActionPanel() {
    const panel = document.querySelector(SEL.actionPanel);
    if (!panel) return;
    let container = null;
    for (const s of SEL.buttonContainers) {
      container = panel.querySelector(s);
      if (container) break;
    }
    if (!container) return;
    injectInto(container, () => document.querySelector(SEL.actionPanel)?.querySelector(SEL.urlInput) || null);
  }

  function checkTextLinkDialog() {
    const dialog = document.querySelector(SEL.textLinkDialog);
    if (!dialog) return;
    let urlGroup = null;
    for (const label of dialog.querySelectorAll('.tox-label')) {
      if (label.textContent.trim() === 'Url') {
        urlGroup = label.closest('.tox-form__group');
        break;
      }
    }
    if (!urlGroup) return;
    injectInto(urlGroup, () => urlGroup.querySelector('input.tox-textfield'), { tox: true });
  }

  function checkLinkModal() {
    for (const modal of document.querySelectorAll(SEL.linkModal)) {
      const urlGroup = modal.querySelector(SEL.linkModalUrl);
      if (!urlGroup) continue;
      injectInto(urlGroup, () => urlGroup.querySelector('input[type="text"]'), { tox: true });
    }
  }

  function scan() {
    for (const m of mounts) {
      if (!m.host.isConnected) {
        if (open?.anchor === m.btn) close();
        m.destroy();
        mounts.delete(m);
      }
    }
    checkActionPanel();
    checkTextLinkDialog();
    checkLinkModal();
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!signal.aborted) scan(); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // ── Picker ─────────────────────────────────────────────────────────────

  function openPicker(anchor, anchorHost, findInput) {
    close();
    if (!library[activeType]) activeType = Object.keys(library)[0] || null;
    // Pick up recents another frame may have written since mount.
    ctx.state.get(RECENTS_KEY, {}).then((r) => {
      recents = normalizeRecents(r);
      if (open?.anchor === anchor) open.render();
    }).catch(() => {});

    const overlay = ui.mountOverlay('float');
    addStyle(overlay.root);
    const scroller = h('div', { class: 'lp-scroll' });
    const tabsSlot = h('div', { style: 'display:contents' });
    const result = ui.input({ mono: true, ariaLabel: 'Resulting link' });
    result.readOnly = true;
    const custom = ui.input({ mono: true, placeholder: 'Custom value…', ariaLabel: 'Custom value' });
    custom.maxLength = MAX_TERM_LENGTH;
    const applyBtn = ui.button('Apply', { variant: 'primary', size: 'sm', disabled: true });
    custom.addEventListener('input', () => { applyBtn.disabled = !custom.value.trim(); });
    // Writing into BEE's link field: only on the person's own input (ARCHITECTURE §7 trusted input).
    custom.addEventListener('keydown', dom.trusted((e) => {
      if (e.key === 'Enter' && custom.value.trim()) { e.preventDefault(); apply(custom.value.trim()); }
    }));
    applyBtn.addEventListener('click', dom.trusted(() => { if (custom.value.trim()) apply(custom.value.trim()); }));

    const settingsLink = ui.button('Settings', {
      variant: 'ghost', size: 'sm',
      onClick: () => { ctx.openOptions(); close(); },
    });
    const foot = h('div', { class: 'lp-foot' },
      h('span', { class: 'wb-help' }, 'Edit the library in Loophole settings.'), settingsLink);

    const panel = ui.panel({
      title: 'Add a link parameter',
      brand: 'Link params',
      onClose: () => close(),
      className: 'lp-float',
      body: [tabsSlot, scroller, foot],
    });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Add a link parameter');
    overlay.el.append(panel);
    for (const type of ISOLATED_EVENTS) overlay.host.addEventListener(type, (e) => e.stopPropagation());

    function currentUrl() {
      return findInput()?.value ?? '';
    }

    function render() {
      dom.clear(tabsSlot);
      dom.clear(scroller);
      const keys = Object.keys(library);
      if (!keys.length || !activeType) {
        scroller.append(h('p', { class: 'lp-empty' }, 'Your library is empty. Add parameters in Loophole settings.'));
        return;
      }
      if (keys.length > 1) {
        tabsSlot.append(ui.tabs({
          tabs: keys.map((k) => ({ id: k, label: library[k].label || k })),
          selected: activeType,
          onSelect: (id) => { activeType = id; render(); },
        }));
      }
      const type = library[activeType];
      const url = currentUrl();
      const unsupported = paramUnsupportedReason(url);
      if (unsupported) {
        scroller.append(h('p', { class: 'lp-empty' }, UNSUPPORTED_NOTE[unsupported]));
        return;
      }
      const current = getParam(url, activeType);
      const bubble = (term, color, recent = false) => {
        const b = h('button', {
          type: 'button', class: ['bub', recent && 'recent', term === current && 'on'], title: `${activeType}=${term}`,
          onClick: dom.trusted(() => apply(term)),
        }, term);
        if (color) b.style.setProperty('--c', normalizeColor(color));
        return b;
      };
      const cats = h('div', { class: 'bub-cats' });
      for (const cat of type.categories) {
        if (!cat.terms.length) continue;
        cats.append(h('div', { class: 'bub-cat' },
          h('h5', null, h('i', { style: { background: normalizeColor(cat.color) } }), cat.name),
          h('div', { class: 'bubs' }, cat.terms.map((t) => bubble(t, cat.color)))));
      }
      const rec = recents[activeType] || [];
      if (rec.length) {
        cats.append(h('div', { class: 'bub-cat' },
          h('h5', null, 'Recent'),
          h('div', { class: 'bubs' }, rec.map((t) => bubble(t, null, true)))));
      }
      if (!cats.childElementCount) cats.append(h('p', { class: 'lp-empty' }, `No saved values for ${activeType} yet.`));
      custom.placeholder = `Custom ${type.label || activeType}…`;
      result.value = url;
      scroller.append(cats,
        h('div', { class: 'lp-custom' }, custom, applyBtn),
        ui.field({ label: 'Resulting link', control: result }));
      scroller.lastChild.classList.add('lp-result');
    }

    function apply(term) {
      const input = findInput();
      if (!input) {
        log.warn('URL input not found');
        ui.toast('Could not find the link field.', { tone: 'bad', source: 'Link params' });
        return;
      }
      const before = input.value;
      if (!before.trim()) {
        ui.toast('Enter a link first, then add parameters.', { tone: 'warn', source: 'Link params' });
        return;
      }
      const unsupported = paramUnsupportedReason(before);
      if (unsupported) {
        ui.toast(UNSUPPORTED_NOTE[unsupported], { tone: 'warn', source: 'Link params' });
        render();
        return;
      }
      const after = addOrReplaceParam(before, activeType, term);
      if (after !== before) dom.setNativeValue(input, after);
      log.debug('URL updated', { param: activeType });
      const type = activeType;
      recents = { ...recents, [type]: addRecent(recents[type], term) };
      ctx.state.set(RECENTS_KEY, recents).catch((e) => log.warn('could not save recents', e));
      custom.value = '';
      applyBtn.disabled = true;
      render();
    }

    function reposition() {
      if (!anchor.isConnected) { close(); return; }
      const r = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const width = Math.min(PANEL_WIDTH, vw - 16);
      const left = Math.max(8, Math.min(r.right - width, vw - width - 8));
      const above = r.top - 8;
      const below = vh - r.bottom - 8;
      panel.style.width = `${width}px`;
      panel.style.left = `${left}px`;
      // The BEE sidebar's link field usually sits low, so open upward like the script when roomier.
      if (above > below) {
        panel.style.top = '';
        panel.style.bottom = `${vh - r.top + 6}px`;
        panel.style.maxHeight = `${Math.max(160, Math.min(520, above - 6))}px`;
      } else {
        panel.style.bottom = '';
        panel.style.top = `${r.bottom + 6}px`;
        panel.style.maxHeight = `${Math.max(160, Math.min(520, below - 6))}px`;
      }
    }

    const ac = new AbortController();
    const opts = { capture: true, signal: ac.signal };
    document.addEventListener('pointerdown', (e) => {
      const path = e.composedPath();   // hosts only: our roots are closed
      if (path.includes(overlay.host) || path.includes(anchorHost)) return;
      close();
    }, opts);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
    }, opts);
    window.addEventListener('scroll', reposition, opts);
    window.addEventListener('resize', reposition, opts);
    // Clicking the parent page (outside this iframe) blurs the frame: close, like the script.
    window.addEventListener('blur', () => close(), { signal: ac.signal });

    open = {
      anchor,
      render,
      destroy() { ac.abort(); overlay.destroy(); anchor.setAttribute('aria-expanded', 'false'); },
    };
    anchor.setAttribute('aria-expanded', 'true');
    render();
    reposition();
  }

  function close() {
    if (!open) return;
    const o = open;
    open = null;
    o.destroy();
  }

  // ── Live settings ──────────────────────────────────────────────────────

  const offSettings = ctx.onSettings((values) => {
    library = resolveParamTypes(values);
    if (!library[activeType]) activeType = Object.keys(library)[0] || null;
    open?.render();
  });

  return () => {
    offSettings?.();
    observer.disconnect();
    close();
    for (const m of mounts) m.destroy();
    mounts.clear();
  };
}
