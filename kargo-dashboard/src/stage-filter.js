// Include/exclude matching for stage names.
// A pattern prefixed with `regex:` is an unanchored regular expression; anything else is a full match.

const REGEX_PREFIX = 'regex:';

export function compilePattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new Error(`stage pattern must be a string, got ${typeof pattern}`);
  }
  if (pattern.startsWith(REGEX_PREFIX)) {
    const re = new RegExp(pattern.slice(REGEX_PREFIX.length));
    return (name) => re.test(name);
  }
  return (name) => name === pattern;
}

export function buildMatcher(patterns = []) {
  const matchers = patterns.map(compilePattern);
  return (name) => matchers.some((m) => m(name));
}

// Applies includes first (absent/empty means "all"), then removes excludes.
export function filterStageNames(names, { includeStages = [], excludeStages = [] } = {}) {
  const isIncluded = includeStages.length ? buildMatcher(includeStages) : () => true;
  const isExcluded = buildMatcher(excludeStages);
  return names.filter((n) => isIncluded(n) && !isExcluded(n));
}
