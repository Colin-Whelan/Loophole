import { h } from '../../core/dom.js';
import * as settings from '../../core/settings.js';
import { groupedFeatures, hasSettings } from '../../features/registry.js';
import { onPermissionsChanged } from '../../core/permissions.js';
import { switchInput, button } from '../../ui/components.js';
import { heading, featureChips, featureAccess, setEnabledFromClick } from './common.js';

export async function render(main) {
  const s = await settings.load();
  let current = s;
  const switches = new Map();
  // Optional hosts (e.g. the sign-in page): the grant is asked for when the feature is switched on,
  // and offered back when it is switched off (ARCHITECTURE §4, §9).
  const access = new Map(); // featureId → featureAccess() line
  main.append(...heading('Features', 'Turn off anything you don’t use. Disabled features don’t load at all.'));

  for (const group of groupedFeatures()) {
    main.append(h('div', { class: 'fgroup' },
      h('h3', null, group.label),
      group.features.map((meta) => {
        const line = featureAccess(meta);
        if (line) access.set(meta.id, line);
        const sw = switchInput({
          checked: s.features[meta.id].enabled, label: meta.name,
          // For a feature with optional hosts the permission request is the first thing this does.
          onChange: (on) => setEnabledFromClick(meta, on, line),
        });
        switches.set(meta.id, sw.input);
        return h('div', { class: 'frow' },
          sw,
          h('div', null,
            h('div', { class: 'fn' }, meta.name, ...featureChips(meta, { list: true })),
            h('div', { class: 'fd' }, meta.description),
            line?.el),
          hasSettings(meta)
            ? button('Settings', { variant: 'ghost', size: 'sm', onClick: () => { location.hash = `feature/${meta.id}`; } })
            : h('span'));
      })));
  }
  for (const line of access.values()) line.refresh();

  const unsubPerms = onPermissionsChanged(() => { for (const line of access.values()) line.refresh(); });
  const unsubSettings = settings.subscribe((next) => {
    const prev = current;
    current = next;
    for (const [id, input] of switches) input.checked = next.features[id].enabled;
    // Don't wipe a pending "Remove access" offer: only refresh rows whose state changed to on.
    for (const [id, line] of access) {
      if (next.features[id].enabled && !prev.features[id]?.enabled) line.refresh();
    }
  });
  return () => { unsubSettings?.(); unsubPerms(); };
}
