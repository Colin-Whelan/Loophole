import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLocale, localeFromSearch, sameLocale, badgeLabel, MAX_LABEL,
} from '../../src/features/locale-banner/logic.js';
import importer, { mapLocaleBanner } from '../../src/features/locale-banner/import.js';
import meta from '../../src/features/locale-banner/meta.js';
import { mergeValues } from '../../src/core/settings.js';

const DEFAULTS = { defaultLocale: '', pulseNonDefault: true, hideWhenNoLocale: true };
const withDefault = (d, extra = {}) => ({ ...DEFAULTS, defaultLocale: d, ...extra });

test('meta: id, route and settings schema', () => {
  assert.equal(meta.id, 'locale-banner');
  assert.deepEqual(meta.legacy, ['Iterable Locale Banner']);
  assert.ok(meta.routes.some((r) => r.test('/templates/editor?templateId=1&locale=fr-CA')));
  assert.ok(!meta.routes.some((r) => r.test('/templates?folder=1')));
  const byKey = Object.fromEntries(meta.settings.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), ['defaultLocale', 'hideWhenNoLocale', 'pulseNonDefault']);
  assert.equal(byKey.defaultLocale.type, 'string');
  assert.equal(byKey.defaultLocale.default, '');
  assert.equal(byKey.pulseNonDefault.type, 'boolean');
  assert.equal(byKey.pulseNonDefault.default, true);
  assert.equal(byKey.hideWhenNoLocale.type, 'boolean');
  assert.equal(byKey.hideWhenNoLocale.default, true);
});

test('localeFromSearch', () => {
  assert.equal(localeFromSearch('?templateId=5&locale=fr-CA'), 'fr-CA');
  assert.equal(localeFromSearch('?locale=%20de-DE%20'), 'de-DE');
  assert.equal(localeFromSearch('?locale='), '');
  assert.equal(localeFromSearch('?templateId=5'), '');
  assert.equal(localeFromSearch(''), '');
  assert.equal(localeFromSearch(undefined), '');
});

test('sameLocale is case-insensitive and treats _ like -', () => {
  assert.ok(sameLocale('fr-CA', 'FR-ca'));
  assert.ok(sameLocale('en_US', 'en-us'));
  assert.ok(!sameLocale('en-US', 'en-CA'));
  assert.ok(!sameLocale('', ''));
});

test('badgeLabel uppercases and caps length', () => {
  assert.equal(badgeLabel(' fr-ca '), 'FR-CA');
  const long = badgeLabel('x'.repeat(100));
  assert.equal(long.length, MAX_LABEL);
  assert.ok(long.endsWith('…'));
});

test('no default configured: every locale is neutral and never pulses', () => {
  for (const loc of ['fr-CA', 'en-CA', 'de-DE']) {
    const s = classifyLocale(loc, DEFAULTS);
    assert.equal(s.visible, true);
    assert.equal(s.tone, 'neutral');
    assert.equal(s.pulse, false);
    assert.equal(s.label, loc.toUpperCase());
  }
});

test('default configured: match → default (green), other → alt (amber, pulsing)', () => {
  const d = classifyLocale('EN-ca', withDefault('en-CA'));
  assert.deepEqual([d.visible, d.tone, d.pulse, d.label], [true, 'default', false, 'EN-CA']);
  const a = classifyLocale('fr-CA', withDefault('en-CA'));
  assert.deepEqual([a.visible, a.tone, a.pulse, a.label], [true, 'alt', true, 'FR-CA']);
  assert.match(a.title, /EN-CA/);
  // Whitespace around the configured default is ignored.
  assert.equal(classifyLocale('en-ca', withDefault('  en-CA ')).tone, 'default');
});

test('pulse needs pulseNonDefault and no reduced-motion preference', () => {
  assert.equal(classifyLocale('fr-CA', withDefault('en-CA', { pulseNonDefault: false })).pulse, false);
  assert.equal(classifyLocale('fr-CA', withDefault('en-CA'), { reducedMotion: true }).pulse, false);
  assert.equal(classifyLocale('fr-CA', withDefault('en-CA'), { reducedMotion: false }).pulse, true);
  // The default locale never pulses.
  assert.equal(classifyLocale('en-CA', withDefault('en-CA')).pulse, false);
});

test('no locale in the URL', () => {
  assert.equal(classifyLocale('', DEFAULTS).visible, false);
  assert.equal(classifyLocale(null, withDefault('en-CA')).visible, false);
  assert.equal(classifyLocale('   ', withDefault('en-CA')).visible, false);
  const shownDefault = classifyLocale('', withDefault('en-CA', { hideWhenNoLocale: false }));
  assert.deepEqual([shownDefault.visible, shownDefault.tone, shownDefault.label, shownDefault.pulse], [true, 'default', 'EN-CA', false]);
  const shownNeutral = classifyLocale(undefined, { ...DEFAULTS, hideWhenNoLocale: false });
  assert.deepEqual([shownNeutral.visible, shownNeutral.tone, shownNeutral.label], [true, 'neutral', 'DEFAULT']);
});

test('classifyLocale tolerates missing or junk settings', () => {
  assert.equal(classifyLocale('fr-CA', undefined).tone, 'neutral');
  assert.equal(classifyLocale('fr-CA', null).tone, 'neutral');
  assert.equal(classifyLocale('fr-CA', { defaultLocale: 42 }).tone, 'neutral');
  assert.equal(classifyLocale('', {}).visible, false); // hideWhenNoLocale defaults to true
});

test('import: empty or unknown storage imports nothing and never throws', () => {
  for (const s of [undefined, null, {}, [], 'junk', 42, { unrelated: 'x', ts: 1 }]) {
    const r = mapLocaleBanner(s);
    assert.deepEqual(r.values, {});
    assert.equal(r.notes.length, 1);
  }
  assert.deepEqual(importer.scripts, ['Iterable Locale Banner']);
  assert.equal(importer.map, mapLocaleBanner);
});

test('import: same-named values, decoded or still JSON-stringified', () => {
  assert.deepEqual(
    mapLocaleBanner({ defaultLocale: ' en-CA ', pulseNonDefault: false, hideWhenNoLocale: 'true' }).values,
    { defaultLocale: 'en-CA', pulseNonDefault: false, hideWhenNoLocale: true });
  assert.deepEqual(
    mapLocaleBanner({ defaultLocale: '"fr-CA"', pulseNonDefault: 'false', hideWhenNoLocale: '"false"' }).values,
    { defaultLocale: 'fr-CA', pulseNonDefault: false, hideWhenNoLocale: false });
  const bad = mapLocaleBanner({ defaultLocale: { x: 1 }, pulseNonDefault: 'maybe' });
  assert.deepEqual(bad.values, {});
  assert.equal(bad.notes.length, 2);
});

test('imported values resolve against the schema', () => {
  const { values } = mapLocaleBanner({ defaultLocale: 'en-CA' });
  const resolved = mergeValues(meta, values);
  assert.deepEqual(resolved, { defaultLocale: 'en-CA', pulseNonDefault: true, hideWhenNoLocale: true });
});
