// Joins warehouses, stages and freight into the per-project row the UI renders.
import { orderStages } from './stage-order.js';
import { filterStageNames } from './stage-filter.js';
import { resolveVersionSource, versionFor } from './version.js';
import { sortFreight, versionsBehind, bucket } from './decay.js';

const NO_FREIGHT_COLOR = '#9e9e9e';

// Kargo UI deep links: <instance>/project/<project>/{freight/<name>|stage/<name>}.
// Returns undefined when there is no instance URL or no name to link to.
export function kargoLink(kargoUrl, project, kind, name) {
  if (!kargoUrl || !name) return undefined;
  const seg = encodeURIComponent;
  return `${kargoUrl.replace(/\/+$/, '')}/project/${seg(project)}/${kind}/${seg(name)}`;
}

// <instance>/project/<project>
export function projectLink(kargoUrl, project) {
  return kargoUrl ? `${kargoUrl.replace(/\/+$/, '')}/project/${encodeURIComponent(project)}` : undefined;
}

// Section 13 (D7). Decides which warehouses become lanes, in lane order.
// `configured` is the normalised list of names (empty means "every warehouse the project has").
// Returns [{ name, warehouse }] where `warehouse` is undefined for a configured name that does not
// exist (the caller turns that into a lane error). Throws only when there is nothing to show.
export function selectWarehouses(available, configured = []) {
  if (configured.length) {
    return configured.map((name) => ({ name, warehouse: available.find((w) => w.metadata.name === name) }));
  }
  if (available.length === 0) throw new Error('project has no warehouses');
  return [...available]
    .sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0))
    .map((warehouse) => ({ name: warehouse.metadata.name, warehouse }));
}

// Pure: builds one lane (one warehouse's pipeline) from already-fetched data. `freight` may be unsorted and may contain
// other warehouses' Freight; `stages` may include stages for other warehouses.
export function buildLane({ project, projectConfig, warehouse, stages, freight, thresholds, kargoUrl, warn = () => {} }) {
  const whName = warehouse.metadata.name;
  const source = resolveVersionSource(warehouse);
  const sorted = sortFreight(freight.filter((f) => f.origin?.name === whName));
  const byName = new Map(sorted.map((f) => [f.metadata.name, f]));
  const describe = (f) => versionFor(f, source, warn);

  const latest = sorted[0]
    ? {
      ...describe(sorted[0]),
      createdAt: sorted[0].discoveredAt || sorted[0].metadata.creationTimestamp,
      freightUrl: kargoLink(kargoUrl, project, 'freight', sorted[0].metadata.name),
    }
    : null;

  const ordered = orderStages(stages, whName, warn).filter((r) => !r.controlFlow);
  const visible = new Set(filterStageNames(ordered.map((r) => r.name), projectConfig));

  const cells = ordered.filter((r) => visible.has(r.name)).map((r) => {
    if (!sorted.length) {
      return {
        name: r.name, stageUrl: kargoLink(kargoUrl, project, 'stage', r.name), version: null,
        decay: { behind: null, color: NO_FREIGHT_COLOR, label: 'no freight' },
      };
    }
    const current = r.stage.status?.freightHistory?.[0]?.items?.[`Warehouse/${whName}`];
    const full = current ? byName.get(current.name) : undefined;
    const info = current ? describe(current) : null;
    return {
      name: r.name,
      stageUrl: kargoLink(kargoUrl, project, 'stage', r.name),
      freightUrl: kargoLink(kargoUrl, project, 'freight', current?.name),
      version: info?.version ?? null,
      alias: full?.alias,
      freightName: current?.name,
      since: full?.status?.currentlyIn?.[r.name]?.since,
      decay: bucket(versionsBehind(sorted, current?.name), thresholds),
    };
  });

  return { warehouse: whName, latest, stages: cells, error: null };
}

export function laneError(warehouse, message) {
  return { warehouse, latest: null, stages: [], error: message };
}

// Captions name each lane's warehouse. They show when the plural form was used or when the
// project resolved to more than one lane; a singular `warehouse` (or a lone default) shows none.
export function assembleRow({ project, projectConfig, kargoUrl, lanes }) {
  return {
    project,
    displayName: projectConfig.displayName,
    projectUrl: projectLink(kargoUrl, project),
    lanes,
    showLaneCaptions: Boolean(projectConfig.plural) || lanes.length > 1,
    error: null,
  };
}

export function errorRow(project, projectConfig, message, kargoUrl) {
  return {
    project, displayName: projectConfig.displayName, projectUrl: projectLink(kargoUrl, project),
    lanes: [], showLaneCaptions: false, error: message,
  };
}

// Fetches and builds one project's row. Never throws. Project-level failures (token, project
// fetch, no warehouses) become an error row; a lane's own failure stays inside that lane.
export async function summarizeProject({ client, project, projectConfig, token, thresholds, kargoUrl, warn }) {
  try {
    const available = await client.listWarehouses(project, token);
    const selected = selectWarehouses(available, projectConfig.warehouses);
    const stages = await client.listStages(project, token);
    const lanes = await Promise.all(selected.map(async ({ name, warehouse }) => {
      if (!warehouse) return laneError(name, `warehouse ${name} not found in project`);
      try {
        const freight = await client.listFreight(project, name, token);
        return buildLane({ project, projectConfig, warehouse, stages, freight, thresholds, kargoUrl, warn });
      } catch (err) {
        return laneError(name, err.message);
      }
    }));
    return assembleRow({ project, projectConfig, kargoUrl, lanes });
  } catch (err) {
    return errorRow(project, projectConfig, err.message, kargoUrl);
  }
}

// Projects are fetched concurrently; row order follows config key order.
export async function summarizeAll({ client, config, env = process.env, warn }) {
  const rows = await Promise.all(Object.entries(config.projects).map(([project, projectConfig]) =>
    summarizeProject({
      client, project, projectConfig, token: env[projectConfig.tokenEnv],
      thresholds: config.decay.thresholds, kargoUrl: config.kargo?.url, warn,
    })));
  return { generatedAt: new Date().toISOString(), rows };
}
