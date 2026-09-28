// Message types exchanged between extension contexts.
// Contract: docs/ARCHITECTURE.md §6. Change both together.

export const MSG = Object.freeze({
  API: 'wb:api',                       // content → background
  KEYS_STATUS: 'wb:keys:status',       // content/popup → background
  KEYS_TEST: 'wb:keys:test',           // options/popup → background
  OPEN_OPTIONS: 'wb:open-options',     // content/popup → background
  TAB_STATUS: 'wb:tab:status',         // popup → content
  FEATURE_ACTION: 'wb:feature:action', // popup → content
});

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
