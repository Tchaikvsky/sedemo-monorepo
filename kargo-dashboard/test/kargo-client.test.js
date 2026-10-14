import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKargoClient, KargoApiError } from '../src/kargo-client.js';

const respond = (status, body) => async (url, init) => {
  respond.calls.push({ url, init });
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};
respond.calls = [];
const client = (impl) => createKargoClient({ url: 'https://k.example/', fetchImpl: impl, timeoutMs: 50 });

test('builds URLs, sends bearer token and JSON accept', async () => {
  respond.calls.length = 0;
  const c = client(respond(200, { items: [{ metadata: { name: 'w' } }] }));
  assert.equal((await c.listWarehouses('p q', 'tok')).length, 1);
  await c.listStages('p', 'tok');
  await c.listFreight('p', 'wh', 'tok');
  assert.deepEqual(respond.calls.map((x) => x.url), [
    'https://k.example/v1beta1/projects/p%20q/warehouses',
    'https://k.example/v1beta1/projects/p/stages',
    'https://k.example/v1beta1/projects/p/freight?origins=wh',
  ]);
  assert.equal(respond.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(respond.calls[0].init.headers.Accept, 'application/json');
});

test('flattens all freight groups and de-duplicates by name', async () => {
  const f = (n) => ({ metadata: { name: n } });
  const c = client(respond(200, { groups: { a: { items: [f('x'), f('y')] }, b: { items: [f('y'), f('z')] } } }));
  assert.deepEqual((await c.listFreight('p', 'w', 't')).map((x) => x.metadata.name), ['x', 'y', 'z']);
});

test('missing items/groups yield empty arrays', async () => {
  const c = client(respond(200, {}));
  assert.deepEqual(await c.listWarehouses('p', 't'), []);
  assert.deepEqual(await c.listFreight('p', 'w', 't'), []);
});

test('401 and 403 become a token-access error that never contains the token', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(client(respond(status, {})).listStages('proj', 'w', 'SECRET'), (e) => {
      assert.ok(e instanceof KargoApiError);
      assert.equal(e.status, status);
      assert.match(e.message, /token lacks access to project proj/);
      assert.ok(!e.message.includes('SECRET'));
      return true;
    });
  }
});

test('other HTTP errors and network failures are KargoApiErrors', async () => {
  await assert.rejects(client(respond(500, {})).listWarehouses('p', 't'), /HTTP 500/);
  await assert.rejects(client(async () => { throw new Error('boom'); }).listWarehouses('p', 't'), /boom/);
});

test('timeouts are reported as such', async () => {
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  await assert.rejects(client(slow).listWarehouses('p', 't'), /timed out after 50ms/);
});
