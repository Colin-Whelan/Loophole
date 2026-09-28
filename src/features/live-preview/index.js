// Live preview editor (isolated half). Ported from the "Iterable - Live Preview Editor"
// userscript (v3.2): a live preview sidebar beside the template code editor (live vs. Iterable's
// own static preview, resizable), a JSON test-data editor (its own Ace instance, plus a popout),
// a user's profile loaded as test data, saved payload bubbles, "Push new value" (the shared field
// editor, through the project's API key) and refresh, quick-insert snippets with ${1:…} stops,
// editor keybindings and font, and a refresh shortcut.
//
// Nothing is sent to Iterable unless the person asks (logic.js refreshPlan): Iterable's Save is
// clicked only by an explicit refresh (button / shortcut) while our sidebar shows; test data is
// posted only on the person's action and only to the template it belongs to (each template keeps
// its own; switching templates or locales only reloads our preview with a GET). On pages without
// the code editor (drag-and-drop templates) the feature makes no requests at all.
//
// The page's Ace editor is only reachable from the page world: main.js does the Ace work, reached
// through ctx.page (ARCHITECTURE §6.3). Its results and events are untrusted page data and are
// type-checked here. Iterable's layout changes (hidden static preview + divider, editor pane
// width) are recorded and put back on unmount, on "Static" and when the preview is hidden.
// Never logs emails, test data or profile data.

import { projectSlot, getMigrated } from '../../core/state.js';
import { getUserFields } from '../../lib/iterable/fields.js';
import { appLookupPath, interpretAppLookup } from '../../lib/iterable/users.js';
import { renderFieldEditor } from '../../lib/iterable/field-editor.js';
import { linkSignal } from '../../core/dom.js';
import { guardFrameDocument } from '../../core/preview.js';
import * as L from './logic.js';

export const SEL = Object.freeze({
  container: '#content-editor-side-by-side',
  aceEl: '#content-editor-ace',
  staticIframe: 'iframe[data-test="secure-iframe-full"]',
  resizer: '[data-test="sbs-resizer"]',
  unsaved: '[data-test="last-saved-indicator"] span',
  saveBtn: '[data-test="btn-save-design"]',
});

const START_DELAY_MS = 1000;     // the script waited 1 s after the editor container appeared
const SAVE_WAIT_MS = 1500;       // after clicking Iterable's Save
const LOAD_TIMEOUT_MS = 20_000;  // give up waiting for the preview frame's load event
const PERSIST_MS = 500;
const ATTACH_TRIES = 30;

// Rendered email HTML, same origin. No allow-scripts (email HTML runs no script; and with
// allow-same-origin it could otherwise lift its own sandbox). allow-same-origin keeps the
// session cookie for showHtml, lets us keep the scroll position across refreshes and lets the
// content script make links inert in the frame (guardFrameDocument). No allow-popups: a link is
// opened only when the person clicks it and then confirms "Open link" (a trusted action), in a
// new tab with noopener / noreferrer; clicks never navigate the preview itself (ARCHITECTURE §9).
export const PREVIEW_SANDBOX = 'allow-same-origin';

const BAR_CSS = `
.lp-host{flex:none}
.lp-bar{display:flex; flex-direction:column; gap:6px; padding:6px 10px; background:var(--wb-raised); border-bottom:1px solid var(--wb-line)}
.lp-row{display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0}
.lp-who{display:flex; align-items:center; gap:4px}
.lp-who .wb-input{width:190px; padding:5px 8px; font-size:12px}
.lp-right{display:flex; align-items:center; gap:6px; margin-left:auto}
.lp-bubs{display:flex; flex-wrap:wrap; gap:4px; align-items:center; min-width:0}
.lp-bub{display:inline-flex; align-items:stretch}
.lp-bub .bub{border-radius:999px 0 0 999px; border-right:0}
.lp-bub .bx{border:1px solid var(--wb-line-strong); border-left:0; border-radius:0 999px 999px 0; background:var(--wb-surface); color:var(--wb-faint); cursor:pointer; padding:0 7px 0 4px; font-size:12px; line-height:1}
.lp-bub .bx:hover{color:var(--wb-bad); background:var(--wb-bad-soft)}
.lp-over{display:inline-flex; align-items:center; gap:2px}
.lp-over .bx{border:0; background:transparent; color:var(--wb-warn); cursor:pointer; font-size:13px; padding:0 3px}
.wb-btn.lp-refresh.dirty{background:var(--wb-warn); border-color:var(--wb-warn); color:var(--wb-surface)}
.lp-json{position:relative; min-height:54px; border:1px solid var(--wb-line-strong); border-radius:var(--wb-r); overflow:hidden; background:var(--wb-surface)}
.lp-json .pop{position:absolute; top:3px; right:3px; z-index:10; opacity:.55; background:var(--wb-surface)}
.lp-json .pop:hover, .lp-json .pop:focus-visible{opacity:1}
.lp-ta{display:block; width:100%; min-height:72px; max-height:260px; border:0; border-radius:0; resize:vertical; padding:6px 30px 6px 8px; font:12px/1.45 var(--wb-mono); background:var(--wb-surface); color:var(--wb-ink)}
.lp-ta:focus{outline:none}
.lp-snips{display:flex; flex-wrap:wrap; gap:4px; align-items:center}
.lp-snips .lbl{font-size:11px; color:var(--wb-muted); margin-right:2px}
.lp-snips .bub{border-radius:var(--wb-r-sm)}
.lp-note{font-size:11.5px; color:var(--wb-warn)}
.lp-status{font-size:11.5px; color:var(--wb-muted)}
.lp-status.bad{color:var(--wb-bad)}
.lp-min{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
`;

const SIDE_CSS = `
.lp-side{display:flex; flex:0 1 auto; height:100%; min-height:0; min-width:0; background:var(--wb-surface)}
.lp-resizer{width:6px; flex:none; cursor:col-resize; background:var(--wb-line); transition:background .12s}
.lp-resizer:hover, .lp-resizer.drag, .lp-resizer:focus-visible{background:var(--wb-accent)}
.lp-pane{flex:1; min-width:0; display:flex; flex-direction:column}
.lp-head{display:flex; align-items:center; gap:8px; padding:5px 10px; background:var(--wb-raised); border-bottom:1px solid var(--wb-line); font-size:12px; color:var(--wb-muted)}
.lp-head .brand{font-family:var(--wb-mono); font-size:11px; color:var(--wb-accent-strong); margin-left:auto}
.lp-frame{flex:1; min-height:0; width:100%; border:0; display:block; background:#fff}
.lp-drag .lp-frame{pointer-events:none}
`;

const DIALOG_CSS = `
.lp-dlg{display:flex; flex-direction:column; gap:10px}
.lp-pop{height:min(60vh,560px); border:1px solid var(--wb-line-strong); border-radius:var(--wb-r); overflow:hidden; background:var(--wb-surface)}
.lp-pop .lp-ta{height:100%; max-height:none; resize:none}
.lp-recent{display:flex; flex-wrap:wrap; gap:4px; align-items:center}
.lp-recent .lbl{font-size:11px; color:var(--wb-muted); margin-right:2px}
`;

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

let seq = 0;
const newId = () => `lp-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/**
 * Records inline styles before we change them, so every change can be put back exactly (an
 * element that had no style attribute gets none back).
 */
export function styleKeeper() {
  const saved = new Map(); // el → { hadAttr, props: Map(prop → [value, priority]) }
  return {
    set(el, prop, value) {
      if (!el) return;
      let rec = saved.get(el);
      if (!rec) { rec = { hadAttr: el.hasAttribute('style'), props: new Map() }; saved.set(el, rec); }
      if (!rec.props.has(prop)) rec.props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
      el.style.setProperty(prop, value);
    },
    restore() {
      for (const [el, rec] of saved) {
        for (const [prop, [v, p]] of rec.props) {
          if (v) el.style.setProperty(prop, v, p); else el.style.removeProperty(prop);
        }
        if (!rec.hadAttr && el.getAttribute('style') === '') el.removeAttribute('style');
      }
      saved.clear();
    },
  };
}

export function mount(ctx) {
  const { h } = ctx.dom;
  const { ui, log, signal } = ctx;
  const SOURCE = ctx.meta?.name || 'Live preview editor';
  let settings = ctx.settings;

  // ── Persistent state ────────────────────────────────────────────────────────────────────
  const view = { open: true, mode: 'live' };            // state 'ui' (all projects)
  // testData: the project's starting test data (an import, or what older versions kept per
  // project); each template's own copy lives under L.testDataName(slot, templateId).
  const names = { testData: 'testData', payloads: 'payloads', recent: 'recentFields', email: 'lastEmail' };
  let slot = '';
  let seedText = '{}';     // starting text for a template without its own copy
  let testText = '{}';
  let testFor = null;      // the template the test data belongs to, or null (only the starting text)
  let baseText = '{}';     // what we last put into the editor ourselves
  let curTid = null;       // the template whose test data is loaded
  let tplGen = 0;          // bumped whenever a template's test data is loaded (see scopeNow)
  let payloads = [];
  let recent = [];
  let lastEmail = '';
  const overrides = new Map();                          // pushed values, this page session only

  // Read on first use (the code editor showing up), so pages without it make no requests.
  let stateReadyP = null;
  const stateReady = () => (stateReadyP ||= (async () => {
    try { await ctx.project.refresh(); } catch { /* keep null */ }
    // Per project (projectSlot); an imported, project-less entry moves to the first project.
    slot = projectSlot(ctx.project.current()?.key || '');
    const read = async (key, fallback) => {
      const base = names[key];
      const name = slot ? `${base}:${slot}` : base;
      names[key] = name;
      try { return slot ? await getMigrated(ctx.state, name, [base], fallback) : await ctx.state.get(name, fallback); } catch { return fallback; }
    };
    const t = await read('testData', '{}');
    seedText = typeof t === 'string' && t.length <= L.MAX_TEST_DATA ? t : '{}';
    testText = seedText;
    payloads = L.normalizePayloads(await read('payloads', []));
    const r = await read('recent', []);
    recent = Array.isArray(r) ? r.filter((f) => typeof f === 'string' && f).slice(0, L.MAX_RECENT) : [];
    const e = await read('email', '');
    lastEmail = typeof e === 'string' ? e : '';
    try {
      const u = await ctx.state.get('ui', null);
      if (u && typeof u === 'object') {
        if (typeof u.open === 'boolean') view.open = u.open;
        if (u.mode === 'live' || u.mode === 'static') view.mode = u.mode;
      }
    } catch { /* defaults */ }
  })());
  const saveUi = () => ctx.state.set('ui', { open: view.open, mode: view.mode }).catch(() => {});
  const saveState = (name, value) => ctx.state.set(name, value).catch((e) => log.warn('could not save state', e?.message || e));

  // ── Page world (Ace) ────────────────────────────────────────────────────────────────────
  async function pageCall(method, args, opts) {
    if (!ctx.page.available || signal.aborted) return null;
    try {
      const r = await ctx.page.call(method, args, opts);
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch (err) {
      if (err?.code !== 'ABORTED') log.debug('page call failed', method, err?.code || '');
      return null;
    }
  }
  let aceStatus = { ace: null, editor: false };

  function configure() {
    const plan = L.editorPlan(settings);
    return pageCall('configure', { bindings: plan.bindings, snippets: plan.snippets, font: plan.font });
  }

  let attachRun = 0;
  async function attach() {
    const run = ++attachRun;
    for (let i = 0; i < ATTACH_TRIES && run === attachRun && !signal.aborted; i++) {
      const r = await pageCall('attach');
      aceStatus = { ace: r ? r.ace === true : false, editor: r ? r.editor === true : false };
      if (aceStatus.editor) { await configure(); renderNote(); return; }
      renderNote();
      await sleep(1000, signal);
    }
  }

  if (ctx.page.available) {
    ctx.page.on('change', () => setSync('dirty'));
    ctx.page.on('json-change', (p) => {
      if (!p || typeof p.id !== 'string' || !jsonEds.has(p.id)) return;
      if (p.id === inlineId) schedulePersist();
    });
  }

  // ── JSON test-data editors ──────────────────────────────────────────────────────────────
  const jsonEds = new Map();   // id → { ace: boolean, ta?: textarea, light?: element }
  let inlineId = null;

  /**
   * An Ace JSON editor slotted into `slotParent` (inside our shadow root) from a light-DOM child
   * of `host` (Ace needs the page's own CSS), or a plain textarea when the page has no Ace.
   */
  async function createJsonEditor({ host, slotParent, value, popout = false, onTextarea }) {
    const id = newId();
    const slotName = `lp-json-${id}`;
    const light = h('div', { 'data-wb-lp-ace': id, slot: slotName, style: popout ? 'width:100%;height:100%' : 'width:100%;min-height:54px' });
    host.append(light);
    slotParent.append(h('slot', { name: slotName }));
    const rec = { ace: false, light, ta: null };
    jsonEds.set(id, rec);
    const r = await pageCall('createJsonEditor', { id, value, popout, focus: popout });
    if (r && r.ok === true && r.ace === true) {
      rec.ace = true;
    } else {
      light.remove();
      rec.light = null;
      rec.ta = h('textarea', { class: 'lp-ta', spellcheck: 'false', 'aria-label': 'Test data JSON', value });
      slotParent.replaceChildren(rec.ta);
      onTextarea?.(rec.ta);
      if (popout) rec.ta.focus();
    }
    return id;
  }

  async function jsonValue(id) {
    const rec = jsonEds.get(id);
    if (!rec) return null;
    if (!rec.ace) return rec.ta.value;
    const r = await pageCall('getJsonValue', { id });
    return r && r.ok === true && typeof r.value === 'string' && r.value.length <= L.MAX_TEST_DATA ? r.value : null;
  }

  async function setJsonValue(id, value) {
    const rec = jsonEds.get(id);
    if (!rec) return;
    if (rec.ace) await pageCall('setJsonValue', { id, value });
    else rec.ta.value = value;
  }

  function destroyJsonEditor(id) {
    const rec = jsonEds.get(id);
    if (!rec) return;
    jsonEds.delete(id);
    if (rec.ace) pageCall('destroyJsonEditor', { id });
    rec.light?.remove();
  }

  /** The test data text: the inline editor's content, else what's stored. */
  async function currentTestText() {
    const v = inlineId ? await jsonValue(inlineId) : null;
    if (typeof v === 'string') testText = v;
    return testText;
  }

  // ── Action scope ────────────────────────────────────────────────────────────────────────
  // A person's action (Load profile, a payload, "Apply & refresh", a push) belongs to the
  // template showing when it started. Every async continuation checks it is still that template
  // (same generation, URL and project, feature still mounted) before writing local state,
  // clicking Save or posting; otherwise the result is dropped.
  const slotNow = () => { const k = ctx.project.current()?.key; return k ? projectSlot(k) : slot; };
  const scopeNow = () => ({ tid: curTid, gen: tplGen, slot: slotNow() });
  const inScope = (scope) => L.actionCurrent(scope, {
    tid: curTid, gen: tplGen, slot: slotNow(), urlTid: L.templateIdFrom(location.search), aborted: signal.aborted,
  });
  const switchedAway = () => { if (!signal.aborted) ui.toast(L.SWITCHED_TEXT, { tone: 'warn', source: SOURCE }); };

  /**
   * Run fn in the template chain (so no template load interleaves) if `scope` is still current.
   * → true when it ran. Never call refresh() from fn (refresh waits for the chain).
   */
  function inTemplate(scope, fn) {
    const run = async () => {
      if (!inScope(scope)) return false;
      await fn();
      return true;
    };
    const p = templateChain.then(run, run).catch((err) => { log.warn('test data update failed', err?.message || err); return false; });
    templateChain = p;
    return p;
  }

  /**
   * The person set the test data (payload, profile, popout) on the template of `scope`: it is now
   * that template's own. → false (nothing changed) when the page has moved to another template.
   */
  function setTestText(text, scope) {
    return inTemplate(scope, async () => {
      testText = text;
      baseText = text;
      if (inlineId) await setJsonValue(inlineId, text);
      claimTestData(text, scope.tid);
      setSync('dirty');
    });
  }

  /** The test data in the editor becomes template `tid`'s own (the current one), saved as such. */
  function claimTestData(text, tid = curTid) {
    if (!tid || tid !== curTid || typeof text !== 'string' || text.length > L.MAX_TEST_DATA) return;
    testFor = tid;
    saveState(L.testDataName(slot, tid), text);
    renderStatus();
  }

  /**
   * Keep an edit made in the editor. Once the text differs from what we put there, it is the
   * current template's own (a programmatic setValue fires the same change event, so compare).
   */
  async function persistEdit() {
    clearTimeout(persistTimer);
    persistTimer = null;
    const tid = curTid;
    if (!tid) return;
    const before = testText;
    const v = await currentTestText();
    if (tid !== curTid || signal.aborted) return;
    if (testFor !== tid && v === baseText) return;
    if (v !== before || testFor !== tid) setSync('dirty');
    claimTestData(v);
  }

  let persistTimer = null;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { persistEdit(); }, PERSIST_MS);
  }

  /**
   * Load a template's own test data (or the starting text) into the editor. A pending edit is
   * saved to the template it was made on first. Serialised, so a quick A → B → C keeps each
   * template's data apart. Pushed values were for the previous template: cleared.
   */
  let templateChain = Promise.resolve();
  function loadTemplate(tid) {
    const run = async () => {
      if (signal.aborted || tid === curTid) return;
      if (persistTimer) await persistEdit();
      // The popped-out editor holds the previous template's data: applying it here would move it.
      if (curTid && popout) popout.d.close(null);
      let own = null;
      if (tid) {
        try { own = await ctx.state.get(L.testDataName(slot, tid), null); } catch { own = null; }
        if (typeof own !== 'string' || own.length > L.MAX_TEST_DATA) own = null;
      }
      if (signal.aborted) return;
      curTid = tid;
      tplGen++;
      testFor = own !== null ? tid : null;
      testText = own !== null ? own : seedText;
      baseText = L.prettyJson(testText);
      if (overrides.size) { overrides.clear(); renderOverrides(); }
      if (inlineId) await setJsonValue(inlineId, baseText);
      renderStatus();
    };
    templateChain = templateChain.then(run, run);
    return templateChain;
  }

  // ── Layout (reversible) ─────────────────────────────────────────────────────────────────
  const styles = styleKeeper();
  let container = null;
  let bar = null;        // { m, … }
  let side = null;       // { m, frame, resizer }

  const isOurs = (el) => el?.tagName === 'WB-HOST';
  const editorPane = () => (container ? [...container.children].find((c) => !isOurs(c)) || null : null);

  /** The container child holding Iterable's static preview (or the iframe itself). */
  function staticBlock() {
    const frame = container?.querySelector(SEL.staticIframe);
    if (!frame) return null;
    let el = frame;
    while (el.parentElement && el.parentElement !== container) el = el.parentElement;
    return el.parentElement === container && el !== editorPane() ? el : frame;
  }

  function applyLayout() {
    const live = view.open && view.mode === 'live';
    styles.restore();
    if (!container || !live) {
      side?.m.host.remove();
      pageCall('resize');
      return;
    }
    ensureSide();
    const pane = editorPane();
    const block = staticBlock();
    if (block) styles.set(block, 'display', 'none');
    styles.set(container.querySelector(SEL.resizer), 'display', 'none');
    styles.set(container.querySelector(SEL.aceEl), 'width', 'auto');
    if (pane) {
      styles.set(pane, 'flex', 'none');
      styles.set(pane, 'width', `${100 - L.clampWidth(settings.previewWidth)}%`);
    }
    side.m.el.style.width = `${L.clampWidth(settings.previewWidth)}%`;
    setTimeout(() => pageCall('resize'), 50);
  }

  // ── Sidebar ─────────────────────────────────────────────────────────────────────────────
  function ensureSide() {
    if (side) {
      if (side.m.host.parentElement !== container) container.append(side.m.host);
      return;
    }
    const m = ui.mountInline(container, 'append');
    m.root.prepend(h('style', null, SIDE_CSS));
    m.el.classList.add('lp-side');
    const frame = h('iframe', { class: 'lp-frame', sandbox: PREVIEW_SANDBOX, title: 'Live preview' });
    const resizer = h('div', { class: 'lp-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the preview', tabindex: '0' });
    const locale = h('span');
    m.el.append(resizer, h('div', { class: 'lp-pane' },
      h('div', { class: 'lp-head' }, h('span', null, 'Live preview'), locale, h('span', { class: 'brand' }, SOURCE)),
      frame));
    side = { m, frame, resizer, locale };
    wireResizer(resizer);
    updateLocale();
  }

  function updateLocale() {
    if (side) side.locale.textContent = L.localeFrom(location.search) ? `· ${L.localeFrom(location.search)}` : '';
  }

  function wireResizer(el) {
    let drag = null;
    const dragStyles = styleKeeper();
    const onMove = (e) => {
      if (!drag) return;
      const cw = container.getBoundingClientRect().width;
      if (!cw) return;
      const editorW = Math.max(cw * 0.25, Math.min(cw * 0.75, drag.startW + (e.clientX - drag.startX)));
      const pct = L.clampWidth(100 - (editorW / cw) * 100);
      drag.pct = pct;
      const pane = editorPane();
      if (pane) styles.set(pane, 'width', `${100 - pct}%`);
      side.m.el.style.width = `${pct}%`;
    };
    const onUp = () => {
      if (!drag) return;
      const { pct } = drag;
      drag = null;
      el.classList.remove('drag');
      side?.m.el.classList.remove('lp-drag');
      dragStyles.restore();
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      pageCall('resize');
      if (pct != null && pct !== settings.previewWidth) ctx.saveSettings({ previewWidth: pct }).catch(() => {});
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { startX: e.clientX, startW: editorPane()?.getBoundingClientRect().width || 0, pct: null };
      el.classList.add('drag');
      side.m.el.classList.add('lp-drag');
      // The script's trick: page iframes would swallow the pointer while dragging over them.
      for (const f of document.querySelectorAll('iframe')) dragStyles.set(f, 'pointer-events', 'none');
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const pct = L.clampWidth(settings.previewWidth + (e.key === 'ArrowLeft' ? 5 : -5));
      if (pct !== settings.previewWidth) ctx.saveSettings({ previewWidth: pct }).catch(() => {});
    });
    signal.addEventListener('abort', onUp, { once: true });
  }

  // ── Refresh ─────────────────────────────────────────────────────────────────────────────
  let sync = 'synced';
  let refreshing = false;
  let again = null;      // { trigger, target } of a refresh asked for while one was running
  let offLoad = null;    // stops waiting for the preview frame's current load
  let lastProblem = '';

  function setSync(next) {
    if (next === 'dirty' && refreshing) return;
    sync = next;
    renderRefresh();
  }

  function loadPreview() {
    const templateId = L.templateIdFrom(location.search);
    if (!side || !templateId) return false;
    const frame = side.frame;
    let scrollY = 0;
    try { scrollY = frame.contentWindow?.scrollY || 0; } catch { /* not readable */ }
    offLoad?.();
    const done = () => {
      offLoad?.();
      refreshing = false;
      setSync('synced');
      runAgain();
    };
    const onLoad = () => {
      guardPreview(frame);
      try { frame.contentWindow?.scrollTo(0, scrollY); } catch { /* not readable */ }
      done();
    };
    frame.addEventListener('load', onLoad);
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    // Guard the new document as soon as it exists (before `load`, while images still load).
    const early = setInterval(() => guardPreview(frame), 50);
    const earlyStop = setTimeout(() => clearInterval(early), LOAD_TIMEOUT_MS);
    offLoad = () => {
      clearTimeout(timer); clearInterval(early); clearTimeout(earlyStop);
      frame.removeEventListener('load', onLoad); offLoad = null;
    };
    frame.src = new URL(L.previewPath(templateId, L.localeFrom(location.search)), location.origin).href;
    return true;
  }

  /** Links in the preview never navigate it; the person's click offers to open http(s) links. */
  function guardPreview(frame) {
    let doc = null;
    try { doc = frame.contentDocument; } catch { return; }
    if (!doc || doc.URL === 'about:blank') return;
    guardFrameDocument(doc, { onLink: (raw, base) => offerLink(raw, base) });
  }

  let linkDialog = null;
  async function offerLink(raw, base) {
    let url;
    try { url = new URL(raw, base); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      ui.toast(`That link (${url.protocol}) isn't opened from the preview.`, { tone: 'warn', source: SOURCE });
      return;
    }
    if (linkDialog) return;
    const href = url.href;
    linkDialog = ui.confirmDialog({
      title: 'Open this link?', source: SOURCE, confirmLabel: 'Open in a new tab',
      body: h('div', null,
        h('p', { style: 'margin:0 0 8px; font-size:13px; line-height:1.5' },
          'The live preview doesn’t follow links. Opening it visits the address below (tracking links count a click).'),
        h('code', { style: 'display:block; word-break:break-all; font-size:12px' }, href.length > 600 ? href.slice(0, 600) + '…' : href)),
    });
    try {
      // The confirm button acts only on a trusted click, so the open below follows a real gesture.
      if (await linkDialog) window.open(href, '_blank', 'noopener,noreferrer');
    } finally {
      linkDialog = null;
    }
  }

  async function saveTestData(scope) {
    const templateId = scope.tid;
    const text = await currentTestText();
    if (!inScope(scope) || testFor !== templateId) return;   // switched while reading
    const parsed = L.parseTestData(text);
    if (!parsed.ok) { lastProblem = `${parsed.error} The preview uses the test data saved before.`; return; }
    const userJson = L.applyOverrides(parsed.value, overrides);
    try {
      await ctx.http.appFetch(L.SAVE_TEST_DATA_PATH, {
        method: 'POST', body: L.testDataBody(templateId, userJson), signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      log.warn('saving test data failed', err?.status || 0);
      lastProblem = `Couldn't save the test data (HTTP ${err?.status || 'error'}).`;
    }
  }

  function runAgain() {
    if (!again) return;
    const { trigger, target } = again;
    again = null;
    setTimeout(() => refresh(trigger, target), 300);
  }

  function queueAgain(trigger, target) {
    if (!again || L.TRIGGER_RANK[trigger] > L.TRIGGER_RANK[again.trigger]) again = { trigger, target };
  }

  const sidebarShown = () => !!side && view.open && view.mode === 'live' && side.m.host.isConnected;

  /**
   * trigger: 'explicit' | 'testData' | 'show' | 'url' (L.refreshPlan says what each may do).
   * target: the template it is for — an action scope ({ tid, gen, slot }, from scopeNow()), or by
   * default the template in the URL when refresh is asked for. Refused (nothing saved or sent) if
   * the editor has moved to another template by the time anything would be done.
   */
  async function refresh(trigger, target = { tid: L.templateIdFrom(location.search) }) {
    if (signal.aborted || !view.open || !container?.isConnected || !bar) return;
    if (refreshing) { queueAgain(trigger, target); return; }
    if (!target?.tid) return;
    await templateChain;
    // No generation given: whichever load of that template is current once switches settle.
    const scope = target.gen === undefined ? { tid: target.tid, gen: tplGen, slot: slotNow() } : target;
    if (!inScope(scope)) return;   // a template switch reloads by itself
    const templateId = scope.tid;
    // An edit typed a moment ago counts before deciding what to send.
    if (trigger === 'explicit' || trigger === 'testData') await persistEdit();
    if (!inScope(scope)) return;
    if (refreshing) { queueAgain(trigger, scope); return; }
    const plan = L.refreshPlan({
      trigger, templateId, testDataFor: testFor,
      editorPresent: !!container?.isConnected, sidebarShown: sidebarShown(),
      unsaved: document.querySelector(SEL.unsaved)?.textContent === L.UNSAVED_TEXT,
    });
    if (!plan.reload && !plan.save && !plan.post) { renderStatus(); return; }
    refreshing = true;
    lastProblem = '';
    sync = 'loading';
    renderRefresh();
    try {
      // Iterable's Save only for the editor of this template.
      if (plan.save && inScope(scope)) {
        document.querySelector(SEL.saveBtn)?.click();
        await sleep(SAVE_WAIT_MS, signal);
      }
      // Checked again after the wait: never send once the page has moved to another template.
      if (plan.post && inScope(scope) && testFor === templateId) {
        await saveTestData(scope);
        await sleep(200, signal);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') log.warn('refresh failed', err?.message || err);
    }
    if (signal.aborted) return;
    if (!(plan.reload && sidebarShown() && loadPreview())) {
      refreshing = false;
      setSync('synced');
      runAgain();
    }
    renderStatus();
  }

  // ── The bar above the code editor ───────────────────────────────────────────────────────
  function ensureBar() {
    const pane = editorPane();
    if (!pane) return;
    if (bar) {
      if (bar.m.host.parentElement !== pane || pane.firstElementChild !== bar.m.host) pane.prepend(bar.m.host);
      return;
    }
    const m = ui.mountInline(pane, 'prepend', { className: 'lp-host' });
    m.root.prepend(h('style', null, BAR_CSS));
    bar = { m, box: h('div', { class: 'lp-bar' }) };
    m.el.append(bar.box);
    renderBar();
  }

  function renderBar() {
    if (!bar) return;
    if (inlineId) { destroyJsonEditor(inlineId); inlineId = null; }
    const box = bar.box;
    bar.snips = h('div', { class: 'lp-snips' });
    bar.note = h('div', { class: 'lp-note', hidden: true });
    if (!view.open) {
      box.replaceChildren(
        h('div', { class: 'lp-min' },
          ui.injectedButton('Live preview', { size: 'sm', title: 'Show the live preview beside the editor', trusted: true, onClick: () => setOpen(true) }),
          bar.snips),
        bar.note);
      renderSnippets();
      renderNote();
      return;
    }
    bar.email = ui.input({ type: 'email', mono: true, value: lastEmail, placeholder: 'user@example.com', ariaLabel: 'Email of a user for test data' });
    // Everything below that saves in Iterable, POSTs test data or uses the API key acts only on the
    // person's own input (ARCHITECTURE §7 trusted input).
    bar.email.addEventListener('keydown', ctx.dom.trusted((e) => { if (e.key === 'Enter') { e.preventDefault(); loadProfile(); } }));
    bar.email.addEventListener('change', () => rememberEmail(bar.email.value.trim()));
    bar.loadBtn = ui.button('Load profile', { size: 'sm', title: 'Replace the test data with this user\'s profile data', trusted: true, onClick: () => loadProfile() });
    bar.pushBtn = ui.button('Push new value', { size: 'sm', title: 'Write a field to this user\'s profile (uses the project\'s API key), then refresh', trusted: true, onClick: () => openPusher() });
    bar.bubs = h('div', { class: 'lp-bubs' });
    bar.over = h('span', { class: 'lp-over', hidden: true });
    bar.refreshBtn = ui.button('Refresh preview', { size: 'sm', variant: 'primary', className: 'lp-refresh', trusted: true, onClick: () => refresh('explicit') });
    bar.status = h('span', { class: 'lp-status', role: 'status' });
    const seg = ui.segmented({
      ariaLabel: 'Preview', value: view.mode,
      options: [{ value: 'live', label: 'Live' }, { value: 'static', label: 'Static' }],
      onChange: (v) => { view.mode = v; saveUi(); applyLayout(); if (v === 'live') refresh('show'); },
    });
    const hide = ui.iconButton('close', { label: 'Hide the live preview', onClick: () => setOpen(false) });
    const jsonBox = h('div', { class: 'lp-json' });
    const popBtn = ui.button('⛶', { size: 'sm', className: 'pop', title: 'Edit the test data in a larger window', onClick: () => openPopout() });
    popBtn.setAttribute('aria-label', 'Edit the test data in a larger window');
    const slotBox = h('div');
    jsonBox.append(slotBox, popBtn);
    box.replaceChildren(
      h('div', { class: 'lp-row' },
        h('div', { class: 'lp-who' }, bar.email, bar.loadBtn, bar.pushBtn),
        bar.bubs, bar.over,
        h('div', { class: 'lp-right' },
          bar.status,
          ui.button('Save JSON', { size: 'sm', variant: 'ghost', title: 'Save the test data as a named payload', trusted: true, onClick: () => savePayload() }),
          bar.refreshBtn, seg, hide)),
      jsonBox,
      bar.snips,
      bar.note);
    renderBubbles();
    renderOverrides();
    renderSnippets();
    renderRefresh();
    renderNote();
    baseText = L.prettyJson(testText);
    createJsonEditor({
      host: bar.m.host, slotParent: slotBox, value: baseText,
      onTextarea: (ta) => ta.addEventListener('input', () => schedulePersist()),
    }).then((id) => { if (signal.aborted || !bar || bar.box !== box) destroyJsonEditor(id); else inlineId = id; });
  }

  function renderRefresh() {
    if (!bar?.refreshBtn) return;
    const keys = L.editorPlan(settings).refreshKeys;
    bar.refreshBtn.textContent = sync === 'loading' ? 'Refreshing…' : 'Refresh preview';
    bar.refreshBtn.classList.toggle('dirty', sync === 'dirty');
    bar.refreshBtn.title = `Save the template (if it has unsaved changes) and this template's test data, then refresh the preview${keys[0] ? ` (${ctx.dom.formatShortcut(keys[0])})` : ''}`;
    renderStatus();
  }

  function renderStatus() {
    if (!bar?.status) return;
    // Until the person edits or loads test data here, the preview uses what Iterable has saved
    // for this template; the JSON shown is only a starting point.
    const hint = !lastProblem && curTid && testFor !== curTid ? 'Uses the test data saved in Iterable until you edit it here' : '';
    bar.status.textContent = lastProblem || hint;
    bar.status.className = lastProblem ? 'lp-status bad' : 'lp-status';
  }

  function renderNote() {
    if (!bar?.note) return;
    let text = '';
    if (!ctx.page.available || aceStatus.ace === false) text = 'The code editor isn\'t reachable on this page: keybindings, quick inserts and change tracking are off, and test data uses a plain text box.';
    bar.note.textContent = text;
    bar.note.hidden = !text;
  }

  function renderBubbles() {
    if (!bar?.bubs) return;
    bar.bubs.replaceChildren(...payloads.map((p, i) => {
      const load = h('button', {
        type: 'button', class: 'bub', title: `Load "${p.name}" as test data and refresh (right-click to delete)`,
        onClick: ctx.dom.trusted(async () => {
          const scope = scopeNow();
          if (!await setTestText(L.prettyJson(p.data), scope)) { switchedAway(); return; }
          refresh('testData', scope);
        }),
        onContextmenu: (e) => { e.preventDefault(); if (e.isTrusted) deletePayload(i); },
      }, p.name);
      const del = h('button', { type: 'button', class: 'bx', 'aria-label': `Delete saved payload ${p.name}`, title: 'Delete', onClick: ctx.dom.trusted(() => deletePayload(i)) }, '×');
      return h('span', { class: 'lp-bub' }, load, del);
    }));
  }

  function renderOverrides() {
    if (!bar?.over) return;
    const fields = [...overrides.keys()];
    bar.over.hidden = !fields.length;
    if (!fields.length) { bar.over.replaceChildren(); return; }
    const c = ui.chip(`Pushed: ${L.overridesLabel(fields)}`, { tone: 'warn' });
    c.title = `Applied on top of the test data at every refresh:\n${fields.join('\n')}`;
    bar.over.replaceChildren(c, h('button', {
      type: 'button', class: 'bx', 'aria-label': 'Stop applying pushed values', title: 'Stop applying pushed values',
      onClick: ctx.dom.trusted(() => { overrides.clear(); renderOverrides(); setSync('dirty'); }),
    }, '×'));
  }

  function renderSnippets() {
    if (!bar?.snips) return;
    const list = Array.isArray(settings.snippets) ? settings.snippets : [];
    bar.snips.hidden = !list.length;
    bar.snips.replaceChildren(h('span', { class: 'lbl' }, 'Insert:'), ...list.map((s) => h('button', {
      type: 'button', class: 'bub', title: s.shortcut ? `${s.name} (${ctx.dom.formatShortcut(s.shortcut)})` : s.name,
      onClick: ctx.dom.trusted(async () => {
        const r = await pageCall('insertSnippet', { body: s.body });
        if (!r?.ok) ui.toast('The code editor isn\'t reachable, so nothing was inserted.', { tone: 'warn', source: SOURCE });
      }),
    }, s.name)));
  }

  async function setOpen(open) {
    // Keep an edit made in the last moment before the editor goes away.
    if (!open && inlineId) await persistEdit();
    if (signal.aborted) return;
    view.open = open;
    saveUi();
    renderBar();
    applyLayout();
    bindShortcuts();
    if (open) refresh('show');
  }

  // ── Payloads ────────────────────────────────────────────────────────────────────────────
  async function savePayload() {
    const text = await currentTestText();
    const parsed = L.parseTestData(text);
    if (!parsed.ok) { ui.toast(`Fix the test data first: ${parsed.error}`, { tone: 'bad', source: SOURCE }); return; }
    const input = ui.input({ placeholder: 'e.g. VIP customer', ariaLabel: 'Payload name' });
    input.maxLength = L.MAX_PAYLOAD_NAME;
    const d = ui.dialog({
      title: 'Save test data', source: SOURCE, body: ui.field({ label: 'Name', control: input, help: 'Saving under an existing name replaces it.' }),
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
        {
          id: 'save', label: 'Save', variant: 'primary', onClick: () => {
            const name = input.value.trim();
            if (!name) { input.focus(); return false; }
            payloads = L.upsertPayload(payloads, name, text);
            saveState(names.payloads, payloads);
            renderBubbles();
            return true;
          },
        },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.run('save', e); } });
    input.focus();
  }

  async function deletePayload(i) {
    const p = payloads[i];
    if (!p) return;
    const ok = await ui.confirmDialog({ title: `Delete "${p.name}"?`, message: 'This removes the saved test data payload.', confirmLabel: 'Delete', danger: true, source: SOURCE });
    if (!ok) return;
    payloads = payloads.filter((x) => x !== p);
    saveState(names.payloads, payloads);
    renderBubbles();
  }

  // ── JSON popout ─────────────────────────────────────────────────────────────────────────
  let popout = null;   // { d, id, apply() }
  async function openPopout() {
    if (popout) return;
    // The popped-out data belongs to the template showing now; applying it anywhere else is refused.
    const scope = scopeNow();
    const text = L.prettyJson(await currentTestText());
    const slotBox = h('div', { class: 'lp-pop' });
    let id = null;
    const apply = async () => {
      const v = id ? await jsonValue(id) : null;
      if (v === null) return false;
      const parsed = L.parseTestData(v);
      if (!parsed.ok) { ui.toast(parsed.error, { tone: 'bad', source: SOURCE }); return false; }
      if (!await setTestText(v, scope)) { d.close(null); switchedAway(); return false; }
      d.close('apply');
      refresh('explicit', scope);
      return true;
    };
    const d = ui.dialog({
      title: 'Test data JSON', source: SOURCE, size: 'lg', css: [BAR_CSS, DIALOG_CSS],
      body: h('div', { class: 'lp-dlg' }, slotBox, h('div', { class: 'wb-help' }, `Ctrl+Shift+F formats. ${L.editorPlan(settings).refreshKeys[0] ? ctx.dom.formatShortcut(L.editorPlan(settings).refreshKeys[0]) + ' applies and refreshes.' : ''}`)),
      actions: [
        {
          id: 'format', label: 'Format', variant: 'ghost', onClick: async () => {
            const v = id ? await jsonValue(id) : null;
            if (v !== null) await setJsonValue(id, L.prettyJson(v));
            return false;
          },
        },
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
        { id: 'apply', label: 'Apply & refresh', variant: 'primary', onClick: async () => { await apply(); return false; } },
      ],
    });
    popout = { d, apply };
    d.closed.then(() => { if (id) destroyJsonEditor(id); popout = null; });
    const host = d.host;
    id = await createJsonEditor({ host, slotParent: slotBox, value: text, popout: true });
    if (!popout || popout.d !== d) destroyJsonEditor(id);
  }

  // ── Load profile ────────────────────────────────────────────────────────────────────────
  function rememberEmail(email) {
    if (email === lastEmail) return;
    lastEmail = email;
    saveState(names.email, email);
  }

  let loading = false;
  async function loadProfile() {
    const email = bar?.email?.value.trim() || '';
    if (!email || loading) { if (!email) bar?.email?.focus(); return; }
    if (!email.includes('@')) { ui.toast('Enter the user\'s email address.', { tone: 'warn', source: SOURCE }); return; }
    const scope = scopeNow();
    loading = true;
    bar.loadBtn.disabled = true;
    bar.loadBtn.textContent = 'Loading…';
    try {
      let data = null;
      let found;
      try {
        data = await ctx.http.appFetch(appLookupPath('email', email), { signal });
        found = interpretAppLookup({ data });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        found = interpretAppLookup({ errorStatus: Number.isInteger(err?.status) ? err.status : 0, message: err?.message });
      }
      if (signal.aborted) return;
      if (found.status === 'found' && data && typeof data === 'object') {
        // The lookup took a while: only for the template it was asked on.
        if (!await setTestText(JSON.stringify(data, null, 2), scope)) { switchedAway(); return; }
        rememberEmail(email);
        log.info('profile loaded as test data');
        refresh('testData', scope);
      } else if (found.status === 'not-found') {
        ui.toast('No user with that email in this project.', { tone: 'warn', source: SOURCE });
      } else {
        log.warn('profile lookup failed');
        ui.toast(`Couldn't load the profile: ${found.message || 'unknown error'}`, { tone: 'bad', source: SOURCE });
      }
    } finally {
      loading = false;
      if (bar?.loadBtn) { bar.loadBtn.disabled = false; bar.loadBtn.textContent = 'Load profile'; }
    }
  }

  // ── Push new value (field editor, API key) ──────────────────────────────────────────────
  let pusher = null;   // the open dialog
  async function openPusher() {
    if (pusher) return;
    const scope = scopeNow();
    const email = (bar?.email?.value.trim() || lastEmail || '').trim();
    if (!email.includes('@')) {
      ui.toast('Enter the email of the user to push to first.', { tone: 'warn', source: SOURCE });
      bar?.email?.focus();
      return;
    }
    pusher = { opening: true };
    try {
      await ctx.project.refresh();
      if (signal.aborted) return;
      const project = ctx.project.current();
      if (!project) {
        ui.toast('Couldn\'t detect which Iterable project this page is in. Reload the page and try again.', { tone: 'bad', source: SOURCE });
        return;
      }
      const key = await ctx.api.keyStatus(project.key);
      if (signal.aborted) return;
      if (!key.hasKey) { showNoKey(project, key); return; }
      let fields = [];
      try { fields = await getUserFields({ http: ctx.http, projectKey: project.key }, { signal }); } catch (err) {
        if (err?.name === 'AbortError') return;
        log.warn('field list unavailable', err?.code || '', err?.status || 0);
      }
      if (signal.aborted) return;
      showPusher(email, project, fields, scope);
    } finally {
      if (pusher?.opening) pusher = null;
    }
  }

  /** beforeSave: re-check the page's project right before the write (§5.2 pinning rule). */
  function pinProject(pinnedKey) {
    return async () => {
      await ctx.project.refresh({ force: true });
      if (ctx.project.error?.()) return 'Couldn\'t re-check which project this page is in, so nothing was saved. Reload the page and try again.';
      const now = ctx.project.current();
      if (!now || now.key !== pinnedKey) return `The project changed to "${now?.name || 'unknown'}" since this opened, so nothing was saved. Close it and start again.`;
      return null;
    };
  }

  function showPusher(email, project, fields, scope) {
    const ac = new AbortController();
    const recentRow = h('div', { class: 'lp-recent', hidden: !recent.length },
      h('span', { class: 'lbl' }, 'Recent:'),
      recent.map((f) => h('button', { type: 'button', class: 'bub', onClick: () => pickField(f) }, f)));
    const wrap = h('div');
    let editor = null;
    const d = ui.dialog({
      title: 'Push a profile value', source: SOURCE, css: [BAR_CSS, DIALOG_CSS],
      body: h('div', { class: 'lp-dlg' }, recentRow, wrap,
        h('div', { class: 'wb-help' }, 'The value is also applied to the test data until you leave this page, and the preview refreshes.')),
      canDismiss: () => !editor?.busy(),
    });
    pusher = { d };
    const onAbort = () => d.close(null);
    signal.addEventListener('abort', onAbort, { once: true });
    d.closed.then(() => { signal.removeEventListener('abort', onAbort); ac.abort(); if (pusher?.d === d) pusher = null; });
    editor = renderFieldEditor(wrap, {
      ctx: { ...ctx, signal: linkSignal(signal, ac.signal) },
      identity: { email }, projectKey: project.key, fields,
      createNewFields: 'new', beforeSave: pinProject(project.key),
      onCancel: () => d.close(null),
      onClose: () => d.close(null),
      onSaved: async (res) => {
        recent = L.pushRecent(recent, res.field);
        saveState(names.recent, recent);
        if (bar?.email && bar.email.value.trim() !== email) bar.email.value = email;
        rememberEmail(email);
        d.close('saved');
        // The profile write is done; applying the value to the test data (which makes it this
        // template's own) only on the template the push was started on.
        const applied = await inTemplate(scope, async () => {
          overrides.set(res.field, res.value);
          renderOverrides();
          const t = await currentTestText();
          claimTestData(t, scope.tid);
        });
        if (signal.aborted) return;
        if (!applied) {
          ui.toast(`Pushed ${res.field}; the profile updates in Iterable shortly. ${L.SWITCHED_TEXT}`, { tone: 'warn', source: SOURCE });
          return;
        }
        ui.toast(`Pushed ${res.field}. It's applied to the test data now; the profile updates in Iterable shortly.`, { tone: 'ok', source: SOURCE });
        refresh('testData', scope);
      },
    });
    function pickField(f) { editor.setField(f); }
    editor.focus();
  }

  function showNoKey(project, key) {
    const body = h('div', null,
      h('p', { style: 'margin:0 0 6px; font-size:13px; line-height:1.5' }, key.error
        ? `Couldn't read the API key status for "${project.name}": ${key.error.message || 'unknown error'}`
        : `Pushing a value writes to the profile through Iterable's API, and no API key is saved for "${project.name}".`),
      !key.error && h('p', { class: 'wb-help', style: 'margin:0' }, 'Everything else in the live preview works without a key.'));
    const actions = [{ id: 'close', label: 'Close', variant: key.error ? 'primary' : 'ghost' }];
    if (!key.error) {
      actions.push({ id: 'keys', label: 'Add key', variant: 'primary', onClick: () => { ctx.openOptions('keys', { id: project.id || undefined, name: project.name, dataCenter: project.dataCenter }); } });
    }
    const d = ui.dialog({ title: 'API key needed', source: SOURCE, body, actions });
    signal.addEventListener('abort', () => d.close(null), { once: true });
  }

  // ── Shortcuts ───────────────────────────────────────────────────────────────────────────
  let shortcutAc = null;
  function bindShortcuts() {
    shortcutAc?.abort();
    shortcutAc = new AbortController();
    if (!view.open) return;
    const sig = linkSignal(signal, shortcutAc.signal);
    for (const combo of L.editorPlan(settings).refreshKeys) {
      ctx.dom.onShortcut(combo, () => {
        if (pusher) return false;
        if (popout) { popout.apply(); return undefined; }
        refresh('explicit');
        return undefined;
      }, { signal: sig, allowInInputs: true });
    }
  }

  // ── Start ───────────────────────────────────────────────────────────────────────────────
  let startTimer = null;
  function setup(el) {
    if (container === el) return;
    teardownLayout();
    container = el;
    clearTimeout(startTimer);
    startTimer = setTimeout(async () => {
      await stateReady();
      if (signal.aborted || container !== el) return;
      await loadTemplate(L.templateIdFrom(location.search));
      if (signal.aborted || container !== el) return;
      ensureBar();
      applyLayout();
      bindShortcuts();
      attach();
      if (view.open) refresh('show');
    }, START_DELAY_MS);
  }

  function teardownLayout() {
    styles.restore();
    if (inlineId) { destroyJsonEditor(inlineId); inlineId = null; }
    bar?.m.destroy();
    side?.m.destroy();
    bar = null;
    side = null;
  }

  ctx.dom.onElement(SEL.container, setup, { signal });
  // A re-rendered editor element (or Ace initialising later) → hook it again.
  ctx.dom.onElement(SEL.aceEl, () => { if (container) attach(); }, { signal });
  // React may re-render the pane and drop our bar / sidebar: put them back.
  let fixTimer = null;
  const keeper = new MutationObserver(() => {
    if (fixTimer) return;
    fixTimer = setTimeout(() => {
      fixTimer = null;
      if (signal.aborted || !container) return;
      if (!container.isConnected) { teardownLayout(); container = null; return; }
      if (bar) ensureBar();
      if (side && view.open && view.mode === 'live' && side.m.host.parentElement !== container) applyLayout();
    }, 100);
  });
  keeper.observe(document.body || document.documentElement, { childList: true, subtree: true });

  ctx.onSettings((v) => {
    settings = v;
    configure();
    bindShortcuts();
    renderSnippets();
    renderRefresh();
    applyLayout();
  });

  // Another template or locale: reload our own view of it; never save or send anything.
  let lastUrl = { id: L.templateIdFrom(location.search), locale: L.localeFrom(location.search) };
  ctx.onUrlChange(async () => {
    const now = { id: L.templateIdFrom(location.search), locale: L.localeFrom(location.search) };
    if (now.id === lastUrl.id && now.locale === lastUrl.locale) return;
    lastUrl = now;
    if (again) again = { trigger: 'url', target: undefined };   // a queued refresh was for the page before
    if (!container?.isConnected || !stateReadyP) return;   // no code editor here: nothing to do
    updateLocale();
    await loadTemplate(now.id);
    if (signal.aborted) return;
    setSync('synced');
    // Give the page a moment to swap editors (a drag-and-drop template has none): reload only if
    // the code editor is still here and the URL hasn't moved on again.
    await sleep(START_DELAY_MS, signal);
    const still = L.templateIdFrom(location.search) === now.id && L.localeFrom(location.search) === now.locale;
    if (!signal.aborted && still && container?.isConnected && view.open) refresh('url');
  });

  return () => {
    clearTimeout(startTimer);
    clearTimeout(persistTimer);
    offLoad?.();
    clearTimeout(fixTimer);
    keeper.disconnect();
    shortcutAc?.abort();
    for (const id of [...jsonEds.keys()]) destroyJsonEditor(id);
    popout?.d.close(null);
    pusher?.d?.close(null);
    teardownLayout();
  };
}
