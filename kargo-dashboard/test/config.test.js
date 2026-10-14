import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, DEFAULT_THRESHOLDS } from '../src/config.js';

const env = { KARGO_TOKEN: 't', OTHER_TOKEN: 'o' };
const base = () => ({ kargo: { url: 'https://k.example/' }, projects: { a: {}, b: { warehouse: 'w' } } });

test('applies defaults and preserves project order', () => {
  const c = validateConfig(base(), env);
  assert.deepEqual(Object.keys(c.projects), ['a', 'b']);
  assert.equal(c.kargo.url, 'https://k.example');
  assert.equal(c.kargo.tokenEnv, 'KARGO_TOKEN');
  assert.equal(c.refreshIntervalSeconds, 30);
  assert.deepEqual(c.decay.thresholds, DEFAULT_THRESHOLDS);
  assert.equal(c.projects.a.displayName, 'a');
  assert.deepEqual(c.projects.a.includeStages, []);
});

test('KARGO_URL overrides config url', () => {
  const c = validateConfig(base(), { ...env, KARGO_URL: 'https://override' });
  assert.equal(c.kargo.url, 'https://override');
});

test('per-project tokenEnv is honored and must be set', () => {
  const raw = base();
  raw.projects.a.tokenEnv = 'OTHER_TOKEN';
  assert.equal(validateConfig(raw, env).projects.a.tokenEnv, 'OTHER_TOKEN');
  raw.projects.a.tokenEnv = 'MISSING';
  assert.throws(() => validateConfig(raw, env), /MISSING/);
});

test('missing or empty global token fails and the message omits values', () => {
  assert.throws(() => validateConfig(base(), { KARGO_TOKEN: '' }), /KARGO_TOKEN/);
});

test('projects must be a non-empty object of objects', () => {
  assert.throws(() => validateConfig({ ...base(), projects: {} }, env), /non-empty/);
  assert.throws(() => validateConfig({ ...base(), projects: [] }, env), /non-empty/);
  assert.throws(() => validateConfig({ ...base(), projects: { a: 'x' } }, env), /projects.a must be an object/);
});

test('bad regex and non-string patterns fail at load', () => {
  const raw = base();
  raw.projects.a.includeStages = ['regex:('];
  assert.throws(() => validateConfig(raw, env), /Invalid regular expression/);
  raw.projects.a.includeStages = [1];
  assert.throws(() => validateConfig(raw, env), /must be a string/);
});

test('threshold validation', () => {
  const t = (thresholds) => validateConfig({ ...base(), decay: { thresholds } }, env);
  const c = (max) => ({ max, label: 'x', color: '#000' });
  assert.throws(() => t([c(0), c(0), c(null)]), /ascending/);
  assert.throws(() => t([c(1), c(0), c(null)]), /ascending/);
  assert.throws(() => t([c(0), c(1)]), /last entry must have max null/);
  assert.throws(() => t([c(null), c(1)]), /only the last/);
  assert.throws(() => t([c(-1), c(null)]), /non-negative integer/);
  assert.throws(() => t([c(1.5), c(null)]), /non-negative integer/);
  assert.doesNotThrow(() => t([c(0), c(null)]));
});

test('requires a url', () => {
  assert.throws(() => validateConfig({ projects: { a: {} } }, env), /kargo.url/);
});
