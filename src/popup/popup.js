// Toolbar popup (mockup: "Toolbar popup").
// States: (a) Iterable tab with Loophole running, (b) Iterable tab opened before Loophole
// (content script missing), (c) Firefox without the host-permission grant, (d) any other tab
// (on a sign-in host, (d) lists the sign-in features so they can be switched on right there).

import { MSG, CAPTURE_COMMAND } from '../core/messages.js';
import { h, clear } from '../core/dom.js';
import * as settings from '../core/settings.js';
import { setKey } from '../core/keys.js';
import { matchRoute, isCatchAll } from '../core/router.js';
import {
  hasHostAccess, requestHostAccess, isIterableAppUrl, hasFeatureAccess, setFeatureEnabledFromClick, removeOrigins, originLabel,
} from '../core/permissions.js';
import { featureOrigins, featureMatchesOrigin } from '../core/feature-frames.js';
import { FEATURES, hasSettings } from '../features/registry.js';
import { themed, watchGeneralSettings } from '../ui/theme.js';
import { mark, iconButton, button, switchInput, chip, input } from '../ui/components.js';
import { createState } from '../core/state.js';
import { FEATURE_ID as USAGE_ID, APP_HOSTS, BILLING_PATH, snapshotStatus } from '../features/usage-monitor/logic.js';
import { loadForProject } from '../features/usage-monitor/data.js';
import { usageSummary, USAGE_CSS, POPUP_CSS } from '../features/usage-monitor/view.js';

const app = document.getElementById('app');
const MANIFEST = chrome.runtime.getManifest();
// Store builds get an update_url; a zip loaded unpacked / as a temporary add-on has none.
const VERSION_LINE = 'v' + MANIFEST.version + (MANIFEST.update_url ? '' : ' · unpacked');
const REPORT_PROBLEM_URL = 'https://github.com/Colin-Whelan/loophole/issues';

themed(document.body);

async function openOptions(section, params) {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS, section, params });
    if (!res?.ok) throw new Error('not handled');
  } catch {
    const qs = params ? '?' + new URLSearchParams(params) : '';
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html' + (section ? '#' + section + qs : '')) });
  }
  window.close();
}

function header() {
  return h('div', { class: 'popup-top' },
    mark({ large: true }),
    h('div', { style: 'flex:1' }, h('div', { class: 'n' }, 'Loophole for Iterable'), h('div', { class: 'v' }, VERSION_LINE)),
    iconButton('gear', { label: 'Settings', onClick: () => openOptions() }));
}

function footer() {
  const report = () => { chrome.tabs.create({ url: REPORT_PROBLEM_URL }); window.close(); };
  return h('div', { class: 'popup-foot' },
    button('All settings', { variant: 'ghost', size: 'sm', onClick: () => openOptions() }),
    button('Report a problem', {
      variant: 'ghost', size: 'sm', onClick: report,
      title: 'Opens the Loophole issue tracker on GitHub. Never paste API keys or customer data.',
    }));
}

function show(...nodes) {
  // Sections return nested arrays and nulls; append() would stringify those.
  clear(app).append(header(), ...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

// ── (c) Firefox: host permission not granted yet ─────────────────────────

function renderNeedsPermission() {
  show(
    h('div', { class: 'msg center' },
      h('strong', null, 'Loophole needs access to Iterable'),
      'Firefox asks you to allow each site an extension works on. Allow Iterable and the drag-and-drop editor, then reload your Iterable tabs.'),
    h('div', { class: 'center-acts' },
      button('Allow Loophole on Iterable', {
        variant: 'primary',
        // No await before request(): it must run inside the click's user gesture.
        onClick: () => requestHostAccess().then((granted) => { if (granted) init(); }).catch(() => {}),
      })),
    footer());
}

// ── (d) Not an Iterable tab ──────────────────────────────────────────────

async function renderNotIterable(tab) {
  let origin = '';
  try { origin = new URL(tab?.url || '').origin; } catch { /* no url (no tabs permission) */ }
  const signIn = FEATURES.filter((m) => m.frame === 'auth' && featureMatchesOrigin(m, origin));
  if (signIn.length) {
    const resolved = await settings.load();
    const statusLine = h('div', { class: 'popup-status', hidden: true });
    show(
      h('div', { class: 'msg' }, 'Sign-in tools run on this page once they are switched on and your browser allows Loophole here. Reload the page after switching one on.'),
      statusLine,
      h('div', { class: 'sect-l' }, 'On this sign-in page'),
      await Promise.all(signIn.map((m) => featureRow(m, { resolved, statusLine }))),
      footer());
    return;
  }
  show(
    h('div', { class: 'msg center' },
      h('strong', null, 'Nothing to do on this page'),
      'Loophole works on app.iterable.com and app.eu.iterable.com. Open Iterable in this tab to see the tools for each page.'),
    h('div', { class: 'center-acts' }, button('Settings', { onClick: () => openOptions() })),
  );
}

// ── Feature switches ─────────────────────────────────────────────────────

/**
 * A feature's switch. Features with optional hosts (meta.permissions) ask for access inside the
 * change handler (it needs the user gesture; Firefox may close this popup while its prompt is up,
 * which is fine: the flag is already written and the background registers the script once the
 * grant arrives) and offer to give access back when switched off.
 */
async function featureSwitch(meta, { resolved, statusLine }) {
  const s = resolved.features[meta.id];
  const needsAccess = featureOrigins(meta).length > 0;
  const hosts = featureOrigins(meta).map(originLabel).join(', ');
  const granted = needsAccess ? await hasFeatureAccess(meta) : true;
  const say = (...nodes) => { clear(statusLine).append(...nodes); statusLine.hidden = !nodes.length; };
  const sw = switchInput({
    checked: s.enabled, label: meta.name,
    onChange: (on) => {
      if (!needsAccess) {
        settings.setFeatureEnabled(meta.id, on).then(() => setTimeout(init, 400)); // let the tab (un)mount first
        return;
      }
      setFeatureEnabledFromClick(meta, on, { setEnabled: settings.setFeatureEnabled, metas: FEATURES }).then((r) => {
        if (r.denied) { sw.input.checked = false; say(`${meta.name} stays off: access to ${hosts} was not granted.`); return; }
        if (r.removable?.length) {
          say(`Loophole can still read ${r.removable.map(originLabel).join(', ')}. `,
            button('Remove access', { size: 'sm', onClick: () => removeOrigins(r.removable).then(() => init()) }));
          return;
        }
        setTimeout(init, 400);
      }).catch(() => {});
    },
  });
  return { sw, needsChip: needsAccess && s.enabled && !granted ? chip('needs access', { tone: 'warn' }) : null };
}

async function featureRow(meta, { resolved, statusLine }) {
  const { sw, needsChip } = await featureSwitch(meta, { resolved, statusLine });
  const acts = h('div', { class: 'acts' });
  if (hasSettings(meta)) {
    acts.append(iconButton('gear', { label: `${meta.name} settings`, onClick: () => openOptions('feature', { id: meta.id }) }));
  }
  return h('div', { class: 'feat' }, sw,
    h('div', null, h('div', { class: 'fn' }, meta.name, needsChip), h('div', { class: 'fd' }, meta.description)),
    acts);
}

// ── (b) Iterable tab without the content script ──────────────────────────

function renderNeedsReload(tab) {
  show(
    h('div', { class: 'msg center' },
      h('strong', null, 'Reload this tab to start Loophole'),
      'This tab was open before Loophole was installed or updated, so it is not running here yet.'),
    h('div', { class: 'center-acts' },
      button('Reload tab', { variant: 'primary', onClick: async () => { await chrome.tabs.reload(tab.id); window.close(); } })),
    footer());
}

// ── (a) Iterable tab, Loophole running ──────────────────────────────────

async function renderActive(tab, status) {
  const resolved = await settings.load();
  const project = status.project;
  const keyState = project ? await chrome.runtime.sendMessage({ type: MSG.KEYS_STATUS, projectKey: project.key }).catch(() => null) : null;
  const hasKey = !!keyState?.hasKey;
  const mounted = new Set(status.mounted || []);

  const url = new URL(status.url || tab.url);
  const target = url.pathname + url.search;
  const top = FEATURES.filter((m) => (m.frame || 'top') === 'top');
  const onPage = top.filter((m) => !isCatchAll(m) && matchRoute(m.routes, target));
  const everywhere = top.filter((m) => isCatchAll(m));
  const bee = FEATURES.filter((m) => m.frame === 'bee');
  const signIn = FEATURES.filter((m) => m.frame === 'auth');

  const statusLine = h('div', { class: 'popup-status', hidden: true });
  const showError = (text) => { statusLine.textContent = text; statusLine.hidden = !text; };

  async function activeRow(meta) {
    const s = resolved.features[meta.id];
    const acts = h('div', { class: 'acts' });
    const canAct = s.enabled && (meta.frame === 'bee' || mounted.has(meta.id));
    for (const a of meta.actions || []) {
      if (!canAct) continue;
      if (a.routes && !matchRoute(a.routes, target)) continue;
      if (a.popup === 'capture') {
        const btn = button(a.label, { variant: 'primary', size: 'sm', onClick: () => captureFromPopup(tab, meta, btn, showError) });
        acts.prepend(btn);
        // The key the browser actually bound to the command (it may differ from the suggestion).
        captureShortcut().then((key) => { btn.title = key ? `${a.label} (${key} on a campaign page)` : `${a.label} (no keyboard shortcut set: see your browser’s extension shortcuts)`; });
        continue;
      }
      const run = async () => {
        const res = await chrome.tabs.sendMessage(tab.id,
          { type: MSG.FEATURE_ACTION, featureId: meta.id, action: a.id },
          meta.frame === 'bee' ? undefined : { frameId: 0 }).catch(() => null);
        if (res?.ok) window.close();
        else showError(res?.error?.message || `${meta.name} did not respond. Try reloading the tab.`);
      };
      acts.append(a.id === 'open'
        ? iconButton('open', { label: `${a.label} ${meta.name.toLowerCase()}`, onClick: run })
        : button(a.label, { variant: 'ghost', size: 'sm', onClick: run }));
    }
    if (hasSettings(meta)) {
      acts.append(iconButton('gear', { label: `${meta.name} settings`, onClick: () => openOptions('feature', { id: meta.id }) }));
    }
    const { sw, needsChip } = await featureSwitch(meta, { resolved, statusLine });
    return h('div', { class: 'feat' },
      sw,
      h('div', null,
        h('div', { class: 'fn' }, meta.name,
          meta.usesApiKey && project && !hasKey && s.enabled ? chip('needs key', { tone: 'warn' }) : null,
          needsChip),
        h('div', { class: 'fd' }, meta.description)),
      acts);
  }

  const section = async (label, metas, emptyText) => [
    h('div', { class: 'sect-l' }, label),
    metas.length ? await Promise.all(metas.map(activeRow)) : h('div', { class: 'empty' }, emptyText),
  ];

  show(
    projectCard(project, keyState),
    await usageSection(tab, url, project, resolved),
    !project || hasKey ? null : quickKeyForm(project),
    statusLine,
    await section('On this page', onPage, 'No tools for this page.'),
    everywhere.length ? await section('Everywhere', everywhere) : null,
    bee.length ? await section('In the drag-and-drop editor', bee) : null,
    signIn.length ? await section('On the sign-in page', signIn) : null,
    footer(),
  );
}

/**
 * "Copy approval screenshot": the toolbar click that opened this popup granted activeTab on the
 * tab, so the popup captures it itself. The feature first opens / prepares its approval view
 * (hides its own buttons) and starts its capture guard (it refuses when something covers the
 * view); right after the capture it checks again (capture-done) and the image is dropped unless
 * the view was intact. The clipboard write happens here (a focused extension page, right after
 * the click); if the browser refuses, the PNG goes to Campaign checks' content script (memory,
 * never the page's DOM), which offers Copy / Save (Save opens the extension's capture page).
 */
/** The key bound to the "Copy approval screenshot" command, or ''. */
async function captureShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    return cmds.find((c) => c.name === CAPTURE_COMMAND)?.shortcut || '';
  } catch { return ''; }
}

async function captureFromPopup(tab, meta, btn, showError) {
  const ask = (action, payload) => chrome.tabs.sendMessage(tab.id,
    { type: MSG.FEATURE_REQUEST, featureId: meta.id, action, payload }, { frameId: 0 }).catch(() => null);
  btn.disabled = true;
  showError('');
  try {
    const prep = await ask('capture-prepare');
    if (!prep?.ok || prep.result?.ready !== true) {
      showError(prep?.result?.reason || prep?.error?.message || `${meta.name} did not respond. Try reloading the tab.`);
      return;
    }
    const captureId = typeof prep.result.captureId === 'string' ? prep.result.captureId : '';
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e) {
      await ask('capture-done', { captureId });
      showError(`Couldn’t capture the tab: ${e?.message || e}`);
      return;
    }
    const done = await ask('capture-done', { captureId });
    if (!done?.ok || done.result?.intact !== true) {
      dataUrl = null; // discarded: the approval view wasn't cleanly on screen
      showError(done?.result?.reason || 'The approval view couldn’t be checked, so the screenshot was discarded.');
      return;
    }
    let copied = false;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    } catch { /* offered in the approval view instead */ }
    if (copied) {
      btn.textContent = 'Screenshot copied';
      setTimeout(() => window.close(), 900);
      return;
    }
    await ask('capture-result', { dataUrl, captureId });
    showError('Your browser didn’t allow the clipboard from here: the screenshot is waiting in the approval view (Copy / Save).');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Usage monitor: the last stored snapshot for this tab's org (host + current project), or nothing
 * when the feature is off or hasn't read this org's usage yet. Read-only; no request is made.
 */
async function usageSection(tab, url, project, resolved) {
  const f = resolved.features[USAGE_ID];
  if (!f?.enabled || project?.id == null || !APP_HOSTS.includes(url.hostname)) return null;
  let snap = null;
  let access = {};
  try {
    const st = createState(USAGE_ID);
    ({ snap } = await loadForProject(st, url.hostname, project.id));
    access = await st.get('access', {});
  } catch { return null; }
  if (!snap || !Array.isArray(snap.rows)) return null;
  const el = usageSummary(snap, f.values, { status: snapshotStatus(snap, { now: Date.now(), access }) });
  el.append(h('div', { class: 'um-pop-acts' },
    button('Open Usage and billing', {
      variant: 'primary', size: 'sm',
      onClick: async () => { await chrome.tabs.update(tab.id, { url: `https://${url.hostname}${BILLING_PATH}` }); window.close(); },
    }),
    button('Settings', { variant: 'ghost', size: 'sm', onClick: () => openOptions('feature', { id: USAGE_ID }) })));
  return [h('style', null, USAGE_CSS + POPUP_CSS), el];
}

function projectCard(project, keyState) {
  let keyChip;
  if (!project) keyChip = chip('Not detected', { tone: undefined, dot: true });
  else if (keyState?.hasKey) keyChip = chip('Key saved', { tone: 'ok', dot: true });
  else keyChip = chip('No key', { tone: 'warn', dot: true });
  return h('div', { class: 'proj' },
    h('span', { class: 'l' }, 'Project on this tab'),
    h('span', { class: 'p' }, project ? project.name : 'No project detected yet'),
    keyChip);
}

function quickKeyForm(project) {
  const err = h('div', { class: 'quickkey-err', hidden: true });
  const field = input({ mono: true, placeholder: 'Paste a server-side API key', ariaLabel: `API key for ${project.name}`, type: 'password' });
  const save = async () => {
    err.hidden = true;
    try {
      await setKey({ projectKey: project.key, name: project.name, dataCenter: project.dataCenter, apiKey: field.value.trim() });
      init();
    } catch (e) {
      err.textContent = e?.message || 'Could not save the key.';
      err.hidden = false;
    }
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  return [
    h('div', { class: 'msg' }, 'Tools that call the Iterable API are paused on this project until you add a key. The key stays in this browser.'),
    h('div', { class: 'quickkey' }, field, button('Save', { variant: 'primary', onClick: save })),
    err,
  ];
}

// ── Entry ────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!(await hasHostAccess())) return renderNeedsPermission();
  if (!tab || !isIterableAppUrl(tab.url)) return renderNotIterable(tab);
  let status = null;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: MSG.TAB_STATUS }, { frameId: 0 });
  } catch { /* no content script in this tab */ }
  if (!status) return renderNeedsReload(tab);
  return renderActive(tab, status);
}

watchGeneralSettings();
init().catch((e) => {
  console.error('[Loophole:popup]', e);
  show(h('div', { class: 'msg center' }, h('strong', null, 'Something went wrong'), String(e?.message || e)), footer());
});
