import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderStages } from '../src/stage-order.js';

const W = 'wh';
// stage(name, { from: [stages], direct, steps, warehouse })
const stage = (name, { from = [], direct = false, steps = true, warehouse = W } = {}) => ({
  metadata: { name },
  spec: {
    requestedFreight: [{ origin: { kind: 'Warehouse', name: warehouse }, sources: direct || !from.length ? { direct: true } : { stages: from } }],
    promotionTemplate: steps ? { spec: { steps: [{ uses: 'x' }] } } : undefined,
  },
});
const names = (rows) => rows.map((r) => r.name);

test('linear dev -> staging -> prod regardless of input order', () => {
  const rows = orderStages([stage('prod', { from: ['staging'] }), stage('dev'), stage('staging', { from: ['dev'] })], W);
  assert.deepEqual(names(rows), ['dev', 'staging', 'prod']);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2]);
});

test('fan-out: siblings share depth and sort by name', () => {
  const rows = orderStages([stage('prod-west', { from: ['dev'] }), stage('prod-east', { from: ['dev'] }), stage('dev')], W);
  assert.deepEqual(names(rows), ['dev', 'prod-east', 'prod-west']);
});

test('fan-in uses the longest path', () => {
  const rows = orderStages([
    stage('dev'), stage('qa', { from: ['dev'] }), stage('perf', { from: ['dev'] }),
    stage('final', { from: ['dev', 'qa'] }),
  ], W);
  assert.equal(rows.find((r) => r.name === 'final').depth, 2);
  assert.deepEqual(names(rows), ['dev', 'perf', 'qa', 'final']);
});

test('stage with no upstream that is not direct is a root', () => {
  const s = stage('orphan');
  s.spec.requestedFreight[0].sources = {};
  assert.equal(orderStages([s], W)[0].depth, 0);
});

test('stages for other warehouses are ignored, and their edges do not count', () => {
  const rows = orderStages([stage('dev'), stage('other', { warehouse: 'x' }), stage('prod', { from: ['dev', 'other'] })], W);
  assert.deepEqual(names(rows), ['dev', 'prod']);
  assert.equal(rows[1].depth, 1);
});

test('control-flow stage keeps depth correct and is flagged', () => {
  const rows = orderStages([stage('dev'), stage('gate', { from: ['dev'], steps: false }), stage('prod', { from: ['gate'] })], W);
  assert.deepEqual(names(rows), ['dev', 'gate', 'prod']);
  assert.deepEqual(rows.map((r) => r.controlFlow), [false, true, false]);
  assert.equal(rows[2].depth, 2);
});

test('depth is computed over all stages, so excluded middle stages do not shift it', () => {
  const rows = orderStages([stage('dev'), stage('mid', { from: ['dev'] }), stage('prod', { from: ['mid'] })], W);
  const visible = rows.filter((r) => r.name !== 'mid');
  assert.deepEqual(visible.map((r) => r.depth), [0, 2]);
});

test('cycle falls back to name order and warns once', () => {
  const warnings = [];
  const rows = orderStages([stage('b', { from: ['a'] }), stage('a', { from: ['b'] })], W, (m) => warnings.push(m));
  assert.deepEqual(names(rows), ['a', 'b']);
  assert.equal(warnings.length, 1);
});
