import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { parseArgs, readCollectors, registerCollector, runCollector, unregisterCollector } from '../collector/run.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import { makeChildProcess } from './_factories.ts';

const ENTRY = fileURLToPath(new URL('../collector/run.ts', import.meta.url));

type CollectorEntry = { pid?: number; startedAt?: string };

function childPid(child: ChildProcess): number {
  assert(child.pid !== undefined, 'spawned child has no pid');
  return child.pid;
}

let tmpHome: string;
let root: string;
let shimDir: string;
let running: ChildProcess[] = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
  shimDir = mkdtempSync(join(tmpdir(), 'stim-shim-'));
  running = [];
});

afterEach(() => {
  for (const child of running) {
    try {
      process.kill(childPid(child), 'SIGKILL');
    } catch {}
  }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function writeShim(name: string, body: string) {
  const file = join(shimDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function spawnCollector(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH}`, STIM_HOME: tmpHome, ...env },
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
        physical: false,
        payloadUrl: null,
      },
    );
  });

  test('--physical selects the devicectl console; it needs the bundle id, not the app name', () => {
    expect(
      parseArgs([
        '--platform',
        'ios',
        '--root',
        '/abs',
        '--udid',
        'U1',
        '--bundle',
        'com.example.MyApp',
        '--physical',
        '--payload-url',
        'stim://x',
      ]),
    ).toEqual({
      platform: 'ios',
      root: '/abs',
      udid: 'U1',
      bundleId: 'com.example.MyApp',
      appName: 'MyApp',
      serial: null,
      packageName: null,
      physical: true,
      payloadUrl: 'stim://x',
    });
  });

  test('--physical is refused on android, and --payload-url without it', () => {
    expect(
      parseArgs(['--platform', 'android', '--root', '/abs', '--serial', 'S', '--package', 'com.x', '--physical']).error,
    ).toMatch(/--physical is an iOS option/);
    expect(
      parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U1', '--bundle', 'com.x', '--payload-url', 'u'])
        .error,
    ).toMatch(/--payload-url only applies to --physical/);
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
    expect(Object.keys(readCollectors(root)).toSorted()).toEqual(['android', 'ios']);
    unregisterCollector(root, 'ios', 1);
    expect(readCollectors(root)).toEqual({ android: { pid: 2, startedAt: 'b' } });
  });

  test('the last collector out removes the key entirely rather than leaving an empty object', () => {
    writeWorkspaceState(root, { supervisor: { pid: 123 } });
    registerCollector(root, 'ios', { pid: 1, startedAt: 'a' });
    unregisterCollector(root, 'ios', 1);
    expect('collectors' in state()).toBe(false);
    expect(state().supervisor).toEqual({ pid: 123 });
  });

  test('unregistering a platform that was never registered is a no-op', () => {
    registerCollector(root, 'android', { pid: 2, startedAt: 'b' });
    unregisterCollector(root, 'ios', 999);
    expect(readCollectors(root)).toEqual({ android: { pid: 2, startedAt: 'b' } });
  });

  test('a stale unregister from a replaced collector does not clobber the newer registration', () => {
    // #182: a replaced collector (proven unverified) is left running instead of signalled, so
    // it can still reach its own finish() -> unregisterCollector after a newer collector has
    // registered over the same platform key. Its own pid must not match the current record.
    registerCollector(root, 'ios', { pid: 1, startedAt: 'a' });
    registerCollector(root, 'ios', { pid: 2, startedAt: 'b' });
    unregisterCollector(root, 'ios', 1);
    expect(readCollectors(root)).toEqual({ ios: { pid: 2, startedAt: 'b' } });
  });
});

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
        `case "$*" in`,
        `  'simctl spawn UDID-1 log stream --style ndjson --predicate processImagePath CONTAINS[c] "MyApp"') ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
        `echo "${banner}" >&2`,
        ...iosShimLines().map((l) => `cat <<'LINE'\n${l}\nLINE`),
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
    expect(first.platform).toBe('ios');
    const firstLog = deviceLog()[0];
    assert(firstLog);
    expect(firstLog.event).toBe('collector_started');
    expect(firstLog.platform).toBe('ios');

    process.kill(childPid(child), 'SIGTERM');
    const result = await exited(child);
    expect(result).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
  });

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

describe('the ios device collector, spawned for real against a fake devicectl', () => {
  const consoleLines = () =>
    readFileSync(fileURLToPath(new URL('./fixtures/ios-device-console.txt', import.meta.url)), 'utf-8')
      .split('\n')
      .filter((l) => l !== '');

  test('launches the app itself, parses BOTH streams, and clears the registration on SIGTERM', async () => {
    const expected =
      'devicectl device process launch --quiet --device UDID-1 --console --terminate-existing ' +
      '--environment-variables {"OS_ACTIVITY_DT_MODE":"enable"} --payload-url stim://open com.example.MyApp';
    writeShim(
      'xcrun',
      [
        `case "$*" in`,
        `  '${expected}') ;;`,
        `  *) echo "unexpected argv: $*" >&2; exit 9 ;;`,
        `esac`,
        `echo 'a raw stdout write'`,
        ...consoleLines().map((l) => `cat >&2 <<'LINE'\n${l}\nLINE`),
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
      '--physical',
      '--payload-url',
      'stim://open',
    ]);

    const registered = await until(() => readCollectors(root).ios as CollectorEntry, {
      label: 'the device collector registration',
    });
    expect(registered.pid).toBe(child.pid);

    const fatals = await until(
      () => {
        const r = deviceLog().filter((x) => x.level === 'fatal');
        return r.length ? r : null;
      },
      { label: 'the crash record from the app stderr' },
    );
    const crash = fatals[0];
    assert(crash);
    expect(crash.msg).toMatch(/Terminating app due to uncaught exception/);
    expect(crash.proc).toBe('StimFixture(431)');
    expect(crash.platform).toBe('ios');
    expect(crash.raw).toBe(true);

    const log = deviceLog();
    const started = log[0];
    assert(started);
    expect(started.event).toBe('collector_started');
    expect(started.msg).toMatch(/launching com\.example\.MyApp on iPhone UDID-1/);
    expect(started.msg).toMatch(/subsystem, category and severity are not carried on hardware/);
    expect(log.some((r) => r.msg === 'a raw stdout write')).toBeTruthy();
    expect(log.some((r) => r.category === 'javascript' && r.msg === 'counter is 1')).toBeTruthy();
    expect(log.some((r) => r.event === 'collector_stderr')).toBe(false);

    expect(verifyCollectorOwnership({ pid: childPid(child), platform: 'ios', root })).toEqual({ status: 'ours' });

    process.kill(childPid(child), 'SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
    expect(deviceLog().some((r) => r.event === 'collector_empty')).toBe(false);
  });

  test('a devicectl refusal is a failure, not a silent empty section', async () => {
    writeShim('xcrun', ['echo "ERROR: The specified device was not found. (Name: UDID-1)" >&2', 'exit 1'].join('\n'));
    const child = spawnCollector([
      '--platform',
      'ios',
      '--root',
      root,
      '--udid',
      'UDID-1',
      '--bundle',
      'com.example.MyApp',
      '--physical',
    ]);
    expect((await exited(child)).code).toBe(1);
    const log = deviceLog();
    expect(
      log.some((r) => r.level === 'error' && String(r.msg).startsWith('ERROR: The specified device')),
    ).toBeTruthy();
    const empty = log.find((r) => r.event === 'collector_empty');
    expect(empty).toBeFalsy();
    const failed = log.find((r) => r.event === 'collector_failed');
    assert(failed);
    expect(failed.level).toBe('error');
    expect(failed.msg).toMatch(/the devicectl console ended with exit code 1/);
    expect('collectors' in (state() || {})).toBe(false);
  });

  test('a clean launch that produced no console output says so rather than reading as a pass', async () => {
    writeShim('xcrun', 'exit 0\n');
    const child = spawnCollector([
      '--platform',
      'ios',
      '--root',
      root,
      '--udid',
      'UDID-1',
      '--bundle',
      'com.example.MyApp',
      '--physical',
    ]);
    expect((await exited(child)).code).toBe(0);
    const empty = deviceLog().find((r) => r.event === 'collector_empty');
    assert(empty);
    expect(empty.level).toBe('warn');
    expect(empty.msg).toMatch(/devicectl only connects the app's streams when it starts the app/);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
  });
});

describe('the android collector, spawned for real against a fake adb', () => {
  test('resolves the app pid, filters logcat on it, and cleans up on SIGTERM', async () => {
    writeShim(
      'adb',
      [
        `case "$*" in`,
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
    expect(deviceLog().some((r) => r.msg?.includes('beginning of main'))).toBe(false);

    process.kill(childPid(child), 'SIGTERM');
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect('collectors' in (state() || {})).toBe(false);
  });

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
    expect(failed.platform).toBe('android');
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

describe('the android collector follows the app across a restart', () => {
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
      { STIM_PID_WATCH_MS: '100' },
    );
    await until(() => deviceLog().some((r) => /before the restart/.test(r.msg || '')), { label: 'the first stream' });

    writeFileSync(join(shimDir, 'restarted'), '');

    const reattached = await until(() => deviceLog().find((r) => r.event === 'collector_reattached'), {
      label: 'the reattach record',
    });
    expect(reattached.msg).toMatch(/pid 4200/);
    expect(reattached.msg).toMatch(/was 3132/);
    await until(() => deviceLog().some((r) => /after the restart/.test(r.msg || '')), { label: 'the second stream' });

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
      { STIM_PID_WATCH_MS: '50' },
    );
    await until(() => deviceLog().some((r) => /steady/.test(r.msg || '')), { label: 'the stream' });
    await new Promise((r) => setTimeout(r, 400));
    expect(deviceLog().filter((r) => r.event === 'collector_reattached').length).toBe(0);
    process.kill(childPid(child), 'SIGKILL');
    await exited(child);
  });
});

describe('runCollector reattach seams', () => {
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

describe('the collector never signals a pid it does not own', () => {
  test('reattaching kills the stream through its own handle, not process.kill on its pid', async () => {
    const signalled: [number, string | number][] = [];
    const killedHandles: (string | number | undefined)[] = [];
    const origKill = process.kill;
    process.kill = ((pid: number, sig: string | number) => {
      signalled.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    try {
      const started: ChildProcess[] = [];
      let pid = 3132;
      const result = await runCollector({
        platform: 'android',
        root,
        serial: 'emulator-5554',
        packageName: 'com.example.app',
        resolvePid: async () => ({ ok: true, pid: 3132 }),
        pidOf: () => pid,
        pidWatchMs: 60000,
        startStream: ({ pid: streamPid }) => {
          const c = makeChildProcess({
            pid: streamPid ?? undefined,
            kill: ((sig?: string | number) => {
              killedHandles.push(sig);
              return true;
            }) as ChildProcess['kill'],
          });
          started.push(c);
          return c;
        },
        attachSignals: false,
        onExit: () => {},
      });

      pid = 4200;
      const firstStarted = started[0];
      assert(firstStarted);
      firstStarted.emit('exit', 0, null);

      expect(killedHandles).toEqual(['SIGTERM']);
      expect(signalled.filter(([, sig]) => sig !== 0)).toEqual([]);

      assert(result);
      result.finish(0, 'info', 'done', 'collector_stopped');
    } finally {
      process.kill = origKill;
    }
  });
});
