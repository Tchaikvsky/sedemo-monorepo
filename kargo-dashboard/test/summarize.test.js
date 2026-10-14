import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRow, selectWarehouse, summarizeProject, summarizeAll } from '../src/summarize.js';
import { KargoApiError } from '../src/kargo-client.js';
import { DEFAULT_THRESHOLDS as T } from '../src/config.js';
import { sortFreight } from '../src/decay.js';

// Real responses captured from the live Kargo API (scrubbed), see test/fixtures.
const load = (project, file) => JSON.parse(readFileSync(new URL(`./fixtures/${project}/${file}.json`, import.meta.url)));
const fixture = (project, warehouse) => ({
  warehouses: load(project, 'warehouses').items,
  warehouse: load(project, 'warehouses').items.find((w) => w.metadata.name === warehouse),
  stages: load(project, 'stages').items,
  freight: Object.values(load(project, 'freight').groups).flatMap((g) => g.items),
});
const row = (project, warehouse, overrides = {}, cfg = {}) => {
  const f = fixture(project, warehouse);
  return buildRow({ project, projectConfig: { displayName: project, ...cfg }, thresholds: T, ...f, ...overrides });
};
const summary = (r) => r.stages.map((s) => [s.name, s.version, s.decay.label, s.decay.behind]);

test('demo-rollouts: pipeline order, image tags, all current', () => {
  const r = row('demo-rollouts', 'demo-rollouts');
  assert.equal(r.warehouse, 'demo-rollouts');
  assert.deepEqual(r.stages.map((s) => s.name),
    ['dev', 'staging', 'prod', 'prod-amer-east', 'prod-amer-west', 'prod-emea']);
  assert.equal(r.latest.version, '50-blue');
  assert.equal(r.latest.alias, 'limping-jaguar');
  for (const s of r.stages) assert.deepEqual([s.version, s.decay.label, s.decay.behind], ['50-blue', 'Good', 0]);
  assert.equal(r.error, null);
});

test('sedemo-app-demo image warehouse: only that warehouse counts', () => {
  const r = row('sedemo-app-demo', 'sedemo-app-demo');
  assert.deepEqual(summary(r), [['dev', '15', 'Good', 0], ['staging', '15', 'Good', 0], ['prod', '15', 'Good', 0]]);
  assert.equal(r.latest.alias, 'sullen-sheep');
  assert.ok(r.stages[0].since, 'deployed-since comes from freight.status.currentlyIn');
});

test('sedemo-app-demo chart warehouse (git only): short SHAs, 5 behind, and nothing deployed', () => {
  const r = row('sedemo-app-demo', 'sedemo-app-demo-chart');
  assert.deepEqual(summary(r), [
    ['dev', '8e87771', 'Good', 0],
    ['staging', '4aca0f4', 'Worse', 5],
    ['prod', null, 'unknown', null],
  ]);
});

test('exactly 3 behind is Bad, 4 is Worse (owner decision), using real shapes', () => {
  const f = fixture('demo-rollouts', 'demo-rollouts');
  const sorted = sortFreight(f.freight.filter((x) => x.origin.name === 'demo-rollouts'));
  const pin = (stageName, idx) => {
    const stages = structuredClone(f.stages);
    const s = stages.find((x) => x.metadata.name === stageName);
    s.status.freightHistory[0].items['Warehouse/demo-rollouts'].name = sorted[idx].metadata.name;
    return stages;
  };
  const dev3 = row('demo-rollouts', 'demo-rollouts', { stages: pin('dev', 3) }).stages.find((s) => s.name === 'dev');
  assert.deepEqual([dev3.decay.behind, dev3.decay.label], [3, 'Bad']);
  const dev4 = row('demo-rollouts', 'demo-rollouts', { stages: pin('dev', 4) }).stages.find((s) => s.name === 'dev');
  assert.deepEqual([dev4.decay.behind, dev4.decay.label], [4, 'Worse']);
});

test('a deployed freight that no longer exists is Worse/unknown but keeps its version', () => {
  const f = fixture('demo-rollouts', 'demo-rollouts');
  const stages = structuredClone(f.stages);
  stages.find((x) => x.metadata.name === 'dev').status.freightHistory[0].items['Warehouse/demo-rollouts'].name = 'gone';
  const dev = row('demo-rollouts', 'demo-rollouts', { stages }).stages.find((s) => s.name === 'dev');
  assert.deepEqual([dev.decay.label, dev.decay.behind], ['unknown', null]);
});

test('include/exclude filters apply after ordering and keep order', () => {
  const r = row('demo-rollouts', 'demo-rollouts', {}, { includeStages: ['dev', 'regex:^prod'], excludeStages: ['prod-emea', 'prod'] });
  assert.deepEqual(r.stages.map((s) => s.name), ['dev', 'prod-amer-east', 'prod-amer-west']);
});

test('control-flow stages are not rendered but do not disturb downstream order', () => {
  const f = fixture('demo-rollouts', 'demo-rollouts');
  const stages = structuredClone(f.stages);
  delete stages.find((x) => x.metadata.name === 'staging').spec.promotionTemplate;
  const names = row('demo-rollouts', 'demo-rollouts', { stages }).stages.map((s) => s.name);
  assert.deepEqual(names, ['dev', 'prod', 'prod-amer-east', 'prod-amer-west', 'prod-emea']);
});

test('warehouse with no freight: no latest, neutral cells labeled "no freight"', () => {
  const r = row('demo-rollouts', 'demo-rollouts', { freight: [] });
  assert.equal(r.latest, null);
  assert.ok(r.stages.length > 0);
  for (const s of r.stages) assert.deepEqual([s.version, s.decay.label, s.decay.color], [null, 'no freight', '#9e9e9e']);
});

test('selectWarehouse follows section 6.1', () => {
  const two = fixture('sedemo-app-demo', 'sedemo-app-demo').warehouses;
  const one = fixture('demo-rollouts', 'demo-rollouts').warehouses;
  assert.equal(selectWarehouse(one).metadata.name, 'demo-rollouts');
  assert.equal(selectWarehouse(two, 'sedemo-app-demo-chart').metadata.name, 'sedemo-app-demo-chart');
  assert.throws(() => selectWarehouse(two), /multiple warehouses; set `warehouse` in config/);
  assert.throws(() => selectWarehouse(two, 'nope'), /warehouse nope not found/);
  assert.throws(() => selectWarehouse([]), /no warehouses/);
});

// A fake client that serves the fixtures per project and records the tokens it was given.
function fakeClient(tokensSeen = []) {
  return {
    async listWarehouses(project, token) {
      tokensSeen.push([project, token]);
      if (project === 'locked') throw new KargoApiError('token lacks access to project locked', 403);
      return load(project, 'warehouses').items;
    },
    async listStages(project) { return load(project, 'stages').items; },
    async listFreight(project, wh) {
      return Object.values(load(project, 'freight').groups).flatMap((g) => g.items).filter((f) => f.origin.name === wh);
    },
  };
}

test('summarizeProject: multi-warehouse project without config becomes an error row', async () => {
  const r = await summarizeProject({
    client: fakeClient(), project: 'sedemo-app-demo', projectConfig: { displayName: 'x' }, token: 't', thresholds: T,
  });
  assert.match(r.error, /multiple warehouses/);
  assert.deepEqual(r.stages, []);
});

test('summarizeAll: one failing project does not fail the others; order and per-project tokens kept', async () => {
  const seen = [];
  const config = {
    decay: { thresholds: T },
    projects: {
      locked: { displayName: 'locked', tokenEnv: 'T_LOCKED' },
      'demo-rollouts': { displayName: 'Rollouts', warehouse: 'demo-rollouts', tokenEnv: 'T_MAIN' },
      'sedemo-app-demo': { displayName: 'App', warehouse: 'sedemo-app-demo', tokenEnv: 'T_MAIN' },
    },
  };
  const out = await summarizeAll({ client: fakeClient(seen), config, env: { T_LOCKED: 'a', T_MAIN: 'b' } });
  assert.deepEqual(out.rows.map((r) => r.project), ['locked', 'demo-rollouts', 'sedemo-app-demo']);
  assert.match(out.rows[0].error, /token lacks access to project locked/);
  assert.equal(out.rows[1].error, null);
  assert.equal(out.rows[2].error, null);
  assert.deepEqual(seen.sort(), [['demo-rollouts', 'b'], ['locked', 'a'], ['sedemo-app-demo', 'b']]);
  assert.ok(Date.parse(out.generatedAt));
});
