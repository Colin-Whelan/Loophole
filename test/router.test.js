import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, routeTarget, isCatchAll, createRouter } from '../src/core/router.js';
import { FEATURES, getMeta } from '../src/features/registry.js';

test('routeTarget is pathname + search (no hash)', () => {
  assert.equal(routeTarget({ pathname: '/templates', search: '?q=1', hash: '#x' }), '/templates?q=1');
  assert.equal(routeTarget({ pathname: '/users', search: '' }), '/users');
  assert.equal(routeTarget({}), '/');
});

test('regex routes match against pathname + search', () => {
  assert.equal(matchRoute([/^\/users\/profiles\//], '/users/profiles/abc'), true);
  assert.equal(matchRoute([/^\/users\/profiles\//], '/users/lookup'), false);
  assert.equal(matchRoute([/[?&]locale=/], '/templates/editor?templateId=1&locale=fr'), true);
});

test('string routes are prefixes; any route matching is enough', () => {
  assert.equal(matchRoute(['/lists'], '/lists/123'), true);
  assert.equal(matchRoute(['/lists'], '/campaigns'), false);
  assert.equal(matchRoute(['/nope', /^\/campaigns/], '/campaigns/9'), true);
  assert.equal(matchRoute([], '/'), false);
  assert.equal(matchRoute(undefined, '/'), false);
});

test('stateful /g regexes do not leak lastIndex between calls', () => {
  const r = /templates/g;
  assert.equal(matchRoute([r], '/templates'), true);
  assert.equal(matchRoute([r], '/templates'), true);
});

test('catch-all detection', () => {
  assert.equal(isCatchAll({ routes: [/.*/] }), true);
  assert.equal(isCatchAll({ routes: [/^\//] }), true);
  assert.equal(isCatchAll({ routes: [/^\/templates/] }), false);
});

test('the shipped feature metas route where they should', () => {
  assert.equal(matchRoute(getMeta('delete-user').routes, '/users/profiles/x%40y.z/profile'), true);
  assert.equal(matchRoute(getMeta('delete-user').routes, '/templates'), false);
  assert.equal(matchRoute(getMeta('quick-search').routes, '/templates?folder=3'), true);
  // Bulk data: the lists index only (any query or trailing slash), never a list's own page.
  const bd = getMeta('bulk-data').routes;
  for (const t of ['/lists', '/lists/', '/lists?folder=3', '/lists/?q=a']) assert.equal(matchRoute(bd, t), true, t);
  for (const t of ['/lists/123', '/lists/123?x=1', '/listsx', '/users', '/', '/campaigns/lists']) assert.equal(matchRoute(bd, t), false, t);
  assert.equal(isCatchAll(getMeta('bulk-data')), false);
  assert.deepEqual(FEATURES.filter((m) => m.frame === 'bee').map((m) => m.id), ['link-params']);
});

test('every meta is well formed', () => {
  const ids = new Set();
  for (const m of FEATURES) {
    assert.match(m.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(['top', 'bee', 'auth'].includes(m.frame), `${m.id} frame`);
    assert.ok(Array.isArray(m.routes) && m.routes.length, `${m.id} routes`);
    assert.ok(Array.isArray(m.settings), `${m.id} settings`);
    assert.ok(Array.isArray(m.legacy), `${m.id} legacy`);
  }
});

// ── createRouter: failed mounts ──────────────────────────────────────────

function routerHarness(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const prevWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = prevWindow; });
  t.mock.method(console, 'error', () => {});

  const loc = { href: 'https://app.iterable.com/a', pathname: '/a', search: '' };
  const go = (path) => {
    Object.assign(loc, { href: 'https://app.iterable.com' + path, pathname: path, search: '' });
    window.dispatchEvent(new Event('popstate'));
  };
  let fail = true;
  let mounts = 0;
  const meta = { id: 'flaky', frame: 'top', routes: ['/a'], settings: [], legacy: [] };
  const impls = { flaky: { mount() { mounts++; if (fail) throw new Error('boom'); } } };
  let settings = { features: { flaky: { enabled: true, values: { n: 1 } }, other: { enabled: true, values: {} } } };
  let push = null;
  const router = createRouter({
    frame: 'top', metas: [meta], impls,
    makeCtx: (m, b) => b,
    loadSettings: async () => settings,
    subscribeSettings: (cb) => { push = cb; return () => {}; },
    getLocation: () => loc,
  });
  const setSettings = (next) => { settings = next; push(next); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { router, go, flush, setSettings, get settings() { return settings; },
    get mounts() { return mounts; }, succeed() { fail = false; } };
}

test('createRouter: a failed mount is retried after leaving and returning to the URL', async (t) => {
  const hx = routerHarness(t);
  await hx.router.start();
  await hx.flush();
  assert.equal(hx.mounts, 1);
  // Same URL: not retried.
  window.dispatchEvent(new Event('popstate'));
  await hx.flush();
  assert.equal(hx.mounts, 1);
  hx.go('/b');
  await hx.flush();
  hx.succeed();
  hx.go('/a');
  await hx.flush();
  assert.equal(hx.mounts, 2);
  assert.deepEqual(hx.router.mounted(), ['flaky']);
});

test('createRouter: a failed mount is retried when that feature’s settings change, not others’', async (t) => {
  const hx = routerHarness(t);
  await hx.router.start();
  await hx.flush();
  assert.equal(hx.mounts, 1);
  hx.succeed();
  // Another feature's settings changed: still not retried on this URL.
  hx.setSettings({ features: { ...hx.settings.features, other: { enabled: false, values: {} } } });
  await hx.flush();
  assert.equal(hx.mounts, 1);
  // This feature toggled / its values changed: retried.
  hx.setSettings({ features: { ...hx.settings.features, flaky: { enabled: true, values: { n: 2 } } } });
  await hx.flush();
  assert.equal(hx.mounts, 2);
  assert.deepEqual(hx.router.mounted(), ['flaky']);
});

// ── createRouter: holdMount / onRouteActive ──────────────────────────────

function holdHarness(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const prevWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = prevWindow; });
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'debug', () => {});

  const loc = { href: 'https://app.iterable.com/lists', pathname: '/lists', search: '' };
  const go = (path) => {
    Object.assign(loc, { href: 'https://app.iterable.com' + path, pathname: path, search: '' });
    window.dispatchEvent(new Event('popstate'));
  };
  const meta = { id: 'busy', frame: 'top', routes: [/^\/lists\/?$/], settings: [], legacy: [] };
  const hx = { ctx: null, mounts: 0, cleanups: 0, active: [] };
  const impls = {
    busy: {
      mount(ctx) {
        hx.mounts++;
        hx.ctx = ctx;
        ctx.onRouteActive((a) => hx.active.push(a));
        return () => { hx.cleanups++; };
      },
    },
  };
  let settings = { features: { busy: { enabled: true, values: {} } } };
  let push = null;
  const router = createRouter({
    frame: 'top', metas: [meta], impls,
    makeCtx: (m, b) => b,
    loadSettings: async () => settings,
    subscribeSettings: (cb) => { push = cb; return () => {}; },
    getLocation: () => loc,
  });
  hx.router = router;
  hx.go = go;
  hx.setEnabled = (enabled) => { settings = { features: { busy: { enabled, values: {} } } }; push(settings); };
  hx.flush = () => new Promise((r) => setTimeout(r, 0));
  return hx;
}

test('createRouter: without a hold, leaving the route unmounts', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  hx.go('/users');
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), []);
  assert.equal(hx.cleanups, 1);
  assert.deepEqual(hx.active, []);
});

test('createRouter: a held feature stays mounted off-route and unmounts when released', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const release = hx.ctx.holdMount();
  hx.go('/users');
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  assert.equal(hx.cleanups, 0);
  assert.equal(hx.ctx.signal.aborted, false);
  assert.deepEqual(hx.active, [false]);
  hx.go('/campaigns'); // still off-route: no repeat notification
  await hx.flush();
  assert.deepEqual(hx.active, [false]);
  release();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), []);
  assert.equal(hx.cleanups, 1);
  assert.equal(hx.ctx.signal.aborted, true);
  release(); // idempotent
  await hx.flush();
  assert.equal(hx.mounts, 1);
});

test('createRouter: coming back while held re-activates the same mount; releasing then keeps it', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const release = hx.ctx.holdMount();
  hx.go('/users');
  await hx.flush();
  hx.go('/lists');
  await hx.flush();
  assert.deepEqual(hx.active, [false, true]);
  assert.equal(hx.mounts, 1);
  release();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  assert.equal(hx.cleanups, 0);
});

test('createRouter: every hold must be released before unmounting', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const a = hx.ctx.holdMount();
  const b = hx.ctx.holdMount();
  hx.go('/users');
  await hx.flush();
  a();
  a();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  b();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), []);
});

test('createRouter: disabling a held feature waits for the release, then unmounts (logged)', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const release = hx.ctx.holdMount();
  hx.setEnabled(false);
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  assert.equal(hx.cleanups, 0);
  assert.deepEqual(hx.active, [false]);
  assert.ok(console.info.mock.calls.some((c) => /disabled while busy/.test(c.arguments.join(' '))));
  release();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), []);
  assert.equal(hx.cleanups, 1);
});

test('createRouter: re-enabling a held feature before release keeps it mounted', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const release = hx.ctx.holdMount();
  hx.setEnabled(false);
  await hx.flush();
  hx.setEnabled(true);
  await hx.flush();
  assert.deepEqual(hx.active, [false, true]);
  release();
  await hx.flush();
  assert.deepEqual(hx.router.mounted(), ['busy']);
  assert.equal(hx.mounts, 1);
});

test('createRouter: a hold taken after unmount is a no-op; unmountAll ignores holds', async (t) => {
  const hx = holdHarness(t);
  await hx.router.start();
  await hx.flush();
  const first = hx.ctx;
  first.holdMount();
  hx.router.unmountAll();
  assert.deepEqual(hx.router.mounted(), []);
  assert.equal(hx.cleanups, 1);
  const late = first.holdMount();
  assert.equal(typeof late, 'function');
  late();
  await hx.flush();
  assert.equal(hx.mounts, 1);
});

// ── createRouter: ctx.onUrlChange ────────────────────────────────────────

test('createRouter: onUrlChange fires on search/hash changes while mounted, unsubscribes, stops on unmount', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const prevWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = prevWindow; });
  t.mock.method(console, 'debug', () => {});

  const loc = { href: 'https://app.iterable.com/lists', pathname: '/lists', search: '' };
  const set = (pathname, search = '', hash = '') => {
    Object.assign(loc, { href: 'https://app.iterable.com' + pathname + search + hash, pathname, search });
    window.dispatchEvent(new Event(hash ? 'hashchange' : 'popstate'));
  };
  let ctx = null;
  const meta = { id: 'watcher', frame: 'top', routes: ['/lists'], settings: [], legacy: [] };
  const router = createRouter({
    frame: 'top', metas: [meta], impls: { watcher: { mount(c) { ctx = c; } } },
    makeCtx: (m, b) => b,
    loadSettings: async () => ({ features: { watcher: { enabled: true, values: {} } } }),
    subscribeSettings: () => () => {},
    getLocation: () => loc,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  await router.start();
  await flush();

  const seen = [];
  const off = ctx.onUrlChange((href) => seen.push(href));
  const other = [];
  ctx.onUrlChange((href) => other.push(href));

  set('/lists', '?page=2');   // search only
  await flush();
  window.dispatchEvent(new Event('hashchange'));   // same href: nothing
  set('/lists', '?page=2', '#top');   // hash only
  await flush();
  assert.deepEqual(seen, ['https://app.iterable.com/lists?page=2', 'https://app.iterable.com/lists?page=2#top']);
  assert.deepEqual(router.mounted(), ['watcher']);

  off();
  set('/lists', '?page=3');
  await flush();
  assert.equal(seen.length, 2);
  assert.equal(other.length, 3);

  // Leaving the route unmounts; the listener is dropped with ctx.signal.
  set('/users');
  await flush();
  assert.deepEqual(router.mounted(), []);
  assert.equal(ctx.signal.aborted, true);
  const before = other.length;
  const stale = ctx;
  set('/campaigns');
  await flush();
  assert.equal(other.length, before);
  // Subscribing on an unmounted ctx is a no-op.
  const late = [];
  stale.onUrlChange((h) => late.push(h));
  set('/templates');
  await flush();
  assert.deepEqual(late, []);
});
