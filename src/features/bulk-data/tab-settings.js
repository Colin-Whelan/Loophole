// Bulk data → Settings tab: the current project's key status (keys themselves live in
// Settings → Projects & keys) and the two pacing groups shared with the options page.

import { h, clear } from '../../core/dom.js';
import { button, chip } from '../../ui/components.js';
import { LIST_SIZE_RATE, PACING } from './logic.js';
import { MAX_CATALOG_BODY_BYTES } from './catalog-logic.js';
import { pacingFields } from './ui.js';

export function createSettingsTab(shell) {
  const { ctx } = shell;
  const projectBox = h('div', { class: 'bd-view', style: 'gap:8px' });
  const bind = { values: shell.values, save: shell.saveValues, subscribe: shell.subscribeValues };
  const users = pacingFields({ ...bind, spec: PACING.users });
  const catalogs = pacingFields({ ...bind, spec: PACING.catalogs, batchLabel: 'Items per batch' });

  const el = h('div', { class: 'bd-view' },
    h('div', { class: 'bd-h' }, 'Project'),
    projectBox,
    h('div', { class: 'bd-h', style: 'margin-top:6px' }, 'Pacing: users & lists'),
    users.el,
    h('div', { class: 'bd-note' }, 'Requests per second is capped at ' + PACING.users.maxRate + ', Iterable’s limit for ',
      h('code', null, 'users/bulkUpdate'), '. Rows per batch: 1 to ' + PACING.users.maxBatch + '. Wide CSVs can hit Iterable’s 4 MB request cap; if batches fail with HTTP 413, lower the batch size.'),
    h('div', { class: 'bd-note' }, 'List size lookups always run at ' + LIST_SIZE_RATE + ' requests per second, because that endpoint has a low limit.'),
    h('div', { class: 'bd-h', style: 'margin-top:6px' }, 'Pacing: catalogs'),
    catalogs.el,
    h('div', { class: 'bd-note' }, 'Requests per second is capped at ' + PACING.catalogs.maxRate + ', Iterable’s per-project limit for ',
      h('code', null, 'catalogs/{name}/items'), '; exports use the same rate. Items per batch: 1 to ' + PACING.catalogs.maxBatch +
      '; a batch also closes early at ' + (MAX_CATALOG_BODY_BYTES / 1048576) + ' MB of documents.'),
    h('div', { class: 'bd-note' }, 'Changes apply to the next run, and are the same values as in Workbench settings.'),
    h('div', { class: 'row' }, button('All Bulk data settings', { size: 'sm', variant: 'ghost', onClick: () => ctx.openOptions() })));

  function render() {
    clear(projectBox);
    const p = ctx.project?.current();
    const k = shell.keyInfo();
    if (!p) {
      projectBox.append(h('div', { class: 'bd-note' }, 'No Iterable project detected on this page yet.'));
      return;
    }
    projectBox.append(
      h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, p.name), h('span', { class: 'bd-code' }, p.key)),
      h('div', { class: 'bd-opt' }, h('span', { class: 'l' }, 'API key'),
        !k ? chip('checking…') : k.hasKey ? chip(k.masked || 'saved', { tone: 'ok', dot: true }) : chip('No key', { tone: 'warn', dot: true })),
      h('div', { class: 'bd-note' }, 'Keys are managed in Workbench settings and never reach this page. Workbench sends the key only to Iterable’s API.'),
      h('div', { class: 'row' }, button(k && k.hasKey ? 'Manage keys' : 'Add key', { size: 'sm', variant: k && k.hasKey ? undefined : 'primary', onClick: () => shell.openKeys() })));
  }

  const unsub = shell.onStatus(render);
  render();

  return {
    id: 'settings',
    label: 'Settings',
    el,
    onShow: () => shell.refreshKey(),
    isRunning: () => false,
    destroy() { unsub(); users.destroy(); catalogs.destroy(); },
  };
}
