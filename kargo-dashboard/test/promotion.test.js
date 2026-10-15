import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promotionState, isActivePromotion } from '../src/promotion.js';
import { resolveVersionSource } from '../src/version.js';
import { DEFAULT_PROMOTION } from '../src/config.js';

// A real Promotion (demo-snow / prod: 22 expanded steps ending in snow-wait-for-condition), scrubbed.
const real = JSON.parse(readFileSync(new URL('./fixtures/promotions/demo-snow-prod.json', import.meta.url)));
const realSteps = real.spec.steps;
const whImage = { spec: { subscriptions: [{ image: { repoURL: 'ghcr.io/akuity/sedemo-monorepo-snow-demo' } }] } };
const source = resolveVersionSource(whImage);
const freightRef = { name: 'f-target', origin: { kind: 'Warehouse', name: 'demo-snow' }, images: [{ repoURL: 'ghcr.io/akuity/sedemo-monorepo-snow-demo', tag: '51-blue' }] };

const info = ({ currentStep, phase = 'Running', steps = realSteps, status = {}, freight = freightRef } = {}) => ({
  name: 'prod.01abc',
  ref: { name: 'prod.01abc', freight, status: { phase } },
  status: { phase, ...(currentStep === undefined ? {} : { currentStep }), startedAt: '2026-10-15T10:00:00Z', ...status },
  steps,
});
const ctx = (promotion = {}) => ({ promotion: { ...DEFAULT_PROMOTION, ...promotion }, source, kargoUrl: 'https://kargo.example', project: 'demo-snow' });

test('the real fixture is what we think it is', () => {
  assert.equal(realSteps.length, 22);
  assert.equal(realSteps[4].uses, 'helm-template');
  assert.equal(realSteps[21].uses, 'snow-wait-for-condition');
  assert.ok(realSteps.every((s) => s.uses), 'task steps are already expanded to concrete steps');
});

test('mid-run: "5 of 22: helm-template" (currentStep is 0-based), not waiting', () => {
  const p = promotionState(info({ currentStep: 4 }), ctx());
  assert.deepEqual([p.step, p.steps, p.uses, p.alias, p.waiting, p.phase], [5, 22, 'helm-template', 'step-4', false, 'Running'].map((x, i) => (i === 3 ? realSteps[4].as : x)));
  assert.equal(p.name, 'prod.01abc');
  assert.equal(p.startedAt, '2026-10-15T10:00:00Z');
  assert.equal(p.promotionUrl, 'https://kargo.example/project/demo-snow/promotion/prod.01abc');
});

test('on snow-wait-for-condition (the last step): waiting with the default pattern', () => {
  const p = promotionState(info({ currentStep: 21 }), ctx());
  assert.deepEqual([p.step, p.steps, p.uses, p.waiting], [22, 22, 'snow-wait-for-condition', true]);
});

test('the same step is NOT waiting under the stricter ^wait-for pattern', () => {
  assert.equal(promotionState(info({ currentStep: 21 }), ctx({ waitingStepPattern: '^wait-for' })).waiting, false);
});

test('wait-for-approval, git-wait-for-pr and get-user-input are waiting; look-alikes are not', () => {
  const mk = (uses) => promotionState(info({ currentStep: 0, steps: [{ uses, as: 'x' }, { uses: 'git-push', as: 'y' }] }), ctx());
  for (const uses of ['wait-for-approval', 'git-wait-for-pr', 'get-user-input']) assert.equal(mk(uses).waiting, true, uses);
  for (const uses of ['get-user-input-extra', 'my-get-user-input', 'helm-template']) assert.equal(mk(uses).waiting, false, uses);
});

test('currentStep omitted means the first step (JSON drops 0)', () => {
  const p = promotionState(info({}), ctx());
  assert.deepEqual([p.step, p.uses], [1, realSteps[0].uses]);
});

test('currentStep past the end is clamped to the last step', () => {
  const p = promotionState(info({ currentStep: 99 }), ctx());
  assert.deepEqual([p.step, p.steps, p.uses], [22, 22, 'snow-wait-for-condition']);
});

test('steps unknown (fetch failed): still promoting, no step detail, never waiting', () => {
  const p = promotionState(info({ currentStep: 6, steps: null }), ctx());
  assert.deepEqual([p.step, p.steps, p.uses, p.alias, p.waiting], [7, null, null, null, false]);
  assert.equal(promotionState(info({ currentStep: 0, steps: [] }), ctx()).steps, null);
});

test('no promotion, or a stale terminal reference, is null', () => {
  assert.equal(promotionState(null, ctx()), null);
  assert.equal(promotionState({ name: 'x', ref: null }, ctx()), null);
  for (const phase of ['Succeeded', 'Failed', 'Errored', 'Aborted']) {
    assert.equal(promotionState(info({ currentStep: 3, phase }), ctx()), null, phase);
    assert.equal(isActivePromotion({ name: 'x', status: { phase } }), false, phase);
  }
  for (const phase of ['Running', 'Pending', undefined]) assert.equal(isActivePromotion({ name: 'x', status: { phase } }), true, String(phase));
  assert.equal(isActivePromotion(undefined), false);
});

test('target version and its Freight link come from the promoted Freight, using the warehouse version rule', () => {
  const p = promotionState(info({ currentStep: 2 }), ctx());
  assert.equal(p.targetVersion, '51-blue');
  assert.equal(p.targetFreightName, 'f-target');
  assert.equal(p.targetFreightUrl, 'https://kargo.example/project/demo-snow/freight/f-target');

  // a chart-first warehouse (like team-ada's) shows the chart version, not the image tag
  const chartFirst = resolveVersionSource({ spec: { subscriptions: [{ chart: { repoURL: 'oci://c/x' } }, { image: { repoURL: 'ghcr.io/o/i' } }] } });
  const f = { name: 'f2', origin: { name: 'w' }, charts: [{ repoURL: 'oci://c/x', version: '0.9.1' }], images: [{ repoURL: 'ghcr.io/o/i', tag: 'main-abc' }] };
  assert.equal(promotionState(info({ currentStep: 0, freight: f }), { ...ctx(), source: chartFirst }).targetVersion, '0.9.1');

  const noFreight = promotionState(info({ currentStep: 0, freight: null }), ctx());
  assert.deepEqual([noFreight.targetVersion, noFreight.targetFreightName, noFreight.targetFreightUrl], [null, null, undefined]);
});

test('the current step\'s message is surfaced for the tooltip', () => {
  const status = { stepExecutionMetadata: realSteps.map((s, i) => ({ alias: s.as, message: i === 21 ? 'waiting on ticket' : undefined })) };
  assert.equal(promotionState(info({ currentStep: 21, status }), ctx()).message, 'waiting on ticket');
  assert.equal(promotionState(info({ currentStep: 4, status }), ctx()).message, null);
});

test('promotion link follows Kargo\'s /project/<project>/promotion/<name> route and encodes the name', () => {
  const p = promotionState({ ...info({ currentStep: 0 }), name: 'staging.01m4zy8x/odd name' }, ctx());
  assert.equal(p.promotionUrl, 'https://kargo.example/project/demo-snow/promotion/staging.01m4zy8x%2Fodd%20name');
  assert.equal(promotionState(info({ currentStep: 0 }), { ...ctx(), kargoUrl: undefined }).promotionUrl, undefined);
});
