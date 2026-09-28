// Locale banner: a badge in the template editor header showing the ?locale= being edited.
// Port of "Iterable Locale Banner" v1.2.0, made generic: the default locale is a setting
// (green), any other locale is amber (optionally pulsing), and with no default set every locale
// uses the neutral accent style. The badge lives in a shadow root (theme.css `.wb-locale`).

import { classifyLocale, localeFromSearch } from './logic.js';

// Proven by the userscript. Its "right-side controls" anchor was a generated styled-components
// class ([class*="hWzpvM"]) that churns with every Iterable deploy; we insert before the header's
// last element child instead, which was already the script's own fallback.
const HEADER = '[data-test="content-header"]';

const EXTRA_CSS = `
.wb.lb{display:inline-flex; align-items:center; flex:none; margin:0 8px}
.wb-locale{white-space:nowrap; user-select:none; line-height:1.2}
.wb-locale .d{flex:none; border-radius:1px}
.wb-locale.neutral{color:var(--wb-accent-strong); background:var(--wb-accent-soft)}
.wb-locale.pulse{animation:lb-pulse 1.8s ease-in-out infinite}
@keyframes lb-pulse{
  0%,100%{box-shadow:0 0 0 0 color-mix(in srgb, currentColor 55%, transparent)}
  50%{box-shadow:0 0 0 5px color-mix(in srgb, currentColor 0%, transparent)}
}
@media (prefers-reduced-motion:reduce){.wb-locale.pulse{animation:none}}
`;

export function mount(ctx) {
  const { h } = ctx.dom;
  let values = ctx.settings;
  let badge = null; // { header, mount, el, key }

  const motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function detach() {
    badge?.mount.destroy();
    badge = null;
  }

  function attach(header) {
    detach();
    // Before the header's right-hand controls, like the userscript; append into an empty header.
    const anchor = header.lastElementChild;
    const m = anchor ? ctx.ui.mountInline(anchor, 'before', { className: 'lb' }) : ctx.ui.mountInline(header, 'append', { className: 'lb' });
    m.root.prepend(h('style', null, EXTRA_CSS));
    const text = h('span', { class: 't' });
    const el = h('span', { class: 'wb-locale' }, h('span', { class: 'd', 'aria-hidden': 'true' }), text);
    m.el.append(el);
    badge = { header, mount: m, el, text, key: '' };
  }

  function sync() {
    if (ctx.signal.aborted) return;
    const state = classifyLocale(localeFromSearch(location.search), values, { reducedMotion: !!motionQuery?.matches });
    const header = state.visible ? document.querySelector(HEADER) : null;
    if (!header) { detach(); return; }
    if (!badge || badge.header !== header || !badge.mount.host.isConnected) attach(header);
    const key = `${state.tone}|${state.pulse}|${state.label}|${state.title}`;
    if (badge.key === key) return;
    badge.key = key;
    badge.el.className = ['wb-locale', state.tone, state.pulse && 'pulse'].filter(Boolean).join(' ');
    badge.el.title = state.title;
    badge.text.textContent = state.label;
  }

  // SPA awareness. The router keeps us mounted while the path stays on /templates/editor, so a
  // ?locale= change has to be noticed here: ctx.onUrlChange (pushState/replaceState, back/forward)
  // and DOM churn, which also covers the header appearing or being re-rendered.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; sync(); });
  };
  const obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ctx.onUrlChange(schedule);
  motionQuery?.addEventListener?.('change', schedule, { signal: ctx.signal });
  const offSettings = ctx.onSettings((v) => { values = v; sync(); });
  sync();

  return () => {
    obs.disconnect();
    offSettings?.();
    detach();
  };
}
