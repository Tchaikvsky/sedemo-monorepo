// Live promotion status for a stage card (PLAN section 14). Pure: no I/O.
import { versionFor } from './version.js';
import { kargoLink } from './links.js';

const TERMINAL = new Set(['Succeeded', 'Failed', 'Errored', 'Aborted']);

// Stage.status.currentPromotion is "the currently Running promotion". A reference whose phase is
// already terminal is stale, and a missing phase means the reference carries no status yet.
export function isActivePromotion(ref) {
  return Boolean(ref && ref.name && !TERMINAL.has(ref.status?.phase));
}

const patterns = new Map();
function waitingRegex(source) {
  if (!patterns.has(source)) patterns.set(source, new RegExp(source));
  return patterns.get(source);
}

// `info` comes from the collector: { name, ref, status, steps }
//   ref    - stage.status.currentPromotion (has `freight`, the Freight being promoted)
//   status - the Promotion status to read progress from (the reference's, or a freshly fetched one)
//   steps  - [{ uses, as }] from the Promotion's spec, or null when it could not be fetched
// `ctx` is { promotion: <config.promotion>, source: <version source>, kargoUrl, project, freight? } where
//   freight - the Freight this lane's warehouse is receiving (a promotion deploys one Freight per warehouse
//             the stage requests); defaults to the promotion's primary Freight.
// Returns the 14.6 object, or null when the stage has no active promotion.
export function promotionState(info, ctx) {
  if (!info || !isActivePromotion(info.ref)) return null;
  const { promotion: cfg, source, kargoUrl, project } = ctx;
  const status = info.status || info.ref.status || {};
  const steps = Array.isArray(info.steps) && info.steps.length ? info.steps : null;

  // currentStep is a 0-based index and is omitted from JSON while it is 0.
  const index = Math.max(0, Number.isInteger(status.currentStep) ? status.currentStep : 0);
  const clamped = steps ? Math.min(index, steps.length - 1) : index;
  const step = steps ? steps[clamped] : null;
  const uses = step?.uses ?? null;

  const freight = ctx.freight !== undefined ? ctx.freight : info.ref.freight;
  const target = freight ? versionFor(freight, source) : null;
  return {
    name: info.name,
    phase: status.phase || 'Running',
    step: clamped + 1,
    steps: steps ? steps.length : null,
    uses,
    alias: step?.as ?? null,
    waiting: uses !== null && waitingRegex(cfg.waitingStepPattern).test(uses),
    message: status.stepExecutionMetadata?.[clamped]?.message || null,
    targetVersion: target ? target.version : null,
    targetFreightName: freight?.name ?? null,
    targetFreightUrl: kargoLink(kargoUrl, project, 'freight', freight?.name),
    startedAt: status.startedAt ?? null,
  };
}
