import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { isMetroRunning } from '../src/ports.js';
import {
  logFileFor,
  projectHash,
  buildMetroSpawnArgs,
  parseLsofPids,
  parseLsofCwd,
  parsePsPgid,
  isInsideProject,
  resolveProjectMetro,
} from '../src/metro.js';

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

test('buildMetroSpawnArgs appends extras after base args', () => {
  const expo = buildMetroSpawnArgs({ isExpo: true, port: 8083, extras: ['--reset-cache'] });
  assert.deepEqual(expo.args, ['expo', 'start', '--port', '8083', '--reset-cache']);
  const bare = buildMetroSpawnArgs({ isExpo: false, port: 8083, extras: ['--reset-cache', '--verbose'] });
  assert.deepEqual(bare.args, ['react-native', 'start', '--port', '8083', '--reset-cache', '--verbose']);
});

// --- port-to-process identity ------------------------------------------------

test('parseLsofPids parses newline separated pids and ignores junk', () => {
  assert.deepEqual(parseLsofPids('59914\n59806\n'), [59914, 59806]);
  assert.deepEqual(parseLsofPids(''), []);
  assert.deepEqual(parseLsofPids(null), []);
  assert.deepEqual(parseLsofPids('not-a-pid\n42'), [42]);
});

test('parseLsofCwd extracts the cwd path from -Fn field output', () => {
  const out = 'p59914\nfcwd\nn/Volumes/SSD/Developer/member-app\n';
  assert.equal(parseLsofCwd(out), '/Volumes/SSD/Developer/member-app');
  assert.equal(parseLsofCwd(''), null);
  assert.equal(parseLsofCwd('p59914\nfcwd\n'), null);
});

test('parsePsPgid reads the process group id', () => {
  assert.equal(parsePsPgid(' 59806\n'), 59806);
  assert.equal(parsePsPgid(''), null);
  assert.equal(parsePsPgid('nonsense'), null);
});

test('isInsideProject accepts the root and descendants, rejects siblings', () => {
  assert.equal(isInsideProject('/a/b', '/a/b'), true);
  assert.equal(isInsideProject('/a/b/apps/x', '/a/b'), true);
  assert.equal(isInsideProject('/a/bc', '/a/b'), false);
  assert.equal(isInsideProject('/a', '/a/b'), false);
  assert.equal(isInsideProject(null, '/a/b'), false);
});

test('resolveProjectMetro returns missing when nothing listens', async () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.equal(r.missing, true);
  resetExecutor();
});

test('resolveProjectMetro refuses a listener that does not answer /status', async () => {
  setExecutor({ run: () => '', runQuiet: () => '4242', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => false });
  assert.match(r.notOurs, /does not answer/);
  assert.equal(r.metro, undefined);
  resetExecutor();
});

test('resolveProjectMetro refuses a Metro running from another directory', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('-sTCP:LISTEN')) return '4242';
      if (cmd.includes('-d cwd')) return 'p4242\nfcwd\nn/somewhere/else\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.match(r.notOurs, /outside/);
  resetExecutor();
});

test('resolveProjectMetro identifies our Metro and reports its group leader', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('-sTCP:LISTEN')) return '59914';
      if (cmd.includes('-d cwd')) return 'p59914\nfcwd\nn/a/b\n';
      if (cmd.includes('ps -o pgid=')) return ' 59806\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  assert.equal(r.metro.pid, 59914);
  assert.equal(r.metro.leader, 59806);
  resetExecutor();
});
