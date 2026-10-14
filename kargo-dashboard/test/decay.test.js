import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortFreight, dedupeFreight, versionsBehind, bucket } from '../src/decay.js';
import { DEFAULT_THRESHOLDS as T } from '../src/config.js';

const f = (name, ts, discoveredAt) => ({ metadata: { name, creationTimestamp: ts }, discoveredAt });
// newest -> oldest: f10 ... f0
const all = sortFreight(Array.from({ length: 11 }, (_, i) => f(`f${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`)));

test('sorts newest first', () => {
  assert.equal(all[0].metadata.name, 'f10');
  assert.equal(all[10].metadata.name, 'f0');
});

test('discoveredAt takes precedence over creationTimestamp', () => {
  const s = sortFreight([f('a', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), f('b', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z')]);
  assert.deepEqual(s.map((x) => x.metadata.name), ['b', 'a']);
});

test('equal timestamps are ordered deterministically by name', () => {
  const a = sortFreight([f('y', 't'), f('x', 't'), f('z', 't')].map((x) => ({ ...x, discoveredAt: '2026-01-01T00:00:00Z' })));
  const b = sortFreight([...a].reverse());
  assert.deepEqual(a.map((x) => x.metadata.name), b.map((x) => x.metadata.name));
});

test('dedupe keeps first occurrence', () => {
  assert.equal(dedupeFreight([f('a', 't'), f('a', 't'), f('b', 't')]).length, 2);
});

test('versions behind and default buckets: 0,1,2,3,4,10', () => {
  const expected = { 0: 'Good', 1: 'OK', 2: 'Bad', 3: 'Bad', 4: 'Worse', 10: 'Worse' };
  for (const [n, label] of Object.entries(expected)) {
    const behind = versionsBehind(all, `f${10 - Number(n)}`);
    assert.equal(behind, Number(n));
    assert.equal(bucket(behind, T).label, label, `${n} behind`);
  }
});

test('nothing deployed or garbage-collected freight is Worse/unknown', () => {
  assert.equal(versionsBehind(all, undefined), null);
  assert.equal(versionsBehind(all, 'gone'), null);
  const b = bucket(null, T);
  assert.deepEqual([b.label, b.color], ['unknown', T[3].color]);
});

test('custom thresholds', () => {
  const custom = [{ max: 0, label: 'fresh', color: '#1' }, { max: null, label: 'old', color: '#2' }];
  assert.equal(bucket(0, custom).label, 'fresh');
  assert.equal(bucket(1, custom).label, 'old');
});
