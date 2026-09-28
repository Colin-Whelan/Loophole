import { h } from '../../core/dom.js';
import * as settings from '../../core/settings.js';
import { segmented, switchInput, field } from '../../ui/components.js';
import { heading } from './common.js';

export async function render(main) {
  const s = await settings.load();
  const debug = switchInput({
    checked: s.general.debug, label: 'Debug logging',
    onChange: (on) => settings.setGeneral({ debug: on }),
  });
  main.append(
    ...heading('General', 'Settings that apply to every Loophole tool.'),
    h('div', { class: 'card form-card' },
      field({
        label: 'Theme',
        control: segmented({
          ariaLabel: 'Theme',
          value: s.general.theme,
          options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Match system' }],
          onChange: (theme) => settings.setGeneral({ theme }),
        }),
        help: 'Applies to this page, the toolbar popup and everything Loophole adds to Iterable. Iterable itself stays light.',
      }),
      h('div', { class: 'wb-field' },
        h('span', { class: 'wb-label' }, 'Debug logging'),
        h('div', { class: 'row' }, debug, h('span', { class: 'wb-help', style: 'margin:0' },
          'Writes detailed [Loophole:…] messages to the browser console. Useful when reporting a problem.'))),
    ),
  );
  // Follow changes made elsewhere (another settings tab).
  return settings.subscribe((next) => { debug.input.checked = next.general.debug; });
}
