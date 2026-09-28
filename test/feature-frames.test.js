// Where features run (companion frames), optional-permission features (frame 'auth'): meta
// validation, the background's registration sync plan, the "remove access" offer, the router's
// companion handling, and the click-handler ordering of the permission request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  homeFrame, companionFrames, runsIn, isCompanionIn, featureOrigins, patternOrigin, featureMatchesOrigin,
  validateFrameMetas, desiredAuthScripts, planScriptSync, unneededOrigins, AUTH_SCRIPT_ID, AUTH_SCRIPT_FILE,
} = await import('../src/core/feature-frames.js');
const { createRouter } = await import('../src/core/router.js');
const { FEATURES } = await import('../src/features/registry.js');

const AUTH = 'https://auth.iterable.com/*';
const OPTIONAL = [AUTH, 'https://sso.example.com/*'];
const REQUIRED = ['https://app.iterable.com/*'];

const login = { id: 'login-autofill', frame: 'auth', routes: [/^\/u\/login/], permissions: { origins: [AUTH] } };
const sso = { id: 'sso-helper', frame: 'auth', routes: [/.*/], permissions: { origins: ['https://sso.example.com/*', AUTH] } };
const acd = { id: 'auto-confirm', frame: 'top', companionFrames: ['bee'], routes: [/^\/templates\/editor/] };
const plain = { id: 'plain', routes: [/.*/] };

const settingsWith = (enabled) => ({ features: Object.fromEntries(Object.entries(enabled).map(([id, on]) => [id, { enabled: on, values: {} }])) });

describe('frame helpers', () => {
  test('home, companions, runsIn', () => {
    assert.equal(homeFrame(plain), 'top');
    assert.deepEqual(companionFrames(plain), []);
    assert.equal(runsIn(acd, 'top'), true);
    assert.equal(runsIn(acd, 'bee'), true);
    assert.equal(runsIn(acd, 'auth'), false);
    assert.equal(isCompanionIn(acd, 'bee'), true);
    assert.equal(isCompanionIn(acd, 'top'), false);
    assert.equal(runsIn(login, 'auth'), true);
    assert.equal(runsIn(login, 'top'), false);
  });

  test('origins', () => {
    assert.deepEqual(featureOrigins(login), [AUTH]);
    assert.deepEqual(featureOrigins(plain), []);
    assert.equal(patternOrigin(AUTH), 'https://auth.iterable.com');
    for (const bad of ['http://auth.iterable.com/*', 'https://auth.iterable.com/u/*', 'https://*.iterable.com/*', '<all_urls>', 'https://auth.iterable.com', 'https://-x.com/*']) {
      assert.equal(patternOrigin(bad), null, bad);
    }
    assert.equal(featureMatchesOrigin(login, 'https://auth.iterable.com'), true);
    assert.equal(featureMatchesOrigin(login, 'https://auth.iterable.com.evil.example'), false);
    assert.equal(featureMatchesOrigin(login, 'https://app.iterable.com'), false);
  });
});

describe('validateFrameMetas (build-time)', () => {
  const files = (map) => (id) => new Set(map[id] || []);
  const v = (metas, fileMap = {}) => validateFrameMetas(metas, { files: files(fileMap), optionalOrigins: OPTIONAL, requiredOrigins: REQUIRED });

  test('the shipped registry is valid', () => {
    // Any feature with companions ships its <frame>.js; the build checks real files, here we trust them.
    const all = new Proxy({}, { get: () => ['index.js', 'bee.js', 'top.js'] });
    assert.deepEqual(validateFrameMetas(FEATURES, { files: (id) => new Set(all[id]), optionalOrigins: [AUTH], requiredOrigins: REQUIRED }), []);
  });

  test('good metas pass', () => {
    assert.deepEqual(v([login, sso, acd, plain], { 'auto-confirm': ['index.js', 'bee.js'] }), []);
  });

  test('bad metas fail with a reason', () => {
    const cases = [
      [{ ...plain, frame: 'popup' }, /unknown frame/],
      [{ ...acd }, /no src\/features\/auto-confirm\/bee.js/],
      [{ ...acd, companionFrames: ['top'] }, /is its home frame/],
      [{ ...acd, companionFrames: ['auth'] }, /companion frame "auth"/],
      [{ ...acd, companionFrames: 'bee' }, /must be an array/],
      [{ ...login, companionFrames: ['bee'] }, /can't have companion frames/],
      [{ ...login, permissions: undefined }, /needs permissions.origins/],
      [{ ...login, permissions: { origins: [] } }, /non-empty/],
      [{ ...login, permissions: { origins: ['https://unlisted.example/*'] } }, /not in manifest optional_host_permissions/],
      [{ ...login, permissions: { origins: ['https://app.iterable.com/*'] } }, /not in manifest optional|already a required/],
      [{ ...login, permissions: { origins: ['<all_urls>'] } }, /must look like/],
      [{ ...login, permissions: { origins: [AUTH], permissions: ['tabs'] } }, /not supported/],
      [{ ...plain, id: 'Bad_Id' }, /kebab-case/],
    ];
    for (const [meta, re] of cases) {
      const errs = v([meta], { 'auto-confirm': ['index.js'], 'login-autofill': ['index.js'] });
      assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(meta)} → ${JSON.stringify(errs)}`);
    }
    assert.ok(v([login], { 'login-autofill': ['index.js', 'main.js'] }).some((e) => /main.js/.test(e)));
    assert.ok(validateFrameMetas([{ ...login, permissions: { origins: [AUTH] } }], { optionalOrigins: [AUTH], requiredOrigins: [AUTH] })
      .some((e) => /already a required/.test(e)));
  });
});

describe('optional content-script sync (background)', () => {
  const metas = [login, sso, acd, plain];

  test('desired = enabled frame:auth features ∩ granted origins, as one registration', () => {
    assert.deepEqual(desiredAuthScripts({ metas, settings: settingsWith({ 'login-autofill': true }), granted: new Set() }), [], 'not granted');
    assert.deepEqual(desiredAuthScripts({ metas, settings: settingsWith({ 'login-autofill': false }), granted: new Set([AUTH]) }), [], 'granted, not enabled');
    const [one] = desiredAuthScripts({ metas, settings: settingsWith({ 'login-autofill': true }), granted: new Set([AUTH]) });
    assert.deepEqual(one, { id: AUTH_SCRIPT_ID, js: [AUTH_SCRIPT_FILE], matches: [AUTH], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true });
    const [both] = desiredAuthScripts({ metas, settings: settingsWith({ 'login-autofill': true, 'sso-helper': true }), granted: new Set([AUTH, 'https://sso.example.com/*']) });
    assert.deepEqual(both.matches, [AUTH, 'https://sso.example.com/*']);
    const [partial] = desiredAuthScripts({ metas, settings: settingsWith({ 'sso-helper': true }), granted: new Set([AUTH]) });
    assert.deepEqual(partial.matches, [AUTH], 'only the granted part of a feature’s origins');
    assert.deepEqual(desiredAuthScripts({ metas: [acd, plain], settings: settingsWith({ 'auto-confirm': true, plain: true }), granted: new Set([AUTH]) }), [], 'non-auth features never register anything');
  });

  test('plan: register missing, unregister stale or changed, leave identical and foreign ids alone', () => {
    const want = desiredAuthScripts({ metas, settings: settingsWith({ 'login-autofill': true }), granted: new Set([AUTH]) });
    assert.deepEqual(planScriptSync([], want), { unregister: [], register: want });
    const registered = [{ id: 'wb-auth', js: ['content-auth.js'], matches: [AUTH], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }];
    assert.deepEqual(planScriptSync(registered, want), { unregister: [], register: [] }, 'idempotent on every background start');
    // Firefox returns the matches it stored; order must not matter.
    const wide = [{ ...registered[0], matches: ['https://sso.example.com/*', AUTH] }];
    const wantWide = [{ ...want[0], matches: [AUTH, 'https://sso.example.com/*'] }];
    assert.deepEqual(planScriptSync(wide, wantWide), { unregister: [], register: [] });
    assert.deepEqual(planScriptSync(wide, want), { unregister: ['wb-auth'], register: want }, 'matches shrank');
    assert.deepEqual(planScriptSync(registered, []), { unregister: ['wb-auth'], register: [] }, 'disabled or permission removed');
    assert.deepEqual(planScriptSync([{ id: 'wb-stale-old', js: ['x.js'], matches: [AUTH] }, { id: 'someone-else', js: ['y.js'], matches: [AUTH] }], []),
      { unregister: ['wb-stale-old'], register: [] });
    assert.deepEqual(planScriptSync(null, []), { unregister: [], register: [] });
  });

  test('unneededOrigins: offer to remove only what no enabled feature still needs', () => {
    assert.deepEqual(unneededOrigins({ metas, settings: settingsWith({ 'login-autofill': false }), candidates: [AUTH] }), [AUTH]);
    assert.deepEqual(unneededOrigins({ metas, settings: settingsWith({ 'login-autofill': false, 'sso-helper': true }), candidates: [AUTH] }), [],
      'another enabled feature uses the same host');
    assert.deepEqual(unneededOrigins({ metas, settings: settingsWith({ 'sso-helper': false }), candidates: featureOrigins(sso) }).sort(), [AUTH, 'https://sso.example.com/*'].sort());
  });
});

describe('permission request ordering (popup / options click handlers)', () => {
  test('switching on calls chrome.permissions.request synchronously, before anything else', async () => {
    const calls = [];
    let resolveRequest;
    globalThis.chrome = {
      permissions: {
        request: (p) => { calls.push(['request', p]); return new Promise((r) => { resolveRequest = r; }); },
        contains: async () => true,
      },
    };
    const { setFeatureEnabledFromClick } = await import('../src/core/permissions.js');
    const setEnabled = (id, on) => { calls.push(['set', id, on]); return Promise.resolve(settingsWith({ [id]: on })); };
    const p = setFeatureEnabledFromClick(login, true, { setEnabled, metas: [login] });
    // Synchronously, in the same tick as the click: the request first, then the optimistic flag.
    assert.deepEqual(calls, [['request', { origins: [AUTH] }], ['set', 'login-autofill', true]]);
    resolveRequest(false);
    assert.deepEqual(await p, { enabled: false, denied: true, error: '' });
    assert.deepEqual(calls.at(-1), ['set', 'login-autofill', false], 'denied → flag put back');

    calls.length = 0;
    const p2 = setFeatureEnabledFromClick(login, true, { setEnabled, metas: [login] });
    resolveRequest(true);
    assert.deepEqual(await p2, { enabled: true });
    assert.deepEqual(calls.map((c) => c[0]), ['request', 'set']);

    // A synchronous throw (e.g. an undeclared origin) is a denial, not a crash.
    globalThis.chrome.permissions.request = () => { throw new Error('not declared'); };
    const r3 = await setFeatureEnabledFromClick(login, true, { setEnabled, metas: [login] });
    assert.equal(r3.denied, true);
    assert.match(r3.error, /not declared/);

    // Off: offers the granted origins nothing else needs.
    globalThis.chrome.permissions.contains = async ({ origins }) => origins[0] === AUTH;
    const r4 = await setFeatureEnabledFromClick(login, false, { setEnabled, metas: [login] });
    assert.deepEqual(r4, { enabled: false, removable: [AUTH] });

    // A feature without optional origins never touches chrome.permissions.
    globalThis.chrome.permissions.request = () => { throw new Error('should not be called'); };
    assert.deepEqual(await setFeatureEnabledFromClick(plain, true, { setEnabled, metas: [plain] }), { enabled: true });
    delete globalThis.chrome;
  });
});

describe('router: companion frames', () => {
  test('a companion mounts in its frame whenever enabled; its home routes don’t apply there', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const prevWindow = globalThis.window;
    globalThis.window = new EventTarget();
    t.after(() => { globalThis.window = prevWindow; });
    const loc = { href: 'https://app.getbee.io/editor', pathname: '/editor', search: '' };
    const mounted = [];
    const impls = { 'auto-confirm': { mount: () => { mounted.push('auto-confirm'); } }, other: { mount: () => { mounted.push('other'); } } };
    let settings = settingsWith({ 'auto-confirm': true, other: true, plain: true });
    let push;
    const other = { id: 'other', frame: 'top', routes: [/.*/] };
    const router = createRouter({
      frame: 'bee', metas: [acd, other, plain], impls, makeCtx: (m, b) => b,
      loadSettings: async () => settings, subscribeSettings: (cb) => { push = cb; return () => {}; }, getLocation: () => loc,
    });
    await router.start();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(mounted, ['auto-confirm'], 'top-only features never mount in a bee frame');
    assert.deepEqual(router.mounted(), ['auto-confirm']);
    settings = settingsWith({ 'auto-confirm': false });
    push(settings);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(router.mounted(), [], 'disabled → unmounted in the companion frame too');
  });
});
