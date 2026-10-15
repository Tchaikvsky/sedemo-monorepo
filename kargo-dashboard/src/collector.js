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
      return { project, error: null, warehouses, stages, freightByWarehouse };
    } catch (err) {
      return { project, error: err.message, warehouses: [], stages: [], freightByWarehouse: new Map() };
    }
  }

  // -> { snapshots: Map<project, snapshot> }
  async function collect(config, env = process.env) {
    const entries = [...planProjects(config)];
    const results = await Promise.all(entries.map(([project, wanted]) =>
      collectProject(project, wanted, env[wanted.tokenEnv])));
    return { snapshots: new Map(results.map((s) => [s.project, s])) };
  }

  return { collect, collectProject };
}
