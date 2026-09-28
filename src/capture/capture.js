// Capture page (ARCHITECTURE §8.5, §9): shows a PNG the approval view handed over (a screenshot
// the clipboard refused, "Save…", or the card fallback) so the person can save or copy it here,
// under the extension's origin, where Iterable's page script can't read it.
//
// The image never travels in the URL: the fragment is only a one-time stash id. The page claims
// the image once (wb:capture:take; the background then forgets it), keeps it in this tab's memory
// and nowhere else.

import { MSG } from '../core/messages.js';
import { h, clear } from '../core/dom.js';
import { themed, watchGeneralSettings } from '../ui/theme.js';
import { mark, button, toast } from '../ui/components.js';

const app = document.getElementById('app');
themed(document.body);
watchGeneralSettings().catch(() => {});

function show(...nodes) {
  clear(app);
  app.append(...nodes.flat().filter(Boolean));
}

function header(title, file, acts = []) {
  return h('div', { class: 'cap-top' },
    mark({ large: true }),
    h('div', { class: 'ttl' }, h('div', { class: 'n' }, title), file && h('div', { class: 'f' }, file)),
    h('div', { class: 'cap-acts' }, acts));
}

async function copyImage(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

async function init() {
  const id = location.hash.slice(1);
  // The id is only a lookup key; drop it from the address bar right away.
  history.replaceState(null, '', location.pathname);
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: MSG.CAPTURE_TAKE, id }); } catch { res = null; }
  if (!res?.ok || typeof res.dataUrl !== 'string' || !res.dataUrl.startsWith('data:image/png;base64,')) {
    show(header('Screenshot', ''), h('div', { class: 'cap-empty' },
      h('strong', null, 'This image is no longer available.'), h('br'),
      'Loophole keeps a handed-over image only until this page opens once (and at most 10 minutes). ',
      'Take the screenshot or copy the card again from the approval view.'));
    return;
  }
  const name = typeof res.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.png$/.test(res.name) ? res.name : 'loophole-capture.png';
  const blob = await (await fetch(res.dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  const img = h('img', { src: url, alt: `Approval capture ${name}` });
  const save = h('a', { class: 'wb-btn primary', href: url, download: name }, 'Save PNG');
  const copy = button('Copy image', {
    onClick: async () => {
      const ok = await copyImage(blob);
      toast(ok ? 'Image copied to the clipboard.' : 'Your browser refused the clipboard here. Use Save PNG.', { tone: ok ? 'ok' : 'warn' });
    },
  });
  const closeBtn = button('Close', { variant: 'ghost', onClick: () => window.close() });
  document.title = `Loophole · ${name}`;
  show(
    header('Approval capture', name, [save, copy, closeBtn]),
    h('p', { class: 'cap-note' }, 'Save or copy it from here. The image lives only in this tab: close it when you are done.'),
    h('div', { class: 'cap-stage' }, img),
  );
  save.focus();
}

init().catch((e) => {
  console.error('[Loophole:capture]', e);
  show(header('Screenshot', ''), h('div', { class: 'cap-empty' }, 'Something went wrong showing the image.'));
});
