// The supervisor daemon: argument parsing, Contract 2's state files, and the
// lifecycle rules that make a supervisor findable and never silently useless.
//
// The two rules under test, because both are invisible until they are broken:
//   1. the pid file, state.json and the global registration are all written
//      BEFORE the server starts, so a supervisor that dies during startup is
//      still findable;
//   2. every exit path -- signal, failed start, server death -- writes a final
//      record and clears every one of those records.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, upsertProject } from '../src/config.js';
import { parseNdjsonText } from '../src/ndjson.ts';
import { supervisorPidFile, workspaceLogsDir, workspaceStateFile } from '../src/paths.ts';
import { describeError, supervisorError } from '../src/supervisor/errors.js';
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
} from '../src/supervisor/run.js';

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
    assert.deepEqual(parseArgs(['--root', '/abs/path', '--port', '8082']), { root: '/abs/path', port: 8082 });
  });

  test('refuses a relative root: every other path in the supervisor derives from it', () => {
    assert.match(parseArgs(['--root', 'rel', '--port', '8082']).error, /absolute/);
  });

  test('refuses a missing or non-numeric port', () => {
    assert.match(parseArgs(['--root', '/abs']).error, /--port/);
    assert.match(parseArgs(['--root', '/abs', '--port', 'metro']).error, /--port/);
    assert.match(parseArgs(['--root', '/abs', '--port', '70000']).error, /--port/);
  });

  test('refuses an unknown argument rather than ignoring it', () => {
    assert.match(parseArgs(['--root', '/abs', '--port', '1', '--reset-cache']).error, /Unknown/);
  });
});

describe('describeError', () => {
  test('renders a structured error as code, message and remedy', () => {
    const err = supervisorError('RN_ISO_BARE_DEPS', 'metro is not resolvable', 'Run `npm install`.');
    const text = describeError(err);
    assert.match(text, /^RN_ISO_BARE_DEPS: metro is not resolvable/);
    assert.match(text, /Remedy: Run `npm install`\./);
  });

  test('renders a plain error as its message', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError(null), 'unknown error');
  });
});

describe('Contract 2: the workspace state file', () => {
  test('writeWorkspaceState creates .rn-iso/state.json and reads back', () => {
    writeWorkspaceState(root, { supervisor: { pid: 1, port: 8082, mode: MODE_BARE } });
    assert.ok(existsSync(workspaceStateFile(root)));
    assert.equal(readWorkspaceState(root).supervisor.port, 8082);
  });

  test('writing merges rather than replaces, so a later step\'s lastBuild survives', () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' } });
    writeWorkspaceState(root, { supervisor: { pid: 2, port: 8083 } });
    const state = readWorkspaceState(root);
    assert.equal(state.lastBuild.fingerprint, 'abc');
    assert.equal(state.supervisor.pid, 2);
  });

  test('writing leaves no temp file behind: readers must never see a partial state', () => {
    writeWorkspaceState(root, { supervisor: { pid: 3, port: 8084 } });
    const leftovers = existsSync(join(root, '.rn-iso'))
      ? readFileSync(workspaceStateFile(root), 'utf-8')
      : '';
    assert.match(leftovers, /"pid": 3/);
    const dir = join(root, '.rn-iso');
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(entries.filter((e) => e.includes('.tmp-')), []);
  });

  test('an unparseable state file reads as no state instead of throwing', () => {
    writeWorkspaceState(root, { supervisor: { pid: 4, port: 1 } });
    writeFileSync(workspaceStateFile(root), '{ half written');
    assert.equal(readWorkspaceState(root), null);
  });

  test('clearWorkspaceSupervisor removes only the supervisor key', () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' }, supervisor: { pid: 5, port: 1 } });
    clearWorkspaceSupervisor(root);
    const state = readWorkspaceState(root);
    assert.equal(state.supervisor, undefined);
    assert.equal(state.lastBuild.fingerprint, 'abc');
  });

  test('clearWorkspaceSupervisor removes the file when nothing else is in it', () => {
    writeWorkspaceState(root, { supervisor: { pid: 6, port: 1 } });
    clearWorkspaceSupervisor(root);
    assert.equal(existsSync(workspaceStateFile(root)), false);
  });

  test('the pid file round-trips and reads as null when absent', () => {
    assert.equal(readPidFile(root), null);
    writePidFile(root, 4242);
    assert.equal(readFileSync(supervisorPidFile(root), 'utf-8').trim(), '4242');
    assert.equal(readPidFile(root), 4242);
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
    const runUrl = new URL('../src/supervisor/run.js', import.meta.url).href;
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
      await Promise.all(keys.map(key => new Promise((resolve, reject) => {
        execFile(process.execPath, [script, root, key, String(startAt)], { env: { ...process.env, RN_ISO_HOME: tmpHome } },
          (err) => (err ? reject(err) : resolve()));
      })));

      const state = readWorkspaceState(root);
      for (const key of keys) {
        assert.ok(state && state[key], `round ${round}: ${key} must survive concurrent writers (lost update)`);
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

    assert.equal(seenAtStart.pid, process.pid);
    assert.equal(seenAtStart.state.supervisor.port, 8091);
    assert.equal(seenAtStart.state.supervisor.mode, MODE_BARE);
    assert.equal(seenAtStart.config.pid, process.pid);
    assert.equal(seenAtStart.config.port, 8091);
    assert.equal(typeof seenAtStart.state.supervisor.startedAt, 'string');
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
    assert.equal(bareCalled, false);
    assert.equal(running.mode, MODE_EXPO);
    // Contract 2's serverPid: the expo child, recorded once it exists.
    assert.equal(readWorkspaceState(root).supervisor.serverPid, 31337);
    assert.equal(readWorkspaceState(root).supervisor.mode, MODE_EXPO);
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

    assert.equal(server.state.closed, 1);
    assert.deepEqual(exits, [0]);
    assert.equal(existsSync(supervisorPidFile(root)), false, 'pid file must go');
    assert.equal(readWorkspaceState(root), null, 'state.json must go');
    assert.equal(getProject(root)?.supervisor, undefined, 'the global registration must go');
    // The project record itself survives: it carries the device claims.
    assert.ok(getProject(root));

    const records = readMetroLog();
    assert.equal(records.at(0).event, 'supervisor_started');
    assert.equal(records.at(-1).event, 'supervisor_stopped');
    assert.equal(records.at(-1).level, 'info');
    assert.equal(records.at(-1).src, 'metro');
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
    assert.equal(server.state.closed, 1);
    assert.deepEqual(exits, [0]);
  });

  test('a dev server that dies on its own takes the supervisor with it, exit 1', async () => {
    const server = fakeServer();
    const exits = [];
    await runSupervisor({
      root, port: 8095, isExpo: () => false, attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });

    assert.equal(server.state.listeners.length, 1, 'the supervisor must watch the server');
    server.state.listeners[0]({ code: 3, signal: null });
    // The shutdown is async; let it settle.
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(exits, [1]);
    assert.equal(existsSync(supervisorPidFile(root)), false);
    assert.equal(getProject(root)?.supervisor, undefined);
    const last = readMetroLog().at(-1);
    assert.equal(last.event, 'supervisor_stopped');
    assert.equal(last.level, 'error');
    assert.match(last.msg, /exited unexpectedly \(exit code 3\)/);
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

    assert.equal(handle, null);
    assert.deepEqual(exits, [1]);
    assert.equal(existsSync(supervisorPidFile(root)), false);
    assert.equal(readWorkspaceState(root), null);
    assert.equal(getProject(root)?.supervisor, undefined);

    const last = readMetroLog().at(-1);
    assert.equal(last.event, 'supervisor_failed');
    assert.equal(last.level, 'fatal');
    assert.match(last.msg, /RN_ISO_BARE_DEPS/);
    assert.match(last.msg, /Remedy: Run `npm install`\./);
    // stderr is what lands in supervisor.log, which is all `start` can show
    // when the supervisor never comes up. It must not be a bare stack.
    assert.match(stderr.join('\n'), /RN_ISO_BARE_DEPS: metro is not resolvable/);
  });
});
