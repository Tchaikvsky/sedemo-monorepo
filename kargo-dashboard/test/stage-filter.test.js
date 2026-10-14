import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterStageNames, compilePattern } from '../src/stage-filter.js';

const names = ['dev', 'staging', 'prod-east', 'prod-west', 'pr-12-ephemeral'];

test('no includes and no excludes keeps everything', () => {
  assert.deepEqual(filterStageNames(names), names);
});

test('plain strings are full matches, not substrings', () => {
  assert.deepEqual(filterStageNames(names, { includeStages: ['prod'] }), []);
  assert.deepEqual(filterStageNames(names, { includeStages: ['dev'] }), ['dev']);
});

test('regex: prefix is an unanchored regex', () => {
  assert.deepEqual(filterStageNames(names, { includeStages: ['regex:^prod-'] }), ['prod-east', 'prod-west']);
  assert.deepEqual(filterStageNames(names, { includeStages: ['regex:prod'] }), ['prod-east', 'prod-west']);
});

test('includes are applied first, then excludes', () => {
  const out = filterStageNames(names, {
    includeStages: ['dev', 'regex:^prod-'],
    excludeStages: ['prod-west'],
  });
  assert.deepEqual(out, ['dev', 'prod-east']);
});

test('excludes alone apply to all stages', () => {
  assert.deepEqual(filterStageNames(names, { excludeStages: ['regex:ephemeral$'] }),
    ['dev', 'staging', 'prod-east', 'prod-west']);
});

test('order of input is preserved', () => {
  assert.deepEqual(filterStageNames(['b', 'a', 'c'], { includeStages: ['c', 'a'] }), ['a', 'c']);
});

test('non-string and invalid regex patterns throw', () => {
  assert.throws(() => compilePattern(5), /must be a string/);
  assert.throws(() => compilePattern('regex:('), /Invalid regular expression/);
});
