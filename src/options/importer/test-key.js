// Test an API key that isn't saved yet (unassigned legacy keys). Options page only: it is the one
// extension page allowed to hold raw keys (ARCHITECTURE §9). Saved keys are tested through the
// background (MSG.KEYS_TEST) instead.

import { API_HOSTS, validateApiKey } from '../../core/api-validation.js';

// Same read-only, parameter-free endpoint the background uses for key tests.
const TEST_PATH = '/api/channels';

/** → { ok, status, message } */
export async function testUnsavedKey(apiKey, dataCenter = 'us') {
  const k = validateApiKey(apiKey);
  if (!k.ok) return { ok: false, status: 0, message: k.message };
  const host = API_HOSTS[dataCenter] || API_HOSTS.us;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`https://${host}${TEST_PATH}`, {
      method: 'GET',
      headers: { 'Api-Key': k.value, Accept: 'application/json' },
      // Same hardening as the background proxy: no cookies, no Referer, and never follow a
      // redirect (a custom header would be replayed to wherever it points).
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true, status: res.status, message: `Key works on the ${dataCenter.toUpperCase()} data center.` };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: `Iterable rejected this key (${res.status}) on the ${dataCenter.toUpperCase()} data center.` };
    }
    return { ok: false, status: res.status, message: `Iterable answered ${res.status}.` };
  } catch (e) {
    return { ok: false, status: 0, message: e?.name === 'AbortError' ? 'The test timed out.' : 'Could not reach Iterable.' };
  } finally {
    clearTimeout(timer);
  }
}
