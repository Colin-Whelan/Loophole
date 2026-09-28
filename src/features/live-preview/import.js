// Legacy mapper for "Iterable - Live Preview Editor" (ARCHITECTURE §8.3). The script kept one GM
// value, `config` (a JSON string). Its API keys (config.apiKeys / activeApiKeyId) are imported
// centrally by options/importer/legacy-keys.js and deliberately not touched here. Test data,
// payloads, recent fields and the last email are the user's own data: they go to local feature
// state (ctx.state), unassigned to a project; the feature moves them to the first project it's
// used in. Never throws. No DOM: this runs in the service worker too.

import { asJson } from '../../options/importer/decode.js';
import { normalizeShortcut, isValidShortcut } from '../../core/shortcut.js';
import { COMMAND_NAMES, FONT_FAMILIES, FONT_SIZE_MIN, FONT_SIZE_MAX } from './commands.js';
import { normalizePayloads, pushRecent, MAX_TEST_DATA, WIDTH_MIN, WIDTH_MAX } from './logic.js';

/** The script's shortcut ('Ctrl+Shift+K', 'Alt+Up'; Ctrl was Cmd on a Mac) → ours, or null. */
export function legacyShortcut(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const parts = s.split('+').map((p) => p.trim());
  const mapped = parts.map((p, i) => (i < parts.length - 1 && /^ctrl$/i.test(p) ? 'Mod' : p)).join('+');
  const n = normalizeShortcut(mapped);
  return n && isValidShortcut(n) ? n : null;
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function numberIn(v, min, max) {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

export function mapLivePreview(storage) {
  const s = isRecord(storage) ? storage : {};
  const values = {};
  const state = {};
  const notes = [];
  const cfg = asJson(s.config);
  if (!isRecord(cfg)) {
    if (s.config !== undefined) notes.push('The saved settings could not be read, so nothing was imported.');
    return { values, state, notes };
  }

  const width = numberIn(asJson(cfg.previewWidth), WIDTH_MIN, WIDTH_MAX);
  if (width !== null) values.previewWidth = width;

  if (cfg.shortcut !== undefined) {
    const sc = legacyShortcut(cfg.shortcut);
    if (sc) values.refreshShortcut = sc;
    else notes.push('The refresh shortcut could not be used (it needs Ctrl, Alt or ⌘), so the default applies.');
  }

  if (typeof cfg.fontFamily === 'string') {
    if (FONT_FAMILIES.includes(cfg.fontFamily)) {
      values.fontFamily = cfg.fontFamily;
      if (cfg.fontFamily) notes.push(`Editor font ${cfg.fontFamily}: Loophole doesn't download fonts, so install it on your computer to see it.`);
    } else {
      notes.push('The editor font is not one Loophole offers, so the editor keeps its own font.');
    }
  }
  const size = numberIn(asJson(cfg.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (size !== null) values.fontSize = size;

  const kb = asJson(cfg.keybindings);
  if (Array.isArray(kb)) {
    const out = [];
    let dropped = 0;
    for (const b of kb) {
      const command = isRecord(b) ? b.name : null;
      const keys = isRecord(b) ? legacyShortcut(b.keys) : null;
      if (typeof command === 'string' && COMMAND_NAMES.includes(command) && keys) out.push({ command, keys });
      else dropped++;
    }
    values.keybindings = out.slice(0, 40);
    if (dropped) notes.push(`Skipped ${dropped} keybinding(s) with an unknown command or unusable keys.`);
  }

  const sn = asJson(cfg.snippets);
  if (Array.isArray(sn)) {
    const out = [];
    let dropped = 0;
    let lostKeys = 0;
    for (const x of sn) {
      const name = isRecord(x) && typeof x.name === 'string' ? x.name.trim() : '';
      const body = isRecord(x) && typeof x.body === 'string' ? x.body : '';
      if (!name || !body.trim()) { dropped++; continue; }
      let shortcut = '';
      if (typeof x.shortcutKey === 'string' && x.shortcutKey.trim()) {
        shortcut = legacyShortcut(x.shortcutKey) || '';
        if (!shortcut) lostKeys++;
      }
      out.push({ name: name.slice(0, 200), body, shortcut });
    }
    values.snippets = out.slice(0, 40);
    if (dropped) notes.push(`Skipped ${dropped} empty quick insert(s).`);
    if (lostKeys) notes.push(`${lostKeys} quick insert shortcut(s) could not be used and were cleared.`);
  }

  // User data → local state.
  if (typeof cfg.customTestData === 'string' && cfg.customTestData.trim() && cfg.customTestData.length <= MAX_TEST_DATA) {
    state.testData = cfg.customTestData;
  } else if (isRecord(cfg.customTestData)) {
    state.testData = JSON.stringify(cfg.customTestData, null, 2);
  }
  const payloads = normalizePayloads(asJson(cfg.savedPayloads));
  if (payloads.length) state.payloads = payloads;
  const recent = asJson(cfg.recentFields);
  if (Array.isArray(recent)) {
    const list = recent.filter((f) => typeof f === 'string' && f.trim() && f.length <= 200).reverse()
      .reduce((acc, f) => pushRecent(acc, f), []);
    if (list.length) state.recentFields = list;
  }
  const email = [cfg.userDataEmail, cfg.lastEmail].find((e) => typeof e === 'string' && e.includes('@') && e.length <= 320);
  if (email) state.lastEmail = email.trim();
  if (cfg.testDataMode !== undefined || cfg.useUserData !== undefined) {
    notes.push('The old "use profile data" mode isn\'t needed any more: the JSON test data is always used, and "Load profile" fills it from a user.');
  }
  if (Object.keys(state).length) {
    notes.push('Test data, saved payloads, recent fields and the last email were kept on this computer and move to the first project you open the live preview in.');
  }
  return { values, state, notes };
}

export default {
  scripts: ['Iterable - Live Preview Editor'],
  map: mapLivePreview,
};
