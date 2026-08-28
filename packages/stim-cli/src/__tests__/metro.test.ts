import { setExecutor, resetExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import {
  parseLsofPids,
  parseLsofCwd,
  parsePsPgid,
  isInsideProject,
  processGroupLeader,
  processCwd,
  resolveProjectMetro,
  killMetroTree,
  NOT_OURS_FOREIGN_CWD,
  NOT_OURS_UNRESPONSIVE,
} from '../metro.ts';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CAN_READ_CWD = processCwd(process.pid) !== null;
import { join } from 'node:path';

afterEach(() => resetExecutor());

test('parseLsofPids parses newline separated pids and ignores junk', () => {
  expect(parseLsofPids('59914\n59806\n')).toEqual([59914, 59806]);
  expect(parseLsofPids('')).toEqual([]);
  expect(parseLsofPids(null)).toEqual([]);
  expect(parseLsofPids('not-a-pid\n42')).toEqual([42]);
});

test('parseLsofCwd extracts the cwd path from -Fn field output', () => {
  const out = 'p59914\nfcwd\nn/Volumes/SSD/Developer/member-app\n';
  expect(parseLsofCwd(out)).toBe('/Volumes/SSD/Developer/member-app');
  expect(parseLsofCwd('')).toBe(null);
  expect(parseLsofCwd('p59914\nfcwd\n')).toBe(null);
});

test('parsePsPgid reads the process group id', () => {
  expect(parsePsPgid(' 59806\n')).toBe(59806);
  expect(parsePsPgid('')).toBe(null);
  expect(parsePsPgid('nonsense')).toBe(null);
});

test('isInsideProject accepts the root and descendants, rejects siblings', () => {
  expect(isInsideProject('/a/b', '/a/b')).toBe(true);
  expect(isInsideProject('/a/b/apps/x', '/a/b')).toBe(true);
  expect(isInsideProject('/a/bc', '/a/b')).toBe(false);
  expect(isInsideProject('/a', '/a/b')).toBe(false);
  expect(isInsideProject(null, '/a/b')).toBe(false);
});

test('resolveProjectMetro returns missing when nothing listens', async () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.missing).toBe(true);
  resetExecutor();
});

test('resolveProjectMetro refuses a listener that does not answer /status', async () => {
  setExecutor({ run: () => '', runQuiet: () => '4242', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => false });
  expect(r.notOurs).toMatch(/does not answer/);
  expect(r.metro).toBe(undefined);
  expect(r.kind).toBe(NOT_OURS_UNRESPONSIVE);
  resetExecutor();
});

test('resolveProjectMetro refuses a Metro running from another directory', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (cmd.includes('-sTCP:LISTEN')) return '4242';
      if (cmd.includes('-d cwd')) return 'p4242\nfcwd\nn/somewhere/else\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.notOurs).toMatch(/outside/);
  expect(r.kind).toBe(NOT_OURS_FOREIGN_CWD);
  resetExecutor();
});

test('resolveProjectMetro identifies our Metro and reports its group leader', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (cmd.includes('-sTCP:LISTEN')) return '59914';
      if (cmd.includes('-d cwd')) return 'p59914\nfcwd\nn/a/b\n';
      if (cmd.includes('ps -o pgid=')) return ' 59806\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.metro!.pid).toBe(59914);
  expect(r.metro!.leader).toBe(59806);
  resetExecutor();
});

test('killMetroTree signals the process group, not just the pid', () => {
  const signalled: [number, string | number][] = [];
  const origKill = process.kill;
  process.kill = ((pid: number, sig: string | number) => {
    signalled.push([pid, sig]);
    return true;
  }) as typeof process.kill;
  try {
    expect(killMetroTree(59806)).toBe(true);
    expect(signalled[0]).toEqual([-59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree falls back to the bare pid when the group is gone', () => {
  const signalled: [number, string | number][] = [];
  const origKill = process.kill;
  process.kill = ((pid: number, sig: string | number) => {
    if (pid < 0) throw new Error('ESRCH');
    signalled.push([pid, sig]);
    return true;
  }) as typeof process.kill;
  try {
    expect(killMetroTree(59806)).toBe(true);
    expect(signalled[0]).toEqual([59806, 'SIGTERM']);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree signals the listener pid, not the leader, when the leader is our own process group', () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => (cmd.includes('ps -o pgid=') ? ' 4242\n' : ''),
    spawn: () => {},
  });
  const signalled: [number, string | number][] = [];
  const origKill = process.kill;
  process.kill = ((pid: number, sig: string | number) => {
    signalled.push([pid, sig]);
    return true;
  }) as typeof process.kill;
  try {
    expect(killMetroTree(4242, 5555)).toBe(true);
    expect(signalled).toEqual([[5555, 'SIGTERM']]);
  } finally {
    process.kill = origKill;
    resetExecutor();
  }
});

test('killMetroTree resolves its own process group with the real ps and spares it', () => {
  const ownPgid = processGroupLeader(process.pid);
  expect(Number.isFinite(ownPgid), 'ps must report a numeric pgid for this process').toBeTruthy();
  const signalled: [number, string | number][] = [];
  const origKill = process.kill;
  process.kill = ((pid: number, sig: string | number) => {
    signalled.push([pid, sig]);
    return true;
  }) as typeof process.kill;
  try {
    expect(killMetroTree(ownPgid)).toBe(true);
    expect(signalled).toEqual([[ownPgid, 'SIGTERM']]);
  } finally {
    process.kill = origKill;
  }
});

test('killMetroTree reports false when nothing could be signalled', () => {
  const origKill = process.kill;
  process.kill = (() => {
    throw new Error('ESRCH');
  }) as typeof process.kill;
  try {
    expect(killMetroTree(1234567)).toBe(false);
  } finally {
    process.kill = origKill;
  }
});

test.skipIf(!CAN_READ_CWD)(
  'resolveProjectMetro identifies and kills a REAL listening process from the project dir',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-cli-metro-'));
    const script = join(dir, 'fake-metro.js');
    writeFileSync(
      script,
      `
    const http = require('http');
    const server = http.createServer((req, res) => res.end('packager-status:running'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
    });
  `,
    );
    const child = realSpawn(process.execPath, [script], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.unref();
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('the fake Metro never reported a port')), 10000);
      child.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk;
        const line = buffered.split('\n')[0] ?? '';
        if (buffered.includes('\n')) {
          clearTimeout(timer);
          resolve(parseInt(line, 10));
        }
      });
    });
    try {
      expect(Number.isFinite(port), 'the fake Metro must report the port it bound').toBeTruthy();
      for (let i = 0; i < 40; i++) {
        if (await isMetroRunning(port)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const ours = await resolveProjectMetro(port, dir);
      expect(ours.metro, `expected identification, got ${JSON.stringify(ours)}`).toBeTruthy();
      expect(typeof ours.metro!.pid).toBe('number');

      const foreign = await resolveProjectMetro(port, join(tmpdir(), 'some-other-project'));
      expect(foreign.notOurs, 'a process outside the project must not be claimed').toBeTruthy();

      expect(killMetroTree(ours.metro!.leader)).toBe(true);
      for (let i = 0; i < 40; i++) {
        if (!(await isMetroRunning(port))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await isMetroRunning(port)).toBe(false);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
