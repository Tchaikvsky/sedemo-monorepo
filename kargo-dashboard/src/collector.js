import { isActivePromotion } from './promotion.js';

// All Kargo I/O orchestration. Each refresh fetches one snapshot per *unique* project across every
// dashboard, so a project shown on several dashboards is fetched once. summarize.js turns snapshots
// into per-dashboard rows without doing any I/O.

// Which projects to fetch and which of their warehouses are needed.
// -> Map<project, { tokenEnv, all: boolean, names: Set<string> }>
// `all` is true when any dashboard asks for every warehouse of the project (no key given).
export function planProjects(config) {
  const plan = new Map();
  for (const dashboard of Object.values(config.dashboards)) {
    for (const [project, pc] of Object.entries(dashboard.projects)) {
      const entry = plan.get(project) || { tokenEnv: pc.tokenEnv, all: false, names: new Set() };
      if (pc.warehouses.length === 0) entry.all = true;
      for (const name of pc.warehouses) entry.names.add(name);
      plan.set(project, entry);
    }
  }
  return plan;
}

export function createCollector({ client, warn = () => {} }) {
  // Promotion steps never change for a given Promotion, so each is fetched once.
  // key: `${project}/${promotionName}` -> [{ uses, as }]
  const stepCache = new Map();

  // The step list (cached) and the status to read progress from, for one active promotion.
  // The stage's currentPromotion reference normally carries the live status; when it carries none
  // the Promotion itself is fetched each refresh. A failed fetch degrades to "Promoting..." without steps.
  async function promotionInfo(project, ref, token) {
    const key = `${project}/${ref.name}`;
    const needStatus = !ref.status?.phase;
    let fetched = null;
    if (!stepCache.has(key) || needStatus) {
      try {
        fetched = await client.getPromotion(project, ref.name, token);
        if (!stepCache.has(key)) {
          stepCache.set(key, (fetched.spec?.steps || []).map((s) => ({ uses: s.uses ?? s.task?.name ?? null, as: s.as ?? null })));
        }
      } catch (err) {
        warn(`could not read promotion ${ref.name} in ${project}: ${err.message}`);
      }
    }
    return { name: ref.name, ref, status: needStatus ? fetched?.status : ref.status, steps: stepCache.get(key) ?? null };
  }

  async function collectPromotions(project, stages, token) {
    const promotions = new Map();
    const active = stages.filter((s) => isActivePromotion(s.status?.currentPromotion));
    await Promise.all(active.map(async (s) => {
      promotions.set(s.metadata.name, await promotionInfo(project, s.status.currentPromotion, token));
    }));
    // Forget promotions that are no longer current anywhere in this project.
    const live = new Set(active.map((s) => `${project}/${s.status.currentPromotion.name}`));
    for (const key of stepCache.keys()) {
      if (key.startsWith(`${project}/`) && !live.has(key)) stepCache.delete(key);
    }
    return promotions;
  }

  // Fetches one project's snapshot. Never throws: failures are recorded in the snapshot.
  async function collectProject(project, wanted, token) {
    try {
      const warehouses = await client.listWarehouses(project, token);
      const stages = await client.listStages(project, token);
      const available = new Set(warehouses.map((w) => w.metadata.name));
      const names = wanted.all ? [...available] : [...wanted.names].filter((n) => available.has(n));
      const freightByWarehouse = new Map();
      await Promise.all(names.map(async (name) => {
        try {
          freightByWarehouse.set(name, { freight: await client.listFreight(project, name, token) });
        } catch (err) {
          freightByWarehouse.set(name, { error: err.message });
        }
      }));
      const promotions = await collectPromotions(project, stages, token);
      return { project, error: null, warehouses, stages, freightByWarehouse, promotions };
    } catch (err) {
      return { project, error: err.message, warehouses: [], stages: [], freightByWarehouse: new Map(), promotions: new Map() };
    }
  }

  // -> { snapshots: Map<project, snapshot>, active: boolean } where `active` means any stage is promoting
  async function collect(config, env = process.env) {
    const entries = [...planProjects(config)];
    const results = await Promise.all(entries.map(([project, wanted]) =>
      collectProject(project, wanted, env[wanted.tokenEnv])));
    return { snapshots: new Map(results.map((s) => [s.project, s])), active: results.some((s) => s.promotions.size > 0) };
  }

  return { collect, collectProject };
}
