// Example page-world handler module (ARCHITECTURE §6.3). NOT registered or shipped: no feature
// folder points at it, so the build never bundles it. Tests (test/page-rpc.test.js) and the
// browser proof use it; copy its shape into src/features/<id>/main.js.
//
// It drives an Ace editor the way the Live Preview Editor userscript did (ace.edit(el), session
// change events, getValue / setValue), and shows the rules every main.js follows:
//  - harmless by design: only things page script could do itself; no network, no navigation,
//    no eval / Function / innerHTML with arguments;
//  - arguments are untrusted (any page script can call these): check their types;
//  - return plain JSON; never secrets (nothing from extension storage comes here anyway).

const MAX_VALUE = 4 * 1024 * 1024;

function editor(selector) {
  const ace = window.ace;
  if (!ace || typeof ace.edit !== 'function') return null;
  const el = typeof selector === 'string' && selector.length < 200 ? document.querySelector(selector) : null;
  if (!el) return null;
  try { return ace.edit(el); } catch { return null; }
}

export const methods = {
  /** → { found: boolean, value?: string } */
  getValue(args) {
    const ed = editor(args?.selector);
    if (!ed) return { found: false };
    const value = String(ed.getValue());
    return value.length > MAX_VALUE ? { found: true, tooLarge: true } : { found: true, value };
  },
  /** args { selector, value } → { ok } */
  setValue(args) {
    if (typeof args?.value !== 'string' || args.value.length > MAX_VALUE) return { ok: false };
    const ed = editor(args.selector);
    if (!ed) return { ok: false };
    ed.setValue(args.value, -1);
    return { ok: true };
  },
};

/** Emit 'change' (no content, just a signal) whenever the page's editor changes. */
export function activate(page) {
  const ed = editor('#content-editor-ace');
  if (!ed?.session?.on) return undefined;
  const onChange = () => page.emit('change', { length: ed.session.getLength?.() ?? null });
  ed.session.on('change', onChange);
  return () => ed.session.off?.('change', onChange);
}
