import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLookupKind, profilePath, formatDate, userKvRows, profileIdOf, lookupOutcome, NO_PROFILE_ID_MESSAGE,
} from '../../src/features/user-lookup/lookup.js';
import meta from '../../src/features/user-lookup/meta.js';

// ── detectLookupKind ─────────────────────────────────────────────────────────

test('detectLookupKind: "@" means email, otherwise userId', () => {
  assert.equal(detectLookupKind('a@example.com'), 'email');
  assert.equal(detectLookupKind('usr_123'), 'userId');
  assert.equal(detectLookupKind('  b@example.com  '), 'email');
});

test('detectLookupKind: empty/whitespace-only → null', () => {
  assert.equal(detectLookupKind(''), null);
  assert.equal(detectLookupKind('   '), null);
  assert.equal(detectLookupKind(undefined), null);
});

// ── profilePath ──────────────────────────────────────────────────────────────

test('profilePath is relative and encodes the id', () => {
  assert.equal(profilePath('abc123'), '/users/profiles/abc123');
  assert.equal(profilePath('has space/slash'), '/users/profiles/has%20space%2Fslash');
});

// ── formatDate ───────────────────────────────────────────────────────────────

test('formatDate: a parseable value becomes a non-empty string; unparseable value passes through', () => {
  const out = formatDate('2024-03-11T09:42:00Z');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
  assert.equal(formatDate('not a date'), 'not a date');
});

// ── userKvRows / profileIdOf ───────────────────────────────────────────────

test('userKvRows: builds rows only for present fields, preferring itblUserId', () => {
  const rows = userKvRows({ email: 'a@example.com', userId: 'u1', itblUserId: 'it1', signupDate: '2024-01-01' });
  assert.deepEqual(rows[0], ['Email', 'a@example.com']);
  assert.deepEqual(rows[1], ['User ID', 'it1']);
  assert.equal(rows[2][0], 'Signup date');
});

test('userKvRows: shows first/last name and last seen when present, in the old bar order', () => {
  const rows = userKvRows({ email: 'a@example.com', itblUserId: 'it1', firstName: 'Ada', lastName: 'Lovelace',
    signupDate: '2024-01-01', lastSeenDate: '2025-01-01T00:00:00Z' });
  assert.deepEqual(rows.map((r) => r[0]), ['Email', 'User ID', 'First name', 'Last name', 'Signup date', 'Last seen']);
  assert.deepEqual(rows[2], ['First name', 'Ada']);
  assert.deepEqual(rows[3], ['Last name', 'Lovelace']);
  assert.deepEqual(userKvRows({ userId: 'u1', firstName: '' }).map((r) => r[0]), ['User ID']);
});

test('userKvRows: falls back to userId when itblUserId is missing', () => {
  const rows = userKvRows({ userId: 'u1' });
  assert.deepEqual(rows, [['User ID', 'u1']]);
});

test('userKvRows: empty/invalid input → no rows, never throws', () => {
  assert.deepEqual(userKvRows({}), []);
  assert.deepEqual(userKvRows(null), []);
});

test('profileIdOf prefers itblUserId, falls back to userId, else null', () => {
  assert.equal(profileIdOf({ itblUserId: 'it1', userId: 'u1' }), 'it1');
  assert.equal(profileIdOf({ userId: 'u1' }), 'u1');
  assert.equal(profileIdOf({}), null);
  assert.equal(profileIdOf(null), null);
});

// ── meta.js shape ────────────────────────────────────────────────────────────

test('meta: ids and the focusShortcut default (not the Workflow link parameters shortcut)', () => {
  assert.equal(meta.id, 'user-lookup');
  assert.equal(meta.frame, 'top');
  const shortcut = meta.settings.find((s) => s.key === 'focusShortcut');
  assert.equal(shortcut.type, 'shortcut');
  assert.equal(shortcut.default, '');
  assert.notEqual(shortcut.default, 'Mod+Shift+L');
});

// ── lookupOutcome: found → straight to the profile ────────────────────────────

test('lookupOutcome: a found user with an id opens the profile (no preview)', () => {
  assert.deepEqual(lookupOutcome({ status: 'found', user: { email: 'a@example.com', itblUserId: 'it 1', userId: 'u1' } }),
    { action: 'open', path: '/users/profiles/it%201' });
  assert.deepEqual(lookupOutcome({ status: 'found', user: { userId: 'u1' } }), { action: 'open', path: '/users/profiles/u1' });
});

test('lookupOutcome: found without a profile id explains why and shows what came back', () => {
  const out = lookupOutcome({ status: 'found', user: { email: 'a@example.com', firstName: 'Ada' } });
  assert.equal(out.action, 'preview');
  assert.equal(out.message, NO_PROFILE_ID_MESSAGE);
  assert.deepEqual(out.rows, [['Email', 'a@example.com'], ['First name', 'Ada']]);
});

test('lookupOutcome: not found and failures are inline errors', () => {
  assert.deepEqual(lookupOutcome({ status: 'not-found' }), { action: 'error', message: 'No user found.' });
  assert.deepEqual(lookupOutcome({ status: 'error', message: 'HTTP 500' }), { action: 'error', message: 'HTTP 500' });
  assert.deepEqual(lookupOutcome({ status: 'error' }), { action: 'error', message: 'Lookup failed.' });
  assert.deepEqual(lookupOutcome(null), { action: 'error', message: 'Lookup failed.' });
});
