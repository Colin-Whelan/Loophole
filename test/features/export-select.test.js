import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCKED_FIELDS, applyPlan, countSelection, fieldIdFromTestAttr, filterFields, formatCount, planSelection,
} from '../../src/features/export-select/plan.js';
import meta from '../../src/features/export-select/meta.js';

const f = (id, checked = false, visible = true, label = id) => ({ id, label, checked, visible });

// A synthetic field list: two locked fields, a mix of checked / unchecked, one hidden by Iterable.
const FIELDS = [
  f('userId', true),
  f('email', true),
  f('firstName', false, true, 'First Name'),
  f('lastName', true, true, 'Last Name'),
  f('signupDate', false),
  f('shoppingCartItems', false, false), // filtered out by Iterable's search (not rendered)
];

const ids = (plan) => plan.map((p) => p.id);
const checkedIds = (fields) => fields.filter((x) => x.checked).map((x) => x.id);

test('locked fields are userId and email', () => {
  assert.deepEqual([...LOCKED_FIELDS], ['userId', 'email']);
});

test('fieldIdFromTestAttr strips the row prefix', () => {
  assert.equal(fieldIdFromTestAttr('export-to-csv-field-email'), 'email');
  assert.equal(fieldIdFromTestAttr('export-to-csv-field-profile.nested.key'), 'profile.nested.key');
  assert.equal(fieldIdFromTestAttr(null), '');
});

test('filterFields: visible rows, then a trimmed case-insensitive label match', () => {
  assert.deepEqual(filterFields(FIELDS, '').map((x) => x.id), ['userId', 'email', 'firstName', 'lastName', 'signupDate']);
  assert.deepEqual(filterFields(FIELDS, '  NAME ').map((x) => x.id), ['firstName', 'lastName']);
  assert.deepEqual(filterFields(FIELDS, 'cart'), []); // matches, but hidden
});

test('select all checks every visible unchecked row, in row order', () => {
  const plan = planSelection(FIELDS, 'select');
  assert.deepEqual(plan, [{ id: 'firstName', checked: true }, { id: 'signupDate', checked: true }]);
  // Hidden rows are left alone.
  assert.deepEqual(checkedIds(applyPlan(FIELDS, plan)), ['userId', 'email', 'firstName', 'lastName', 'signupDate']);
});

test('select filtered: select all only touches rows matching the search', () => {
  const plan = planSelection(FIELDS, 'select', 'first');
  assert.deepEqual(plan, [{ id: 'firstName', checked: true }]);
  assert.deepEqual(planSelection(FIELDS, 'select', 'no such field'), []);
});

test('deselect all unchecks visible rows but never the locked fields', () => {
  const plan = planSelection(FIELDS, 'deselect');
  assert.deepEqual(plan, [{ id: 'lastName', checked: false }]);
  assert.deepEqual(checkedIds(applyPlan(FIELDS, plan)), ['userId', 'email']);
});

test('deselect with a search only touches matching rows', () => {
  const fields = FIELDS.map((x) => ({ ...x, checked: true }));
  assert.deepEqual(ids(planSelection(fields, 'deselect', 'date')), ['signupDate']);
  assert.deepEqual(planSelection(fields, 'deselect', 'mail'), []); // only email matches, and it's locked
});

test('invert flips visible rows but keeps checked locked fields checked', () => {
  const plan = planSelection(FIELDS, 'invert');
  assert.deepEqual(plan, [
    { id: 'firstName', checked: true },
    { id: 'lastName', checked: false },
    { id: 'signupDate', checked: true },
  ]);
  assert.deepEqual(checkedIds(applyPlan(FIELDS, plan)), ['userId', 'email', 'firstName', 'signupDate']);
});

test('invert checks an unchecked locked field (it only refuses to uncheck them)', () => {
  const fields = [f('userId', false), f('email', true), f('city', true)];
  assert.deepEqual(planSelection(fields, 'invert'), [{ id: 'userId', checked: true }, { id: 'city', checked: false }]);
});

test('invert with a search only flips matching rows', () => {
  assert.deepEqual(planSelection(FIELDS, 'invert', 'last'), [{ id: 'lastName', checked: false }]);
});

test('no operation ever unchecks userId or email', () => {
  const variants = [
    FIELDS,
    FIELDS.map((x) => ({ ...x, checked: true })),
    [f('email', true, true, 'Email'), f('userId', true, true, 'User ID'), f('emailListIds', true)],
  ];
  for (const fields of variants) {
    for (const op of ['select', 'deselect', 'invert']) {
      for (const q of ['', 'email', 'user', 'id']) {
        const plan = planSelection(fields, op, q);
        for (const p of plan) {
          if (LOCKED_FIELDS.includes(p.id)) assert.equal(p.checked, true, `${op} "${q}" unchecked ${p.id}`);
        }
        const after = applyPlan(fields, plan);
        for (const id of LOCKED_FIELDS) {
          const before = fields.find((x) => x.id === id);
          if (before?.checked) assert.equal(after.find((x) => x.id === id).checked, true);
        }
      }
    }
  }
});

test('plans only list rows that change, and skip rows without an id', () => {
  const fields = [f('', false), f('a', true), f('b', false)];
  assert.deepEqual(planSelection(fields, 'select'), [{ id: 'b', checked: true }]);
  assert.deepEqual(planSelection(fields, 'bogus'), []);
});

test('count is checked vs total over the filtered rows', () => {
  assert.deepEqual(countSelection(FIELDS), { selected: 3, total: 5 });
  assert.deepEqual(countSelection(FIELDS, 'name'), { selected: 1, total: 2 });
  assert.equal(formatCount({ selected: 42, total: 180 }), 'Selected 42 of 180');
});

test('meta: segmentation routes only', () => {
  assert.equal(meta.id, 'export-select');
  const matches = (p) => meta.routes.some((r) => r.test(p));
  assert.ok(matches('/segmentation'));
  assert.ok(matches('/segmentation?emailListId=123'));
  assert.ok(matches('/segmentation/abc'));
  assert.ok(!matches('/segmentationx'));
  assert.ok(!matches('/lists/123'));
  assert.ok(!matches('/templates'));
});
