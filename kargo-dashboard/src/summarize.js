// Joins warehouses, stages and freight into the per-project row the UI renders.
import { orderStages } from './stage-order.js';
import { filterStageNames } from './stage-filter.js';
import { resolveVersionSource, versionFor } from './version.js';
import { sortFreight, versionsBehind, bucket } from './decay.js';

const NO_FREIGHT_COLOR = '#9e9e9e';

// Section 6.1. Returns the warehouse object or throws an Error with a row-ready message.
export function selectWarehouse(warehouses, configured) {
  if (configured) {
    const w = warehouses.find((x) => x.metadata.name === configured);
    if (!w) throw new Error(`warehouse ${configured} not found in project`);
    return w;
  }
  if (warehouses.length === 1) return warehouses[0];
  if (warehouses.length === 0) throw new Error('project has no warehouses');
  throw new Error('multiple warehouses; set `warehouse` in config');
}

// Pure: builds a row from already-fetched data. `freight` may be unsorted and may contain
// other warehouses' Freight; `stages` may include stages for other warehouses.
export function buildRow({ project, projectConfig, warehouse, stages, freight, thresholds, warn = () => {} }) {
  const whName = warehouse.metadata.name;
  const source = resolveVersionSource(warehouse);
  const sorted = sortFreight(freight.filter((f) => f.origin?.name === whName));
  const byName = new Map(sorted.map((f) => [f.metadata.name, f]));
  const describe = (f) => versionFor(f, source, warn);

  const latest = sorted[0]
    ? { ...describe(sorted[0]), createdAt: sorted[0].discoveredAt || sorted[0].metadata.creationTimestamp }
    : null;

  const ordered = orderStages(stages, whName, warn).filter((r) => !r.controlFlow);
  const visible = new Set(filterStageNames(ordered.map((r) => r.name), projectConfig));

  const cells = ordered.filter((r) => visible.has(r.name)).map((r) => {
    if (!sorted.length) {
      return { name: r.name, version: null, decay: { behind: null, color: NO_FREIGHT_COLOR, label: 'no freight' } };
    }
    const current = r.stage.status?.freightHistory?.[0]?.items?.[`Warehouse/${whName}`];
    const full = current ? byName.get(current.name) : undefined;
    const info = current ? describe(current) : null;
    return {
      name: r.name,
      version: info?.version ?? null,
      alias: full?.alias,
      freightName: current?.name,
      since: full?.status?.currentlyIn?.[r.name]?.since,
      decay: bucket(versionsBehind(sorted, current?.name), thresholds),
    };
  });

  return { project, displayName: projectConfig.displayName, warehouse: whName, latest, stages: cells, error: null };
}

export function errorRow(project, projectConfig, message) {
  return {
    project, displayName: projectConfig.displayName, warehouse: projectConfig.warehouse ?? null,
    latest: null, stages: [], error: message,
  };
}

// Fetches and builds one project's row. Never throws; failures become an error row.
export async function summarizeProject({ client, project, projectConfig, token, thresholds, warn }) {
  try {
    const warehouses = await client.listWarehouses(project, token);
    const warehouse = selectWarehouse(warehouses, projectConfig.warehouse);
    const name = warehouse.metadata.name;
    const [stages, freight] = await Promise.all([
      client.listStages(project, name, token),
      client.listFreight(project, name, token),
    ]);
    return buildRow({ project, projectConfig, warehouse, stages, freight, thresholds, warn });
  } catch (err) {
    return errorRow(project, projectConfig, err.message);
  }
}

// Projects are fetched concurrently; row order follows config key order.
export async function summarizeAll({ client, config, env = process.env, warn }) {
  const rows = await Promise.all(Object.entries(config.projects).map(([project, projectConfig]) =>
    summarizeProject({
      client, project, projectConfig, token: env[projectConfig.tokenEnv],
      thresholds: config.decay.thresholds, warn,
    })));
  return { generatedAt: new Date().toISOString(), rows };
}
