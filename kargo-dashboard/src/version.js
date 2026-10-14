// Turns Freight into the "version" string shown in a cell.

const SHORT_SHA = 7;

// Decides once per warehouse which subscription supplies the version:
// the first image or chart subscription, else the first git subscription, else null.
export function resolveVersionSource(warehouse) {
  const subs = warehouse?.spec?.subscriptions || [];
  for (const sub of subs) {
    if (sub.image) return { type: 'image', name: sub.name, spec: sub.image };
    if (sub.chart) return { type: 'chart', name: sub.name, spec: sub.chart };
  }
  for (const sub of subs) {
    if (sub.git) return { type: 'git', name: sub.name, spec: sub.git };
  }
  return null;
}

function matches(source, artifact) {
  if (source.name) return artifact.subscriptionName === source.name;
  if (artifact.repoURL !== source.spec.repoURL) return false;
  if (source.type === 'chart' && source.spec.name) return artifact.name === source.spec.name;
  return true;
}

// `freight` may be a Freight or a stage's FreightReference; both carry the artifact arrays.
// Returns { version, freightName, alias, fallback } where fallback is true when the
// chosen subscription had no matching artifact and the alias/name was used instead.
export function versionFor(freight, source, warn = () => {}) {
  const freightName = freight.metadata?.name ?? freight.name;
  const alias = freight.alias;
  let version;
  if (source) {
    if (source.type === 'image') {
      version = (freight.images || []).find((a) => matches(source, a))?.tag;
    } else if (source.type === 'chart') {
      version = (freight.charts || []).find((a) => matches(source, a))?.version;
    } else {
      version = (freight.commits || []).find((a) => matches(source, a))?.id?.slice(0, SHORT_SHA);
    }
  }
  if (version) return { version, freightName, alias, fallback: false };
  warn(`freight ${freightName} has no artifact matching the version subscription; using alias`);
  return { version: alias || freightName, freightName, alias, fallback: true };
}
