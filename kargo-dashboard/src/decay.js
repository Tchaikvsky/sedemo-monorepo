// Version decay: how many Freight versions a stage is behind the latest.

const time = (f) => Date.parse(f.discoveredAt || f.metadata?.creationTimestamp || 0) || 0;
const nameOf = (f) => f.metadata?.name ?? '';

// Newest first by discoveredAt (falling back to creationTimestamp); ties broken by name.
export function sortFreight(freights) {
  return [...freights].sort((a, b) => time(b) - time(a) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
}

// Keeps the first occurrence of each Freight name.
export function dedupeFreight(freights) {
  const seen = new Set();
  return freights.filter((f) => !seen.has(nameOf(f)) && seen.add(nameOf(f)));
}

// Number of Freight newer than `freightName` in the newest-first list, or null if not present.
export function versionsBehind(sortedFreight, freightName) {
  if (!freightName) return null;
  const idx = sortedFreight.findIndex((f) => nameOf(f) === freightName);
  return idx < 0 ? null : idx;
}

// Maps a behind-count to the first threshold whose max >= count (null max matches everything).
// A null count (nothing deployed, or Freight no longer exists) is the last threshold, labeled "unknown".
export function bucket(behind, thresholds) {
  if (behind === null) {
    const worst = thresholds[thresholds.length - 1];
    return { behind: null, color: worst.color, label: 'unknown' };
  }
  const t = thresholds.find((x) => x.max === null || behind <= x.max);
  return { behind, color: t.color, label: t.label };
}
