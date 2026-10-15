import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCollector, planProjects } from '../src/collector.js';
import { buildDashboard } from '../src/summarize.js';
import { KargoApiError } from '../src/kargo-client.js';
import { DEFAULT_THRESHOLDS as T } from '../src/config.js';

const load = (project, file) => JSON.parse(readFileSync(new URL(`./fixtures/${project}/${file}.json`, import.meta.url)));

// Serves the fixtures and records every call so tests can assert on request counts.
function loggingClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async listWarehouses(project, token) { calls.push(['warehouses', project, token]); return load(project, 'warehouses').items; },
    async listStages(project, token) { calls.push(['stages', project, token]); return load(project, 'stages').items; },
    async listFreight(project, wh, token) {
      calls.push(['freight', project, wh, token]);
      return Object.values(load(project, 'freight').groups).flatMap((g) => g.items).filter((f) => f.origin.name === wh);
    },
    ...overrides,
  };
}
const pc = (extra = {}) => ({ displayName: 'x', warehouses: [], plural: false, includeStages: [], excludeStages: [], tokenEnv: 'T', ...extra });
const cfg = (dashboards) => ({
  dashboards: Object.fromEntries(Object.entries(dashboards).map(([id, projects]) => [id, { id, name: id, projects }])),
});
const count = (calls, kind) => calls.filter((c) => c[0] === kind).length;

test('planProjects: unique projects, union of warehouses, and "all" if any dashboard wants every warehouse', () => {
  const plan = planProjects(cfg({
    a: { 'sedemo-app-demo': pc({ warehouses: ['sedemo-app-demo'] }), 'team-ada': pc({ warehouses: ['akkoma-main'] }) },
    b: { 'sedemo-app-demo': pc({ warehouses: ['sedemo-app-demo-chart'] }), 'team-ada': pc({ warehouses: [] }) },
  }));
  assert.deepEqual([...plan.keys()], ['sedemo-app-demo', 'team-ada']);
  assert.deepEqual([...plan.get('sedemo-app-demo').names].sort(), ['sedemo-app-demo', 'sedemo-app-demo-chart']);
  assert.equal(plan.get('sedemo-app-demo').all, false);
  assert.equal(plan.get('team-ada').all, true);
});

test('a project shown on two dashboards is fetched once per refresh, with each warehouse fetched once', async () => {
  const client = loggingClient();
  const config = cfg({
    a: { 'sedemo-app-demo': pc({ warehouses: ['sedemo-app-demo'] }) },
    b: { 'sedemo-app-demo': pc({ warehouses: ['sedemo-app-demo', 'sedemo-app-demo-chart'], plural: true, displayName: 'Same project' }) },
  });
  const { snapshots } = await createCollector({ client }).collect(config, { T: 'tok' });
  assert.equal(count(client.calls, 'warehouses'), 1);
  assert.equal(count(client.calls, 'stages'), 1);
  assert.deepEqual(client.calls.filter((c) => c[0] === 'freight').map((c) => c[2]).sort(), ['sedemo-app-demo', 'sedemo-app-demo-chart']);

  // each dashboard builds its own view from the shared snapshot
  const ctx = { thresholds: T, kargoUrl: 'https://k' };
  const a = buildDashboard(config.dashboards.a, snapshots, ctx);
  const b = buildDashboard(config.dashboards.b, snapshots, ctx);
  assert.equal(a.rows[0].lanes.length, 1);
  assert.equal(b.rows[0].lanes.length, 2);
  assert.equal(b.rows[0].displayName, 'Same project');
  assert.deepEqual(a.rows[0].lanes[0], b.rows[0].lanes[0], 'the shared warehouse looks identical on both dashboards');
});

test('the project token is used for every call to that project', async () => {
  const client = loggingClient();
  await createCollector({ client }).collect(cfg({ a: { 'demo-rollouts': pc({ tokenEnv: 'T_ONE' }) } }), { T_ONE: 'one' });
  assert.ok(client.calls.length >= 3);
  assert.ok(client.calls.every((c) => c[c.length - 1] === 'one'));
});

test('no key fetches every warehouse; unknown configured names are not fetched', async () => {
  const all = loggingClient();
  await createCollector({ client: all }).collect(cfg({ a: { 'sedemo-app-demo': pc() } }), { T: 't' });
  assert.deepEqual(all.calls.filter((c) => c[0] === 'freight').map((c) => c[2]).sort(), ['sedemo-app-demo', 'sedemo-app-demo-chart']);

  const some = loggingClient();
  const { snapshots } = await createCollector({ client: some }).collect(
    cfg({ a: { 'sedemo-app-demo': pc({ warehouses: ['nope', 'sedemo-app-demo'] }) } }), { T: 't' });
  assert.deepEqual(some.calls.filter((c) => c[0] === 'freight').map((c) => c[2]), ['sedemo-app-demo']);
  assert.deepEqual([...snapshots.get('sedemo-app-demo').freightByWarehouse.keys()], ['sedemo-app-demo']);
});

test('failures are recorded in the snapshot, never thrown: project-level and warehouse-level', async () => {
  const locked = loggingClient({ async listWarehouses() { throw new KargoApiError('token lacks access to project demo-rollouts', 403); } });
  const { snapshots } = await createCollector({ client: locked }).collect(cfg({ a: { 'demo-rollouts': pc() } }), { T: 't' });
  assert.match(snapshots.get('demo-rollouts').error, /token lacks access/);

  const stagesDown = loggingClient({ async listStages() { throw new KargoApiError('Kargo API returned HTTP 500', 500); } });
  const r2 = await createCollector({ client: stagesDown }).collect(cfg({ a: { 'demo-rollouts': pc() } }), { T: 't' });
  assert.match(r2.snapshots.get('demo-rollouts').error, /HTTP 500/);

  const base = loggingClient();
  const flaky = loggingClient({ async listFreight(p, wh, t) { if (wh === 'sedemo-app-demo-chart') throw new Error('boom'); return base.listFreight(p, wh, t); } });
  const r3 = await createCollector({ client: flaky }).collect(cfg({ a: { 'sedemo-app-demo': pc() } }), { T: 't' });
  const snap = r3.snapshots.get('sedemo-app-demo');
  assert.equal(snap.error, null);
  assert.equal(snap.freightByWarehouse.get('sedemo-app-demo-chart').error, 'boom');
  assert.ok(snap.freightByWarehouse.get('sedemo-app-demo').freight.length > 0);
});

test('a project-level failure becomes an error row in every dashboard that lists the project', async () => {
  const client = loggingClient({ async listWarehouses(p) { if (p === 'team-ada') throw new KargoApiError('token lacks access to project team-ada', 403); return load(p, 'warehouses').items; } });
  const config = cfg({
    a: { 'team-ada': pc(), 'demo-rollouts': pc() },
    b: { 'team-ada': pc({ displayName: 'Ada' }) },
  });
  const { snapshots } = await createCollector({ client }).collect(config, { T: 't' });
  const ctx = { thresholds: T, kargoUrl: 'https://k' };
  const a = buildDashboard(config.dashboards.a, snapshots, ctx);
  const b = buildDashboard(config.dashboards.b, snapshots, ctx);
  assert.match(a.rows[0].error, /token lacks access/);
  assert.equal(a.rows[1].error, null, 'the other project still renders');
  assert.match(b.rows[0].error, /token lacks access/);
  assert.equal(b.rows[0].displayName, 'Ada');
});
