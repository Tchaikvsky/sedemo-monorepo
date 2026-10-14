import { readFileSync } from 'node:fs';
import { compilePattern } from './stage-filter.js';

export const DEFAULT_THRESHOLDS = [
  { max: 0, label: 'Good', color: '#2e7d32' },
  { max: 1, label: 'OK', color: '#fdd835' },
  { max: 3, label: 'Bad', color: '#fb8c00' },
  { max: null, label: 'Worse', color: '#c62828' },
];

const DEFAULT_TOKEN_ENV = 'KARGO_TOKEN';

function validateThresholds(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    throw new Error('decay.thresholds must be a non-empty array');
  }
  let prev = -1;
  thresholds.forEach((t, i) => {
    const last = i === thresholds.length - 1;
    if (t.max === null) {
      if (!last) throw new Error('decay.thresholds: only the last entry may have max null');
    } else {
      if (!Number.isInteger(t.max) || t.max < 0) {
        throw new Error(`decay.thresholds[${i}].max must be a non-negative integer`);
      }
      if (t.max <= prev) throw new Error('decay.thresholds: max values must be strictly ascending');
      prev = t.max;
    }
    if (typeof t.color !== 'string' || typeof t.label !== 'string') {
      throw new Error(`decay.thresholds[${i}] needs string label and color`);
    }
  });
  if (thresholds[thresholds.length - 1].max !== null) {
    throw new Error('decay.thresholds: the last entry must have max null');
  }
}

function validatePatterns(name, patterns) {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) throw new Error(`${name} must be an array`);
  patterns.forEach(compilePattern); // throws on non-strings and bad regexes
  return patterns;
}

// Validates a parsed config object and returns it with defaults applied.
// `env` is injectable for tests.
export function validateConfig(raw, env = process.env) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');

  const kargo = { ...(raw.kargo || {}) };
  kargo.url = env.KARGO_URL || kargo.url;
  if (!kargo.url) throw new Error('kargo.url (or KARGO_URL) is required');
  kargo.url = kargo.url.replace(/\/+$/, '');
  kargo.tokenEnv = kargo.tokenEnv || DEFAULT_TOKEN_ENV;

  const thresholds = raw.decay?.thresholds ?? DEFAULT_THRESHOLDS;
  validateThresholds(thresholds);

  const refreshIntervalSeconds = raw.refreshIntervalSeconds ?? 30;
  if (!Number.isFinite(refreshIntervalSeconds) || refreshIntervalSeconds < 1) {
    throw new Error('refreshIntervalSeconds must be a number >= 1');
  }

  const rawProjects = raw.projects;
  if (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects) ||
      Object.keys(rawProjects).length === 0) {
    throw new Error('projects must be a non-empty object');
  }

  // Object key order is preserved, which is the display order.
  const projects = {};
  for (const [key, value] of Object.entries(rawProjects)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`projects.${key} must be an object`);
    }
    const tokenEnv = value.tokenEnv || kargo.tokenEnv;
    projects[key] = {
      displayName: value.displayName || key,
      warehouse: value.warehouse,
      tokenEnv,
      includeStages: validatePatterns(`projects.${key}.includeStages`, value.includeStages),
      excludeStages: validatePatterns(`projects.${key}.excludeStages`, value.excludeStages),
    };
    if (!env[tokenEnv]) {
      throw new Error(`env var ${tokenEnv} (token for project ${key}) must be set and non-empty`);
    }
  }

  return { kargo, refreshIntervalSeconds, decay: { thresholds }, projects };
}

export function loadConfig(path = process.env.CONFIG_PATH || './config.json', env = process.env) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot load config ${path}: ${err.message}`);
  }
  return validateConfig(raw, env);
}
