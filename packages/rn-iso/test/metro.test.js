import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { isMetroRunning } from '../src/ports.js';
import {
  parseLsofPids,
  parseLsofCwd,
  parsePsPgid,
  isInsideProject,
  processGroupLeader,
  resolveProjectMetro,
  killMetroTree,
} from '../src/metro.js';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => resetExecutor());

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

test('killMetroTree signals the process group, not just the pid', () => {
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    assert.equal(killMetroTree(59806), true);
    assert.deepEqual(signalled[0], [-59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree falls back to the bare pid when the group is gone', () => {
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => {
    if (pid < 0) throw new Error('ESRCH');
    signalled.push([pid, sig]);
  };
  try {
    assert.equal(killMetroTree(59806), true);
    assert.deepEqual(signalled[0], [59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

// A Metro backgrounded by a non-interactive script shares its shell's process
// group with rn-iso itself, so signalling the group would kill rn-iso and the
// shell that started it.
test('killMetroTree signals the bare pid when the leader is our own process group', () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => (cmd.includes('ps -o pgid=') ? ' 4242\n' : ''),
    spawn: () => {},
  });
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    assert.equal(killMetroTree(4242), true);
    assert.deepEqual(signalled, [[4242, 'SIGTERM']], 'must never signal the group rn-iso is in');
  } finally {
    process.kill = origKill;
    resetExecutor();
  }
});

// Live: the guard reads the real `ps -o pgid= -p <pid>` for THIS process. A
// mocked executor cannot prove that command reports the group rn-iso is in.
test('killMetroTree resolves its own process group with the real ps and spares it', () => {
  const ownPgid = processGroupLeader(process.pid);
  assert.ok(Number.isFinite(ownPgid), 'ps must report a numeric pgid for this process');
  const signalled = [];
  const origKill = process.kill;
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    assert.equal(killMetroTree(ownPgid), true);
    assert.deepEqual(signalled, [[ownPgid, 'SIGTERM']], 'rn-iso must never signal its own group');
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree reports false when nothing could be signalled', () => {
  const origKill = process.kill;
  process.kill = () => { throw new Error('ESRCH'); };
  try {
    assert.equal(killMetroTree(1234567), false);
  } finally {
    process.kill = origKill;
  }
});

// The whole feature is real lsof/ps/kill behavior, and a mocked executor
// cannot prove those commands are correct. This runs a genuine listener that
// answers /status exactly like Metro does, from a real directory.
//
// The listener binds port 0 and reports back the port the kernel gave it, so
// the test never competes with a real dev server for a fixed number.
test('resolveProjectMetro identifies and kills a REAL listening process from the project dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-metro-'));
  const script = join(dir, 'fake-metro.js');
  writeFileSync(script, `
    const http = require('http');
    const server = http.createServer((req, res) => res.end('packager-status:running'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
    });
  `);
  const child = realSpawn(process.execPath, [script], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.unref();
  const port = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('the fake Metro never reported a port')), 10000);
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const line = buffered.split('\n')[0];
      if (buffered.includes('\n')) {
        clearTimeout(timer);
        resolve(parseInt(line, 10));
      }
    });
  });
  try {
    assert.ok(Number.isFinite(port), 'the fake Metro must report the port it bound');
    for (let i = 0; i < 40; i++) {
      if (await isMetroRunning(port)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const ours = await resolveProjectMetro(port, dir);
    assert.ok(ours.metro, `expected identification, got ${JSON.stringify(ours)}`);
    assert.equal(typeof ours.metro.pid, 'number');

    const foreign = await resolveProjectMetro(port, join(tmpdir(), 'some-other-project'));
    assert.ok(foreign.notOurs, 'a process outside the project must not be claimed');

    assert.equal(killMetroTree(ours.metro.leader), true);
    for (let i = 0; i < 40; i++) {
      if (!(await isMetroRunning(port))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await isMetroRunning(port), false, 'real process should be dead');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
