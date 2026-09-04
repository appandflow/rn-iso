import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CACHE_PROVIDER_ENV, CACHE_PROVIDER_ENV_NONE, cacheProviderConfigFromEnv } from '@stim-cli/cache';
import { getProject, upsertProject } from '../config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import {
  startTunnel,
  startTunnelSequence,
  terminateChild,
  withManagedTunnelLock,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { supervisorLogFile, workspaceLogsDir, workspaceMetadataFile } from '../paths.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import { readMetroTunnel } from '../supervisor/state.ts';
import {
  liveSupervisor,
  parseWait,
  readLogTail,
  failureEvidence,
  registerStart,
  startFacts,
  supervisorEntry,
  tailLines,
  wantsExpoOwnTunnel,
} from '../commands/start.ts';
import { IMPOSSIBLE_PID, asProcessExit, makeChildProcess } from './_factories.ts';

let tmpHome: string;
let root: string;

const successfulTunnelCleanup = async () => ({ status: 'stopped' as const });

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

function captureAction(register: (cmd: Command) => void) {
  let captured: ActionFn | undefined;
  const stub: CommandStub = {
    command() {
      return stub;
    },
    description() {
      return stub;
    },
    option() {
      return stub;
    },
    action(fn) {
      captured = fn;
      return stub;
    },
  };
  register(stub as Command);
  return (opts: Record<string, unknown> = {}) => {
    if (!captured) throw new Error('register did not register an action');
    return captured(opts);
  };
}

interface ChildStub {
  pid: number | undefined;
  unref(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: SpawnOptions;
}

interface MetroExecutorMock {
  calls: { run: string[]; spawn: SpawnCall[] };
  listening: boolean;
  run(): string;
  runFile(): string;
  runQuiet(cmd: string): string;
  runFileQuiet(): string;
  spawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildStub;
}

const DEAD_LISTENER_PID = 999999901;

function metroExecutor({
  listeners = {},
  cwd = root,
  spawnResult = null,
}: {
  listeners?: Record<string, number>;
  cwd?: string;
  spawnResult?: ChildStub | null;
} = {}): MetroExecutorMock {
  const calls: { run: string[]; spawn: SpawnCall[] } = { run: [], spawn: [] };
  return {
    calls,
    listening: false,
    run() {
      return '';
    },
    runFile() {
      return '';
    },
    runQuiet(cmd) {
      calls.run.push(cmd);
      const listening = /lsof -nP -iTCP:(\d+)/.exec(cmd);
      if (listening) return listeners[listening[1] ?? ''] ? String(listeners[listening[1] ?? '']) : '';
      if (/lsof -a -p \d+ -d cwd/.test(cmd)) return `p1\nfcwd\nn${cwd}`;
      if (/ps -o pgid=/.test(cmd)) return '777';
      return '';
    },
    runFileQuiet() {
      return '';
    },
    spawn(cmd, args, opts) {
      calls.spawn.push({ cmd, args, opts });
      return spawnResult || { pid: 4242, unref() {}, on() {} };
    },
  };
}

const openServers: Server[] = [];

function metroListener(port: number): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('packager-status:running');
  });
  openServers.push(server);
  return new Promise<Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function runAction(opts: Record<string, unknown>, register: (cmd: Command) => void = registerStart) {
  const run = captureAction(register);
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const cwd = process.cwd();
  let exitCode = null;
  console.log = (l) => logs.push(String(l));
  console.error = (l) => errs.push(String(l));
  process.exit = asProcessExit((c) => {
    exitCode = c;
  });
  process.chdir(root);
  try {
    await run(opts);
  } finally {
    process.chdir(cwd);
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode };
}

async function runConcurrentActions(opts: Record<string, unknown>, register: (cmd: Command) => void) {
  const run = captureAction(register);
  const logs: string[] = [];
  const errs: string[] = [];
  const exits: Array<string | number | null | undefined> = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const cwd = process.cwd();
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errs.push(String(line));
  process.exit = asProcessExit((code) => exits.push(code));
  process.chdir(root);
  try {
    await Promise.all([run(opts), run(opts)]);
  } finally {
    process.chdir(cwd);
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exits };
}

async function runSpawnedExpoStart({
  port,
  options = {},
  settings,
  tunnelDelayMs,
  exitAfterTunnel = false,
}: {
  port: number;
  options?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  tunnelDelayMs?: number;
  exitAfterTunnel?: boolean;
}) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
  const exec = metroExecutor({ listeners: {} });
  const held: { server: Server | null } = { server: null };
  const childHandlers: Record<string, (...args: unknown[]) => void> = {};
  let tunnelWritten: Promise<number | null> = Promise.resolve(null);
  exec.spawn = (cmd, args, opts) => {
    exec.calls.spawn.push({ cmd, args, opts });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });
    metroListener(port).then((server) => {
      held.server = server;
      exec.listening = true;
      return server;
    });
    if (tunnelDelayMs !== undefined) {
      tunnelWritten = new Promise((resolve) => {
        setTimeout(() => {
          writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url: 'exp://remote.exp.direct' } });
          if (exitAfterTunnel) childHandlers.exit?.(1, null);
          resolve(Date.now());
        }, tunnelDelayMs);
      });
    }
    return {
      pid: process.pid,
      unref() {},
      on(event, cb) {
        childHandlers[event] = cb;
      },
    };
  };
  const base = exec.runQuiet.bind(exec);
  exec.runQuiet = (cmd) => {
    if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
    return base(cmd);
  };
  setExecutor(exec);
  upsertProject(root, { metroPort: port, ...(settings ? { settings } : {}) });

  try {
    const result = await runAction(options);
    const completedAt = Date.now();
    return { result, exec, completedAt, tunnelWrittenAt: await tunnelWritten };
  } finally {
    held.server?.close();
  }
}

describe('wantsExpoOwnTunnel', () => {
  test('a local Expo start does not request a tunnel', () => {
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: false, mode: 'auto' })).toBe(false);
  });

  test('a remote Expo start requests its own tunnel only in expo mode', () => {
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'auto' })).toBe(false);
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'expo' })).toBe(true);
  });

  test('a bare RN workspace never does -- there is no dev server here to tunnel itself', () => {
    expect(wantsExpoOwnTunnel({ isExpo: false, remote: true, mode: 'auto' })).toBe(false);
    expect(wantsExpoOwnTunnel({ isExpo: false, remote: true, mode: 'expo' })).toBe(false);
  });

  test('an explicit managed provider defers to `ios`/`android --remote`, not `start`', () => {
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'cloudflared' })).toBe(false);
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'ngrok' })).toBe(false);
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'off' })).toBe(false);
  });

  test("an operator-supplied metro.publicUrl wins -- starting Expo's own tunnel too would be a second one", () => {
    expect(wantsExpoOwnTunnel({ isExpo: true, remote: true, mode: 'auto', publicUrl: 'https://abc.ngrok.app' })).toBe(
      false,
    );
  });
});

describe('option parsing', () => {
  test('--wait defaults to 60 seconds', () => {
    expect(parseWait(undefined)).toEqual({ seconds: 60 });
  });

  test('--wait takes a number of seconds', () => {
    expect(parseWait('90')).toEqual({ seconds: 90 });
  });

  test('a --wait that is not a positive number is refused, not silently defaulted', () => {
    expect(parseWait('soon').error).toMatch(/--wait/);
    expect(parseWait('0').error).toMatch(/--wait/);
    expect(parseWait('-5').error).toMatch(/--wait/);
  });
});

describe('the supervisor entry point', () => {
  test('resolves to the run.js that is actually shipped', () => {
    expect(existsSync(supervisorEntry())).toBeTruthy();
    expect(supervisorEntry()).toMatch(/src\/supervisor\/run\.ts$/);
  });
});

describe('liveSupervisor', () => {
  const alive = () => true;
  const dead = () => false;

  test('takes the workspace state first, because only it carries the mode', () => {
    const found = liveSupervisor({
      state: { supervisor: { pid: 10, port: 8082, mode: 'bare-inproc', startedAt: 'T' } },
      project: { supervisor: { pid: 10, port: 8082 } },
      port: 8082,
      isAlive: alive,
    });
    expect(found).toEqual({ pid: 10, port: 8082, mode: 'bare-inproc', startedAt: 'T' });
  });

  test('falls back to the global registration when the workspace file is gone', () => {
    const found = liveSupervisor({
      state: null,
      project: { supervisor: { pid: 11, port: 8082, startedAt: 'T' } },
      port: 8082,
      isAlive: alive,
    });
    assert(found);
    expect(found.pid).toBe(11);
    expect(found.mode).toBe(null);
  });

  test('a dead pid is not a supervisor: a stale record outlives its process', () => {
    expect(
      liveSupervisor({
        state: { supervisor: { pid: 12, port: 8082 } },
        project: null,
        port: 8082,
        isAlive: dead,
      }),
    ).toBe(null);
  });

  test('a supervisor recorded on another port is not the one that would answer here', () => {
    expect(
      liveSupervisor({
        state: { supervisor: { pid: 13, port: 8099 } },
        project: null,
        port: 8082,
        isAlive: alive,
      }),
    ).toBe(null);
  });

  test('no record at all is null, not a throw', () => {
    expect(liveSupervisor({ port: 8082 })).toBe(null);
    expect(liveSupervisor()).toBe(null);
  });
});

describe('startFacts', () => {
  test('shapes the facts an agent reads', () => {
    expect(
      startFacts({
        port: 8082,
        supervisor: { pid: 91, mode: 'expo-child' },
        logsDir: '/w/.stim/logs',
        alreadyRunning: false,
      }),
    ).toEqual({
      port: 8082,
      supervisorPid: 91,
      mode: 'expo-child',
      logsDir: '/w/.stim/logs',
      alreadyRunning: false,
    });
  });

  test('a dev server Stim did not start reports a null supervisor rather than a lie', () => {
    const facts = startFacts({ port: 8082, supervisor: null, logsDir: '/l', alreadyRunning: true });
    expect(facts.supervisorPid).toBe(null);
    expect(facts.mode).toBe(null);
    expect(facts.alreadyRunning).toBe(true);
  });
});

describe('the supervisor log tail', () => {
  test('takes the last lines and drops the blank ones', () => {
    expect(tailLines('a\nb\n\nc\nd\ne\nf\n', 3)).toEqual(['d', 'e', 'f']);
  });

  test('a log that does not exist yet is an empty tail, not a throw', () => {
    expect(readLogTail(join(root, 'nope.log'))).toEqual([]);
  });
});

describe('failureEvidence (issue #24)', () => {
  const record = (ts: number, msg: string, src = 'metro') => JSON.stringify({ ts, level: 'error', src, msg });

  test('an empty supervisor.log is not pointed at; the timeline errors are quoted instead', () => {
    const logsDir = join(root, '.stim', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'supervisor.log');
    writeFileSync(logFile, '');
    writeFileSync(
      join(logsDir, 'metro.ndjson'),
      [
        record(1000, 'stale error from a previous run'),
        record(5000, 'PluginError: Failed to resolve plugin for module "expo-share-intent"\n  at resolve'),
        record(5001, 'from expo config'),
      ].join('\n') + '\n',
    );
    const lines = failureEvidence({ logFile, logsDir, sinceTs: 2000 });
    expect(lines.some((l) => l.includes('Supervisor log:'))).toBe(false);
    expect(lines.some((l) => l.includes('stale error'))).toBe(false);
    expect(lines).toContain('metro: PluginError: Failed to resolve plugin for module "expo-share-intent"');
    expect(lines).toContain('metro: from expo config');
    expect(lines.at(-1)).toMatch(/logs --errors/);
  });

  test('a supervisor.log with content is still quoted, ahead of the timeline records', () => {
    const logsDir = join(root, '.stim', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'supervisor.log');
    writeFileSync(logFile, 'Error: Cannot find module expo\n');
    const lines = failureEvidence({ logFile, logsDir, sinceTs: 0 });
    expect(lines[0]).toBe('Error: Cannot find module expo');
    expect(lines[1]).toBe(`Supervisor log: ${logFile}`);
  });

  test('falls back to any-level records from this attempt when nothing reached error level (#30)', () => {
    const logsDir = join(root, '.stim', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'supervisor.log');
    writeFileSync(logFile, '');
    const rec = (ts: number, msg: string) => JSON.stringify({ ts, level: 'info', src: 'metro', msg });
    writeFileSync(
      join(logsDir, 'metro.ndjson'),
      [rec(1000, 'old noise'), rec(5000, 'PluginError: Failed to resolve plugin'), rec(5001, 'at loadConfig')].join(
        '\n',
      ) + '\n',
    );
    const lines = failureEvidence({ logFile, logsDir, sinceTs: 2000 });
    expect(lines).toContain('metro: PluginError: Failed to resolve plugin');
    expect(lines).toContain('metro: at loadConfig');
    expect(lines.some((l) => l.includes('old noise'))).toBe(false);
    expect(lines.at(-1)).toBe('Full records: `stim logs`');
  });

  test('nothing anywhere is an empty evidence list, not a throw', () => {
    const logsDir = join(root, 'no-such-logs');
    expect(failureEvidence({ logFile: join(logsDir, 'supervisor.log'), logsDir, sinceTs: 0 })).toEqual([]);
  });
});

describe('action: already running', () => {
  test('a healthy dev server with a live supervisor record is a no-op exit 0', async () => {
    const port = 8151;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } }));
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });

    let result;
    try {
      result = await runAction({ json: true });
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(result.logs.length).toBe(1);
    const facts = JSON.parse(result.logs[0] ?? '');
    expect(facts).toEqual({
      port,
      supervisorPid: process.pid,
      mode: 'bare-inproc',
      logsDir: workspaceLogsDir(root),
      alreadyRunning: true,
    });
  });

  test('a healthy dev server the agent started itself is reported, not fought', async () => {
    const port = 8152;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true });
    } finally {
      server.close();
    }

    const facts = JSON.parse(result.logs[0] ?? '');
    expect(facts.supervisorPid).toBe(null);
    expect(facts.alreadyRunning).toBe(true);
    expect(result.exitCode).toBe(null);
    expect(exec.calls.spawn).toEqual([]);
    expect(result.errs.join('\n')).toMatch(/started outside Stim/);
  });

  test('start --remote refuses an external Expo server that has no public URL', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8169;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'expo' } } });

    let result;
    try {
      result = await runAction({ json: true, remote: true });
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_REMOTE_START_REQUIRED');
  });

  test('start --remote accepts an external Expo server with an operator public URL', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8170;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, {
      metroPort: port,
      settings: { metro: { publicUrl: 'https://metro.example.test' } },
    });

    let result;
    try {
      result = await runAction({ json: true, remote: true });
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '').alreadyRunning).toBe(true);
  });

  test.each([
    ['owned', true],
    ['external', false],
  ])('start --remote refuses to add a managed tunnel to an existing %s bare server', async (_kind, owned) => {
    const port = owned ? 8176 : 8177;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    if (owned) {
      writeWorkspaceState(root, {
        supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' },
      });
    }
    let tunnelStarted = false;

    let result;
    try {
      result = await runAction({ json: true, remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => {
            tunnelStarted = true;
            return {
              provider: 'ngrok',
              url: 'https://late.ngrok.app',
              pid: 4242,
              processToken: 'linux:100',
              cleanup: successfulTunnelCleanup,
            };
          },
          isTunnelAlive: () => false,
        }),
      );
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(1);
    expect(tunnelStarted).toBe(false);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '')).toEqual({
      code: 'STIM_REMOTE_START_REQUIRED',
      message: `The dev server on port ${port} is local-only and cannot gain a managed tunnel while it is running.`,
      remedy: 'Run `stim stop`, then `stim start --remote`.',
    });
  });

  test('two starts in a row leave one supervisor', async () => {
    const port = 8153;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });

    try {
      await runAction({ json: true });
      await runAction({ json: true });
    } finally {
      server.close();
    }
    expect(exec.calls.spawn).toEqual([]);
  });

  test('start --remote refuses when a healthy local Expo supervisor has no Expo tunnel', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8166;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'expo' } } });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });

    let result;
    try {
      result = await runAction({ json: true, remote: true, wait: '1' });
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '')).toEqual({
      code: 'STIM_REMOTE_START_REQUIRED',
      message: `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`,
      remedy: 'Run `stim stop`, then `stim start --remote`.',
    });
  });

  test('a concurrent remote start waits when an owned Expo server is already healthy before its tunnel', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8173;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'expo' } } });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });
    const tunnelWritten = new Promise<number>((resolve) => {
      setTimeout(() => {
        writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url: 'exp://already-healthy.exp.direct' } });
        resolve(Date.now());
      }, 1000);
    });

    let result;
    let completedAt = 0;
    let tunnelWrittenAt = 0;
    try {
      result = await runAction({ json: true, remote: true, wait: '10' });
      completedAt = Date.now();
    } finally {
      tunnelWrittenAt = await tunnelWritten;
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '').alreadyRunning).toBe(true);
    expect(completedAt >= tunnelWrittenAt).toBe(true);
  });
});

describe('action: spawning the supervisor', () => {
  test('spawns node run.js --root --port detached, with stdio into supervisor.log, and waits for health', async () => {
    const port = 8154;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        held.server = s;
        exec.listening = true;
        return s;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true, wait: '10' });
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(null);
    const spawned = exec.calls.spawn[0];
    assert(spawned);
    expect(spawned.cmd).toBe(process.execPath);
    expect(spawned.args).toEqual([supervisorEntry(), '--root', root, '--port', String(port)]);
    expect(spawned.opts.cwd).toBe(root);
    expect(spawned.opts.detached).toBe(true);
    const stdio = spawned.opts.stdio;
    assert(Array.isArray(stdio));
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[1]).toBe(stdio[2]);
    expect(existsSync(supervisorLogFile(root))).toBeTruthy();

    const facts = JSON.parse(result.logs[0] ?? '');
    expect(facts.port).toBe(port);
    expect(facts.alreadyRunning).toBe(false);
    expect(facts.supervisorPid).toBe(process.pid);
    expect(facts.mode).toBe('bare-inproc');
  });

  test('a configured cache provider reaches the supervisor through the environment', async () => {
    const port = 8155;
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ cache: { provider: './tools/cache-provider.cjs', options: { bucket: 'mobile' } } }),
    );
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        held.server = s;
        exec.listening = true;
        return s;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    try {
      await runAction({ json: true, wait: '10' });
    } finally {
      held.server?.close();
    }

    const spawned = exec.calls.spawn[0];
    assert(spawned);
    const env = spawned.opts.env as NodeJS.ProcessEnv;
    expect(cacheProviderConfigFromEnv(env)).toEqual({
      provider: './tools/cache-provider.cjs',
      options: { bucket: 'mobile' },
      baseDir: root,
    });
    expect(process.env[CACHE_PROVIDER_ENV]).toBeUndefined();
  });

  test('no configured provider hands the supervisor an explicit none', async () => {
    const port = 8157;
    process.env[CACHE_PROVIDER_ENV] = 'stale';
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        held.server = s;
        exec.listening = true;
        return s;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    try {
      await runAction({ json: true, wait: '10' });
    } finally {
      held.server?.close();
      delete process.env[CACHE_PROVIDER_ENV];
    }

    const spawned = exec.calls.spawn[0];
    assert(spawned);
    const env = spawned.opts.env as NodeJS.ProcessEnv;
    expect(env[CACHE_PROVIDER_ENV]).toBe(CACHE_PROVIDER_ENV_NONE);
    expect(cacheProviderConfigFromEnv(env)).toBeNull();
  });

  test('start --remote passes --tunnel to an Expo supervisor in explicit expo mode', async () => {
    const { exec } = await runSpawnedExpoStart({
      port: 8156,
      options: { json: true, wait: '10', remote: true },
      tunnelDelayMs: 0,
      settings: { metro: { tunnel: 'expo' } },
    });
    const spawned = exec.calls.spawn[0];
    assert(spawned);
    expect(spawned.args).toEqual([supervisorEntry(), '--root', root, '--port', '8156', '--tunnel']);
  });

  test('start --remote waits for the Expo tunnel URL after Metro becomes healthy', async () => {
    const { result, completedAt, tunnelWrittenAt } = await runSpawnedExpoStart({
      port: 8168,
      options: { json: true, wait: '10', remote: true },
      tunnelDelayMs: 1000,
      settings: { metro: { tunnel: 'expo' } },
    });

    expect(result.exitCode).toBe(null);
    expect(tunnelWrittenAt).not.toBe(null);
    expect(completedAt >= (tunnelWrittenAt as number)).toBe(true);
  });

  test('start --remote refuses when the tunnel URL and supervisor exit arrive together', async () => {
    const { result } = await runSpawnedExpoStart({
      port: 8172,
      options: { json: true, wait: '10', remote: true },
      tunnelDelayMs: 1000,
      exitAfterTunnel: true,
      settings: { metro: { tunnel: 'expo' } },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_SUPERVISOR_EXITED');
  });

  test('plain start does not pass --tunnel to an Expo supervisor in auto mode', async () => {
    const { exec } = await runSpawnedExpoStart({ port: 8163, options: { json: true, wait: '10' } });
    const spawned = exec.calls.spawn[0];
    assert(spawned);
    expect(spawned.args).toEqual([supervisorEntry(), '--root', root, '--port', '8163']);
  });

  test('plain start does not inject a configured public URL into the dev server', async () => {
    const { exec } = await runSpawnedExpoStart({
      port: 8178,
      options: { json: true, wait: '10' },
      settings: { metro: { publicUrl: 'https://operator.example.test' } },
    });
    const spawned = exec.calls.spawn[0];
    assert(spawned);
    expect(spawned.opts.env).not.toHaveProperty('STIM_METRO_PUBLIC_URL');
    expect(spawned.opts.env).not.toHaveProperty('EXPO_PACKAGER_PROXY_URL');
  });

  test.each([
    ['an invalid tunnel mode', { metro: { tunnel: 'ngork' } }],
    ['a misplaced ngrok URL', { metro: { tunnel: 'auto', ngrokUrl: 'https://stable.ngrok.app' } }],
    ['a non-HTTPS ngrok URL', { metro: { tunnel: 'ngrok', ngrokUrl: 'http://stable.ngrok.app' } }],
    ['a malformed ngrok URL', { metro: { tunnel: 'ngrok', ngrokUrl: 'not a URL' } }],
  ])('start --remote refuses %s before provider startup', async (_label, settings) => {
    const port = 8179;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings });
    let providerStarted = false;

    const result = await runAction({ json: true, remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok', 'cloudflared'],
        startTunnelSequence: async () => {
          providerStarted = true;
          return { failed: true, reason: 'provider should not start' };
        },
      }),
    );

    expect(providerStarted).toBe(false);
    expect(exec.calls.spawn).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_BAD_ARG');
  });

  test('start --remote reports worktree removal before project registration', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    let providerChecked = false;
    const result = await runAction({ json: true, remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => {
          providerChecked = true;
          return ['ngrok'];
        },
        withWorktreeLock: async () => {
          throw Object.assign(new Error('held for worktree removal'), { code: 'STIM_LOCK_REFUSED' });
        },
      }),
    );

    const error = JSON.parse(result.logs[0] ?? '');
    expect(result.exitCode).toBe(1);
    expect(error.code).toBe('STIM_WORKTREE_REMOVAL_IN_PROGRESS');
    expect(error.remedy).toMatch(/retry.*worktree remove.*finishes/i);
    expect(providerChecked).toBe(false);
    expect(getProject(root)).toBeNull();
  });

  test.each(['ios', 'android'])('%s.remote gives plain start remote intent', async (platform) => {
    const port = platform === 'ios' ? 8164 : 8165;
    const { exec } = await runSpawnedExpoStart({
      port,
      options: { json: true, wait: '10' },
      settings: { [platform]: { remote: 'proxy' }, metro: { tunnel: 'expo' } },
      tunnelDelayMs: 0,
    });
    expect(exec.calls.spawn[0]?.args).toEqual([supervisorEntry(), '--root', root, '--port', String(port), '--tunnel']);
  });

  test('plain start does not start an explicitly configured managed provider', async () => {
    const port = 8157;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        held.server = s;
        exec.listening = true;
        return s;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5150' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });

    try {
      await runAction({ json: true, wait: '10' }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => {
            throw new Error('plain start must not start a tunnel');
          },
        }),
      );
    } finally {
      held.server?.close();
    }

    const spawned = exec.calls.spawn[0];
    assert(spawned);
    expect(spawned.args).toEqual([supervisorEntry(), '--root', root, '--port', String(port)]);
  });

  test('start --remote records a managed tunnel before starting the bare dev server', async () => {
    const port = 8174;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    const order: string[] = [];
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      order.push('server');
      expect(readMetroTunnel(root)).toMatchObject({
        kind: 'managed',
        provider: 'ngrok',
        url: 'https://stable.ngrok.app',
        port,
      });
      expect(opts.env).toMatchObject({
        STIM_METRO_PUBLIC_URL: 'https://stable.ngrok.app',
        EXPO_PACKAGER_PROXY_URL: 'https://stable.ngrok.app',
      });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((server) => {
        held.server = server;
        exec.listening = true;
        return server;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5155' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, {
      metroPort: port,
      settings: { metro: { tunnel: 'ngrok', ngrokUrl: 'https://stable.ngrok.app' } },
    });

    let result;
    try {
      result = await runAction({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok', 'cloudflared'],
          startTunnelSequence: async (options) => {
            order.push('tunnel');
            expect(options).toMatchObject({
              providers: ['ngrok'],
              port,
              ngrokUrl: 'https://stable.ngrok.app',
              requireReachable: false,
            });
            return {
              provider: 'ngrok',
              url: 'https://stable.ngrok.app',
              pid: 4242,
              processToken: 'linux:100',
              cleanup: successfulTunnelCleanup,
            };
          },
          isTunnelAlive: () => true,
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(null);
    expect(order).toEqual(['tunnel', 'server']);
  });

  test('concurrent remote starts acquire and record one managed tunnel', async () => {
    const port = 8180;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null; starting: Promise<Server> | null } = { server: null, starting: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      held.starting ??= metroListener(port).then((server) => {
        held.server = server;
        exec.listening = true;
        return server;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5156' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let tunnelStarts = 0;
    let active = 0;
    let maxActive = 0;

    try {
      await runConcurrentActions({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => {
            tunnelStarts += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return {
              provider: 'ngrok',
              url: 'https://one.ngrok.app',
              pid: 4242,
              processToken: 'linux:100',
              cleanup: successfulTunnelCleanup,
            };
          },
          isTunnelAlive: () => true,
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(tunnelStarts).toBe(1);
    expect(maxActive).toBe(1);
    expect(exec.calls.spawn).toHaveLength(1);
    expect(readMetroTunnel(root)).toMatchObject({ provider: 'ngrok', pid: 4242, url: 'https://one.ngrok.app' });
  });

  test('concurrent managed starts hand off one supervisor spawn inside the tunnel lock', async () => {
    const port = 8186;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    let releaseFirstLock!: () => void;
    const firstLockGate = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    let lockReturns = 0;
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      if (exec.calls.spawn.length === 1) {
        queueMicrotask(releaseFirstLock);
        setTimeout(() => {
          writeWorkspaceState(root, {
            supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' },
          });
          metroListener(port).then((server) => {
            held.server = server;
            exec.listening = true;
            return server;
          });
        }, 20);
      }
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5158' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });

    try {
      await runConcurrentActions({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => ({
            provider: 'ngrok',
            url: 'https://one.ngrok.app',
            pid: 4242,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          }),
          isTunnelAlive: () => true,
          withTunnelLock: async (workspaceRoot, fn) => {
            const result = await withManagedTunnelLock(workspaceRoot, fn);
            if (++lockReturns === 1) await firstLockGate;
            return result;
          },
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(exec.calls.spawn).toHaveLength(1);
  });

  test('a tunnel that resists cleanup during an existing-server race keeps its record', async () => {
    const port = 8188;
    const exec = metroExecutor({ listeners: {} });
    let listening = false;
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return listening ? String(DEAD_LISTENER_PID) : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let server: Server | null = null;

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => {
          server = await metroListener(port);
          listening = true;
          return {
            provider: 'ngrok',
            url: 'https://still-running.ngrok.app',
            pid: 4242,
            processToken: 'linux:100',
            cleanup: async () => ({ status: 'failed', reason: 'pid 4242 ignored SIGKILL' }),
          };
        },
        isTunnelAlive: () => true,
      }),
    ).finally(() => server?.close());

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').remedy).toMatch(/cleanup failed.*pid 4242/i);
    expect(readMetroTunnel(root)).toMatchObject({ pid: 4242, url: 'https://still-running.ngrok.app' });
    expect(exec.calls.spawn).toEqual([]);
  });

  test('a supervisor handoff write failure reaps a child that ignores SIGTERM', async () => {
    const port = 8189;
    const exec = metroExecutor({ listeners: {} });
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    let alive = true;
    let now = 0;
    const child = Object.assign(
      makeChildProcess({
        kill(signal) {
          signals.push(signal);
          if (signal === 'SIGKILL') {
            alive = false;
            child.emit('exit', null, 'SIGKILL');
          }
          return true;
        },
      }),
      { pid: 4242 },
    );
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return child;
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => ({
          provider: 'ngrok',
          url: 'https://ready.ngrok.app',
          pid: 4343,
          processToken: 'linux:100',
          cleanup: successfulTunnelCleanup,
        }),
        isTunnelAlive: () => true,
        writeSupervisorRecord: () => {
          throw new Error('disk full');
        },
        terminateSupervisorChild: (spawned) =>
          terminateChild(spawned, {
            alreadyExited: false,
            timeoutMs: 1,
            now: () => now,
            sleep: async (ms) => void (now += ms),
            isAlive: () => alive,
          }),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_SUPERVISOR_EXITED');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(alive).toBe(false);
    expect(readMetroTunnel(root)).toMatchObject({ pid: 4343 });
  });

  test('a failed managed tunnel acquisition releases the concurrency lock', async () => {
    const port = 8181;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((server) => {
        held.server = server;
        exec.listening = true;
        return server;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5157' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let attempts = 0;
    let active = 0;
    let maxActive = 0;

    try {
      await runConcurrentActions({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => {
            const attempt = ++attempts;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return attempt === 1
              ? { failed: true, reason: 'authentication failed' }
              : {
                  provider: 'ngrok',
                  url: 'https://retry.ngrok.app',
                  pid: 4243,
                  processToken: 'linux:100',
                  cleanup: successfulTunnelCleanup,
                };
          },
          isTunnelAlive: () => true,
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(attempts).toBe(2);
    expect(maxActive).toBe(1);
    expect(readMetroTunnel(root)).toMatchObject({ pid: 4243, url: 'https://retry.ngrok.app' });
  });

  test('a failed managed tunnel record stops the process before the dev server starts', async () => {
    const port = 8175;
    const exec = metroExecutor({ listeners: {} });
    let serverStarted = false;
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      serverStarted = true;
      return { pid: 1, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let cleanupCalled = false;

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => ({
          provider: 'ngrok',
          url: 'https://ready.ngrok.app',
          pid: 4242,
          processToken: 'linux:100',
          cleanup: async () => {
            cleanupCalled = true;
            return { status: 'stopped' };
          },
        }),
        isTunnelAlive: () => false,
        writeTunnelRecord: () => {
          throw new Error('disk full');
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(serverStarted).toBe(false);
    expect(cleanupCalled).toBe(true);
  });

  test('a failed managed tunnel record escalates cleanup for a child that ignores SIGTERM', async () => {
    const port = 8184;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    let alive = true;
    let exited = false;
    let now = 0;
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          alive = false;
          exited = true;
          child.emit('exit', null, 'SIGKILL');
        }
        return true;
      },
    });

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: (options) =>
          startTunnelSequence({
            ...options,
            start: async (startOptions) => {
              const started = startTunnel({
                ...startOptions,
                spawnFn: () => child,
                cleanupTimeoutMs: 1,
                isChildAlive: () => alive,
                now: () => now,
                sleep: async (ms) => void (now += ms),
                readProcessToken: () => 'linux:100',
              });
              child.stdout?.emit('data', `${JSON.stringify({ url: 'https://ready.ngrok.app' })}\n`);
              return started;
            },
          }),
        writeTunnelRecord: () => {
          throw new Error('disk full');
        },
        stopTunnel: async () => ({ status: 'failed', reason: 'SIGTERM did not stop pid 4242.' }),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exited).toBe(true);
    expect(exec.calls.spawn).toEqual([]);
  });

  test('an unconfirmed record-failure cleanup reports the unmanaged pid', async () => {
    const port = 8185;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let now = 0;
    const child = makeChildProcess({ kill: () => true });

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: (options) =>
          startTunnelSequence({
            ...options,
            start: async (startOptions) => {
              const started = startTunnel({
                ...startOptions,
                spawnFn: () => child,
                cleanupTimeoutMs: 1,
                isChildAlive: () => true,
                now: () => now,
                sleep: async (ms) => void (now += ms),
                readProcessToken: () => 'linux:100',
              });
              child.stdout?.emit('data', `${JSON.stringify({ url: 'https://ready.ngrok.app' })}\n`);
              return started;
            },
          }),
        writeTunnelRecord: () => {
          throw new Error('disk full');
        },
        stopTunnel: async () => ({ status: 'failed', reason: 'SIGTERM did not stop pid 4242.' }),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').remedy).toMatch(new RegExp(`unmanaged.*pid ${IMPOSSIBLE_PID}`, 'i'));
    expect(exec.calls.spawn).toEqual([]);
  });

  test('an unconfirmed pre-spawn cleanup keeps the managed tunnel record', async () => {
    const port = 8190;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => ({
          provider: 'ngrok',
          url: 'https://unconfirmed.ngrok.app',
          pid: 4242,
          processToken: 'linux:100',
          cleanup: async () => ({ status: 'failed', reason: 'SIGKILL did not confirm exit' }),
        }),
        isTunnelAlive: () => false,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').remedy).toMatch(/unmanaged.*pid 4242/i);
    expect(readMetroTunnel(root)).toMatchObject({ pid: 4242, url: 'https://unconfirmed.ngrok.app' });
    expect(exec.calls.spawn).toEqual([]);
  });

  test('a managed provider that exits before Metro readiness fails and clears its record', async () => {
    const port = 8182;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((server) => {
        held.server = server;
        exec.listening = true;
        return server;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5158' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    const stopped: TunnelRecord[] = [];
    let livenessChecks = 0;

    let result;
    try {
      result = await runAction({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => ({
            provider: 'ngrok',
            url: 'https://gone.ngrok.app',
            pid: 4242,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          }),
          isTunnelAlive: () => ++livenessChecks === 1,
          stopTunnel: async (record) => {
            stopped.push(record);
            return { status: 'missing' };
          },
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_REMOTE_METRO_UNREACHABLE');
    expect(stopped).toEqual([expect.objectContaining({ pid: 4242 })]);
    expect(readMetroTunnel(root)).toBeNull();
  });

  test('a failed readiness cleanup keeps the managed tunnel record for stop to retry', async () => {
    const port = 8191;
    const exec = metroExecutor({ listeners: {} });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: process.pid, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let livenessChecks = 0;

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => ({
          provider: 'ngrok',
          url: 'https://cleanup-failed.ngrok.app',
          pid: 4242,
          processToken: 'linux:100',
          cleanup: successfulTunnelCleanup,
        }),
        isTunnelAlive: () => ++livenessChecks === 1,
        stopTunnel: async () => ({ status: 'failed', reason: 'pid 4242 ignored SIGTERM' }),
      }),
    );

    const error = JSON.parse(result.logs[0] ?? '');
    expect(result.exitCode).toBe(1);
    expect(error.code).toBe('STIM_REMOTE_METRO_UNREACHABLE');
    expect(error.remedy).toMatch(/cleanup.*failed.*stim stop/i);
    expect(readMetroTunnel(root)).toMatchObject({ pid: 4242, url: 'https://cleanup-failed.ngrok.app' });
  });

  test('a reused managed provider that dies before Metro readiness fails without clearing its replacement', async () => {
    const port = 8187;
    const exec = metroExecutor({ listeners: {} });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, {
        supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' },
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    const reused = {
      kind: 'managed' as const,
      provider: 'ngrok' as const,
      pid: 4242,
      url: 'https://reused.ngrok.app',
      port,
      startedAt: 'old',
      processToken: 'linux:100',
    };
    const replacement = {
      kind: 'managed' as const,
      provider: 'ngrok' as const,
      pid: 4343,
      url: 'https://replacement.ngrok.app',
      port,
      startedAt: 'new',
      processToken: 'linux:200',
    };
    writeWorkspaceState(root, { metroTunnel: reused });
    let livenessChecks = 0;

    const result = await runAction({ json: true, wait: '1', remote: true }, (cmd) =>
      registerStart(cmd, {
        providers: () => ['ngrok'],
        startTunnelSequence: async () => {
          throw new Error('the recorded tunnel must be reused');
        },
        isTunnelAlive: () => {
          if (++livenessChecks <= 3) return true;
          writeWorkspaceState(root, { metroTunnel: replacement });
          return false;
        },
        stopTunnel: async () => {
          throw new Error('a reused dead tunnel must not be signalled');
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_REMOTE_METRO_UNREACHABLE');
    expect(readMetroTunnel(root)).toEqual(replacement);
  });

  test('managed provider exit cleanup preserves a replacement tunnel record', async () => {
    const port = 8183;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((server) => {
        held.server = server;
        exec.listening = true;
        return server;
      });
      return { pid: process.pid, unref() {}, on() {} };
    };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5159' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'ngrok' } } });
    let replaced = false;
    let livenessChecks = 0;

    try {
      await runAction({ json: true, wait: '10', remote: true }, (cmd) =>
        registerStart(cmd, {
          providers: () => ['ngrok'],
          startTunnelSequence: async () => ({
            provider: 'ngrok',
            url: 'https://gone.ngrok.app',
            pid: 4242,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          }),
          isTunnelAlive: () => {
            if (++livenessChecks === 1) return true;
            if (!replaced) {
              replaced = true;
              writeWorkspaceState(root, {
                metroTunnel: {
                  kind: 'managed',
                  provider: 'cloudflared',
                  url: 'https://replacement.trycloudflare.com',
                  pid: 9999,
                  port,
                  startedAt: 'later',
                  processToken: 'linux:200',
                },
              });
            }
            return false;
          },
          stopTunnel: async () => ({ status: 'missing' }),
        }),
      );
    } finally {
      held.server?.close();
    }

    expect(readMetroTunnel(root)).toMatchObject({
      provider: 'cloudflared',
      pid: 9999,
      url: 'https://replacement.trycloudflare.com',
    });
  });

  test('a supervisor that never answers exits 1 with the log tail and the log path', async () => {
    const port = 8155;
    const exec = metroExecutor({ listeners: {} });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: process.pid, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(
      supervisorLogFile(root),
      [
        'noise 1',
        'noise 2',
        'noise 3',
        'noise 4',
        'noise 5',
        'noise 6',
        'Stim supervisor: failed to start the bare-inproc dev server: STIM_BARE_DEPS: metro is not resolvable',
      ].join('\n'),
    );

    const result = await runAction({ json: true, wait: '1' });

    expect(result.exitCode).toBe(1);
    expect(result.logs.length).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '')).toEqual({
      code: 'STIM_METRO_TIMEOUT',
      message: 'The dev server did not answer on port 8155 within 1s.',
      remedy: 'It may still be starting. Run `stim stop` to halt it, or `stim logs` to follow along.',
    });
    const stderr = result.errs.join('\n');
    expect(stderr).toMatch(/did not answer on port 8155 within 1s/);
    expect(stderr).toMatch(/STIM_BARE_DEPS/);
    expect(stderr).toMatch(new RegExp(supervisorLogFile(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(!stderr.includes('noise 1')).toBeTruthy();
    expect(stderr.includes('noise 4')).toBeTruthy();
  });

  test('a supervisor that exits during startup ends the wait immediately', async () => {
    const port = 8156;
    const exec = metroExecutor({ listeners: {} });
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      const child: ChildStub = {
        pid: process.pid,
        unref() {},
        on(event, cb) {
          handlers[event] = cb;
        },
      };
      setTimeout(() => handlers.exit?.(1, null), 5);
      return child;
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    const started = Date.now();
    const result = await runAction({ json: true, wait: '30' });
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(1);
    expect(elapsed < 5000).toBeTruthy();
    expect(result.errs.join('\n')).toMatch(/supervisor exited \(code 1\) before the dev server came up/);
    const lastLog = result.logs.at(-1);
    assert(lastLog);
    const facts = JSON.parse(lastLog);
    expect(facts.code).toBe('STIM_SUPERVISOR_EXITED');
    expect(facts.remedy).toMatch(/start` again/);
  });
});

describe('the error contract', () => {
  test('a refusal before anything runs still puts one JSON line on stdout', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    const result = await runAction({ json: true, wait: 'soon' });
    expect(result.exitCode).toBe(1);
    expect(result.logs.length).toBe(1);
    const facts = JSON.parse(result.logs[0] ?? '');
    expect(facts.code).toBe('STIM_BAD_ARG');
    expect(facts.message).toMatch(/Invalid --wait/);
    expect(facts.remedy).toBeTruthy();
  });

  test('without --json a failure keeps stdout free of JSON and names the code', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    const result = await runAction({ wait: 'soon' });
    expect(result.exitCode).toBe(1);
    for (const line of result.logs) expect(() => JSON.parse(line)).toThrow(SyntaxError);
    expect(result.errs.join('\n')).toMatch(/STIM_BAD_ARG/);
  });
});

describe('global workspace storage', () => {
  test('creates ownership metadata under STIM_HOME and never touches .gitignore', async () => {
    const port = 8161;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } }));
    upsertProject(root, { metroPort: port });
    try {
      const result = await runAction({ json: true, wait: '5' });
      expect(result.exitCode).toBe(null);
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
      expect(JSON.parse(readFileSync(workspaceMetadataFile(root), 'utf-8')).projectRoot).toBe(root);
      expect(result.logs.length).toBe(1);
      expect(JSON.parse(result.logs[0] ?? '').port).toBeTruthy();
    } finally {
      server.close();
    }
  });
});

describe('action: the reserved port', () => {
  test('a FOREIGN holder of the reserved port moves the reservation instead of counting as healthy', async () => {
    const port = 8157;
    const server = await metroListener(port);
    const exec = metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID }, cwd: '/somewhere/else' });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: 1, unref() {}, on() {} };
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });

    let result;
    try {
      result = await runAction({ json: true, wait: '1' });
    } finally {
      server.close();
    }

    const project = getProject(root);
    assert(project);
    const reserved = project.metroPort;
    expect(reserved).not.toBe(port);
    expect(result.errs.join('\n')).toMatch(/is held by something else/);
    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn[0]?.args[4]).toBe(String(reserved));
  });

  test('a project with no reservation gets one', async () => {
    const exec = metroExecutor({ listeners: {} });
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      return { pid: 1, unref() {}, on() {} };
    };
    setExecutor(exec);

    const result = await runAction({ json: true, wait: '1' });

    const project = getProject(root);
    assert(project);
    const reserved = project.metroPort;
    expect(typeof reserved).toBe('number');
    expect(exec.calls.spawn[0]?.args[4]).toBe(String(reserved));
    expect(result.exitCode).toBe(1);
  });

  test('an invalid --wait fails before anything is spawned', async () => {
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    const result = await runAction({ json: true, wait: 'soon' });
    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn).toEqual([]);
    expect(result.errs.join('\n')).toMatch(/Invalid --wait/);
  });
});

describe('action: an existing supervisor that is not answering', () => {
  test('waits on the one that exists rather than spawning a second', async () => {
    const port = 8158;
    const exec = metroExecutor({ listeners: {} });
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(supervisorLogFile(root), 'still starting\n');

    const result = await runAction({ json: true, wait: '1' });

    expect(exec.calls.spawn).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.errs.join('\n')).toMatch(/did not serve port 8158/);
    expect(result.errs.join('\n')).toMatch(/stim stop/);
  });

  test('and reports success once that supervisor answers', async () => {
    const port = 8159;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5152' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
    metroListener(port).then((s) => {
      held.server = s;
      exec.listening = true;
      return undefined;
    });

    let result;
    try {
      result = await runAction({ json: true, wait: '10' });
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(null);
    const facts = JSON.parse(result.logs[0] ?? '');
    expect(facts.supervisorPid).toBe(process.pid);
    expect(facts.alreadyRunning).toBe(true);
    expect(exec.calls.spawn).toEqual([]);
  });

  test('a remote start refuses after the local Expo supervisor begins answering without a tunnel', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8167;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5153' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'expo' } } });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });
    metroListener(port).then((server) => {
      held.server = server;
      exec.listening = true;
      return server;
    });

    let result;
    try {
      result = await runAction({ json: true, remote: true, wait: '1' });
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(1);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '').code).toBe('STIM_REMOTE_START_REQUIRED');
    expect(result.errs.join('\n')).toMatch(/stim stop.*stim start --remote/);
  });

  test('a concurrent remote start waits when Metro becomes healthy before the Expo tunnel', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts: { ios: 'expo run:ios' } }));
    const port = 8171;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    const base = exec.runQuiet.bind(exec);
    exec.runQuiet = (cmd) => {
      if (new RegExp(`lsof -nP -iTCP:${port}`).test(cmd)) return exec.listening ? '5154' : '';
      return base(cmd);
    };
    setExecutor(exec);
    upsertProject(root, { metroPort: port, settings: { metro: { tunnel: 'expo' } } });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });
    metroListener(port).then((server) => {
      held.server = server;
      exec.listening = true;
      return server;
    });
    const tunnelWritten = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url: 'exp://concurrent.exp.direct' } });
        resolve();
      }, 1000);
    });

    let result;
    try {
      result = await runAction({ json: true, remote: true, wait: '10' });
      await tunnelWritten;
    } finally {
      held.server?.close();
    }

    expect(result.exitCode).toBe(null);
    expect(exec.calls.spawn).toEqual([]);
    expect(JSON.parse(result.logs[0] ?? '').alreadyRunning).toBe(true);
  });
});

describe('output contract', () => {
  test('without --json every line is human and nothing is JSON', async () => {
    const port = 8160;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } }));
    upsertProject(root, { metroPort: port });
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'expo-child', startedAt: 'T' } });

    let result;
    try {
      result = await runAction({});
    } finally {
      server.close();
    }

    expect(result.exitCode).toBe(null);
    expect(result.logs.join('\n')).toMatch(/OK: dev server on port 8160.* \(\d+m?\d*s\)/);
    expect(result.logs.join('\n')).toMatch(/expo-child/);
    expect(result.logs.join('\n')).toMatch(new RegExp(workspaceLogsDir(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const line of result.logs) {
      expect(() => JSON.parse(line)).toThrow(SyntaxError);
    }
  });
});
