import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetExecutor } from '../src/exec.js';
import { logFileFor, projectHash, buildMetroSpawnArgs } from '../src/metro.js';

afterEach(() => resetExecutor());

test('projectHash is deterministic and short', () => {
  const a = projectHash('/foo/bar');
  const b = projectHash('/foo/bar');
  const c = projectHash('/foo/baz');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 12);
});

test('logFileFor uses RN_ISO_HOME and project hash', () => {
  process.env.RN_ISO_HOME = '/tmp/test-rn-iso';
  const path = logFileFor('/some/project');
  assert.match(path, /^\/tmp\/test-rn-iso\/logs\/[0-9a-f]{12}\.log$/);
  delete process.env.RN_ISO_HOME;
});

test('buildMetroSpawnArgs returns correct argv for expo', () => {
  const { cmd, args } = buildMetroSpawnArgs({ isExpo: true, port: 8083 });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['expo', 'start', '--port', '8083']);
});

test('buildMetroSpawnArgs returns correct argv for bare', () => {
  const { cmd, args } = buildMetroSpawnArgs({ isExpo: false, port: 8083 });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['react-native', 'start', '--port', '8083']);
});
