// Usage monitor: DOM for the usage card (Usage and billing page, both tabs) and the compact
// summary the toolbar popup shows. Everything Iterable sends is rendered as text (h() children),
// never as markup. CSS uses theme tokens only, so it works in a shadow root and in the popup.

import { h } from '../../core/dom.js';
import { chip, button, tabs as tabStrip } from '../../ui/components.js';
import {
  formatInt, formatCompact, formatPercent, formatDay, formatTerm, rowState, projection, projectionText,
  alertLevels, normalizeThresholds, normalizeUnwatched, reachedLevel, checkedText,
} from './logic.js';

export const USAGE_CSS = `
.um-card{background:var(--wb-surface); border:1px solid var(--wb-line); border-radius:var(--wb-r-lg); box-shadow:var(--wb-shadow); overflow:hidden; margin:0 0 20px; font-size:13px}
.um-head{display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px; padding:12px 20px; background:var(--wb-raised); border-bottom:1px solid var(--wb-line)}
.um-head h2{margin:0; font-size:15px; font-weight:600}
.um-brand{display:inline-flex; align-items:center; gap:6px; padding:2px 9px; border:1px solid var(--wb-accent); border-radius:var(--wb-r); color:var(--wb-accent-strong); font-size:12px; font-weight:600}
.um-brand::before{content:""; width:7px; height:7px; background:var(--wb-accent); transform:rotate(45deg); border-radius:1px}
.um-head .wb-tabs{border-bottom:0}
.um-grow{flex:1}
.um-sub{font-size:12.5px; color:var(--wb-muted)}
.um-lbl{font:600 11px var(--wb-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--wb-muted)}
.um-num{font-family:var(--wb-mono); font-variant-numeric:tabular-nums}
.um-main{display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
.um-main.solo{grid-template-columns:minmax(0,1fr)}
.um-primary{padding:20px; display:flex; flex-direction:column; gap:14px; min-width:0}
.um-main:not(.solo) .um-primary{border-right:1px solid var(--wb-line)}
.um-row{display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 12px}
.um-big{font-size:38px; font-weight:500; letter-spacing:-.02em; line-height:1.1}
.um-pct{font-size:24px; font-weight:500}
.um-pct.over{color:var(--wb-bad)} .um-pct.warn{color:var(--wb-warn)} .um-pct.ok{color:var(--wb-accent-strong)} .um-pct.unknown{color:var(--wb-muted)}
.um-bar{position:relative; height:12px; background:var(--wb-sunken); border-radius:6px}
.um-bar.sm{height:8px; border-radius:4px}
.um-bar.dashed{background:transparent; border:1px dashed var(--wb-line-strong)}
.um-bar .fill{position:absolute; left:0; top:0; bottom:0; border-radius:inherit; background:var(--wb-accent)}
.um-bar[data-state="warn"] .fill{background:var(--wb-warn)}
.um-bar[data-state="over"] .fill{background:var(--wb-bad)}
.um-bar .mk{position:absolute; top:-4px; bottom:-4px; width:2px; margin-left:-1px; background:var(--wb-ink); opacity:.5}
.um-axis{position:relative; height:16px; font-size:11.5px; color:var(--wb-muted)}
.um-axis span{position:absolute; white-space:nowrap}
.um-axis .mid{transform:translateX(-50%)}
.um-axis .end{right:0}
.um-call{display:flex; gap:8px; align-items:flex-start; padding:9px 12px; border-radius:var(--wb-r); background:var(--wb-raised); line-height:1.45}
.um-call.bad{background:var(--wb-bad-soft)} .um-call.warn{background:var(--wb-warn-soft)}
.um-call strong{font-weight:600}
.um-facts{padding:20px; display:flex; flex-direction:column; gap:16px; min-width:0}
.um-fact{display:flex; flex-direction:column; gap:2px}
.um-fact .v{font-size:20px; font-weight:500}
.um-sect{border-top:1px solid var(--wb-line); padding:16px 20px; display:flex; flex-direction:column; gap:12px}
.um-grid{display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:18px 32px}
.um-item{display:flex; flex-direction:column; gap:7px; min-width:0}
.um-item .name{font-size:13.5px; font-weight:600}
.um-note{font-size:12px; color:var(--wb-muted)}
.um-note.warn{color:var(--wb-warn); font-weight:600} .um-note.over{color:var(--wb-bad); font-weight:600}
.um-free{border-top:1px solid var(--wb-line); padding:10px 20px; display:flex; flex-wrap:wrap; gap:6px 24px; font-size:12.5px; color:var(--wb-muted); background:var(--wb-raised)}
.um-free .um-num{color:var(--wb-ink)}
.um-msg{padding:18px 20px; color:var(--wb-muted); line-height:1.5}
.um-msg.bad{color:var(--wb-bad)}
.um-split{display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:18px 28px}
.um-list{display:flex; flex-direction:column; gap:4px}
.um-list div{display:flex; justify-content:space-between; gap:12px; font-size:12.5px}
.um-stack{display:flex; height:8px; border-radius:4px; overflow:hidden; background:var(--wb-sunken); margin:4px 0}
.um-stack i{display:block; height:100%; background:var(--wb-accent)}
.um-stack i:nth-child(2n){background:var(--wb-accent-strong); opacity:.6}
.um-stack i:nth-child(3n){background:var(--wb-warn); opacity:.7}
@media (max-width:900px){ .um-main{grid-template-columns:minmax(0,1fr)} .um-main:not(.solo) .um-primary{border-right:0; border-bottom:1px solid var(--wb-line)} }
`;

const STATE_CHIP = { over: 'bad', warn: 'warn', ok: 'ok' };

function stateChip(row, thresholds) {
  const st = rowState(row, thresholds);
  if (st === 'over') return chip(row.value > row.limit ? 'Over limit' : 'At limit', { tone: 'bad' });
  if (st === 'warn') return chip(`Past ${reachedLevel(row.percent, thresholds)}%`, { tone: 'warn' });
  if (st === 'unknown') return chip('Term total unavailable');
  return null;
}

/** Usage bar with the alert levels marked. `axis` adds the labels row under it. */
export function usageBar(row, thresholds, { small = false, axis = false } = {}) {
  const st = rowState(row, thresholds);
  const levels = normalizeThresholds(thresholds);
  const bar = h('div', { class: ['um-bar', small && 'sm', st === 'unknown' && 'dashed'], dataset: { state: st }, role: 'presentation' },
    st !== 'unknown' && h('div', { class: 'fill', style: { width: `${Math.min(100, Math.max(0, row.percent))}%` } }),
    levels.map((t) => h('div', { class: 'mk', style: { left: `${t}%` }, title: `${t}% alert` })));
  if (!axis) return bar;
  // Labels: '80% alert' alone, '80%' '95%' when there are several; the limit at the right end
  // only when no label sits close to it.
  return h('div', null, bar, h('div', { class: 'um-axis' },
    h('span', null, '0'),
    levels.map((t) => h('span', { class: 'mid', style: { left: `${t}%` } }, levels.length > 1 ? `${t}%` : `${t}% alert`)),
    !levels.some((t) => t > 90) && h('span', { class: 'end' }, formatCompact(row.limit))));
}

/** One-line status under a smaller row. */
function rowNote(row, thresholds, snap) {
  const st = rowState(row, thresholds);
  const p = projectionText(projection(row, thresholds), { refDay: snap.day });
  if (st === 'unknown') {
    const recent = Number.isFinite(row.recent)
      ? ` · ${formatInt(row.recent)} from ${formatDay(snap.query.start, { refDay: snap.day })} to ${formatDay(snap.query.end, { refDay: snap.day })}` : '';
    return h('span', { class: 'um-note' }, `Term total unavailable${recent}`);
  }
  if (st === 'over') return h('span', { class: 'um-note over' }, [`${formatInt(row.value - row.limit)} over the limit`, p].filter(Boolean).join(' · '));
  if (st === 'warn') return h('span', { class: 'um-note warn' }, [`Past the ${reachedLevel(row.percent, thresholds)}% alert`, p].filter(Boolean).join(' · '));
  const next = alertLevels(thresholds).find((t) => t > row.percent);
  const gap = next != null ? `${(next - row.percent).toFixed(1)} points below the ${next}% ${next === 100 ? 'limit' : 'alert'}` : '';
  return h('span', { class: 'um-note' }, [gap, p].filter(Boolean).join(' · '));
}

function primaryCallout(row, thresholds, snap) {
  const st = rowState(row, thresholds);
  const p = projection(row, thresholds);
  const day = (d) => h('strong', null, formatDay(d, { refDay: snap.day }));
  const pace = snap.query?.partial ? 'the last 30 days’ pace' : 'this term’s pace';
  if (st === 'unknown') {
    return h('div', { class: 'um-call' }, 'The total for this contract term couldn’t be loaded, so there’s no percentage yet.');
  }
  if (st === 'over') {
    return h('div', { class: 'um-call bad', role: 'note' },
      h('span', null, h('strong', null, `${formatInt(row.value - row.limit)} over`), ' your contract limit.',
        p?.kind === 'crossed' ? [` At ${pace} it crossed the limit around `, day(p.date), '.'] : null));
  }
  if (!p) return st === 'warn' ? h('div', { class: 'um-call warn' }, `Past the ${reachedLevel(row.percent, thresholds)}% alert.`) : null;
  const line = p.afterTerm
    ? [` At ${pace} it stays under ${p.threshold}% until the term ends.`]
    : [` At ${pace} it reaches ${p.threshold}% around `, day(p.date), '.'];
  return h('div', { class: ['um-call', st === 'warn' && 'warn'] },
    h('span', null, st === 'warn' ? `Past the ${reachedLevel(row.percent, thresholds)}% alert.` : 'Under your alert thresholds.', ...line));
}

function factTiles(primary, snap) {
  if (primary.metric !== 'TotalUsersAllTime') return [];
  const f = snap.facts || {};
  const tiles = [];
  if (Number.isFinite(f.usersAdded)) {
    const perDay = f.addedDays ? `≈ ${formatInt(f.usersAdded / f.addedDays)} a day over ${formatInt(f.addedDays)} days` : '';
    tiles.push([snap.query?.partial ? 'Added, last 30 days' : 'Added this term', `+${formatInt(f.usersAdded)}`, perDay]);
  }
  if (Number.isFinite(f.activeUsers)) tiles.push(['Active users', formatInt(f.activeUsers), `${formatPercent((f.activeUsers / primary.limit) * 100)} of the user limit`]);
  if (Number.isFinite(f.highWatermark)) tiles.push(['High watermark', formatInt(f.highWatermark), f.highWatermarkDate ? `set ${formatDay(f.highWatermarkDate, { refDay: snap.day })}` : '']);
  return tiles.map(([l, v, s]) => h('div', { class: 'um-fact' }, h('span', { class: 'um-lbl' }, l), h('span', { class: 'v um-num' }, v), s && h('span', { class: 'um-sub' }, s)));
}

function usersTab(snap, values) {
  const thresholds = values.thresholds;
  const unwatched = new Set(normalizeUnwatched(values.unwatched));
  const watchChip = (r) => (unwatched.has(r.id) ? chip('Not watched') : null);
  const rows = snap.rows.filter((r) => !r.metric.startsWith('Sms') && !r.metric.startsWith('Mms'));
  const [primary, ...others] = rows;
  const out = [];
  if (primary) {
    const st = rowState(primary, thresholds);
    const facts = factTiles(primary, snap);
    out.push(h('div', { class: ['um-main', !facts.length && 'solo'] },
      h('div', { class: 'um-primary' },
        h('div', { class: 'um-row' }, h('span', { class: 'um-lbl' }, primary.label), stateChip(primary, thresholds), watchChip(primary)),
        h('div', { class: 'um-row' },
          h('span', { class: 'um-big um-num' }, Number.isFinite(primary.value) ? formatInt(primary.value) : '—'),
          h('span', { class: 'um-sub' }, 'of ', h('span', { class: 'um-num' }, formatInt(primary.limit)), ' in your contract'),
          h('span', { class: 'um-grow' }),
          h('span', { class: ['um-pct', 'um-num', st] }, formatPercent(primary.percent))),
        usageBar(primary, thresholds, { axis: true }),
        primaryCallout(primary, thresholds, snap)),
      facts.length ? h('div', { class: 'um-facts' }, facts) : null));
  } else {
    out.push(h('div', { class: 'um-msg' }, 'Iterable reports no contract limits for this account.'));
  }
  if (others.length) {
    out.push(h('div', { class: 'um-sect' },
      h('span', { class: 'um-lbl' }, primary ? 'Other contract limits' : 'Contract limits'),
      h('div', { class: 'um-grid' }, others.map((r) => h('div', { class: 'um-item' },
        h('div', { class: 'um-row' },
          h('span', { class: 'name' }, r.kind === 'flow' ? `${r.label}, term to date` : r.label), watchChip(r),
          h('span', { class: 'um-grow' }),
          h('span', { class: 'um-sub um-num' }, `${Number.isFinite(r.value) ? formatInt(r.value) : '[term total]'} / ${formatInt(r.limit)}`),
          h('span', { class: ['um-num', 'um-pct', rowState(r, thresholds)], style: { fontSize: '15px' } }, formatPercent(r.percent))),
        usageBar(r, thresholds, { small: true }),
        rowNote(r, thresholds, snap))))));
  }
  if (snap.unlimited?.length) {
    out.push(h('div', { class: 'um-free' }, h('span', null, 'No contract limit:'),
      snap.unlimited.map((u) => h('span', null, `${u.label} `, h('span', { class: 'um-num' }, formatInt(u.value)),
        u.dataThrough ? ` through ${formatDay(u.dataThrough, { refDay: snap.day })}` : ''))));
  }
  return out;
}

function breakdown(title, items) {
  if (!items?.length) return null;
  const total = items.reduce((s, x) => s + x.value, 0) || 1;
  return h('div', { class: 'um-item' },
    h('span', { class: 'um-lbl' }, title),
    h('div', { class: 'um-stack', role: 'presentation' }, items.slice(0, 6).map((x) => h('i', { style: { width: `${(x.value / total) * 100}%` }, title: x.name }))),
    h('div', { class: 'um-list' }, items.slice(0, 8).map((x) => h('div', null, h('span', null, x.name), h('span', { class: 'um-num' }, formatInt(x.value))))));
}

function smsTab(snap, values) {
  const thresholds = values.thresholds;
  const rowsById = new Map(snap.rows.map((r) => [r.id, r]));
  const tiles = snap.sms.metrics.map((m) => {
    const limited = m.rowIds.map((id) => rowsById.get(id)).filter(Boolean);
    return h('div', { class: 'um-item' },
      h('span', { class: 'um-lbl' }, m.label),
      h('div', { class: 'um-row' }, h('span', { class: 'um-num', style: { fontSize: '22px', fontWeight: '500' } }, formatInt(m.value))),
      limited.map((r) => [
        h('div', { class: 'um-row' },
          h('span', { class: 'um-sub' }, r.party ? `${r.label}: ` : '', 'of ', h('span', { class: 'um-num' }, formatInt(r.limit)), ' included'),
          stateChip(r, thresholds),
          h('span', { class: 'um-grow' }),
          h('span', { class: ['um-num', rowState(r, thresholds)] }, formatPercent(r.percent))),
        usageBar(r, thresholds, { small: true }),
        rowNote(r, thresholds, snap),
      ]),
      !limited.length && h('span', { class: 'um-note' }, 'No contract limit'));
  });
  const parts = [
    breakdown('Segments by billing party', snap.sms.byParty),
    breakdown('Segments by provider', snap.sms.byProvider),
    breakdown('Segments by recipient country', snap.sms.byCountry),
  ].filter(Boolean);
  return [
    h('div', { class: 'um-sect', style: { borderTop: '0' } }, h('div', { class: 'um-grid' }, tiles)),
    parts.length ? h('div', { class: 'um-sect' }, h('div', { class: 'um-split' }, parts)) : null,
  ];
}

/**
 * The card. model: { status: 'loading' | 'ok' | 'denied' | 'error', snap?, error?, values, tab }.
 * handlers: { onSettings(), onRetry(), onTab(id) }.
 */
export function usageCard(model, handlers) {
  const { snap, values } = model;
  const showSms = model.status === 'ok' && snap?.sms?.visible;
  const tab = showSms && model.tab === 'sms' ? 'sms' : 'users';
  const head = h('div', { class: 'um-head' },
    h('span', { class: 'um-brand' }, 'Loophole'),
    h('h2', null, 'Usage monitor'),
    showSms ? tabStrip({
      tabs: [{ id: 'users', label: 'Limits' }, { id: 'sms', label: 'SMS & MMS' }], selected: tab, flush: false,
      onSelect: (id) => handlers.onTab?.(id),
    }) : null,
    h('span', { class: 'um-grow' }),
    snap ? h('span', { class: 'um-sub' }, [
      snap.term ? `Contract term ${formatTerm(snap.term)}` : '',
      snap.dataThrough ? `Data through ${formatDay(snap.dataThrough, { refDay: snap.day })}` : '',
      model.status === 'loading' ? 'Refreshing…' : '',
    ].filter(Boolean).join(' · ')) : null,
    button('Alert settings', { size: 'sm', onClick: () => handlers.onSettings?.() }));

  let body;
  if (snap && (model.status === 'ok' || model.status === 'loading')) body = tab === 'sms' ? smsTab(snap, values) : usersTab(snap, values);
  else if (model.status === 'loading') body = h('div', { class: 'um-msg' }, 'Loading usage from Iterable…');
  else if (model.status === 'denied') body = h('div', { class: 'um-msg' }, 'This Iterable login can’t see usage data, so Loophole has nothing to monitor here. Someone with billing access sees the card and alerts.');
  else {
    body = h('div', { class: 'um-msg bad' }, `Couldn’t load usage: ${model.error || 'unknown error'}. `,
      button('Try again', { size: 'sm', onClick: () => handlers.onRetry?.() }));
  }
  return h('section', { class: 'um-card', 'aria-label': 'Loophole usage monitor' }, head, body);
}

/** Compact summary for the toolbar popup: rows with bars, two facts, term line. */
export function usageSummary(snap, values, { now = Date.now() } = {}) {
  const thresholds = values.thresholds;
  const unwatched = new Set(normalizeUnwatched(values.unwatched));
  const rows = snap.rows.filter((r) => !unwatched.has(r.id));
  const f = snap.facts || {};
  const facts = [
    Number.isFinite(f.usersAdded) && [snap.query?.partial ? 'Users added, last 30 days' : 'Users added this term', `+${formatInt(f.usersAdded)}`],
    Number.isFinite(f.activeUsers) && ['Active users', formatInt(f.activeUsers)],
  ].filter(Boolean);
  return h('div', { class: 'um-pop' },
    h('div', { class: 'um-pop-h' }, h('span', { class: 'um-pop-t' }, 'Iterable usage'), h('span', { class: 'um-grow' }),
      h('span', { class: 'um-sub' }, `Checked ${checkedText(snap.at, now)}`)),
    rows.length ? rows.map((r) => {
      const st = rowState(r, thresholds);
      return h('div', { class: 'um-pop-row' },
        h('div', { class: 'um-row' }, h('span', { class: 'um-lbl' }, r.kind === 'flow' ? `${r.label}, term to date` : r.label),
          STATE_CHIP[st] && st !== 'ok' ? stateChip(r, thresholds) : null,
          h('span', { class: 'um-grow' }), h('span', { class: ['um-num', 'um-pct-sm', st] }, formatPercent(r.percent))),
        usageBar(r, thresholds, { small: true }),
        h('div', { class: 'um-sub' }, h('span', { class: 'um-num' }, Number.isFinite(r.value) ? formatInt(r.value) : '[term total]'), ' of ',
          h('span', { class: 'um-num' }, formatInt(r.limit))));
    }) : h('div', { class: 'um-sub' }, 'No watched contract limits.'),
    facts.length ? h('div', { class: 'um-pop-facts' }, facts.map(([l, v]) => h('div', null, h('span', null, l), h('span', { class: 'um-num' }, v)))) : null,
    snap.term ? h('div', { class: 'um-sub' }, `Term ${formatTerm(snap.term)}${snap.dataThrough ? ` · Data through ${formatDay(snap.dataThrough, { refDay: snap.day })}` : ''}`) : null);
}

export const POPUP_CSS = `
.um-pop{margin:0 14px 10px; padding:10px 12px; border:1px solid var(--wb-line); border-radius:8px; display:flex; flex-direction:column; gap:10px}
.um-pop-h{display:flex; align-items:center; gap:8px}
.um-pop-t{font-weight:600; font-size:13px}
.um-pop-row{display:flex; flex-direction:column; gap:5px}
.um-pop .um-row{display:flex; flex-wrap:nowrap; align-items:center; gap:6px}
.um-pop .um-row > :first-child{min-width:0}
.um-pop .um-lbl{font-size:10.5px}
.um-pct-sm{font-size:13px; font-weight:500}
.um-pct-sm.over{color:var(--wb-bad)} .um-pct-sm.warn{color:var(--wb-warn)} .um-pct-sm.ok{color:var(--wb-accent-strong)} .um-pct-sm.unknown{color:var(--wb-muted)}
.um-pop-facts{display:flex; flex-direction:column; gap:3px; padding-top:8px; border-top:1px solid var(--wb-line); font-size:12px}
.um-pop-facts div{display:flex; justify-content:space-between; gap:10px}
.um-pop-acts{display:flex; gap:6px}
`;
