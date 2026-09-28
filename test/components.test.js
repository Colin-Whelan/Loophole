// ui/components.js bits testable without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default "";', shortCircuit: true };
  return next(url, context);
}`));

const { popupOpenAt } = await import('../src/ui/components.js');

function el(attrs) {
  return { getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs };
}
const ev = (target) => ({ key: 'Escape', composedPath: () => [target], target });

test('dialog Escape: an open combobox list swallows the first Escape', () => {
  assert.equal(popupOpenAt(ev(el({ role: 'combobox', 'aria-expanded': 'true' }))), true);
  assert.equal(popupOpenAt(ev(el({ role: 'combobox', 'aria-expanded': 'false' }))), false);
  assert.equal(popupOpenAt(ev(el({ 'aria-haspopup': 'menu', 'aria-expanded': 'true' }))), true);
  // A plain disclosure button (expanded section) doesn't block closing the dialog.
  assert.equal(popupOpenAt(ev(el({ 'aria-expanded': 'true' }))), false);
  assert.equal(popupOpenAt({ key: 'Escape', target: null }), false);
});
