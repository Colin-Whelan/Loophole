// Usage monitor: compares the org's usage with its contract limits and alerts before (and after)
// a limit is reached. Iterable has no such alert itself.
//
// - Checks at most once a day per org, on the first Iterable page load of the PST day, shared by
//   every tab through extension storage (a short lock so two tabs don't both fetch).
// - Usage and billing (/payments/info) always fetches fresh and gets the usage card at the top.
// - Alerts (logic.js evaluateAlerts): the banner across Iterable, the header chip in the Loophole
//   strip, a desktop notification (background, wb:usage:notify) when switched on. The toolbar
//   badge is the background's job: it follows the stored snapshots.
// Quiet when nothing is past a threshold, and for logins that can't read usage (401/403).
// Privacy: never log usage numbers or project names; statuses only.

import { MSG, STORAGE } from '../../core/messages.js';
import * as storage from '../../core/storage.js';
import {
  BILLING_PATH, pstDay, shouldCheck, lockEntry, holdsLock, gateAfter, isDenied, unknownSlot, evaluateAlerts,
  watchedRows, chipModel, bannerVisible, dismissAlerts, snoozeAlerts, normalizeAlertState, alertText,
  notificationText, projection, projectionText, normalizeThresholds,
} from './logic.js';
import { fetchSnapshot, saveSnapshot, setAccessDenied, loadForProject } from './data.js';
import { usageCard, USAGE_CSS } from './view.js';

const SOURCE = 'Usage monitor';
const NAV_ORDER = 30;
const ANCHOR_TICK_MS = 1000;

/**
 * Where the card goes on Usage and billing: right after the page heading (or the header row that
 * holds it), else at the top of the main content. Selectors in one place for markup changes.
 */
export const CARD_ANCHOR = {
  headings: 'h1, h2',
  headingText: /usage\s*(and|&)\s*billing/i,
  main: 'main, [role="main"]',
};

const BANNER_CSS = `
.um-banner{position:fixed; left:50%; transform:translateX(-50%); width:min(980px, calc(100vw - 32px)); display:flex; align-items:center; gap:12px; padding:10px 12px 10px 16px; border-radius:var(--wb-r-lg); box-shadow:var(--wb-shadow); border:1px solid var(--wb-warn); background:var(--wb-warn-soft); color:var(--wb-ink); font-size:13px}
.um-banner.bad{border-color:var(--wb-bad); background:var(--wb-bad-soft)}
.um-banner svg{width:20px; height:20px; flex:none; color:var(--wb-warn)}
.um-banner.bad svg{color:var(--wb-bad)}
.um-banner .txt{display:flex; flex-direction:column; gap:2px; flex:1; min-width:0}
.um-banner .t{font-weight:600; font-size:14px}
.um-banner .d{color:var(--wb-muted); font-family:var(--wb-mono); font-size:12px; overflow-wrap:anywhere}
.um-banner .acts{display:flex; align-items:center; gap:4px; flex:none}
.um-banner .wb-x{border:0; background:transparent; width:30px; height:30px; border-radius:var(--wb-r); cursor:pointer; color:var(--wb-muted); font-size:18px; line-height:1}
.um-banner .wb-x:hover{background:var(--wb-surface); color:var(--wb-ink)}
@media (max-width:720px){ .um-banner{flex-wrap:wrap} .um-banner .acts{width:100%; justify-content:flex-end} }
`;

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function warnIcon(h) {
  return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    h('path', { d: 'M12 8v5M12 16.5v.5M12 3l9.5 17h-19Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

export function mount(ctx) {
  const { ui, dom, state, signal, log } = ctx;
  const { h, linkSignal } = dom;
  const host = location.hostname;

  let values = ctx.settings;
  let projectId = null;
  let slot = null;        // org slot once known
  let snap = null;        // last snapshot for this org
  let alerts = null;      // alert state for this org
  let denied = false;     // this login can't read usage
  let checking = null;    // the fetch in flight (shared by the gate path and the card)

  const gateName = () => 'check:' + (slot || unknownSlot(host, projectId));
  const onBilling = () => location.pathname === BILLING_PATH || location.pathname.startsWith(BILLING_PATH + '/');
  const thresholds = () => normalizeThresholds(values.thresholds);

  // ── Org + stored state ─────────────────────────────────────────────────

  async function resolveOrg() {
    const p = await ctx.project.refresh();
    projectId = p?.id ?? null;
    const r = await loadForProject(state, host, projectId);
    slot = r.slot;
    snap = r.snap;
    alerts = slot ? await state.get('alerts:' + slot, null) : null;
    const gate = await state.get(gateName(), null);
    denied = !!(gate?.noAccess && gate.day === pstDay());
  }

  // ── Fetching ───────────────────────────────────────────────────────────

  /** Fetch now (no gate). → { status: 'ok' | 'denied' | 'error', error? } */
  function fetchNow() {
    if (checking) return checking;
    checking = (async () => {
      const gate = gateName();
      const now = Date.now();
      const today = pstDay(now);
      try {
        const s = await fetchSnapshot(ctx.http, { today, now, host, signal });
        if (signal.aborted) return { status: 'error', error: 'stopped' };
        const newSlot = await saveSnapshot(state, s, { fallbackProjectId: projectId, gate: gateAfter('ok', { today, now }) });
        if (gate !== 'check:' + newSlot) await state.remove(gate);
        slot = newSlot;
        snap = s;
        denied = false;
        await runAlerts(today);
        log.debug('usage checked');
        return { status: 'ok' };
      } catch (e) {
        if (signal.aborted) return { status: 'error', error: 'stopped' };
        if (isDenied(e)) {
          await state.set(gate, gateAfter('denied', { today, now }));
          await setAccessDenied(state, host, now);
          denied = true;
          renderAlerts();
          log.debug('usage not readable with this login:', e.status);
          return { status: 'denied' };
        }
        await state.set(gate, gateAfter('failed', { today, now }));
        log.warn('usage check failed:', e?.status || e?.name || 'error');
        return { status: 'error', error: e?.status ? `HTTP ${e.status}` : 'network error' };
      }
    })().finally(() => { checking = null; });
    return checking;
  }

  /** The once-a-day path: only when the gate says so and this tab wins the lock. */
  async function maybeCheck() {
    if (checking || signal.aborted) return;
    const name = gateName();
    const entry = await state.get(name, null);
    const now = Date.now();
    if (!shouldCheck(entry, { today: pstDay(now), now })) return;
    const lockId = crypto.randomUUID();
    await state.set(name, lockEntry(entry, { now, lockId }));
    await sleep(300 + Math.random() * 500, signal);
    if (signal.aborted || !holdsLock(await state.get(name, null), lockId)) return;
    await fetchNow();
  }

  async function runAlerts(today) {
    if (!slot || !snap) return;
    const prev = await state.get('alerts:' + slot, null);
    const { state: next, firings } = evaluateAlerts(prev, { rows: watchedRows(snap.rows, values.unwatched), thresholds: thresholds(), today });
    await state.set('alerts:' + slot, next);
    alerts = next;
    if (firings.length && values.notify) {
      const n = notificationText(firings[0]);
      chrome.runtime.sendMessage({ type: MSG.USAGE_NOTIFY, title: n.title, message: n.message }).catch(() => {});
    }
    renderAlerts();
  }

  // ── Header chip ────────────────────────────────────────────────────────

  let chip = null; // { ac, item }

  function renderChip() {
    const model = !denied && snap && values.chipMode !== 'off'
      ? chipModel(watchedRows(snap.rows, values.unwatched), thresholds(), values.chipMode) : null;
    if (!model) {
      chip?.ac.abort();
      chip = null;
      return;
    }
    if (!chip) {
      const ac = new AbortController();
      chip = { ac, item: ui.navSlot({ featureId: ctx.featureId, order: NAV_ORDER, signal: linkSignal(signal, ac.signal) }) };
    }
    dom.replaceChildren(chip.item, h('a', {
      class: ['wb-chip', model.tone], href: BILLING_PATH, title: model.title, 'aria-label': model.title,
      style: { textDecoration: 'none', fontSize: '12px', padding: '3px 9px', fontWeight: '600' },
      'data-test': 'usage-monitor-chip',
    }, h('span', { class: 'dot' }), model.text));
  }

  // ── Banner ─────────────────────────────────────────────────────────────

  let banner = null; // mountOverlay result

  function placeBanner() {
    if (!banner) return;
    const nav = document.querySelector(ui.NAVBAR.navbar);
    const bottom = nav ? nav.getBoundingClientRect().bottom : 0;
    banner.el.firstElementChild?.style.setProperty('top', `${Math.max(8, Math.round(bottom) + 8)}px`);
  }

  function hideBanner() {
    banner?.destroy();
    banner = null;
  }

  async function updateAlerts(fn) {
    if (!slot) return;
    const next = fn(await state.get('alerts:' + slot, null));
    await state.set('alerts:' + slot, next);
    alerts = next;
    renderAlerts();
  }

  function renderBanner() {
    const a = alerts ? normalizeAlertState(alerts) : null;
    // Not on Usage and billing itself: the card there says the same, without covering the page.
    if (!values.banner || denied || onBilling() || !a || !bannerVisible(a, Date.now())) { hideBanner(); return; }
    const top = a.pending[0];
    const row = snap?.rows.find((r) => r.id === top.id);
    const text = alertText(top, {
      more: a.pending.length - 1,
      projectionLine: row ? projectionText(projection(row, thresholds()), { refDay: snap.day }) : '',
    });
    if (!banner) {
      banner = ui.mountOverlay('float');
      banner.root.prepend(h('style', null, BANNER_CSS));
    }
    dom.replaceChildren(banner.el, h('div', { class: ['um-banner', text.tone], role: 'alert', 'aria-label': `${SOURCE}: ${text.title}` },
      warnIcon(h),
      h('div', { class: 'txt' }, h('span', { class: 't' }, text.title), h('span', { class: 'd' }, text.detail)),
      h('div', { class: 'acts' },
        h('a', { class: 'wb-btn sm', href: BILLING_PATH }, 'View usage'),
        ui.button('Remind me tomorrow', { variant: 'ghost', size: 'sm', trusted: true, onClick: () => updateAlerts((s) => snoozeAlerts(s, Date.now())) }),
        h('button', {
          type: 'button', class: 'wb-x', 'aria-label': 'Dismiss', title: 'Dismiss',
          onClick: dom.trusted(() => updateAlerts(dismissAlerts)),
        }, '×'))));
    placeBanner();
  }

  function renderAlerts() {
    if (signal.aborted) return;
    renderChip();
    renderBanner();
  }

  window.addEventListener('resize', placeBanner, { signal });

  // ── Card on Usage and billing ──────────────────────────────────────────

  let card = null; // { m, model, timer, anchor }

  function findAnchor() {
    const heading = [...document.querySelectorAll(CARD_ANCHOR.headings)].find((el) => CARD_ANCHOR.headingText.test(el.textContent || ''));
    const main = document.querySelector(CARD_ANCHOR.main);
    if (heading) {
      let node = heading;
      while (node.parentElement && node.parentElement !== main && node.parentElement.children.length === 1) node = node.parentElement;
      // A header row (heading beside buttons): go below the whole row.
      const p = node.parentElement;
      if (p && p !== main && p !== document.body) {
        const cs = getComputedStyle(p);
        if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection)) node = p;
      }
      return { target: node, where: 'after' };
    }
    if (main) return { target: main, where: 'prepend' };
    return null;
  }

  function renderCard() {
    if (!card?.m) return;
    dom.replaceChildren(card.m.el, usageCard({ ...card.model, values: { ...values, thresholds: thresholds() } }, {
      onSettings: () => ctx.openOptions(),
      onRetry: () => loadCard(),
      onTab: (id) => { card.model.tab = id; renderCard(); },
    }));
  }

  function anchorCard() {
    if (!card) return;
    if (card.m?.host.isConnected) return;
    const a = findAnchor();
    if (!a) return;
    card.m?.destroy();
    card.m = ui.mountInline(a.target, a.where, { className: 'um-host', display: 'block' });
    card.m.root.prepend(h('style', null, USAGE_CSS));
    renderCard();
  }

  async function loadCard() {
    if (!card) return;
    card.model = { ...card.model, status: 'loading', snap };
    renderCard();
    const res = await fetchNow();
    if (!card) return;
    card.model = { ...card.model, status: res.status, error: res.error, snap };
    renderCard();
  }

  function showCard() {
    if (card) return;
    card = { m: null, model: { status: 'loading', snap, tab: 'users' } };
    card.timer = setInterval(anchorCard, ANCHOR_TICK_MS);
    anchorCard();
    loadCard();
  }

  function hideCard() {
    if (!card) return;
    clearInterval(card.timer);
    card.m?.destroy();
    card = null;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  const prefix = `${STORAGE.STATE_PREFIX}${ctx.featureId}:`;
  const offStorage = storage.onChanged((changes) => {
    if (!slot) return;
    let touched = false;
    if (changes[prefix + 'alerts:' + slot]) { alerts = changes[prefix + 'alerts:' + slot].newValue ?? null; touched = true; }
    if (changes[prefix + 'snap:' + slot]) {
      snap = changes[prefix + 'snap:' + slot].newValue ?? null;
      touched = true;
      if (card && card.model.status !== 'loading') { card.model = { ...card.model, snap }; renderCard(); }
    }
    if (touched) renderAlerts();
  });

  ctx.onSettings((v) => {
    values = v;
    renderAlerts();
    renderCard();
  });

  // "Check now" from the options page: the gates were just cleared there, so the normal path runs.
  ctx.onAction('check-now', () => {
    maybeCheck().catch((e) => log.warn('check failed', e?.name));
    return { started: true };
  });

  ctx.onUrlChange(() => {
    if (onBilling()) showCard(); else hideCard();
    renderBanner();
  });

  resolveOrg().then(() => {
    if (signal.aborted) return;
    renderAlerts();
    if (onBilling()) showCard();
    else return maybeCheck();
  }).catch((e) => log.warn('start failed', e?.name || e));

  return () => {
    offStorage();
    hideCard();
    hideBanner();
  };
}
