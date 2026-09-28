// Bulk data: the project's static lists, shared by the Users tab ("Add to list") and the Lists
// tab. Lists are remembered together with the project they were loaded from, so a list id from
// one project can never be used for a run in another.

import { fetchLists, createList, deleteList, listSize } from './requests.js';

export function createListStore(shell) {
  const listeners = new Set();
  const state = { projectKey: null, lists: [], loaded: false, loading: false, error: '', sizes: new Map() };
  const emit = () => { for (const cb of listeners) { try { cb(state); } catch (e) { shell.ctx.log.error('lists listener threw', e); } } };

  function reset() {
    state.projectKey = null; state.lists = []; state.loaded = false; state.error = ''; state.sizes = new Map();
    emit();
  }

  return {
    get state() { return state; },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    byId: (id) => state.lists.find((l) => String(l.id) === String(id)) || null,
    byName: (name) => state.lists.find((l) => l.name === name) || null,
    /** Forget the lists (project changed). */
    reset,

    async refresh() {
      const pin = await shell.pin({ quiet: false });
      if (!pin) return false;
      state.loading = true; state.error = ''; emit();
      const r = await fetchLists(pin.request, shell.ctx.signal);
      state.loading = false;
      if (!r.ok) {
        state.error = shell.describeError(r.res, 'Could not load lists');
        shell.handleAuthFailure(r.res, pin);
        emit();
        return false;
      }
      state.projectKey = pin.projectKey;
      state.lists = r.lists;
      state.loaded = true;
      state.sizes = new Map();
      emit();
      return true;
    },

    /** → the new list id, or null. */
    async create(name) {
      const pin = await shell.pin({ quiet: false });
      if (!pin) return null;
      const r = await createList(pin.request, name, shell.ctx.signal);
      if (!r.ok) {
        shell.toast(shell.describeError(r.res, 'Could not create the list'), 'bad');
        shell.handleAuthFailure(r.res, pin);
        return null;
      }
      shell.toast('List "' + name + '" created in ' + pin.projectName + '.', 'ok');
      await this.refresh();
      const id = r.listId != null ? r.listId : this.byName(name)?.id;
      return id != null ? String(id) : null;
    },

    async remove(list, pin) {
      const r = await deleteList(pin.request, list.id, shell.ctx.signal);
      if (!r.ok) {
        shell.toast(shell.describeError(r.res, 'Could not delete the list'), 'bad');
        shell.handleAuthFailure(r.res, pin);
        return false;
      }
      shell.toast('List "' + list.name + '" deleted.', 'ok');
      await this.refresh();
      return true;
    },

    /** Size of one list (throttled to 2 req/s). */
    async loadSize(id) {
      if (!state.loaded) return null;
      const pk = state.projectKey;
      state.sizes.set(String(id), 'loading');
      emit();
      const r = await listSize(shell.requestFor(pk), id, shell.ctx.signal);
      if (state.projectKey !== pk) return null; // project changed meanwhile
      state.sizes.set(String(id), r.ok && r.size != null ? r.size : 'error');
      emit();
      return r.size;
    },
  };
}
