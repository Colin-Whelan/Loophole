// Thin promise wrappers over chrome.storage.local (never storage.sync: see ARCHITECTURE §5.1).
// `chrome` is only touched at call time so pure modules that import this stay testable in Node.

import { STORAGE } from './messages.js';

const area = () => chrome.storage.local;

export async function get(key, fallback = undefined) {
  const res = await area().get(key);
  return Object.prototype.hasOwnProperty.call(res, key) ? res[key] : fallback;
}

/** Returns an object with only the keys that exist in storage. */
export function getMany(keys) {
  return area().get(keys);
}

/**
 * Every stored key. Extension pages only (options backup/import): in a content script this would
 * pull the raw wb:keys vault into the web page's process, so it refuses there.
 */
export function getAll() {
  if (/^https?:$/.test(globalThis.location?.protocol || '')) {
    return Promise.reject(new Error('storage.getAll() is not available in content scripts'));
  }
  return area().get(null);
}

export function set(key, value) {
  return area().set({ [key]: value });
}

export function setMany(items) {
  return area().set(items);
}

export function remove(keys) {
  return area().remove(keys);
}

/**
 * Subscribe to local-area changes. `cb(changes)` gets the raw `{ key: { oldValue, newValue } }` map.
 * Returns an unsubscribe function.
 */
export function onChanged(cb) {
  // Web pages (content scripts) never see the raw key vault, even as a change record.
  const inWebPage = /^https?:$/.test(globalThis.location?.protocol || '');
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (inWebPage && changes[STORAGE.KEYS]) {
      const { [STORAGE.KEYS]: _dropped, ...rest } = changes;
      if (Object.keys(rest).length) cb(rest);
      return;
    }
    cb(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Subscribe to one key. `cb(newValue, oldValue)`. Returns an unsubscribe function. */
export function subscribe(key, cb) {
  return onChanged((changes) => {
    if (changes[key]) cb(changes[key].newValue, changes[key].oldValue);
  });
}
