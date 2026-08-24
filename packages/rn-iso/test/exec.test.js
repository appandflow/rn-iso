import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, getExecutor, resetExecutor } from '../src/exec.js';

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello');
  assert.equal(out, 'hello');
});

test('runQuiet returns null on failure', () => {
  resetExecutor();
  const out = getExecutor().runQuiet('false');
  assert.equal(out, null);
});

test('setExecutor replaces the active executor', () => {
  setExecutor({
    run: () => 'mocked',
    runQuiet: () => 'mocked-quiet',
    spawn: () => ({ pid: 999 }),
  });
  assert.equal(getExecutor().run('anything'), 'mocked');
  assert.equal(getExecutor().runQuiet('anything'), 'mocked-quiet');
  resetExecutor();
});
