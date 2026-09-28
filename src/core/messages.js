// Message types exchanged between extension contexts.
// Contract: docs/ARCHITECTURE.md §6. Change both together.

export const MSG = Object.freeze({
  API: 'wb:api',                       // content → background
  KEYS_STATUS: 'wb:keys:status',       // content/popup → background
  KEYS_TEST: 'wb:keys:test',           // options/popup → background
  OPEN_OPTIONS: 'wb:open-options',     // content/popup → background
  TAB_STATUS: 'wb:tab:status',         // popup → content
  FEATURE_ACTION: 'wb:feature:action', // popup → content
  FEATURE_REQUEST: 'wb:feature:request', // popup/bg → content: a feature action with payload + result
  CAPTURE_TAB: 'wb:capture:tab',       // content (app, top frame) → background: PNG of the sender's visible tab
  // A PNG (approval screenshot or card) to show on the extension's own capture page (Save / Copy
  // there, under the extension's origin): content (app, top frame) or popup → background.
  CAPTURE_OPEN: 'wb:capture:open',
  CAPTURE_TAKE: 'wb:capture:take',     // capture.html → background: claim a stashed PNG once
});

/** Extension page that shows a stashed capture (built from src/capture/). */
export const CAPTURE_PAGE = 'capture.html';

/** The keyboard command (manifest `commands`) that captures the campaign approval view. */
export const CAPTURE_COMMAND = 'copy-approval-screenshot';

export const API_ERROR = Object.freeze({
  NO_KEY: 'NO_KEY',
  BAD_REQUEST: 'BAD_REQUEST',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  HTTP: 'HTTP',
});

export const STORAGE = Object.freeze({
  SETTINGS: 'wb:settings',
  KEYS: 'wb:keys',
  // Non-secret change counter written by core/keys.js with every vault write. Content scripts
  // can't see wb:keys changes (storage.js drops them), so they watch this instead.
  KEYS_REV: 'wb:keys-rev',
  STATE_PREFIX: 'wb:state:',
});
