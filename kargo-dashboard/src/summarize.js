// Joins warehouses, stages and freight into the per-project row the UI renders.
import { orderStages } from './stage-order.js';
import { filterStageNames } from './stage-filter.js';
import { resolveVersionSource, versionFor } from './version.js';
import { sortFreight, versionsBehind, bucket } from './decay.js';
import { kargoLink, projectLink } from './links.js';
import { promotionState } from './promotion.js';

const NO_FREIGHT_COLOR = '#9e9e9e';

export { kargoLink, projectLink };

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
export function buildLane({ project, projectConfig, warehouse, stages, freight, thresholds, kargoUrl, promotions, promotion, warn = () => {} }) {
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

  // A stage's running promotion belongs to the lane whose warehouse the promoted Freight came from.
  const promotionFor = (stageName) => {
    if (!promotion) return null;
    const info = promotions?.get(stageName);
    const origin = info?.ref?.freight?.origin?.name;
    if (!info || (origin && origin !== whName)) return null;
    return promotionState(info, { promotion, source, kargoUrl, project });
  };

  const ordered = orderStages(stages, whName, warn).filter((r) => !r.controlFlow);
  const visible = new Set(filterStageNames(ordered.map((r) => r.name), projectConfig));

  const cells = ordered.filter((r) => visible.has(r.name)).map((r) => {
    if (!sorted.length) {
      return {
        name: r.name, stageUrl: kargoLink(kargoUrl, project, 'stage', r.name), version: null,
        decay: { behind: null, color: NO_FREIGHT_COLOR, label: 'no freight' },
        promotion: promotionFor(r.name),
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
      promotion: promotionFor(r.name),
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

// Builds one project's row from its snapshot (see collector.js). Pure and never throws.
// A project-level snapshot error becomes an error row; a warehouse-level problem stays in its lane.
export function buildRow(project, projectConfig, snapshot, ctx) {
  const { thresholds, kargoUrl, warn } = ctx;
  if (!snapshot || snapshot.error) {
    return errorRow(project, projectConfig, snapshot ? snapshot.error : 'no data for project', kargoUrl);
  }
  let selected;
  try {
    selected = selectWarehouses(snapshot.warehouses, projectConfig.warehouses);
  } catch (err) {
    return errorRow(project, projectConfig, err.message, kargoUrl);
  }
  const lanes = selected.map(({ name, warehouse }) => {
    if (!warehouse) return laneError(name, `warehouse ${name} not found in project`);
    const fetched = snapshot.freightByWarehouse.get(name);
    if (!fetched) return laneError(name, `no data for warehouse ${name}`);
    if (fetched.error) return laneError(name, fetched.error);
    return buildLane({
      project, projectConfig, warehouse, stages: snapshot.stages, freight: fetched.freight, thresholds, kargoUrl,
      promotions: snapshot.promotions, promotion: ctx.promotion, warn,
    });
  });
  return assembleRow({ project, projectConfig, kargoUrl, lanes });
}

// One dashboard's payload body: { dashboard: { id, name }, rows }. A project listed in several
// dashboards is built from the same snapshot each time.
export function buildDashboard(dashboard, snapshots, ctx) {
  const rows = Object.entries(dashboard.projects).map(([project, projectConfig]) =>
    buildRow(project, projectConfig, snapshots.get(project), ctx));
  return { dashboard: { id: dashboard.id, name: dashboard.name }, rows };
}
