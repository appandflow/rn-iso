// `rn-iso start`.
//
// The behaviours pinned here are the ones an agent loop depends on:
//   - idempotence: a healthy dev server on the reserved port is a no-op exit 0,
//     never a second bundler;
//   - honesty about who is serving: a dev server the agent started itself is
//     reported with supervisor null rather than fought;
//   - identity: health is resolveProjectMetro, so a FOREIGN listener on the
//     reserved port moves the reservation instead of counting as success;
//   - a failure prints the supervisor log's tail and its path, not a stack.
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getProject, upsertProject } from '../config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import {
  liveSupervisor,
  parseWait,
  readLogTail,
  failureEvidence,
  registerStart,
  startFacts,
  supervisorEntry,
  tailLines,
} from '../commands/start.ts';
import { asProcessExit } from './_factories.ts';

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  // realpath: findProjectRoot canonicalizes, and on macOS /var is a symlink
  // to /private/var, so an uncanonicalized root registers under a different key
  // than the command computes.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// The action callback commander invokes: `(opts)`.
type ActionFn = (opts: Record<string, unknown>) => void | Promise<void>;

// The subset of commander's Command that registerStart chains off of. A real
// Command is assignable to this, so `stub as Command` is a plain widening cast
// (no `as unknown` needed) that lets the stub stand in for the real object.
interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

// The same commander stub the other command tests use.
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

// The child `start` spawns and then wires listeners onto: a minimal stand-in
// for the ChildProcess `getExecutor().spawn` returns. `on` carries the
// (event, cb) shape so a test can drive the 'exit' listener.
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
  spawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildStub;
}

// resolveProjectMetro asks lsof who listens, probes /status for real, then
// reads that pid's cwd and process group. This mock answers the three shell
// calls; the /status half is a real listener started by the test.
// The mocked listener's pid must be one that CANNOT exist: metro.ts resolves a
// listener's identity through processCwd, which on Linux reads /proc/<pid>/cwd
// FIRST and only falls back to the lsof this mock intercepts. A plausible pid
// (4242) sometimes exists on a CI runner, whose real cwd is not this project --
// the dev server then reads as someone else's and `start` fails, which is
// exactly how this suite flaked twice on ubuntu and never once on macOS.
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
    spawn(cmd, args, opts) {
      calls.spawn.push({ cmd, args, opts });
      return spawnResult || { pid: 4242, unref() {}, on() {} };
    },
  };
}

// Every listener is registered for teardown: one left open by a test whose
// assertion failed first would keep the test runner's process alive.
const openServers: Server[] = [];

function metroListener(port: number): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('packager-status:running');
  });
  openServers.push(server);
  return new Promise<Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function runAction(opts: Record<string, unknown>) {
  const run = captureAction(registerStart);
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
        logsDir: '/w/.rn-iso/logs',
        alreadyRunning: false,
      }),
    ).toEqual({ port: 8082, supervisorPid: 91, mode: 'expo-child', logsDir: '/w/.rn-iso/logs', alreadyRunning: false });
  });

  test('a dev server rn-iso did not start reports a null supervisor rather than a lie', () => {
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
    const logsDir = join(root, '.rn-iso', 'logs');
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
    const logsDir = join(root, '.rn-iso', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'supervisor.log');
    writeFileSync(logFile, 'Error: Cannot find module expo\n');
    const lines = failureEvidence({ logFile, logsDir, sinceTs: 0 });
    expect(lines[0]).toBe('Error: Cannot find module expo');
    expect(lines[1]).toBe(`Supervisor log: ${logFile}`);
  });

  test('falls back to any-level records from this attempt when nothing reached error level (#30)', () => {
    const logsDir = join(root, '.rn-iso', 'logs');
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
    expect(lines.at(-1)).toBe('Full records: `rn-iso logs`');
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
    // A pid that is definitely alive: this test process.
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
    expect(result.errs.join('\n')).toMatch(/started outside rn-iso/);
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
});

describe('action: spawning the supervisor', () => {
  test('spawns node run.js --root --port detached, with stdio into supervisor.log, and waits for health', async () => {
    const port = 8154;
    const exec = metroExecutor({ listeners: {} });
    const held: { server: Server | null } = { server: null };
    // The fake supervisor: spawning it is what makes the port answer, exactly
    // as the real one does.
    exec.spawn = (cmd, args, opts) => {
      exec.calls.spawn.push({ cmd, args, opts });
      // The real supervisor records itself and then serves; both are faked
      // here, and the pid has to be a live one or `start` correctly concludes
      // the supervisor is already gone.
      writeWorkspaceState(root, { supervisor: { pid: process.pid, port, mode: 'bare-inproc', startedAt: 'T' } });
      metroListener(port).then((s) => {
        held.server = s;
        exec.listening = true;
        return undefined;
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

  test('a supervisor that never answers exits 1 with the log tail and the log path', async () => {
    const port = 8155;
    const exec = metroExecutor({ listeners: {} });
    // A live pid, so this is the genuine "still running, not serving" timeout
    // rather than the "already dead" path tested below.
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
        'rn-iso supervisor: failed to start the bare-inproc dev server: RN_ISO_BARE_DEPS: metro is not resolvable',
      ].join('\n'),
    );

    const result = await runAction({ json: true, wait: '1' });

    expect(result.exitCode).toBe(1);
    // The error contract, not an empty stdout. A caller doing
    // `facts=$(rn-iso start --json)` got an empty string on every failure and
    // had to scrape stderr prose, which `guide facts` promises it never has to.
    expect(result.logs.length).toBe(1);
    expect(JSON.parse(result.logs[0] ?? '')).toEqual({
      code: 'RN_ISO_METRO_TIMEOUT',
      message: 'The dev server did not answer on port 8155 within 1s.',
      remedy: 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.',
    });
    const stderr = result.errs.join('\n');
    expect(stderr).toMatch(/did not answer on port 8155 within 1s/);
    expect(stderr).toMatch(/RN_ISO_BARE_DEPS/);
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
      // Dead before the first poll.
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
    // A supervisor that DIED and one that is merely slow need different next
    // steps, so they carry different codes rather than one generic failure.
    const lastLog = result.logs.at(-1);
    assert(lastLog);
    const facts = JSON.parse(lastLog);
    expect(facts.code).toBe('RN_ISO_SUPERVISOR_EXITED');
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
    expect(facts.code).toBe('RN_ISO_BAD_ARG');
    expect(facts.message).toMatch(/Invalid --wait/);
    expect(facts.remedy).toBeTruthy();
  });

  test('without --json a failure keeps stdout free of JSON and names the code', async () => {
    setExecutor(metroExecutor({ listeners: {} }));
    const result = await runAction({ wait: 'soon' });
    expect(result.exitCode).toBe(1);
    for (const line of result.logs) expect(() => JSON.parse(line)).toThrow(SyntaxError);
    expect(result.errs.join('\n')).toMatch(/RN_ISO_BAD_ARG/);
  });
});

// `.rn-iso/` used to be gitignored by `rn-iso init`, which made it a step a
// repo had to remember before its first build -- and forgetting it dead-ended
// `worktree remove` on `?? .rn-iso/`. `start` is the first command of the loop,
// so it ensures the entry itself.
describe('the workspace gitignore', () => {
  test('adds the entry on a repo that has none, and says so once on stderr', async () => {
    const port = 8161;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } }));
    upsertProject(root, { metroPort: port });
    try {
      const result = await runAction({ json: true, wait: '5' });
      expect(result.exitCode).toBe(null);
      const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
      expect(gitignore).toMatch(/^\.rn-iso\/$/m);
      const notes = result.errs.filter((l) => /added \.rn-iso\/ to \.gitignore/.test(l));
      expect(notes.length).toBe(1);
      expect(notes[0]).toMatch(/note {3}added/);
      // The note is stderr, never the --json payload's line.
      expect(result.logs.length).toBe(1);
      expect(JSON.parse(result.logs[0] ?? '').port).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('a repo that already ignores it is left alone and says nothing', async () => {
    const port = 8162;
    const server = await metroListener(port);
    setExecutor(metroExecutor({ listeners: { [port]: DEAD_LISTENER_PID } }));
    upsertProject(root, { metroPort: port });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n/.rn-iso\n');
    try {
      const result = await runAction({ json: true, wait: '5' });
      expect(result.exitCode).toBe(null);
      expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('node_modules\n/.rn-iso\n');
      expect(result.errs.filter((l) => /gitignore/.test(l))).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('action: the reserved port', () => {
  test('a FOREIGN holder of the reserved port moves the reservation instead of counting as healthy', async () => {
    const port = 8157;
    const server = await metroListener(port);
    // Answers /status, but runs from somewhere else: not this project's.
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
    // It then tries to start on the new port, and fails to come up within 1s.
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
    expect(result.errs.join('\n')).toMatch(/rn-iso stop/);
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
    // The OK line carries the total wait, in formatDuration's shape.
    expect(result.logs.join('\n')).toMatch(/OK: dev server on port 8160.* \(\d+m?\d*s\)/);
    expect(result.logs.join('\n')).toMatch(/expo-child/);
    expect(result.logs.join('\n')).toMatch(new RegExp(workspaceLogsDir(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const line of result.logs) {
      expect(() => JSON.parse(line)).toThrow(SyntaxError);
    }
  });
});
