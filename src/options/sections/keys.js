// Projects & API keys: the one shared key vault.

import { MSG, STORAGE } from '../../core/messages.js';
import { h, clear } from '../../core/dom.js';
import * as storage from '../../core/storage.js';
import {
  listProjects, setKey, renameProject, removeKey, getRawKey, makeProjectKey, parseProjectKey,
} from '../../core/keys.js';
import { FEATURES } from '../../features/registry.js';
import { button, chip, field, input, select, toast, confirmDialog } from '../../ui/components.js';
import { heading, formatDate } from './common.js';

export async function render(main, route) {
  const tableHost = h('div');
  const formHost = h('div');
  let editing = null; // projectKey being edited, or null for "add"

  main.append(
    ...heading('Projects & API keys',
      'Loophole reads the project you’re viewing and uses the matching key. Keys stay in this browser. They’re never synced, and exports leave them out unless you tick “Include API keys”.'),
    tableHost,
    formHost,
    h('div', { class: 'grid2', style: 'margin-top:16px' },
      h('div', { class: 'card' },
        h('h3', null, 'Which features use a key'),
        h('div', { class: 'row', style: 'gap:6px' },
          FEATURES.filter((m) => m.usesApiKey).map((m) => chip(m.name, { tone: 'accent' }))),
        h('p', { class: 'wb-help' }, 'Everything else uses your normal Iterable login.')),
      h('div', { class: 'card' },
        h('h3', null, 'Where to get a key'),
        h('p', { class: 'wb-help', style: 'margin:0' },
          'In Iterable, go to Integrations → API Keys and create a server-side key for the project. Each project needs its own key. EU projects use the EU data center.'))),
  );

  async function renderTable() {
    const projects = await listProjects();
    const rows = projects.map((p) => projectRow(p));
    clear(tableHost).append(h('div', { class: 'tbl-wrap' },
      h('table', { class: 'wb-t' },
        h('thead', null, h('tr', null, h('th', null, 'Project'), h('th', null, 'Key'), h('th', null, 'Status'), h('th', null, ''))),
        h('tbody', null, rows.length ? rows
          : h('tr', null, h('td', { colspan: '4', class: 'wb-help' }, 'No keys saved yet. Add one below, or paste a key from the toolbar popup while you’re in a project.'))))));
  }

  function projectRow(p) {
    const parsed = parseProjectKey(p.projectKey) || {};
    const details = [parsed.id ? `id ${parsed.id}` : 'matched by name', p.dataCenter === 'eu' ? 'EU data center' : 'US data center'];
    const keyText = h('span', null, p.masked || '—');
    let revealed = false;
    const reveal = button('Show', {
      variant: 'ghost', size: 'sm',
      onClick: async () => {
        revealed = !revealed;
        keyText.textContent = revealed ? ((await getRawKey(p.projectKey)) || '') : p.masked;
        reveal.textContent = revealed ? 'Hide' : 'Show';
      },
    });
    const testBtn = button('Test', {
      size: 'sm',
      onClick: async () => {
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
        const res = await chrome.runtime.sendMessage({ type: MSG.KEYS_TEST, projectKey: p.projectKey }).catch((e) => ({ ok: false, message: e.message }));
        testBtn.disabled = false; testBtn.textContent = 'Test';
        toast(res?.ok ? `Key accepted for ${p.name}.` : (res?.message || 'The key test failed.'),
          { tone: res?.ok ? 'ok' : 'bad', source: 'Projects & keys' });
        renderTable();
      },
    });
    return h('tr', null,
      h('td', null, h('strong', null, p.name), h('div', { class: 'wb-help', style: 'margin:0' }, details.join(' · '))),
      h('td', null, p.hasKey ? h('div', { class: 'keycell' }, keyText, reveal) : h('span', { class: 'wb-help' }, 'No key')),
      h('td', null, statusChip(p)),
      h('td', null, h('div', { class: 'row', style: 'justify-content:flex-end; flex-wrap:nowrap' },
        p.hasKey ? testBtn : null,
        button('Edit', { variant: 'ghost', size: 'sm', onClick: () => { editing = p.projectKey; renderForm(p); formHost.scrollIntoView({ behavior: 'smooth' }); } }),
        button('Remove', {
          variant: 'ghost', size: 'sm',
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Remove the key for ${p.name}?`, brand: 'Projects & keys', danger: true, confirmLabel: 'Remove key',
              body: h('p', { style: 'margin:0; font-size:13px; line-height:1.5' },
                'Tools that call the API stop working on this project until you add a key again. The key is not deleted in Iterable.'),
            });
            if (!ok) return;
            await removeKey(p.projectKey);
            toast(`Removed the key for ${p.name}.`, { source: 'Projects & keys' });
            if (editing === p.projectKey) { editing = null; renderForm(); }
            renderTable();
          },
        }))));
  }

  function statusChip(p) {
    if (!p.hasKey) return chip('Missing', { tone: 'warn', dot: true });
    const t = p.lastTest;
    if (!t) return chip('Not tested', { dot: true });
    const when = formatDate(t.at);
    const c = t.ok ? chip('Works', { tone: 'ok', dot: true }) : chip(`${t.status || 'Failed'} last test`, { tone: 'bad', dot: true });
    if (when) c.title = `Tested ${when}`;
    return c;
  }

  function renderForm(existing = null, prefill = {}) {
    const parsed = existing ? parseProjectKey(existing.projectKey) || {} : {};
    const name = input({ value: existing?.name || prefill.name || '', placeholder: 'e.g. Northwind Retail · Prod' });
    const id = input({ value: parsed.id || prefill.id || '', mono: true, placeholder: 'e.g. 18244' });
    const dc = select({
      value: existing?.dataCenter || prefill.dataCenter || 'us',
      options: [{ value: 'us', label: 'US (app.iterable.com)' }, { value: 'eu', label: 'EU (app.eu.iterable.com)' }],
    });
    const key = input({ mono: true, type: 'password', placeholder: existing ? 'Leave empty to keep the saved key' : 'Paste a server-side API key' });
    const err = h('div', { class: 'err', hidden: true });
    if (existing) { id.disabled = true; dc.disabled = true; }

    const save = async () => {
      err.hidden = true;
      try {
        const apiKey = key.value.trim();
        if (existing) {
          if (apiKey) await setKey({ projectKey: existing.projectKey, name: name.value.trim(), dataCenter: existing.dataCenter, apiKey });
          else if (name.value.trim() !== existing.name) await renameProject(existing.projectKey, name.value.trim());
        } else {
          const projectKey = makeProjectKey({ dataCenter: dc.value, id: id.value.trim() || null, name: name.value.trim() });
          if (!projectKey) throw new Error('Enter a numeric project id, or a project name to match by.');
          if (!apiKey) throw new Error('Paste the API key.');
          await setKey({ projectKey, name: name.value.trim(), dataCenter: dc.value, apiKey });
        }
        toast(existing ? 'Project updated.' : 'Key saved.', { tone: 'ok', source: 'Projects & keys' });
        editing = null;
        renderForm();
        renderTable();
      } catch (e) {
        err.textContent = e?.message || 'Could not save.';
        err.hidden = false;
      }
    };

    clear(formHost).append(h('div', { class: 'card', style: 'margin-top:16px' },
      h('h3', null, existing ? `Edit ${existing.name}` : 'Add a project key'),
      h('div', { class: 'grid2' },
        field({ label: 'Project name', control: name, help: 'Shown in Loophole only.' }),
        field({ label: 'Project id', control: id, help: existing ? 'Can’t be changed. Remove and re-add to move a key.' : 'Numeric id of the Iterable project. Leave empty to match the project by name instead.' }),
        field({ label: 'Data center', control: dc }),
        field({ label: 'API key', control: key })),
      err,
      h('div', { class: 'actions' },
        existing ? button('Cancel', { variant: 'ghost', onClick: () => { editing = null; renderForm(); } }) : null,
        button(existing ? 'Save changes' : 'Save key', { variant: 'primary', onClick: save }))));
  }

  await renderTable();
  renderForm(null, { id: route.params.id, name: route.params.name, dataCenter: route.params.dataCenter });
  // Popup saves, key tests and other tabs all write wb:keys; keep the table current.
  return storage.subscribe(STORAGE.KEYS, () => renderTable());
}
