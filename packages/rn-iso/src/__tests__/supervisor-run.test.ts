// The supervisor daemon: argument parsing, Contract 2's state files, and the
// lifecycle rules that make a supervisor findable and never silently useless.
//
// The two rules under test, because both are invisible until they are broken:
//   1. the pid file, state.json and the global registration are all written
//      BEFORE the server starts, so a supervisor that dies during startup is
//      still findable;
//   2. every exit path -- signal, failed start, server death -- writes a final
//      record and clears every one of those records.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { supervisorPidFile, workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { describeError, supervisorError } from '../supervisor/errors.ts';
import {
  MODE_BARE,
  MODE_EXPO,
  clearWorkspaceSupervisor,
  parseArgs,
  readPidFile,
  readWorkspaceState,
  runSupervisor,
  writePidFile,
  writeWorkspaceState,
} from '../supervisor/run.ts';

let tmpHome;
let root;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  root = mkdtempSync(join(tmpdir(), 'rn-iso-ws-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

function readMetroLog() {
  try {
    return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf-8'));
  } catch {
    return [];
  }
}

describe('parseArgs', () => {
  test('accepts --root and --port', () => {
    expect(parseArgs(['--root', '/abs/path', '--port', '8082'])).toEqual({ root: '/abs/path', port: 8082 });
  });

  test('refuses a relative root: every other path in the supervisor derives from it', () => {
    expect(parseArgs(['--root', 'rel', '--port', '8082']).error).toMatch(/absolute/);
  });

  test('refuses a missing or non-numeric port', () => {
    expect(parseArgs(['--root', '/abs']).error).toMatch(/--port/);
    expect(parseArgs(['--root', '/abs', '--port', 'metro']).error).toMatch(/--port/);
    expect(parseArgs(['--root', '/abs', '--port', '70000']).error).toMatch(/--port/);
  });

  test('refuses an unknown argument rather than ignoring it', () => {
    expect(parseArgs(['--root', '/abs', '--port', '1', '--reset-cache']).error).toMatch(/Unknown/);
  });
});

describe('describeError', () => {
  test('renders a structured error as code, message and remedy', () => {
    const err = supervisorError('RN_ISO_BARE_DEPS', 'metro is not resolvable', 'Run `npm install`.');
    const text = describeError(err);
    expect(text).toMatch(/^RN_ISO_BARE_DEPS: metro is not resolvable/);
    expect(text).toMatch(/Remedy: Run `npm install`\./);
  });

  test('renders a plain error as its message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(null)).toBe('unknown error');
  });
});

describe('Contract 2: the workspace state file', () => {
  test('writeWorkspaceState creates .rn-iso/state.json and reads back', () => {
    writeWorkspaceState(root, { supervisor: { pid: 1, port: 8082, mode: MODE_BARE } });
    expect(existsSync(workspaceStateFile(root))).toBeTruthy();
    expect(readWorkspaceState(root).supervisor.port).toBe(8082);
  });

  test('writing merges rather than replaces, so a later step\'s lastBuild survives', () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' } });
    writeWorkspaceState(root, { supervisor: { pid: 2, port: 8083 } });
    const state = readWorkspaceState(root);
    expect(state.lastBuild.fingerprint).toBe('abc');
    expect(state.supervisor.pid).toBe(2);
  });

  test('writing leaves no temp file behind: readers must never see a partial state', () => {
    writeWorkspaceState(root, { supervisor: { pid: 3, port: 8084 } });
    const leftovers = existsSync(join(root, '.rn-iso'))
      ? readFileSync(workspaceStateFile(root), 'utf-8')
      : '';
    expect(leftovers).toMatch(/"pid": 3/);
    const dir = join(root, '.rn-iso');
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  test('an unparseable state file reads as no state instead of throwing', () => {
    writeWorkspaceState(root, { supervisor: { pid: 4, port: 1 } });
    writeFileSync(workspaceStateFile(root), '{ half written');
    expect(readWorkspaceState(root)).toBe(null);
  });

  test('clearWorkspaceSupervisor removes only the supervisor key', () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' }, supervisor: { pid: 5, port: 1 } });
    clearWorkspaceSupervisor(root);
    const state = readWorkspaceState(root);
    expect(state.supervisor).toBe(undefined);
    expect(state.lastBuild.fingerprint).toBe('abc');
  });

  test('clearWorkspaceSupervisor removes the file when nothing else is in it', () => {
    writeWorkspaceState(root, { supervisor: { pid: 6, port: 1 } });
    clearWorkspaceSupervisor(root);
    expect(existsSync(workspaceStateFile(root))).toBe(false);
  });

  test('the pid file round-trips and reads as null when absent', () => {
    expect(readPidFile(root)).toBe(null);
    writePidFile(root, 4242);
    expect(readFileSync(supervisorPidFile(root), 'utf-8').trim()).toBe('4242');
    expect(readPidFile(root)).toBe(4242);
  });
});

// state.json is a multi-writer read-modify-write: the supervisor writes
// `supervisor`, each collector writes its own `collectors.<platform>`, and
// `ios`/`android` write `lastBuild`. renameSync stops a reader ever seeing half
// a file, but it does NOT stop a LOST UPDATE: two writers that both read the
// old state and then rename their own version over it silently drop one side's
// key. Losing `collectors.<platform>` leaks a log stream `stop` can never reap.
// Every writer goes through writeWorkspaceState, so a lock there is what makes
// the whole cycle atomic. This is the live proof, cross-process on purpose:
// several real processes writing different keys against one file at once, every
// key must survive.
describe('state.json concurrent writers (Contract 2 lock)', () => {
  test('4+ processes writing different keys never lose an update', async () => {
    const script = join(tmpHome, 'state-writer.mjs');
    const runUrl = new URL('../supervisor/run.ts', import.meta.url).href;
    writeFileSync(script, [
      `const { writeWorkspaceState } = await import(${JSON.stringify(runUrl)});`,
      'const root = process.argv[2];',
      'const key = process.argv[3];',
      'const startAt = Number(process.argv[4]);',
      // A shared start instant so every process does its single read-modify-write
      // at the same moment -- process startup otherwise dominates and the
      // writers never overlap. One-shot writes are the faithful reproduction:
      // the real supervisor, collector and ios/android writers each patch their
      // own key ONCE, so whichever renames last silently drops every key it did
      // not happen to read (the lost update renameSync cannot prevent).
      'while (Date.now() < startAt) {}',
      'writeWorkspaceState(root, { [key]: { pid: process.pid } });',
    ].join('\n'));

    const keys = ['supervisor', 'lastBuild', 'collectorsIos', 'collectorsAndroid', 'extra', 'sixth', 'seventh', 'eighth'];
    // Repeated rounds: a single simultaneous volley loses a key often but not
    // every time, so the assertion is over several volleys -- an unlocked
    // writer drops a key in at least one, a locked one never does.
    for (let round = 0; round < 8; round++) {
      mkdirSync(join(root, '.rn-iso'), { recursive: true });
      writeFileSync(workspaceStateFile(root), '{}\n');
      const startAt = Date.now() + 250;
      await Promise.all(keys.map(key => new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [script, root, key, String(startAt)], { env: { ...process.env, RN_ISO_HOME: tmpHome } },
          (err) => (err ? reject(err) : resolve()));
      })));

      const state = readWorkspaceState(root);
      for (const key of keys) {
        expect(state && state[key]).toBeTruthy();
      }
    }
  });
});

describe('runSupervisor', () => {
  function fakeServer(overrides = {}) {
    const state = { closed: 0, listeners: [] };
    return {
      state,
      handle: {
        mode: MODE_BARE,
        serverPid: null,
        onExit(cb) { state.listeners.push(cb); },
        async close() { state.closed += 1; },
        ...overrides,
      },
    };
  }

  test('records the supervisor BEFORE the server starts', async () => {
    let seenAtStart = null;
    const server = fakeServer();
    await runSupervisor({
      root,
      port: 8091,
      isExpo: () => false,
      attachSignals: false,
      onExit: () => {},
      startBare: async () => {
        // The crash-safety rule: everything that makes this process findable
        // exists by the time the server is asked to start.
        seenAtStart = {
          pid: readPidFile(root),
          state: readWorkspaceState(root),
          config: getProject(root)?.supervisor ?? null,
        };
        return server.handle;
      },
    });

    expect(seenAtStart.pid).toBe(process.pid);
    expect(seenAtStart.state.supervisor.port).toBe(8091);
    expect(seenAtStart.state.supervisor.mode).toBe(MODE_BARE);
    expect(seenAtStart.config.pid).toBe(process.pid);
    expect(seenAtStart.config.port).toBe(8091);
    expect(typeof seenAtStart.state.supervisor.startedAt).toBe('string');
  });

  test('detects the ecosystem and hosts Expo as a child', async () => {
    const server = fakeServer({ mode: MODE_EXPO, serverPid: 31337 });
    let bareCalled = false;
    const running = await runSupervisor({
      root,
      port: 8092,
      isExpo: () => true,
      attachSignals: false,
      onExit: () => {},
      startBare: async () => { bareCalled = true; return server.handle; },
      startExpo: async () => server.handle,
    });
    expect(bareCalled).toBe(false);
    expect(running.mode).toBe(MODE_EXPO);
    // Contract 2's serverPid: the expo child, recorded once it exists.
    expect(readWorkspaceState(root).supervisor.serverPid).toBe(31337);
    expect(readWorkspaceState(root).supervisor.mode).toBe(MODE_EXPO);
  });

  test('SIGTERM-shaped shutdown closes the server, writes a final record and clears every registration', async () => {
    upsertProject(root, { bundleId: null, androidPackage: null, isExpo: false });
    const server = fakeServer();
    const exits = [];
    const running = await runSupervisor({
      root,
      port: 8093,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });

    await running.shutdown(0, 'supervisor_stopped', 'received SIGTERM; stopping the dev server');

    expect(server.state.closed).toBe(1);
    expect(exits).toEqual([0]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(readWorkspaceState(root)).toBe(null);
    expect(getProject(root)?.supervisor).toBe(undefined);
    // The project record itself survives: it carries the device claims.
    expect(getProject(root)).toBeTruthy();

    const records = readMetroLog();
    expect(records.at(0).event).toBe('supervisor_started');
    expect(records.at(-1).event).toBe('supervisor_stopped');
    expect(records.at(-1).level).toBe('info');
    expect(records.at(-1).src).toBe('metro');
  });

  test('a second shutdown is a no-op: the server is closed once', async () => {
    const server = fakeServer();
    const exits = [];
    const running = await runSupervisor({
      root, port: 8094, isExpo: () => false, attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });
    await running.shutdown(0, 'supervisor_stopped', 'first');
    await running.shutdown(0, 'supervisor_stopped', 'second');
    expect(server.state.closed).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('a dev server that dies on its own takes the supervisor with it, exit 1', async () => {
    const server = fakeServer();
    const exits = [];
    await runSupervisor({
      root, port: 8095, isExpo: () => false, attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });

    expect(server.state.listeners.length).toBe(1);
    server.state.listeners[0]({ code: 3, signal: null });
    // The shutdown is async; let it settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(exits).toEqual([1]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(getProject(root)?.supervisor).toBe(undefined);
    const last = readMetroLog().at(-1);
    expect(last.event).toBe('supervisor_stopped');
    expect(last.level).toBe('error');
    expect(last.msg).toMatch(/exited unexpectedly \(exit code 3\)/);
  });

  test('a server that fails to start leaves no registration and exits 1 with the structured error', async () => {
    const exits = [];
    const stderr = [];
    const handle = await runSupervisor({
      root, port: 8096, isExpo: () => false, attachSignals: false,
      onExit: (code) => exits.push(code),
      stderr: (line) => stderr.push(line),
      startBare: async () => {
        throw supervisorError('RN_ISO_BARE_DEPS', 'metro is not resolvable from the project', 'Run `npm install`.');
      },
    });

    expect(handle).toBe(null);
    expect(exits).toEqual([1]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(readWorkspaceState(root)).toBe(null);
    expect(getProject(root)?.supervisor).toBe(undefined);

    const last = readMetroLog().at(-1);
    expect(last.event).toBe('supervisor_failed');
    expect(last.level).toBe('fatal');
    expect(last.msg).toMatch(/RN_ISO_BARE_DEPS/);
    expect(last.msg).toMatch(/Remedy: Run `npm install`\./);
    // stderr is what lands in supervisor.log, which is all `start` can show
    // when the supervisor never comes up. It must not be a bare stack.
    expect(stderr.join('\n')).toMatch(/RN_ISO_BARE_DEPS: metro is not resolvable/);
  });
});
