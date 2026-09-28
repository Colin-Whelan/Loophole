// Bulk data: the project's catalog names for the Catalogs tab's pickers (upload target and
// export source). Remembered together with the project they were loaded from, like the lists.

import { fetchCatalogs } from './requests.js';

export function createCatalogStore(shell) {
  const listeners = new Set();
  const state = { projectKey: null, names: [], loaded: false, loading: false, error: '' };
  const emit = () => { for (const cb of listeners) { try { cb(state); } catch (e) { shell.ctx.log.error('catalogs listener threw', e); } } };

  return {
    get state() { return state; },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    has: (name) => state.names.includes(name),
    /** Forget the names (project changed). */
    reset() {
      state.projectKey = null; state.names = []; state.loaded = false; state.error = '';
      emit();
    },

    async refresh() {
      if (state.loading) return false;
      const pin = await shell.pin({ quiet: false });
      if (!pin) return false;
      state.loading = true; state.error = ''; emit();
      let r;
      try { r = await fetchCatalogs(pin.request, shell.ctx.signal); } catch (e) {
        state.loading = false;
        if (e?.name !== 'AbortError') { state.error = 'Could not load catalogs: ' + (e?.message || e) + '.'; emit(); }
        return false;
      }
      state.loading = false;
      if (!r.ok) {
        state.error = shell.describeError(r.res, 'Could not load catalogs');
        shell.handleAuthFailure(r.res, pin);
        emit();
        return false;
      }
      state.projectKey = pin.projectKey;
      state.names = r.names;
      state.loaded = true;
      emit();
      return true;
    },
  };
}
