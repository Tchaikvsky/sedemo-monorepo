// Orders the stages of one warehouse's pipeline by their Kargo dependencies.

// Kargo treats a Stage with no promotion steps as control flow: it never holds Freight.
export function isControlFlow(stage) {
  return !(stage.spec?.promotionTemplate?.spec?.steps?.length > 0);
}

function requestFor(stage, warehouse) {
  return (stage.spec?.requestedFreight || []).find(
    (r) => r.origin?.name === warehouse && (!r.origin.kind || r.origin.kind === 'Warehouse'),
  );
}

// Returns [{ name, depth, controlFlow, stage }] for every stage requesting `warehouse`,
// sorted by (depth asc, name asc). Control-flow stages are included so depth is correct;
// callers decide whether to render them. `warn` is called once if a cycle forces name order.
export function orderStages(stages, warehouse, warn = () => {}) {
  const byName = new Map();
  for (const s of stages) {
    if (requestFor(s, warehouse)) byName.set(s.metadata.name, s);
  }

  const memo = new Map();
  const visiting = new Set();
  let cyclic = false;

  const depthOf = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) {
      cyclic = true;
      return 0;
    }
    visiting.add(name);
    const upstream = (requestFor(byName.get(name), warehouse).sources?.stages || [])
      .filter((u) => byName.has(u));
    let depth = 0;
    for (const u of upstream) depth = Math.max(depth, depthOf(u) + 1);
    visiting.delete(name);
    memo.set(name, depth);
    return depth;
  };

  const rows = [...byName.keys()].map((name) => ({
    name,
    depth: depthOf(name),
    controlFlow: isControlFlow(byName.get(name)),
    stage: byName.get(name),
  }));

  if (cyclic) {
    warn(`cycle detected among stages for warehouse ${warehouse}; falling back to name order`);
    rows.forEach((r) => { r.depth = 0; });
  }
  return rows.sort((a, b) => a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
