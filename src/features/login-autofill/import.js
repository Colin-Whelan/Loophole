// Legacy mapper for "Login Screen - Auto Fill Username" (ARCHITECTURE §8.3).
// The script stored autoLoginEmail (default "your@email.com") and autoLoginDelay (seconds, 0–60).
// The feature stays off after an import: it needs access to auth.iterable.com, which only the
// person can grant, by switching it on. Never throws; no DOM (runs in the service worker too).
// The email is a value to import, never something to put in a note.

import { asJson } from '../../options/importer/decode.js';
import { cleanEmail, isValidEmail, MAX_DELAY } from './logic.js';

const SWITCH_ON_NOTE = 'Fill username on login stays off after an import: switch it on under Features → Sign-in and allow access to auth.iterable.com when asked.';

export function mapLoginAutofill(storage) {
  const s = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const values = {};
  const notes = [];

  if (has('autoLoginEmail')) {
    const raw = asJson(s.autoLoginEmail);
    const email = typeof raw === 'string' ? cleanEmail(raw) : '';
    if (email && isValidEmail(email)) values.email = email;
    else if (email) notes.push('The saved email address doesn’t look like an email address, so it was not imported.');
    else if (typeof raw !== 'string') notes.push('The saved email address could not be read, so it was not imported.');
    // else: empty or the script's placeholder (your@email.com): nothing to import.
  }

  if (has('autoLoginDelay')) {
    const raw = asJson(s.autoLoginDelay);
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_DELAY) values.delay = Math.round(n);
    else notes.push(`The saved delay isn’t a number of seconds from 0 to ${MAX_DELAY}, so the default (5 s) applies.`);
  }

  if (Object.keys(values).length) notes.push(SWITCH_ON_NOTE);
  return { values, notes };
}

export default {
  scripts: ['Login Screen - Auto Fill Username'],
  map: mapLoginAutofill,
};
