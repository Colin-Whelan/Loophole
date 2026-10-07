// Options-page editor for the Usage monitor (every value in meta.js is hidden and owned here).
// Contract (src/options/sections/feature.js):
//   render(container, { values, defaults, save(values), reset(keys?), state, meta }) → cleanup
//
// Limits are read-only (from the last snapshot Loophole stored); only which ones are watched,
// the alert thresholds and the alert channels are edited, as a draft until Save. The desktop
// notification switch asks for the optional "notifications" permission inside its own change
// handler (the browser needs the user gesture; core/permissions.js pattern).

import { h, clear } from '../../core/dom.js';
import { MSG, STORAGE } from '../../core/messages.js';
import * as storage from '../../core/storage.js';
import { button, chip, select, toast, input } from '../../ui/components.js';
import {
  APP_HOSTS, normalizeThresholds, normalizeUnwatched, formatInt, formatTerm, checkedText, firedSummary,
  partyLabel, MAX_THRESHOLDS,
} from './logic.js';
import { allSnapshots, clearCheckGates } from './data.js';

const SOURCE = 'Usage monitor';
const NOTIFY_PERMISSION = { permissions: ['notifications'] };

const CSS = `
.um-ed{display:flex; flex-direction:column; gap:18px}
.um-ed .um-top{display:flex; flex-wrap:wrap; align-items:center; gap:10px}
.um-ed .grow{flex:1}
.um-ed .help{font-size:12px; color:var(--wb-muted); line-height:1.5}
.um-ed .h{font:600 11px var(--wb-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--wb-muted); margin:0}
.um-ed .sect{display:flex; flex-direction:column; gap:10px}
.um-ed .sect-h{display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 12px}
.um-ed .lim{display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--wb-sunken); font-size:13px; cursor:pointer}
.um-ed .lim .num{font-family:var(--wb-mono); font-variant-numeric:tabular-nums; margin-left:auto; color:var(--wb-muted)}
.um-ed input[type="checkbox"]{width:15px; height:15px; margin:0; accent-color:var(--wb-accent)}
.um-ed .chk{display:flex; align-items:center; gap:8px; font-size:13px}
.um-ed .chipsel{display:flex; flex-direction:column; gap:4px; font-size:13px; max-width:360px}
.um-ed .ths{display:flex; flex-wrap:wrap; align-items:center; gap:8px}
.um-ed .th{display:inline-flex; align-items:center; gap:4px; padding:3px 6px 3px 10px; border-radius:999px; font:500 12.5px var(--wb-mono); background:var(--wb-warn-soft); color:var(--wb-warn)}
.um-ed .th.fixed{padding-right:10px; background:var(--wb-bad-soft); color:var(--wb-bad)}
.um-ed .th button{border:0; background:transparent; color:inherit; cursor:pointer; font-size:14px; line-height:1; padding:0 3px; border-radius:50%}
.um-ed .th button:hover{background:var(--wb-surface)}
.um-ed .add{display:inline-flex; gap:6px; align-items:center}
.um-ed .add .wb-input{width:72px}
.um-ed .cols{display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:18px 28px}
.um-ed .foot{display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:flex-end; border-top:1px solid var(--wb-line); padding-top:14px}
.um-ed .msg{font-size:12.5px; color:var(--wb-muted)}
.um-ed .msg.bad{color:var(--wb-bad)}
.um-ed .err{color:var(--wb-bad); font-size:12px}
`;

function cleanDraft(values) {
  return {
    thresholds: normalizeThresholds(values.thresholds),
    unwatched: normalizeUnwatched(values.unwatched),
    banner: values.banner !== false,
    chipMode: ['alert', 'always', 'off'].includes(values.chipMode) ? values.chipMode : 'alert',
    notify: values.notify === true,
  };
}

export function render(container, { values, save, state, meta }) {
  let saved = cleanDraft(values);
  let draft = structuredClone(saved);
  let orgs = [];          // allSnapshots(): [{ slot, org, snap }]
  let access = {};
  let sel = null;         // selected org slot
  let alertState = null;

  const root = h('div', { class: 'um-ed' });
  const statusLine = h('span', { class: 'msg', role: 'status' });
  const lastChecked = h('span', { class: 'help' });
  const orgPick = h('span');
  const limitsBox = h('div', { class: 'sect' });
  const thresholdBox = h('div', { class: 'sect' });
  const channelBox = h('div', { class: 'sect' });
  const dirtyChip = chip('Unsaved changes', { tone: 'warn' });
  dirtyChip.hidden = true;

  root.append(
    h('style', null, CSS),
    h('div', { class: 'um-top' },
      lastChecked, orgPick, h('span', { class: 'grow' }), statusLine,
      button('Check now', { size: 'sm', onClick: checkNow, title: 'Check on the next Iterable page load (now, if an Iterable tab is open)' })),
    limitsBox,
    thresholdBox,
    h('div', { class: 'cols' },
      channelBox,
      h('div', { class: 'sect' },
        h('h3', { class: 'h' }, 'Checking'),
        h('span', null, 'Once a day'),
        h('span', { class: 'help' }, 'The first time Iterable is open in this browser each day (Pacific time). Iterable updates these numbers about once a day, so checking more often wouldn’t show anything new. Opening Usage and billing always reads them fresh.'))),
    h('div', { class: 'foot' },
      dirtyChip,
      button('Revert', { variant: 'ghost', onClick: () => { draft = structuredClone(saved); renderDraft(); } }),
      button('Save', { variant: 'primary', onClick: onSave })),
  );
  container.append(root);

  const isDirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
  const touch = () => { dirtyChip.hidden = !isDirty(); };
  const current = () => orgs.find((o) => o.slot === sel) || null;

  // ── Data from storage ──────────────────────────────────────────────────

  async function loadData() {
    orgs = await allSnapshots(state);
    access = (await state.get('access', {})) || {};
    if (!orgs.some((o) => o.slot === sel)) sel = orgs[0]?.slot || null;
    alertState = sel ? await state.get('alerts:' + sel, null) : null;
    renderData();
  }

  function orgLabel(o) {
    const names = o.org.projectNames || [];
    const n = o.org.projectIds?.length || names.length;
    return `${o.org.host} · ${n} project${n === 1 ? '' : 's'}${names.length ? ` (${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''})` : ''}`;
  }

  function renderData() {
    const o = current();
    lastChecked.textContent = o ? `Last checked ${checkedText(o.snap.at)}` : 'Not checked yet';
    clear(orgPick);
    if (orgs.length > 1) {
      orgPick.append(select({
        ariaLabel: 'Iterable account', value: sel,
        options: orgs.map((x) => ({ value: x.slot, label: orgLabel(x) })),
        onChange: async (v) => { sel = v; alertState = await state.get('alerts:' + sel, null); renderData(); },
      }));
    }
    renderLimits();
    renderThresholds();
  }

  function renderLimits() {
    clear(limitsBox);
    const o = current();
    const deniedHosts = APP_HOSTS.filter((x) => access[x]?.denied);
    limitsBox.append(h('div', { class: 'sect-h' },
      h('h3', { class: 'h' }, 'Watch these contract limits'),
      h('span', { class: 'grow' }),
      o?.snap.term ? h('span', { class: 'help' }, `Read from Iterable · term ${formatTerm(o.snap.term)}`) : null));
    if (!o) {
      limitsBox.append(h('span', { class: 'help' }, deniedHosts.length
        ? `This Iterable login can’t see usage on ${deniedHosts.join(' and ')} (it needs access to Usage and billing), so there is nothing to monitor.`
        : 'No usage read yet. Open Iterable in this browser: Loophole checks on the first page load of the day.'));
      return;
    }
    if (!o.snap.rows.length) {
      limitsBox.append(h('span', { class: 'help' }, 'Iterable reports no contract limits for this account.'));
    }
    for (const r of o.snap.rows) {
      const box = h('input', {
        type: 'checkbox', checked: !draft.unwatched.includes(r.id),
        onChange: (e) => {
          const set = new Set(draft.unwatched);
          if (e.target.checked) set.delete(r.id); else set.add(r.id);
          draft.unwatched = [...set];
          touch();
        },
      });
      limitsBox.append(h('label', { class: 'lim' }, box,
        h('span', null, r.party ? r.label.replace(/\s*\(.*\)$/, '') : r.label,
          r.party || r.kind === 'flow' ? h('span', { class: 'help' }, ` (${[r.party && partyLabel(r.party), r.defaultLimit && 'default', r.kind === 'flow' && (r.period === 'month' ? 'per month' : 'per term')].filter(Boolean).join(', ')})`) : null),
        h('span', { class: 'num' }, formatInt(r.limit))));
    }
    if (deniedHosts.length) {
      limitsBox.append(h('span', { class: 'help' }, `This Iterable login can’t see usage on ${deniedHosts.join(' and ')}.`));
    }
    limitsBox.append(h('span', { class: 'help' }, 'Limits your contract adds later (SMS, push and others) show up here automatically, watched.'));
  }

  function renderThresholds() {
    clear(thresholdBox);
    const err = h('span', { class: 'err', hidden: true });
    const add = h('span', { class: 'add', hidden: true });
    const addInput = input({ type: 'number', min: 1, max: 99, step: 1, ariaLabel: 'New alert threshold (percent)', placeholder: '90' });
    const commitAdd = () => {
      const n = Number(addInput.value);
      if (!Number.isInteger(n) || n < 1 || n > 99) { err.textContent = 'Use a whole number from 1 to 99 (100% always alerts).'; err.hidden = false; return; }
      if (draft.thresholds.includes(n)) { err.textContent = `${n}% is already there.`; err.hidden = false; return; }
      draft.thresholds = normalizeThresholds([...draft.thresholds, n]);
      touch();
      renderThresholds();
    };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } });
    add.append(addInput, h('span', null, '%'), button('Add', { size: 'sm', onClick: commitAdd }));
    const full = draft.thresholds.length >= MAX_THRESHOLDS;
    const fired = sel ? firedSummary(alertState, current()?.snap.rows) : '';

    thresholdBox.append(
      h('h3', { class: 'h' }, 'Alert me at'),
      h('div', { class: 'ths' },
        draft.thresholds.map((t) => h('span', { class: 'th' }, `${t}%`,
          h('button', {
            type: 'button', 'aria-label': `Remove ${t}%`, title: `Remove ${t}%`,
            onClick: () => { draft.thresholds = draft.thresholds.filter((x) => x !== t); touch(); renderThresholds(); },
          }, '×'))),
        h('span', { class: 'th fixed', title: 'Always alerts' }, '100%'),
        button('+ Add threshold', {
          variant: 'ghost', size: 'sm', disabled: full, title: full ? `At most ${MAX_THRESHOLDS}` : undefined,
          onClick: () => { add.hidden = false; addInput.focus(); },
        }),
        add),
      err,
      h('div', { class: 'sect-h' },
        h('span', { class: 'help', style: 'flex:1; min-width:240px' }, 'Each threshold alerts once, then re-arms by itself when usage drops back under it. Over 100% reminds you daily.'),
        button('Reset alerts', { size: 'sm', disabled: !sel, onClick: onResetAlerts })),
      h('span', { class: 'help' }, fired ? `Sent so far: ${fired}.` : 'Nothing has alerted yet.'));
  }

  function renderChannels() {
    clear(channelBox);
    const notifyNote = h('span', { class: 'help', hidden: true });
    const notifyBox = h('input', {
      type: 'checkbox', checked: draft.notify,
      onChange: (e) => {
        if (!e.target.checked) { draft.notify = false; touch(); return; }
        // Ask first, synchronously in the change handler: the browser needs the user gesture.
        let req;
        try { req = chrome.permissions.request(NOTIFY_PERMISSION); } catch (err) { req = Promise.reject(err); }
        draft.notify = true;
        touch();
        req.then((granted) => {
          if (granted) { notifyNote.hidden = true; return; }
          draft.notify = false;
          e.target.checked = false;
          touch();
          notifyNote.textContent = 'Desktop notifications were not allowed.';
          notifyNote.hidden = false;
        }, () => {
          draft.notify = false;
          e.target.checked = false;
          touch();
        });
      },
    });
    const allow = button('Allow', {
      size: 'sm',
      onClick: () => chrome.permissions.request(NOTIFY_PERMISSION).then(() => renderChannels()).catch(() => {}),
    });
    const notGranted = h('span', { class: 'help', hidden: true }, 'Not allowed in this browser right now. ', allow);
    if (saved.notify) {
      chrome.permissions.contains(NOTIFY_PERMISSION).then((ok) => { notGranted.hidden = ok; }).catch(() => {});
    }
    channelBox.append(
      h('h3', { class: 'h' }, 'How to alert'),
      h('label', { class: 'chk' }, h('input', {
        type: 'checkbox', checked: draft.banner, onChange: (e) => { draft.banner = e.target.checked; touch(); },
      }), 'Banner across Iterable'),
      h('div', { class: 'chipsel' }, h('span', null, 'Usage chip in the header'),
        select({
          ariaLabel: 'Usage chip in the header', value: draft.chipMode,
          options: meta.settings.find((f) => f.key === 'chipMode').options,
          onChange: (v) => { draft.chipMode = v; touch(); },
        })),
      h('label', { class: 'chk' }, notifyBox, 'Desktop notification'),
      notifyNote,
      notGranted,
      h('span', { class: 'help' }, 'While a watched limit is past an alert threshold, the Loophole toolbar button shows its percentage.'));
  }

  function renderDraft() {
    renderLimits();
    renderThresholds();
    renderChannels();
    touch();
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async function onSave() {
    try {
      await save({ ...draft });
      saved = structuredClone(draft);
      touch();
    } catch (e) {
      toast(`Couldn’t save: ${e?.message || e}`, { tone: 'bad', source: SOURCE });
    }
  }

  async function onResetAlerts() {
    if (!sel) return;
    await state.remove('alerts:' + sel);
    alertState = null;
    renderThresholds();
    toast('Alerts reset. Every threshold can alert again.', { tone: 'ok', source: SOURCE });
  }

  async function checkNow() {
    statusLine.className = 'msg';
    statusLine.textContent = 'Asking…';
    await clearCheckGates(state);
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: APP_HOSTS.map((x) => `https://${x}/*`) }); } catch { /* none visible */ }
    let started = 0;
    for (const t of tabs) {
      const res = await chrome.tabs.sendMessage(t.id, { type: MSG.FEATURE_REQUEST, featureId: meta.id, action: 'check-now' }, { frameId: 0 }).catch(() => null);
      if (res?.ok) started++;
    }
    statusLine.textContent = started
      ? 'Checking in your open Iterable tab…'
      : 'Open Iterable (or reload an Iterable tab) and it checks on that page load.';
  }

  // Snapshots, alerts and the org index change when an Iterable tab checks: show them live.
  const prefix = `${STORAGE.STATE_PREFIX}${meta.id}:`;
  const off = storage.onChanged((changes) => {
    const keys = Object.keys(changes).filter((k) => k.startsWith(prefix) && !k.startsWith(prefix + 'check:'));
    if (!keys.length) return;
    if (keys.some((k) => k.startsWith(prefix + 'snap:'))) statusLine.textContent = '';
    loadData().catch(() => {});
  });

  renderDraft();
  loadData().catch((e) => {
    statusLine.className = 'msg bad';
    statusLine.textContent = `Couldn’t read stored usage: ${e?.message || e}`;
  });

  return () => off();
}
