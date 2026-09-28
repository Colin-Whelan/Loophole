import { h } from '../../core/dom.js';
import { button } from '../../ui/components.js';
import { heading, permissionNotice } from './common.js';

export async function render(main) {
  const go = (hash) => () => { location.hash = hash; };
  main.append(
    ...heading('Welcome to Loophole for Iterable',
      'Loophole adds power tools to Iterable: bulk CSV uploads, a safer way to delete users, one-click template searches, a link parameter picker and more. Everything Loophole adds to Iterable has a teal outline and the diamond mark, so you can always tell it apart from Iterable’s own buttons.'),
  );
  const notice = await permissionNotice();
  if (notice) main.append(notice);
  main.append(
    h('h3', { class: 'sub' }, 'Next steps'),
    h('div', { class: 'steps' },
      h('div', { class: 'card' },
        h('h3', null, 'Add an API key'),
        h('p', null, 'Some tools call the Iterable API, which needs a server-side API key for each project. Keys stay in this browser and are never synced.'),
        button('Projects & keys', { variant: 'primary', onClick: go('keys') })),
      h('div', { class: 'card' },
        h('h3', null, 'Bring your Tampermonkey settings'),
        h('p', null, 'Used the old userscripts? Import a Tampermonkey backup and Loophole picks up your saved keys and settings.'),
        button('Import', { onClick: go('import') })),
      h('div', { class: 'card' },
        h('h3', null, 'Pick your tools'),
        h('p', null, 'Everything is on by default. Turn off what you don’t use; disabled features don’t load at all.'),
        button('Features', { onClick: go('features') }))),
    h('p', { class: 'wb-help', style: 'margin-top:18px' },
      'Tip: the Loophole button in your browser toolbar shows the tools for the Iterable page you are on.'),
  );
}
