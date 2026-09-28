// createLogger(scope) → console output prefixed with [WB:scope].
// debug() is silent unless general.debug is on; entry points call setDebug() when settings load/change.

let debugEnabled = false;

export function setDebug(on) {
  debugEnabled = !!on;
}

export function createLogger(scope) {
  const prefix = `[WB:${scope}]`;
  return {
    debug: (...args) => { if (debugEnabled) console.debug(prefix, ...args); },
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
