import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProjectContext, dataCenterFromHost, projectFromContext, createProjectTracker,
} from '../src/core/project.js';

test('parses the plausible /i/user/context shapes', () => {
  assert.deepEqual(parseProjectContext({ project: { id: 18244, name: 'Prod' } }), { id: '18244', name: 'Prod' });
  assert.deepEqual(parseProjectContext({ currentProject: { projectId: 7, projectName: 'Stg' } }), { id: '7', name: 'Stg' });
  assert.deepEqual(parseProjectContext({ user: { project: { id: 3, name: 'Nested' } } }), { id: '3', name: 'Nested' });
  assert.deepEqual(parseProjectContext({ projectId: 12, projectName: 'Flat' }), { id: '12', name: 'Flat' });
});

test('falls back to a generated name or a name-only project', () => {
  assert.deepEqual(parseProjectContext({ project: { id: 5 } }), { id: '5', name: 'project 5' });
  assert.deepEqual(parseProjectContext({ project: { name: 'Only name' } }), { id: null, name: 'Only name' });
  assert.deepEqual(parseProjectContext({ project: { id: 0, name: 'Zero' } }), { id: '0', name: 'Zero' });
});

test('returns null when nothing identifies a project', () => {
  assert.equal(parseProjectContext(null), null);
  assert.equal(parseProjectContext({}), null);
  assert.equal(parseProjectContext({ user: { email: 'a@b.c' } }), null);
  assert.equal(parseProjectContext('nope'), null);
});

test('data center comes from the app hostname', () => {
  assert.equal(dataCenterFromHost('app.iterable.com'), 'us');
  assert.equal(dataCenterFromHost('app.eu.iterable.com'), 'eu');
  assert.equal(dataCenterFromHost('APP.EU.ITERABLE.COM'), 'eu');
  assert.equal(dataCenterFromHost('eu.example.com'), 'us');
  assert.equal(dataCenterFromHost(''), 'us');
});

test('projectKey format: <dc>:<id> or <dc>:name:<name>, built by makeProjectKey', () => {
  assert.equal(projectFromContext({ project: { id: 18244, name: 'Prod' } }, 'app.iterable.com').key, 'us:18244');
  assert.equal(projectFromContext({ project: { name: 'Foo' } }, 'app.eu.iterable.com').key, 'eu:name:Foo');
  // A name the vault would reject (control/bidi characters) never becomes a key.
  assert.equal(projectFromContext({ project: { name: 'Evil\u202Eeman' } }, 'app.iterable.com'), null);
  assert.equal(projectFromContext({ project: { id: 'a:b', name: 'Colon' } }, 'app.iterable.com'), null);
});

test('projectFromContext combines the parse with the host', () => {
  assert.deepEqual(projectFromContext({ project: { id: 20911, name: 'Harbor' } }, 'app.eu.iterable.com'),
    { key: 'eu:20911', id: '20911', name: 'Harbor', dataCenter: 'eu' });
  assert.equal(projectFromContext({}, 'app.iterable.com'), null);
});

test('tracker: refresh, throttle, force, change events, failure keeps last project', async () => {
  let now = 0;
  let calls = 0;
  let response = { project: { id: 1, name: 'A' } };
  const tracker = createProjectTracker({
    fetchContext: async () => { calls++; if (response instanceof Error) throw response; return response; },
    hostname: () => 'app.iterable.com',
    now: () => now,
  });
  const changes = [];
  tracker.onChange((next, prev) => changes.push([prev?.key ?? null, next.key]));

  assert.equal((await tracker.refresh()).key, 'us:1');
  now += 1000;
  await tracker.refresh();
  assert.equal(calls, 1, 'throttled within 30 s');

  response = { project: { id: 2, name: 'B' } };
  await tracker.refresh({ force: true });
  assert.equal(calls, 2);
  assert.equal(tracker.current().key, 'us:2');

  response = new Error('HTTP 500');
  now += 60_000;
  await tracker.refresh();
  assert.equal(tracker.current().key, 'us:2', 'a failed refresh keeps the last project');
  assert.match(tracker.error(), /500/);
  assert.deepEqual(changes, [[null, 'us:1'], ['us:1', 'us:2']]);
});

test('tracker: concurrent refreshes share one request', async () => {
  let calls = 0;
  const tracker = createProjectTracker({
    fetchContext: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { project: { id: 9 } }; },
    hostname: () => 'app.iterable.com',
  });
  await Promise.all([tracker.refresh({ force: true }), tracker.refresh({ force: true }), tracker.refresh()]);
  assert.equal(calls, 1);
});
