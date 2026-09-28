// Legacy mapper for "Iterable Workflow - Add Google Tracking Params" (ARCHITECTURE §8.3).
//   iterableLinkParamsConfig  JSON.stringify({ enableGA, gaCampaign, enableLinkParams, linkParams })
// After Tampermonkey decoding it is usually still a JSON string; a parsed object is accepted too.
// The script's keyboard shortcut was fixed (Ctrl+Shift+L, Cmd+Shift+L on macOS) and not stored:
// it maps to 'Mod+Shift+L'. A `shortcut` string in the config (this feature's earlier plain
// format, "Ctrl+Shift+L" meaning Ctrl or Cmd) is mapped the same way (config.js legacyShortcut).

import { asJson } from '../../options/importer/decode.js';
import { configToValues, DEFAULT_SHORTCUT } from './config.js';

/** The script's built-in parameters only lived in its code, so they can't be read from storage. */
export const NO_SAVED_SETTINGS_NOTE = 'No saved settings: the script was using its built-in defaults ' +
  '(utm_source=iterable, utm_id={{now format="yyyyMMdd"}}), which aren’t carried over. ' +
  'Add them as link parameters in Settings → Workflow link parameters if you want them.';

export function mapWorkflowParams(storage) {
  const raw = storage && typeof storage === 'object' ? storage.iterableLinkParamsConfig : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { values: {}, notes: [NO_SAVED_SETTINGS_NOTE] };
  }
  const cfg = asJson(raw);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { values: {}, notes: ['The saved settings could not be read, so nothing was imported.'] };
  }
  const { values, dropped } = configToValues(cfg);
  const notes = [];
  const recognised = Object.keys(values).length > 0;
  if (recognised && values.shortcut === undefined) values.shortcut = DEFAULT_SHORTCUT;
  if (values.linkParams) {
    const n = values.linkParams.length;
    notes.push(`${n} link parameter${n === 1 ? '' : 's'}${n ? ` (${values.linkParams.map((p) => p.key).join(', ')})` : ''}.`);
  }
  if (dropped > 0) notes.push(`Skipped ${dropped} link parameter row${dropped === 1 ? '' : 's'} without a key.`);
  if (!recognised) notes.push('No recognised settings in the saved data.');
  return { values, notes };
}

export default {
  scripts: ['Iterable Workflow - Add Google Tracking Params'],
  map: mapWorkflowParams,
};
