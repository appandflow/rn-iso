// The collector daemon: argument parsing, Contract 5's registration, and the
// lifecycle -- exercised BY SPAWNING IT FOR REAL against fake `xcrun` / `adb`
// shims on PATH.
//
// Why for real rather than with an injected spawn: the two rules that matter
// here are only observable across a process boundary. The registration has to
// carry the collector's OWN pid (a `stop` that kills the wrong pid is worse
// than one that kills nothing), and the SIGTERM path has to actually run to
// completion inside a dying process. A mocked executor proves neither, and
// CLAUDE.md item 9 says as much about anything that shells out.
//
// No simulator or emulator is touched: the shims are shell scripts that print
// canned lines (taken from the real captures in test/fixtures/) and then
// sleep.
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { parseArgs, readCollectors, registerCollector, runCollector, unregisterCollector } from '../collector/run.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import { makeChildProcess } from './_factories.ts';

const ENTRY = fileURLToPath(new URL('../collector/run.ts', import.meta.url));

// The registration entry readCollectors returns is Record<string, unknown>; this
// structural view lets a test read the two fields it asserts on, matching the
// narrowing the android reattach test already does inline below.
type CollectorEntry = { pid?: number; startedAt?: string };

// A spawned child always has a pid; assert it so process.kill takes a number.
function childPid(child: ChildProcess): number {
  assert(child.pid !== undefined, 'spawned child has no pid');
  return child.pid;
}

let tmpHome: string;
let root: string;
let shimDir: string;
let running: ChildProcess[] = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  root = mkdtempSync(join(tmpdir(), 'rn-iso-ws-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
  shimDir = mkdtempSync(join(tmpdir(), 'rn-iso-shim-'));
  running = [];
});

afterEach(() => {
  for (const child of running) {
    try {
      process.kill(childPid(child), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

function writeShim(name: string, body: string) {
  const file = join(shimDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function spawnCollector(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH}`, RN_ISO_HOME: tmpHome, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  return child;
}

function deviceLog() {
  try {
    return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf-8'));
  } catch {
    return [];
  }
}

function state() {
  try {
    return JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
  } catch {
    return null;
  }
}

async function until<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 15000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
}

describe('parseArgs', () => {
  test('accepts the ios invocation and derives the predicate app name from the bundle id', () => {
    expect(parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U1', '--bundle', 'com.example.MyApp'])).toEqual(
      {
        platform: 'ios',
        root: '/abs',
        udid: 'U1',
        bundleId: 'com.example.MyApp',
        appName: 'MyApp',
        serial: null,
        packageName: null,
      },
    );
  });

  test('an explicit --app-name wins, because the product name is not always the last bundle segment', () => {
    expect(
      parseArgs([
        '--platform',
        'ios',
        '--root',
        '/abs',
        '--udid',
        'U1',
        '--bundle',
        'com.example.app',
        '--app-name',
        'MyApp',
      ]).appName,
    ).toBe('MyApp');
  });

  test('accepts the android invocation', () => {
    const parsed = parseArgs([
      '--platform',
      'android',
      '--root',
      '/abs',
      '--serial',
      'emulator-5554',
      '--package',
      'com.example.app',
    ]);
    expect(parsed.serial).toBe('emulator-5554');
    expect(parsed.packageName).toBe('com.example.app');
  });

  test('refuses a missing or unknown platform, a relative root, and each missing per-platform argument', () => {
    expect(parseArgs([]).error).toMatch(/--platform/);
    expect(parseArgs(['--platform', 'web', '--root', '/abs']).error).toMatch(/--platform/);
    expect(parseArgs(['--platform', 'ios', '--root', 'rel']).error).toMatch(/absolute/);
    expect(parseArgs(['--platform', 'ios', '--root', '/abs']).error).toMatch(/--udid/);
    expect(parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U']).error).toMatch(/--bundle/);
    expect(parseArgs(['--platform', 'android', '--root', '/abs']).error).toMatch(/--serial/);
    expect(parseArgs(['--platform', 'android', '--root', '/abs', '--serial', 'S']).error).toMatch(/--package/);
  });

  test('refuses an unknown argument rather than ignoring it', () => {
    expect(parseArgs(['--platform', 'ios', '--root', '/abs', '--follow']).error).toMatch(/Unknown/);
  });
});

// Contract 5 lives in the SAME state.json the supervisor writes. Each writer
// read-modify-writes, so the test that matters is that a collector's entry
// and exit leave everything that is not its own key alone.
describe('Contract 5: the registration', () => {
  test('registers under collectors.<platform> without disturbing the supervisor record', () => {
    writeWorkspaceState(root, { supervisor: { pid: 123, port: 8082 } });
    registerCollector(root, 'ios', { pid: 999, startedAt: 'now' });
    expect(state().collectors).toEqual({ ios: { pid: 999, startedAt: 'now' } });
    expect(state().supervisor).toEqual({ pid: 123, port: 8082 });
  });

  test('two platforms coexist, and unregistering one leaves the other', () => {
    registerCollector(root, 'ios', { pid: 1, startedAt: 'a' });
    registerCollector(root, 'android', { pid: 2, startedAt: 'b' });
    expect(Object.keys(readCollectors(root)).sort()).toEqual(['android', 'ios']);
    unregisterCollector(root, 'ios');
    expect(readCollectors(root)).toEqual({ android: { pid: 2, startedAt: 'b' } });
  });

  test('the last collector out removes the key entirely rather than leaving an empty object', () => {
    writeWorkspaceState(root, { supervisor: { pid: 123 } });
    registerCollector(root, 'ios', { pid: 1, startedAt: 'a' });
    unregisterCollector(root, 'ios');
    expect('collectors' in state()).toBe(false);
    expect(state().supervisor).toEqual({ pid: 123 });
  });

  test('unregistering a platform that was never registered is a no-op', () => {
    registerCollector(root, 'android', { pid: 2, startedAt: 'b' });
    unregisterCollector(root, 'ios');
    expect(readCollectors(root)).toEqual({ android: { pid: 2, startedAt: 'b' } });
  });
});

// The real captured lines from test/fixtures/ios-log-stream.ndjson, minus the
// banner, so the shim emits exactly what a live `log stream` emits.
function iosShimLines() {
  const text = readFileSync(fileURLToPath(new URL('./fixtures/ios-log-stream.ndjson', import.meta.url)), 'utf-8');
  return text.split('\n').filter((l) => l.startsWith('{'));
}

describe('the ios collector, spawned for real against a fake xcrun', () => {
  test('registers its own pid, writes records, and clears the registration on SIGTERM', async () => {
    const banner = 'Filtering the log data using "processImagePath CONTAINS[c] \\"MyApp\\""';
    writeShim(
      'xcrun',
      [
        // Prove the collector passed the argv logStreamArgs builds.
        `case "$*" in`,
        `  'simctl spawn UDID-1 log stream --style ndjson --predicate processImagePath CONTAINS[c] "MyApp"') ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
        `echo "${banner}" >&2`,
        ...iosShimLines().map((l) => `cat <<'LINE'\n${l}\nLINE`),
        // exec so the shim's pid IS the sleeping process: a SIGTERM at the
        // recorded pid must actually end the stream.
        'exec sleep 30',
      ].join('\n'),
    );

    const child = spawnCollector([
      '--platform',
      'ios',
      '--root',
      root,
      '--udid',
      'UDID-1',
      '--bundle',
      'com.example.MyApp',
    ]);

    const registered = await until(() => readCollectors(root).ios as CollectorEntry, {
      label: 'the collector registration',
    });
    expect(registered.pid).toBe(child.pid);
    expect(registered.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const records = await until(
      () => {
        const r = deviceLog().filter((x) => x.level === 'fatal');
        return r.length ? r : null;
      },
      { label: 'a parsed device record' },
    );
    const first = records[0];
    assert(first);
    expect(first.msg).toMatch(/LocationProvider/);
    expect(first.proc).toBe('locationd');
    const firstLog = deviceLog()[0];
    assert(firstLog);
    expect(firstLog.event).toBe('collector_started');

    process.kill(childPid(child), 'SIGTERM');
    const result = await exited(child);
    expect(result).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
  });

  // The app being killed, the sim being shut down: the stream simply ends.
  // That is the normal end of a collector's life, not a failure -- but it
  // must say so, or `logs` just stops having device lines with no reason.
  test('survives the stream ending: a record, and exit 0', async () => {
    writeShim(
      'xcrun',
      [
        ...iosShimLines()
          .slice(0, 1)
          .map((l) => `cat <<'LINE'\n${l}\nLINE`),
        'exit 0',
      ].join('\n'),
    );

    const child = spawnCollector([
      '--platform',
      'ios',
      '--root',
      root,
      '--udid',
      'UDID-1',
      '--bundle',
      'com.example.MyApp',
    ]);
    const result = await exited(child);
    expect(result.code).toBe(0);
    const stopped = deviceLog().find((r) => r.event === 'collector_stopped');
    expect(stopped).toBeTruthy();
    assert(stopped);
    expect(stopped.msg).toMatch(/device log stream ended/);
    expect('collectors' in (state() || {})).toBe(false);
  });
});

describe('the android collector, spawned for real against a fake adb', () => {
  test('resolves the app pid, filters logcat on it, and cleans up on SIGTERM', async () => {
    writeShim(
      'adb',
      [
        `case "$*" in`,
        // Two-phase: the app "starts" only on the second pidof, so the retry
        // loop is what makes this pass.
        `  '-s emulator-5554 shell pidof -s com.example.app')`,
        `    if [ -f "${join(shimDir, 'started')}" ]; then echo 3132; else touch "${join(shimDir, 'started')}"; fi ;;`,
        `  '-s emulator-5554 logcat --pid 3132 -v time')`,
        `    echo '--------- beginning of main'`,
        `    echo '08-21 17:51:19.507 I/ReactNativeJS(  3132): Running "App" with {"rootTag":11}'`,
        `    echo '08-21 17:51:20.100 E/ReactNativeJS(  3132): TypeError: undefined is not a function'`,
        `    exec sleep 30 ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
      ].join('\n'),
    );

    const child = spawnCollector([
      '--platform',
      'android',
      '--root',
      root,
      '--serial',
      'emulator-5554',
      '--package',
      'com.example.app',
    ]);

    const registered = await until(() => readCollectors(root).android as CollectorEntry, {
      label: 'the android registration',
    });
    expect(registered.pid).toBe(child.pid);

    const errors = await until(
      () => {
        const r = deviceLog().filter((x) => x.level === 'error');
        return r.length ? r : null;
      },
      { label: 'a parsed logcat record' },
    );
    const firstError = errors[0];
    assert(firstError);
    expect(firstError.msg).toMatch(/undefined is not a function/);
    expect(firstError.proc).toBe('ReactNativeJS(3132)');
    // The banner is skipped, not recorded raw.
    expect(deviceLog().some((r) => r.msg?.includes('beginning of main'))).toBe(false);

    process.kill(childPid(child), 'SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
  });

  // Rule 1, at the point where it is load-bearing: the registration is
  // written BEFORE the pid resolves, so a collector still waiting on an app
  // that never starts is findable. An unrecorded process is the one nothing
  // will ever clean up. (The pid-timeout branch itself runs through the seams
  // below -- a suite must not sit through the 30s wait.)
  test('is registered while it is still waiting for the app pid to appear', async () => {
    writeShim('adb', 'exit 1\n');
    const child = spawnCollector([
      '--platform',
      'android',
      '--root',
      root,
      '--serial',
      'emulator-5554',
      '--package',
      'com.example.app',
    ]);
    const registered = await until(() => readCollectors(root).android as CollectorEntry, {
      label: 'the android registration',
    });
    expect(registered.pid).toBe(child.pid);
    expect(deviceLog().some((r) => r.event === 'collector_started')).toBe(false);
    process.kill(childPid(child), 'SIGKILL');
    await exited(child);
  });

  // The other half of the same window: `stop` signals a collector that is
  // still waiting for a pid. At the default disposition that kills the
  // process outright and strands the registration rule 1 just wrote --
  // pointing at a pid nothing will ever clear. So the handlers are attached
  // before the wait, not after the stream starts.
  test('a SIGTERM during the pid wait still clears the registration', async () => {
    writeShim('adb', 'exit 1\n');
    const child = spawnCollector([
      '--platform',
      'android',
      '--root',
      root,
      '--serial',
      'emulator-5554',
      '--package',
      'com.example.app',
    ]);
    await until(() => readCollectors(root).android, { label: 'the android registration' });
    process.kill(childPid(child), 'SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
  });
});

// The pid-timeout path with the seams injected: a 30s wait is not something a
// suite should sit through, and the branch is the same one either way.
describe('runCollector seams', () => {
  test('an app whose pid never appears is an error record, exit 1, and no registration left behind', async () => {
    let code = null;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ failed: true, reason: 'no process appeared' }),
      startStream: () => {
        throw new Error('must not start logcat without a pid');
      },
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    expect(result).toBe(null);
    expect(code).toBe(1);
    const failed = deviceLog().find((r) => r.event === 'collector_failed');
    assert(failed);
    expect(failed.msg).toMatch(/no process appeared/);
    expect(failed.level).toBe('error');
    expect('collectors' in (state() || {})).toBe(false);
  });

  test('a stream that fails to start is an error record rather than a throw', async () => {
    let code = null;
    const result = await runCollector({
      platform: 'ios',
      root,
      udid: 'U1',
      appName: 'MyApp',
      startStream: () => {
        throw new Error('spawn xcrun ENOENT');
      },
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    expect(result).toBe(null);
    expect(code).toBe(1);
    const failed = deviceLog().find((r) => r.event === 'collector_failed');
    assert(failed);
    expect(failed.msg).toMatch(/ENOENT/);
  });
});

// --- rule 3: an app restart is not the end of the collector ----------------
//
// The failure this closes: `--pid` pins logcat to ONE process, so restarting
// the app -- the most common thing anyone does between two log reads -- left
// the collector streaming for a pid that would never write another line.
// Nothing failed, nothing exited, `rn-iso logs --source device` simply had no
// more lines and said nothing about why.
describe('the android collector follows the app across a restart', () => {
  // A fake adb whose `pidof` answers 3132 until a marker file appears and
  // 4200 afterwards -- an app restart, from the only angle the collector can
  // see one. Each logcat prints a line that names its own pid, so the device
  // log says which stream produced what.
  const restartingShim = () =>
    writeShim(
      'adb',
      [
        `case "$*" in`,
        `  '-s emulator-5554 shell pidof -s com.example.app')`,
        `    if [ -f "${join(shimDir, 'restarted')}" ]; then echo 4200; else echo 3132; fi ;;`,
        `  '-s emulator-5554 logcat --pid 3132 -v time')`,
        `    echo '08-21 17:51:19.507 I/ReactNativeJS(  3132): before the restart'`,
        `    exec sleep 30 ;;`,
        `  '-s emulator-5554 logcat --pid 4200 -v time')`,
        `    echo '08-21 17:51:29.507 I/ReactNativeJS(  4200): after the restart'`,
        `    exec sleep 30 ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
      ].join('\n'),
    );

  test('a new pid reattaches the stream, with a record saying so', async () => {
    restartingShim();
    const child = spawnCollector(
      ['--platform', 'android', '--root', root, '--serial', 'emulator-5554', '--package', 'com.example.app'],
      // The real watch is every 3s; a suite must not sit through it.
      { RN_ISO_PID_WATCH_MS: '100' },
    );
    await until(() => deviceLog().some((r) => /before the restart/.test(r.msg || '')), { label: 'the first stream' });

    writeFileSync(join(shimDir, 'restarted'), '');

    const reattached = await until(() => deviceLog().find((r) => r.event === 'collector_reattached'), {
      label: 'the reattach record',
    });
    expect(reattached.msg).toMatch(/pid 4200/);
    expect(reattached.msg).toMatch(/was 3132/);
    await until(() => deviceLog().some((r) => /after the restart/.test(r.msg || '')), { label: 'the second stream' });

    // Still one collector, still registered under this pid, still alive: a
    // restart is not an exit.
    expect((readCollectors(root).android as { pid?: number }).pid).toBe(child.pid);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBe(false);

    process.kill(childPid(child), 'SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
  });

  test('the same pid, poll after poll, changes nothing', async () => {
    writeShim(
      'adb',
      [
        `case "$*" in`,
        `  '-s emulator-5554 shell pidof -s com.example.app') echo 3132 ;;`,
        `  '-s emulator-5554 logcat --pid 3132 -v time')`,
        `    echo '08-21 17:51:19.507 I/ReactNativeJS(  3132): steady'`,
        `    exec sleep 30 ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
      ].join('\n'),
    );
    const child = spawnCollector(
      ['--platform', 'android', '--root', root, '--serial', 'emulator-5554', '--package', 'com.example.app'],
      { RN_ISO_PID_WATCH_MS: '50' },
    );
    await until(() => deviceLog().some((r) => /steady/.test(r.msg || '')), { label: 'the stream' });
    await new Promise((r) => setTimeout(r, 400)); // several polls
    expect(deviceLog().filter((r) => r.event === 'collector_reattached').length).toBe(0);
    process.kill(childPid(child), 'SIGKILL');
    await exited(child);
  });
});

// The same rule through the seams, where the edges are reachable: a stream
// that ends on its own while the app is back under a new pid, and a watcher
// that must not outlive the collector.
describe('runCollector reattach seams', () => {
  // startStream hands back the stream pid, typed `number | null` on the seam;
  // at runtime it is always the resolved number, so a null collapses to undefined.
  const fakeChild = (pid: number | null | undefined) => makeChildProcess({ pid: pid ?? undefined });

  test('a stream that ends while the app is back under a new pid reattaches instead of exiting', async () => {
    const started: ChildProcess[] = [];
    let pid = 3132;
    let code = null;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      pidOf: () => pid,
      // Long enough that the timer never fires: the exit probe is the path
      // under test.
      pidWatchMs: 60000,
      startStream: ({ pid: streamPid }) => {
        const c = fakeChild(streamPid);
        started.push(c);
        return c;
      },
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    expect(started.map((c) => c.pid)).toEqual([3132]);

    pid = 4200;
    const firstStarted = started[0];
    assert(firstStarted);
    firstStarted.emit('exit', 0, null);

    expect(started.map((c) => c.pid)).toEqual([3132, 4200]);
    expect(code).toBe(null);
    expect(deviceLog().some((r) => r.event === 'collector_reattached')).toBeTruthy();
    assert(result);
    result.finish(0, 'info', 'done', 'collector_stopped');
  });

  test('a stream that ends with no app left is still the end of the collector', async () => {
    let code = null;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      pidOf: () => null,
      pidWatchMs: 60000,
      startStream: ({ pid: streamPid }) => fakeChild(streamPid),
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    assert(result?.child);
    result.child.emit('exit', 0, null);
    expect(code).toBe(0);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
    expect('collectors' in (state() || {})).toBe(false);
  });

  test('finish() stops the watcher, or the collector process never exits', async () => {
    const timers = { set: 0, cleared: 0 };
    let stopped = false;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      startStream: ({ pid }) => fakeChild(pid),
      watchPid: () => ({
        stop: () => {
          stopped = true;
          timers.cleared++;
        },
        probe: () => null,
        pid: 3132,
      }),
      attachSignals: false,
      onExit: () => {},
    });
    expect(result).toBeTruthy();
    assert(result);
    result.finish(0, 'info', 'done', 'collector_stopped');
    expect(stopped).toBe(true);
  });
});
