import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersionSource, versionFor } from '../src/version.js';

const wh = (...subscriptions) => ({ spec: { subscriptions } });
const IMG = 'ghcr.io/o/app';
const freight = (extra = {}) => ({
  metadata: { name: 'abc123def' }, alias: 'fuzzy-cat',
  images: [{ repoURL: IMG, tag: '7-red', subscriptionName: 'img' }],
  charts: [{ repoURL: 'oci://c/chart', name: '', version: '1.2.3', subscriptionName: 'ch' }],
  commits: [{ repoURL: 'https://g/r', id: '0123456789abcdef', subscriptionName: 'git' }],
  ...extra,
});

test('image first', () => {
  const src = resolveVersionSource(wh({ image: { repoURL: IMG } }, { git: { repoURL: 'https://g/r' } }));
  assert.equal(src.type, 'image');
  assert.equal(versionFor(freight(), src).version, '7-red');
});

test('git listed before image still picks the image', () => {
  const src = resolveVersionSource(wh({ git: { repoURL: 'https://g/r' } }, { image: { repoURL: IMG } }));
  assert.equal(src.type, 'image');
  assert.equal(versionFor(freight(), src).version, '7-red');
});

test('chart only', () => {
  const src = resolveVersionSource(wh({ chart: { repoURL: 'oci://c/chart' } }));
  assert.equal(versionFor(freight(), src).version, '1.2.3');
});

test('git only uses the 7-char short sha', () => {
  const src = resolveVersionSource(wh({ git: { repoURL: 'https://g/r' } }));
  assert.equal(versionFor(freight(), src).version, '0123456');
});

test('image and chart: whichever is listed first wins', () => {
  assert.equal(resolveVersionSource(wh({ chart: { repoURL: 'oci://c/chart' } }, { image: { repoURL: IMG } })).type, 'chart');
  assert.equal(resolveVersionSource(wh({ image: { repoURL: IMG } }, { chart: { repoURL: 'oci://c/chart' } })).type, 'image');
});

test('OCI chart with empty name matches by repoURL alone; classic chart also matches name', () => {
  const f = freight({ charts: [
    { repoURL: 'https://repo', name: 'other', version: '9.9.9' },
    { repoURL: 'https://repo', name: 'mine', version: '2.0.0' },
  ] });
  assert.equal(versionFor(f, resolveVersionSource(wh({ chart: { repoURL: 'https://repo', name: 'mine' } }))).version, '2.0.0');
  assert.equal(versionFor(freight(), resolveVersionSource(wh({ chart: { repoURL: 'oci://c/chart' } }))).version, '1.2.3');
});

test('same repoURL, different subscription names: matched by subscriptionName', () => {
  const f = freight({ images: [
    { repoURL: IMG, tag: 'stable', subscriptionName: 'a' },
    { repoURL: IMG, tag: 'edge', subscriptionName: 'b' },
  ] });
  const src = resolveVersionSource(wh({ name: 'b', image: { repoURL: IMG } }, { name: 'a', image: { repoURL: IMG } }));
  assert.equal(versionFor(f, src).version, 'edge');
});

test('generic subscription listed first is skipped', () => {
  const src = resolveVersionSource(wh({ custom: { x: 1 } }, { image: { repoURL: IMG } }));
  assert.equal(src.type, 'image');
});

test('no usable subscription yields null source and alias fallback with a warning', () => {
  assert.equal(resolveVersionSource(wh({ custom: {} })), null);
  const warnings = [];
  const r = versionFor(freight(), null, (m) => warnings.push(m));
  assert.deepEqual([r.version, r.fallback, warnings.length], ['fuzzy-cat', true, 1]);
});

test('missing match falls back to alias, then freight name', () => {
  const src = resolveVersionSource(wh({ image: { repoURL: 'ghcr.io/other' } }));
  assert.equal(versionFor(freight(), src).version, 'fuzzy-cat');
  assert.equal(versionFor(freight({ alias: undefined }), src).version, 'abc123def');
});

test('works on a stage FreightReference (name instead of metadata.name)', () => {
  const ref = { name: 'abc123def', images: [{ repoURL: IMG, tag: '5-blue' }] };
  const r = versionFor(ref, resolveVersionSource(wh({ image: { repoURL: IMG } })));
  assert.deepEqual([r.version, r.freightName], ['5-blue', 'abc123def']);
});
