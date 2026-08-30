import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { isBundleActivityLine } from '../supervisor/server-expo.ts';
import {
  DEFAULT_METRO_PORT,
  INSTALL_ERROR,
  LAUNCH_ERROR,
  STABILITY_WINDOW_MS,
  VERIFY_TIMEOUT_MS,
  devClientUrl,
  isBundleProof,
  isBundleRequestProof,
  unverifiedLaunchLines,
  verifyLaunch,
  amStartError,
  androidAppProcess,
  androidDevClientUrl,
  debugHttpHostScript,
  deviceShellArg,
  installAndroidApp,
  installConflictKind,
  installIosApp,
  iosAppProcess,
  iosSchemeApprovalKeys,
  launchAndroidReleaseApp,
  parsePidof,
  parsePsPid,
  verifyAndroidReleaseLaunch,
  openAndroidDevClientUrl,
  jsLocationValue,
  launchAndroidApp,
  launchIosApp,
  parseLaunchedPid,
  parseResolvedActivity,
  verifyReleaseLaunch,
  reverseMetroPorts,
  writeDebugHttpHost,
} from '../engine/app-install.ts';

type LaunchResult = {
  ok?: boolean;
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientUrl?: string;
  devClientNote?: string | null;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  [key: string]: unknown;
};

interface RecordingExec extends Executor {
  calls: string[][];
}
function recordingExec({
  fail = null,
  outputs = {},
}: { fail?: string | null; outputs?: Record<string, string> } = {}): RecordingExec {
  const calls: string[][] = [];
  return {
    calls,
    runFile(file: string, args: string[] = []) {
      calls.push([file, ...args]);
      const key = [file, ...args].join(' ');
      if (fail && key.includes(fail)) {
        const err = new Error(`Command failed: ${key}`);
        (err as Error & { stderr?: string }).stderr = 'device not booted';
        throw err;
      }
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) return value;
      }
      return '';
    },
    run() {
      throw new Error('app-install must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('app-install must use runFile, not the shell');
    },
    spawn() {
      throw new Error('app-install does not spawn');
    },
  };
}

describe('the two pure port-wiring shapes', () => {
  test('jsLocationValue is host:port', () => {
    expect(jsLocationValue(8082)).toBe('localhost:8082');
    expect(jsLocationValue(8082)).toMatch(/:/);
  });

  test('devClientUrl matches the shape expo-dev-launcher asserts on', () => {
    expect(devClientUrl('myapp', 8082)).toBe('myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082');
    expect(devClientUrl('scheme', 8081)).toBe('scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081');
  });

  test('iOS scheme approvals cover the bundle id and dev-client scheme without duplicates', () => {
    expect(iosSchemeApprovalKeys('com.example.app', 'myapp')).toEqual([
      'com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app',
      'com.apple.CoreSimulator.CoreSimulatorBridge-->myapp',
    ]);
    expect(iosSchemeApprovalKeys('com.example.app', 'com.example.app')).toEqual([
      'com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app',
    ]);
  });
});

describe('ios', () => {
  test('installIosApp passes the .app path as one literal argv element', () => {
    const exec = recordingExec();
    const appPath = '/tmp/Build Products/My App.app';
    expect(installIosApp({ udid: 'U1', appPath }, { exec })).toEqual({ ok: true, appPath });
    expect(exec.calls).toEqual([['xcrun', 'simctl', 'install', 'U1', appPath]]);
  });

  test('installIosApp reports a simctl failure instead of throwing', () => {
    const exec = recordingExec({ fail: 'simctl install' });
    const result = installIosApp({ udid: 'U1', appPath: '/tmp/a.app' }, { exec });
    expect(result.code).toBe(INSTALL_ERROR);
    expect(result.reason).toMatch(/device not booted/);
  });

  test('installIosApp approves the exact app and scheme after installation', () => {
    const exec = recordingExec();
    const appPath = '/tmp/My App.app';
    expect(
      installIosApp(
        {
          udid: 'U1',
          appPath,
          bundleId: 'com.example.app',
          devClientScheme: 'myapp',
        },
        { exec },
      ),
    ).toEqual({ ok: true, appPath });
    expect(exec.calls).toEqual([
      ['xcrun', 'simctl', 'install', 'U1', appPath],
      [
        'xcrun',
        'simctl',
        'spawn',
        'U1',
        'defaults',
        'write',
        'com.apple.launchservices.schemeapproval',
        'com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app',
        '-string',
        'com.example.app',
      ],
      [
        'xcrun',
        'simctl',
        'spawn',
        'U1',
        'defaults',
        'write',
        'com.apple.launchservices.schemeapproval',
        'com.apple.CoreSimulator.CoreSimulatorBridge-->myapp',
        '-string',
        'com.example.app',
      ],
    ]);
  });

  test('a failed scheme approval reports a failed install result', () => {
    const exec = recordingExec({ fail: 'schemeapproval' });
    const result = installIosApp(
      {
        udid: 'U1',
        appPath: '/tmp/My App.app',
        bundleId: 'com.example.app',
        devClientScheme: 'myapp',
      },
      { exec },
    );
    expect(result.code).toBe(INSTALL_ERROR);
    expect(result.reason).toMatch(/preapprove/);
  });

  test('launchIosApp writes RCT_jsLocation before launching, bare RN path', () => {
    const exec = recordingExec();
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('launch');
    expect(exec.calls).toEqual([
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'launch', 'U1', 'com.example.app'],
    ]);
  });

  test('launchIosApp opens the preapproved dev-client URL after the RCT defaults write', () => {
    const exec = recordingExec();
    const result = launchIosApp(
      { udid: 'U1', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' },
      { exec },
    );
    expect(result.mode).toBe('openurl');
    expect(exec.calls).toEqual([
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'openurl', 'U1', 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082'],
    ]);
  });

  test('a failed defaults write stops the launch rather than launching unwired', () => {
    const exec = recordingExec({ fail: 'defaults write' });
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/RCT_jsLocation/);
    expect(exec.calls.length).toBe(1);
  });

  test('a failed launch is reported, not thrown', () => {
    const exec = recordingExec({ fail: 'simctl launch' });
    expect(launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec }).reason).toMatch(
      /simctl launch/,
    );
  });

  test('launchIosApp with metroPort null is a plain launch: no RCT_jsLocation write, no openurl', () => {
    const exec = recordingExec({ outputs: { 'simctl launch': 'com.example.app: 4242' } });
    const result = launchIosApp(
      { udid: 'U1', bundleId: 'com.example.app', metroPort: null, devClientScheme: 'myapp' },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('launch');
    expect(result.pid).toBe(4242);
    expect(result.jsLocation).toBeUndefined();
    expect(exec.calls).toEqual([['xcrun', 'simctl', 'launch', 'U1', 'com.example.app']]);
  });

  test('parseLaunchedPid reads `<bundleId>: <pid>` and nothing else', () => {
    expect(parseLaunchedPid('com.example.app: 4242')).toBe(4242);
    expect(parseLaunchedPid('com.example.app: 4242\n')).toBe(4242);
    expect(parseLaunchedPid('')).toBe(null);
    expect(parseLaunchedPid('something went wrong')).toBe(null);
    expect(parseLaunchedPid(null)).toBe(null);
    expect(parseLaunchedPid('com.example.app: 0')).toBe(null);
  });

  test('iosAppProcess finds the app pid in the simulator launchctl list', () => {
    const exec = recordingExec({
      outputs: {
        'launchctl list': '-\t0\tcom.apple.foo\n4242\t0\tUIKitApplication:com.example.app[abcd][rb-legacy]\n',
      },
    });
    expect(iosAppProcess('U1', 'com.example.app', { exec })).toBe(4242);
    expect(exec.calls[0]).toEqual(['xcrun', 'simctl', 'spawn', 'U1', 'launchctl', 'list']);
  });

  test('iosAppProcess returns null when the app is not running', () => {
    const exec = recordingExec({ outputs: { 'launchctl list': '-\t0\tcom.apple.foo\n' } });
    expect(iosAppProcess('U1', 'com.example.app', { exec })).toBe(null);
  });

  test('iosAppProcess returns undefined when the process probe fails', () => {
    const exec = recordingExec({ fail: 'launchctl list' });
    expect(iosAppProcess('U1', 'com.example.app', { exec })).toBeUndefined();
  });
});

describe('verifyReleaseLaunch', () => {
  const instantly = {
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 1500);
    })(),
  };

  test('verified when the process is still alive after the wait', async () => {
    const result = await verifyReleaseLaunch({ pid: 4242, alive: () => true, ...instantly });
    expect(result.verified).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
  });

  test('a process that died within the window is unverified with reason exited', async () => {
    const result = await verifyReleaseLaunch({ pid: 4242, alive: () => false, sleep: async () => {} });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('exited');
  });

  test('no pid means nothing can be checked: unverified, no wait at all', async () => {
    let slept = false;
    const result = await verifyReleaseLaunch({
      pid: null,
      alive: () => {
        throw new Error('must not be called without a pid');
      },
      sleep: async () => {
        slept = true;
      },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('no-pid');
    expect(slept).toBe(false);
  });
});

describe('android: resolve-activity parsing', () => {
  const REAL =
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.settings/.Settings\n';

  test('takes the component line, not the key=value header', () => {
    expect(parseResolvedActivity(REAL)).toBe('com.android.settings/.Settings');
  });

  test('returns null for "No activity found", which resolve-activity prints with exit 0', () => {
    expect(parseResolvedActivity('No activity found\n')).toBe(null);
  });

  test('returns null for empty or non-string output', () => {
    expect(parseResolvedActivity('')).toBe(null);
    expect(parseResolvedActivity(null)).toBe(null);
  });

  test('handles a fully qualified activity name', () => {
    expect(parseResolvedActivity('priority=0 isDefault=true\ncom.example.app/com.example.app.MainActivity\n')).toBe(
      'com.example.app/com.example.app.MainActivity',
    );
  });
});

describe('android: install and launch', () => {
  test('installAndroidApp uses adb install -r with the apk as one argv element', () => {
    const exec = recordingExec();
    const apkPath = '/tmp/out puts/app-debug.apk';
    expect(installAndroidApp({ serial: 'emulator-5554', apkPath }, { exec })).toEqual({ ok: true, apkPath });
    expect(exec.calls).toEqual([['adb', '-s', 'emulator-5554', 'install', '-r', apkPath]]);
  });

  test('reverseMetroPorts maps 8081 to the reserved port AND keeps the same-port reverse', () => {
    const exec = recordingExec();
    const result = reverseMetroPorts({ serial: 'emulator-5554', metroPort: 8082 }, { exec });
    expect(result.ok).toBe(true);
    expect(exec.calls).toEqual([
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
    ]);
  });

  test('a workspace that actually reserved 8081 gets one reverse, not a duplicate', () => {
    const exec = recordingExec();
    reverseMetroPorts({ serial: 'emulator-5554', metroPort: DEFAULT_METRO_PORT }, { exec });
    expect(exec.calls).toEqual([['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081']]);
  });

  test('launchAndroidApp reverses, resolves the activity, and am starts it', () => {
    const exec = recordingExec({
      outputs: { 'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n' },
    });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('am-start');
    expect(exec.calls).toEqual([
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
      exec.calls[2],
      [
        'adb',
        '-s',
        'emulator-5554',
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        'com.example.app',
      ],
      ['adb', '-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.app/.MainActivity'],
    ]);
    const httpHostCall = exec.calls[2];
    assert(httpHostCall);
    expect(httpHostCall.slice(0, 6)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'run-as', 'com.example.app']);
    expect(httpHostCall.at(-1)).toMatch(/debug_http_host.*10\.0\.2\.2:8082/);
  });

  test('falls back to monkey when no launcher activity resolves', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'No activity found\n' } });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('monkey');
    expect(exec.calls.at(-1)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.app', '1']);
  });

  test('a failed reverse stops the launch', () => {
    const exec = recordingExec({ fail: 'reverse' });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/adb reverse/);
    expect(exec.calls.length).toBe(1);
  });

  test('an am start failure is reported, not thrown', () => {
    const exec = recordingExec({
      fail: 'am start',
      outputs: { 'resolve-activity': 'priority=0\ncom.example.app/.MainActivity\n' },
    });
    expect(
      (
        launchAndroidApp(
          { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
          { exec },
        ) as LaunchResult
      ).reason,
    ).toMatch(/am start/);
  });

  test('an adb failure while resolving the activity falls through to monkey', () => {
    const exec = recordingExec({ fail: 'resolve-activity' });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('monkey');
  });
});

test('writeDebugHttpHost writes host:port via run-as and reports it', () => {
  const calls: string[][] = [];
  const exec = {
    runFile: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return '';
    },
  } as unknown as Executor;
  const r = writeDebugHttpHost({ serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 }, { exec });
  expect(r.ok).toBe(true);
  expect(r.host).toBe('10.0.2.2:8082');
  const argv = calls[0];
  assert(argv);
  expect(argv[0]).toBe('adb');
  expect(argv.slice(1, 6)).toEqual(['-s', 'emulator-5554', 'shell', 'run-as', 'com.x']);
  expect(argv[8]).toMatch(/debug_http_host/);
  expect(argv[8]).toMatch(/10\.0\.2\.2:8082/);
});

test('a failed prefs write does not fail the launch', () => {
  const exec = {
    runFile: (_cmd: string, args: string[]) => {
      if (args.includes('run-as')) {
        const e = new Error('run-as: package not debuggable');
        throw e;
      }
      return '';
    },
    runQuiet: () => 'com.x/.MainActivity',
  } as unknown as Executor;
  const r: LaunchResult = launchAndroidApp(
    { serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 },
    { exec },
  );
  expect(r.ok).toBe(true);
  expect(r.debugHttpHost).toBe(null);
  expect(r.debugHttpHostNote).toMatch(/relying on adb reverse/);
});

function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe('isBundleProof', () => {
  test('a Metro reporter bundle event after the launch is proof', () => {
    expect(isBundleProof({ ts: 100, event: 'bundle_build_started', src: 'metro' }, 100)).toBe(true);
    expect(isBundleProof({ ts: 150, event: 'bundle_build_done', src: 'metro' }, 100)).toBe(true);
    expect(isBundleProof({ ts: 150, event: 'bundling_error', src: 'metro' }, 100)).toBe(true);
  });

  test('an expo-child stdout line is the same proof by another route', () => {
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundling complete 812ms' },
        100,
      ),
    ).toBe(true);
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundled 812ms index.js (1150 modules)' },
        100,
      ),
    ).toBe(true);
    expect(isBundleActivityLine('Android Bundling failed 91ms')).toBe(true);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundling failed 91ms' }, 100)).toBe(true);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundled 91ms' }, 100, 'ios')).toBe(false);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'iOS Bundled 91ms' }, 100, 'ios')).toBe(true);
    expect(isBundleProof({ ts: 150, event: 'bundle_build_done', platform: 'android' }, 100, 'ios')).toBe(false);
  });

  test('a record from BEFORE the launch is not proof of this launch', () => {
    expect(isBundleProof({ ts: 99, event: 'bundle_build_done' }, 100)).toBe(false);
    expect(isBundleProof({ event: 'bundle_build_done' }, 100)).toBe(false);
  });

  test('server chatter is not proof', () => {
    expect(
      isBundleProof({ ts: 150, src: 'metro', event: 'supervisor_started', msg: 'supervisor pid 1 starting' }, 100),
    ).toBe(false);
    expect(
      isBundleProof({ ts: 150, src: 'metro', event: 'expo_stdout', msg: 'Waiting on http://localhost:8082' }, 100),
    ).toBe(false);
    expect(isBundleProof(null, 100)).toBe(false);
  });
});

describe('verifyLaunch', () => {
  test('verified: the stability window starts after bundle completion', async () => {
    const clock = fakeClock();
    const records: NdjsonRecord[] = [];
    let reads = 0;
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => {
        reads += 1;
        if (reads === 3) records.push({ ts: clock.at(), event: 'bundle_build_done' });
        return records;
      },
    });
    expect(result.verified).toBe(true);
    assert(result.record);
    expect(result.record.event).toBe('bundle_build_done');
    expect(result.waitedMs).toBeGreaterThanOrEqual(STABILITY_WINDOW_MS);
  });

  test('the picker: an app that fetches nothing times out as UNVERIFIED, not as a failure', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [
        {
          ts: clock.at(),
          src: 'metro',
          event: 'supervisor_started',
          msg: 'supervisor pid 3 starting the expo-child dev server on port 8082',
        },
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs >= VERIFY_TIMEOUT_MS).toBeTruthy();
  });

  test('the alert stall: a bundle that arrives after the deadline does not retroactively verify', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() > 1000 + 30000 ? [{ ts: clock.at(), event: 'bundle_build_started' }] : []),
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test('a missing metro.ndjson is a miss, never a throw', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      logsDir: '/nope/does/not/exist',
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 1000,
    });
    expect(result.verified).toBe(false);
  });

  test("reads the workspace's own metro.ndjson, half-written last line and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-cli-verify-'));
    try {
      const clock = fakeClock();
      writeFileSync(
        join(dir, 'metro.ndjson'),
        `${JSON.stringify({ ts: clock.at() - 5, event: 'bundle_build_done' })}\n` +
          `${JSON.stringify({ ts: clock.at() + 10, event: 'bundle_build_done' })}\n` +
          '{"ts":123,"event":"half-writ',
      );
      const result = await verifyLaunch({ logsDir: dir, since: clock.at(), now: clock.now, sleep: clock.sleep });
      expect(result.verified).toBe(true);
      assert(result.record);
      expect(result.record.ts).toBe(1010);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unverifiedLaunchLines', () => {
  test('iOS names the picker and the exact command to retry without an alert step', () => {
    const url = devClientUrl('io.tlon.groups', 8082);
    const text = unverifiedLaunchLines({
      platform: 'ios',
      metroPort: 8082,
      waitedMs: 20000,
      bundleId: 'io.tlon.groups',
      udid: 'BF2A1C3D',
      devClientUrl: url,
    }).join('\n');
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/localhost:8082/);
    expect(text).not.toMatch(/Open in/);
    expect(text).toMatch(/xcrun simctl openurl BF2A1C3D/);
    expect(text.includes(url)).toBeTruthy();
  });

  test('with no scheme it offers the launch command instead of a deep link', () => {
    const text = unverifiedLaunchLines({ platform: 'ios', metroPort: 8082, bundleId: 'com.x', udid: 'U1' }).join('\n');
    expect(text).toMatch(/xcrun simctl launch --console U1 com\.x/);
  });

  test('Android names its own re-launch, not simctl', () => {
    const text = unverifiedLaunchLines({
      platform: 'android',
      metroPort: 8082,
      bundleId: 'com.x',
      serial: 'emulator-5584',
    }).join('\n');
    expect(text).not.toMatch(/simctl/);
    expect(text).toMatch(/adb -s emulator-5584 shell monkey -p com\.x 1/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
  });
});

describe('unverifiedLaunchLines: the action comes first', () => {
  function iosLines() {
    return unverifiedLaunchLines({
      platform: 'ios',
      metroPort: 8082,
      waitedMs: 20000,
      bundleId: 'io.tlon.groups',
      udid: 'BF2A1C3D',
      devClientUrl: devClientUrl('io.tlon.groups', 8082),
    });
  }

  test('the picker is first and the retry is last', () => {
    const lines = iosLines();
    const picker = lines.findIndex((l) => /DEVELOPMENT SERVERS/.test(l));
    const retry = lines.findIndex((l) => /simctl openurl/.test(l));
    expect(picker !== -1 && retry !== -1).toBeTruthy();
    expect(picker < retry).toBeTruthy();
    expect(lines.some((line) => /alert|Open in/.test(line))).toBe(false);
  });

  test('the picker line still carries THIS workspace port, from the facts', () => {
    const picker = iosLines().find((l) => /DEVELOPMENT SERVERS/.test(l));
    expect(picker).toMatch(/localhost:8082/);
    expect(picker).toMatch(/NOT another workspace/);
  });

  test('android has no such alert, so it leads with the picker', () => {
    const lines = unverifiedLaunchLines({
      platform: 'android',
      metroPort: 8082,
      bundleId: 'com.x',
      serial: 'emulator-5584',
    });
    const picker = lines.findIndex((l) => /DEVELOPMENT SERVERS/.test(l));
    const relaunch = lines.findIndex((l) => /monkey -p com\.x/.test(l));
    expect(picker !== -1 && relaunch !== -1).toBeTruthy();
    expect(picker < relaunch).toBeTruthy();
    expect(!lines.some((l) => /Open in <app>/.test(l))).toBeTruthy();
  });
});

describe('the debug_http_host script, run for real under sh', () => {
  let dir: string;
  const PKG = 'com.example.app';
  const prefsPath = () => join(dir, 'shared_prefs', `${PKG}_preferences.xml`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-cli-prefs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runScript = (port: number) =>
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `sh -c ${deviceShellArg(debugHttpHostScript({ packageName: PKG, host: `10.0.2.2:${port}`, dataDir: dir }))}`,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

  const parsePrefs = (text: string) => {
    const entries: Record<string, string> = {};
    const stack: Array<{ name: string; attrs: Record<string, string> }> = [];
    const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    const body = text.replace(/<\?xml[^>]*\?>/g, '');
    let last = 0;
    let m;
    while ((m = tag.exec(body)) !== null) {
      const [full, closing, name, attrs, selfClosing] = m;
      if (full === undefined || name === undefined || attrs === undefined) continue;
      const between = body.slice(last, m.index);
      last = m.index + full.length;
      if (closing) {
        const open = stack.pop();
        assert(open);
        expect(open.name).toBe(name);
        const key = open.attrs.name;
        if (name === 'string' && key !== undefined) entries[key] = between;
        continue;
      }
      const attrMap: Record<string, string> = {};
      for (const a of attrs.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        const k = a[1];
        const v = a[2];
        if (k !== undefined && v !== undefined) attrMap[k] = v;
      }
      if (selfClosing) {
        const key = attrMap.name;
        if (name === 'string' && key !== undefined) entries[key] = '';
        continue;
      }
      stack.push({ name, attrs: attrMap });
    }
    expect(stack).toEqual([]);
    expect(body.trim()).toMatch(/^<map>[\s\S]*<\/map>$/);
    return entries;
  };

  test('case 1: no prefs file at all', () => {
    runScript(8085);
    const entries = parsePrefs(readFileSync(prefsPath(), 'utf-8'));
    expect(entries).toEqual({ debug_http_host: '10.0.2.2:8085' });
  });

  test('case 2: a prefs file that already carries the key (the value is replaced, once)', () => {
    runScript(8085);
    runScript(8099);
    const text = readFileSync(prefsPath(), 'utf-8');
    expect(parsePrefs(text)).toEqual({ debug_http_host: '10.0.2.2:8099' });
    const hostMatches = text.match(/debug_http_host/g);
    assert(hostMatches);
    expect(hostMatches.length).toBe(1);
  });

  test('case 3: a prefs file WITHOUT the key keeps every other entry', () => {
    execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
    writeFileSync(
      prefsPath(),
      [
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
        '<map>',
        '    <string name="onboarding">done</string>',
        '    <string name="last_route">/settings?tab=1&amp;q=x</string>',
        '</map>',
        '',
      ].join('\n'),
    );
    runScript(8085);
    expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({
      onboarding: 'done',
      last_route: '/settings?tab=1&amp;q=x',
      debug_http_host: '10.0.2.2:8085',
    });
  });

  test("case 4: Android's empty-prefs form, `<map />`", () => {
    execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
    writeFileSync(prefsPath(), "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n");
    runScript(8085);
    expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({ debug_http_host: '10.0.2.2:8085' });
  });

  test('a data directory that does not exist exits non-zero rather than pretending', () => {
    const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085', dataDir: join(dir, 'nope') });
    expect(() => execFileSync('/bin/sh', ['-c', `sh -c ${deviceShellArg(script)}`], { stdio: 'ignore' })).toThrow(
      Error,
    );
  });

  test('the script is multi-line, and every line survives the quoting', () => {
    const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085' });
    expect(script.split('\n').length >= 6).toBeTruthy();
    expect(script).toMatch(/^cd \/data\/data\/com\.example\.app \|\| exit 1$/m);
    expect(script).not.toMatch(/\\"/);
    const roundTripped = execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(script)}`], { encoding: 'utf-8' });
    expect(roundTripped).toBe(script);
  });
});

describe('the Android dev-client deep link', () => {
  test('the url is the iOS shape pointed at the emulator loopback', () => {
    expect(androidDevClientUrl('exp+app', 8085)).toBe(
      'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8085',
    );
    expect(devClientUrl('exp+app', 8085)).toBe('exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8085');
  });

  test('launchAndroidApp sends it, quoted for the device shell, and skips resolve-activity', () => {
    const exec = recordingExec();
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'exp+app' },
      { exec },
    );
    expect(result.mode).toBe('deep-link');
    expect(result.devClientUrl).toBe('exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082');
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      `'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082'`,
    ]);
    expect(!exec.calls.some((c: string[]) => c.includes('resolve-activity'))).toBeTruthy();
    expect(result.debugHttpHost).toBe('10.0.2.2:8082');
    expect(result.reversed).toEqual(['tcp:8081->tcp:8082', 'tcp:8082->tcp:8082']);
  });

  test('am start exits 0 on an intent it could not resolve, so the OUTPUT is read', () => {
    expect(
      amStartError(
        'Starting: Intent { act=android.intent.action.VIEW dat=exp+app://expo-development-client/... }\nError: Activity not started, unable to resolve Intent',
      ),
    ).toMatch(/unable to resolve Intent/);
    expect(amStartError('Starting: Intent { act=android.intent.action.VIEW dat=exp+app://... }')).toBe(null);
    expect(
      amStartError(
        'Starting: Intent { ... }\nWarning: Activity not started, its current task has been brought to the front',
      ),
    ).toBe(null);
    expect(amStartError('')).toBe(null);
  });

  test('a deep link nothing answers falls back to the launcher and says so', () => {
    const exec = recordingExec({
      outputs: {
        'android.intent.action.VIEW':
          'Starting: Intent { act=android.intent.action.VIEW dat=exp+app://expo-development-client/... }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW }',
        'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n',
      },
    });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'exp+app' },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('am-start');
    expect(result.devClientNote).toMatch(/unable to resolve Intent/);
    expect(result.devClientNote).toMatch(/fell back to the launcher activity/);
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-n',
      'com.example.app/.MainActivity',
    ]);
  });

  test('openAndroidDevClientUrl reports an adb failure rather than throwing', () => {
    const exec = recordingExec({ fail: 'am start' });
    const r = openAndroidDevClientUrl({ serial: 'emulator-5554', url: 'exp+app://x' }, { exec });
    expect(r.failed).toBe(true);
    expect(r.reason).toMatch(/am start -d exp\+app:\/\/x failed/);
  });

  test('deviceShellArg quotes what adb will not', () => {
    expect(deviceShellArg('a b')).toBe(`'a b'`);
    expect(deviceShellArg("it's")).toBe(`'it'\\''s'`);
    for (const raw of ['a b', "it's", 'x\ny', '?url=a&b=c', '$HOME `id`', '<map>']) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(raw)}`], { encoding: 'utf-8' })).toBe(raw);
    }
  });
});

describe('installConflictKind', () => {
  test('the signer conflict, which a locally re-signed APK guarantees', () => {
    expect(installConflictKind('adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]')).toBe(
      'signature',
    );
    expect(installConflictKind('Failure [INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES]')).toBe('signature');
    expect(installConflictKind('Package com.x signatures do not match previously installed version')).toBe('signature');
  });

  test('the downgrade conflict, answered the same way', () => {
    expect(installConflictKind('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]')).toBe('downgrade');
  });

  test('everything else is a plain install failure, and must NOT trigger an uninstall', () => {
    expect(installConflictKind('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')).toBe(null);
    expect(installConflictKind('device offline')).toBe(null);
    expect(installConflictKind(null)).toBe(null);
  });
});

describe('installAndroidApp: the uninstall-and-retry, exactly once', () => {
  const apkPath = '/tmp/stim-cli-apk-swap-1/app-production-release.apk';

  function conflictingExec(text: string, { alsoFailRetry = false } = {}) {
    const calls: string[][] = [];
    let installs = 0;
    const exec: Executor = {
      runFile(file: string, args: string[] = []) {
        calls.push([file, ...args]);
        if (args.includes('install')) {
          installs += 1;
          if (installs === 1 || alsoFailRetry) {
            const err = new Error(`Command failed: adb install`);
            (err as Error & { stderr?: string }).stderr = text;
            throw err;
          }
        }
        return '';
      },
      run: () => '',
      runQuiet: () => null,
      spawn: () => {
        throw new Error('not used');
      },
    };
    return { exec, calls };
  }

  test('a signer conflict uninstalls the package and installs once more, with a note saying why', () => {
    const { exec, calls } = conflictingExec('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]');
    const result = installAndroidApp(
      { serial: 'emulator-5584', apkPath, packageName: 'com.example.app', allowUninstall: true },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(result.uninstalled).toBe(true);
    expect(result.note).toMatch(/different signer/);
    expect(result.note).toMatch(/data went with it/);
    expect(calls).toEqual([
      ['adb', '-s', 'emulator-5584', 'install', '-r', apkPath],
      ['adb', '-s', 'emulator-5584', 'uninstall', 'com.example.app'],
      ['adb', '-s', 'emulator-5584', 'install', '-r', apkPath],
    ]);
  });

  test('a version downgrade is the same answer with its own note', () => {
    const { exec } = conflictingExec('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]');
    const result = installAndroidApp(
      { serial: 'emulator-5584', apkPath, packageName: 'com.example.app', allowUninstall: true },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/higher versionCode/);
  });

  test('ONCE: a conflict that survives the uninstall is a plain failure, not a loop', () => {
    const { exec, calls } = conflictingExec('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]', { alsoFailRetry: true });
    const result = installAndroidApp(
      { serial: 'emulator-5584', apkPath, packageName: 'com.example.app', allowUninstall: true },
      { exec },
    );
    expect(result.failed).toBe(true);
    expect(result.code).toBe(INSTALL_ERROR);
    expect(result.reason).toMatch(/even after uninstalling com\.example\.app/);
    expect(calls.filter((c) => c.includes('install')).length).toBe(2);
  });

  test('without allowUninstall nothing is ever removed -- the DEBUG flow keeps its app data', () => {
    const { exec, calls } = conflictingExec('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]');
    const result = installAndroidApp({ serial: 'emulator-5584', apkPath, packageName: 'com.example.app' }, { exec });
    expect(result.failed).toBe(true);
    expect(calls.some((c) => c.includes('uninstall'))).toBe(false);
  });

  test('a non-conflict failure never uninstalls, even with allowUninstall', () => {
    const { exec, calls } = conflictingExec('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]');
    const result = installAndroidApp(
      { serial: 'emulator-5584', apkPath, packageName: 'com.example.app', allowUninstall: true },
      { exec },
    );
    expect(result.failed).toBe(true);
    expect(calls.some((c) => c.includes('uninstall'))).toBe(false);
  });
});

describe('launchAndroidReleaseApp', () => {
  test('a plain am start of the launcher activity: no reverse, no prefs write, no deep link', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'com.example.app/.MainActivity\n' } });
    const result = launchAndroidReleaseApp({ serial: 'emulator-5584', packageName: 'com.example.app' }, { exec });
    expect(result).toEqual({ ok: true, mode: 'am-start', component: 'com.example.app/.MainActivity' });
    expect(exec.calls.some((c) => c.includes('reverse'))).toBe(false);
    expect(exec.calls.some((c) => c.includes('am') && c.includes('-d'))).toBe(false);
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5584',
      'shell',
      'am',
      'start',
      '-n',
      'com.example.app/.MainActivity',
    ]);
  });

  test('an unresolvable launcher activity falls through to monkey, as the debug launch does', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'No activity found\n' } });
    const result = launchAndroidReleaseApp({ serial: 'emulator-5584', packageName: 'com.example.app' }, { exec });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('monkey');
  });

  test('an am start that fails is a return value naming the component', () => {
    const exec = recordingExec({
      outputs: { 'resolve-activity': 'com.example.app/.MainActivity\n' },
      fail: 'am start',
    });
    const result = launchAndroidReleaseApp({ serial: 'emulator-5584', packageName: 'com.example.app' }, { exec });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(LAUNCH_ERROR);
  });
});

describe('the android release process proof', () => {
  test('parsePidof takes the first pid, and an empty answer is not a process', () => {
    expect(parsePidof('4242\n')).toBe(4242);
    expect(parsePidof('4242 4310\n')).toBe(4242);
    expect(parsePidof('')).toBe(null);
    expect(parsePidof(null)).toBe(null);
    expect(parsePidof('0')).toBe(null);
  });

  test('parsePsPid matches the MAIN process, not a :remote one', () => {
    const ps = [
      'USER           PID  PPID     VSZ    RSS WCHAN            ADDR S NAME',
      'u0_a123       4242   310 1502444 123456 0                   0 S com.example.app',
      'u0_a123       4310   310 1402444  23456 0                   0 S com.example.app:remote',
    ].join('\n');
    expect(parsePsPid(ps, 'com.example.app')).toBe(4242);
    expect(parsePsPid(ps, 'com.other.app')).toBe(null);
    expect(parsePsPid('', 'com.example.app')).toBe(null);
  });

  test('pidof answers, and the ps fallback is not paid for', async () => {
    const exec = recordingExec({ outputs: { pidof: '4242\n' } });
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result.verified).toBe(true);
    expect(result.pid).toBe(4242);
    expect(exec.calls.some((c) => c.includes('ps'))).toBe(false);
  });

  test('a device with no pidof falls through to ps -A', async () => {
    const exec = recordingExec({
      fail: 'pidof',
      outputs: { 'ps -A': 'USER PID\nu0_a1 4242 310 1 1 0 0 S com.example.app\n' },
    });
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result.verified).toBe(true);
    expect(result.pid).toBe(4242);
  });

  test('no process at all is unverified with reason exited -- a crashed embedded bundle', async () => {
    const exec = recordingExec({ outputs: { pidof: '', 'ps -A': 'USER PID\n' } });
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('exited');
    expect(result.pid).toBe(null);
  });

  test('a failed process probe is unverified without claiming the app exited', async () => {
    const exec = recordingExec({ fail: 'adb' });
    expect(androidAppProcess('emulator-5584', 'com.example.app', { exec })).toBeUndefined();
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ verified: false, reason: 'probe-failed' });
  });
});

describe('isBundleRequestProof', () => {
  test("a device log line naming a bundle URL on THIS workspace's port is proof of the request", () => {
    expect(
      isBundleRequestProof(
        { ts: 150, src: 'device', msg: 'Loading app from http://10.0.2.2:8082/index.bundle?platform=android' },
        100,
        8082,
      ),
    ).toBe(true);
    expect(
      isBundleRequestProof(
        { ts: 150, src: 'device', msg: 'RCTJavaScriptLoader http://localhost:8082/.expo/.virtual-metro-entry.bundle' },
        100,
        8082,
      ),
    ).toBe(true);
  });

  test("another workspace's port is never proof -- that is the failure this check exists for", () => {
    expect(
      isBundleRequestProof({ ts: 150, src: 'device', msg: 'Loading http://10.0.2.2:8081/index.bundle' }, 100, 8082),
    ).toBe(false);
  });

  test("another platform's device request is not proof", () => {
    expect(
      isBundleRequestProof(
        {
          ts: 150,
          src: 'device',
          platform: 'android',
          msg: 'Loading http://10.0.2.2:8082/index.bundle?platform=android',
        },
        100,
        8082,
        'ios',
      ),
    ).toBe(false);
  });

  test('an error-level line naming the same URL is a request that FAILED, not one in flight', () => {
    expect(
      isBundleRequestProof(
        { ts: 150, src: 'device', level: 'error', msg: 'Could not load http://10.0.2.2:8082/index.bundle' },
        100,
        8082,
      ),
    ).toBe(false);
  });

  test('a URL with no bundle path, a record from before the launch, and a missing port are all not proof', () => {
    expect(
      isBundleRequestProof({ ts: 150, src: 'device', msg: 'connected to http://localhost:8082/' }, 100, 8082),
    ).toBe(false);
    expect(isBundleRequestProof({ ts: 99, src: 'device', msg: 'http://localhost:8082/index.bundle' }, 100, 8082)).toBe(
      false,
    );
    expect(isBundleRequestProof({ ts: 150, msg: 'http://localhost:8082/index.bundle' }, 100, null)).toBe(false);
    expect(isBundleRequestProof(null, 100, 8082)).toBe(false);
  });
});

describe('verifyLaunch: still bundling', () => {
  test('a bundle that only started reports requested after the readiness window', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      metroPort: 8082,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_started' }],
      readDeviceRecords: () => [],
    });
    expect(result).toMatchObject({ verified: false, timedOut: true, requested: true });
    expect(result.record?.event).toBe('bundle_build_started');
  });

  test('a timeout with a device-log request reports requested, not a bare unverified', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      metroPort: 8082,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [],
      readDeviceRecords: () => [
        { ts: since + 10, src: 'device', msg: 'Loading app from http://10.0.2.2:8082/index.bundle?platform=android' },
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.requested).toBe(true);
    assert(result.record);
    expect(result.record.msg).toMatch(/index\.bundle/);
  });

  test('a timeout with nothing in the device log stays plain unverified', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      metroPort: 8082,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [],
      readDeviceRecords: () => [{ ts: clock.at(), src: 'device', msg: 'nw_socket_handle_socket_event' }],
    });
    expect(result.requested).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  test('a completed bundle verifies after stability-window device logs are checked', async () => {
    const clock = fakeClock();
    let deviceReads = 0;
    const result = await verifyLaunch({
      since: clock.at(),
      metroPort: 8082,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: clock.at(), event: 'bundle_build_done' }],
      readDeviceRecords: () => {
        deviceReads += 1;
        return [];
      },
    });
    expect(result.verified).toBe(true);
    expect(deviceReads).toBe(1);
    expect(result.waitedMs).toBe(STABILITY_WINDOW_MS);
  });

  test('a delayed bundle completion starts a fresh stability window', async () => {
    const clock = fakeClock();
    const since = clock.at();
    let processChecks = 0;
    const result = await verifyLaunch({
      since,
      timeoutMs: 10000,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() >= since + 5000 ? [{ ts: since + 5000, event: 'bundle_build_done' }] : []),
      readDeviceRecords: () => [],
      processAlive: () => {
        processChecks += 1;
        return true;
      },
    });
    expect(result).toMatchObject({ verified: true, processAlive: true, waitedMs: 8000 });
    expect(processChecks).toBe(1);
  });

  test('overlapping native bundles wait for the requested platform', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const iosStarted = { ts: since, event: 'bundle_build_started', buildID: 'ios_1', platform: 'ios' };
    const androidStarted = {
      ts: since,
      event: 'bundle_build_started',
      buildID: 'android_1',
      platform: 'android',
    };
    const androidDone = {
      ts: since + 1000,
      event: 'bundle_build_done',
      buildID: 'android_1',
      platform: 'android',
    };
    const iosDone = { ts: since + 5000, event: 'bundle_build_done', buildID: 'ios_1', platform: 'ios' };
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      timeoutMs: 10000,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => {
        const records = [iosStarted, androidStarted];
        if (clock.at() >= since + 1000) records.push(androidDone);
        if (clock.at() >= since + 5000) records.push(iosDone);
        return records;
      },
      readDeviceRecords: () => [],
    });
    expect(result).toMatchObject({ verified: true, waitedMs: 8000 });
    expect(result.record).toMatchObject({ buildID: 'ios_1', platform: 'ios' });
  });

  test("another platform's bundle failure does not fail this launch", async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [
        {
          ts: since + 10,
          event: 'bundle_build_failed',
          buildID: 'android_1',
          platform: 'android',
          level: 'error',
          msg: 'Android failed',
        },
        {
          ts: since + 11,
          event: 'bundling_error',
          buildID: 'android_1',
          platform: 'android',
          level: 'error',
          msg: 'Unable to resolve AndroidOnly',
        },
        { ts: since + 20, event: 'bundle_build_done', buildID: 'ios_1', platform: 'ios' },
      ],
      readDeviceRecords: () => [],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: true, processAlive: true });
    expect(result.errors).toEqual([]);
  });

  test('Expo text markers match their named platform', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      timeoutMs: 10000,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => {
        const records = [{ ts: since, src: 'metro', event: 'expo_stdout', msg: 'Android Bundled 80ms index.js' }];
        if (clock.at() >= since + 2000) {
          records.push({ ts: since + 2000, src: 'metro', event: 'expo_stdout', msg: 'iOS Bundled 90ms index.js' });
        }
        return records;
      },
      readDeviceRecords: () => [],
    });
    expect(result).toMatchObject({ verified: true, waitedMs: 5000 });
    expect(result.record?.msg).toMatch(/^iOS Bundled/);
  });

  test('the stability window starts at the Metro completion timestamp', async () => {
    const clock = fakeClock(5000);
    const result = await verifyLaunch({
      since: 1000,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: 2000, event: 'bundle_build_done' }],
      readDeviceRecords: () => [],
    });
    expect(result).toMatchObject({ verified: true, waitedMs: 0 });
  });

  test('a second bundle completion does not shorten the first stability window', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const first = { ts: since, event: 'bundle_build_done', msg: 'first bundle' };
    const second = { ts: since + 2500, event: 'bundle_build_done', msg: 'second bundle' };
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() >= since + 2500 ? [first, second] : [first]),
      readDeviceRecords: () => [],
    });
    expect(result).toMatchObject({ verified: true, waitedMs: STABILITY_WINDOW_MS });
    expect(result.record?.msg).toBe('first bundle');
  });

  test('a client console error is returned with a live, verified app', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_done' }],
      readDeviceRecords: () => [],
      readClientRecords: () => [
        { ts: since + 20, src: 'client', event: 'client_log', level: 'error', msg: 'console.error during launch' },
      ],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: true, processAlive: true });
    expect(result.errors?.[0]?.msg).toBe('console.error during launch');
  });

  test('a healthy iOS launch omits the transient TCP refusal but keeps application errors', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const refusal = {
      ts: since + 20,
      src: 'device',
      level: 'error',
      msg: 'TCP Conn 0x11e8cb020 Failed : error 0:61 [61]',
    };
    const recovered = {
      ts: since + 25,
      src: 'device',
      level: 'info',
      msg: 'TCP Conn 0x11e8cb020 complete. fd: 25, err: 0',
    };
    const applicationError = {
      ts: since + 30,
      src: 'client',
      event: 'client_log',
      level: 'error',
      msg: 'console.error during launch',
    };
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_done', platform: 'ios' }],
      readDeviceRecords: () => [refusal, recovered],
      readClientRecords: () => [applicationError],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: true, processAlive: true });
    expect(result.errors).toEqual([applicationError]);
    expect(refusal.level).toBe('error');
  });

  test.each([true, false, null])(
    'the TCP refusal stays an error without a later pointer recovery when process health is %s',
    async (alive) => {
      const clock = fakeClock();
      const since = clock.at();
      const refusal = {
        ts: since + 20,
        src: 'device',
        level: 'error',
        msg: 'TCP Conn 0x11e8cb020 Failed : error 0:61 [61]',
      };
      const result = await verifyLaunch({
        since,
        platform: 'ios',
        now: clock.now,
        sleep: clock.sleep,
        readRecords: () => [{ ts: since + 10, event: 'bundle_build_done', platform: 'ios' }],
        readDeviceRecords: () => [refusal],
        processAlive: () => alive,
      });
      expect(result.processAlive).toBe(alive);
      expect(result.errors).toEqual([refusal]);
    },
  );

  test('the TCP refusal stays an error when only an earlier or different pointer succeeds', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const refusal = {
      ts: since + 20,
      src: 'device',
      level: 'error',
      msg: 'TCP Conn 0x11e8cb020 Failed : error 0:61 [61]',
    };
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_done', platform: 'ios' }],
      readDeviceRecords: () => [
        { ts: since + 15, src: 'device', level: 'info', msg: 'TCP Conn 0x11e8cb020 complete. fd: 24, err: 0' },
        refusal,
        { ts: since + 25, src: 'device', level: 'info', msg: 'TCP Conn 0x11e8cb160 complete. fd: 25, err: 0' },
      ],
      processAlive: () => true,
    });
    expect(result.errors).toEqual([refusal]);
  });

  test('errors before bundle completion are outside the stability window', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 100, event: 'bundle_build_done' }],
      readDeviceRecords: () => [
        { ts: since + 50, level: 'error', msg: 'pre-bundle warning' },
        { ts: since + 200, level: 'error', msg: 'post-bundle warning' },
      ],
      processAlive: () => true,
    });
    expect(result.errors?.map((record) => record.msg)).toEqual(['post-bundle warning']);
  });

  test('a bundle failure is fatal and includes its error text', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [
        { ts: since + 10, level: 'error', event: 'bundle_build_failed', msg: 'Unable to resolve module X' },
      ],
      readDeviceRecords: () => [],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: false, fatal: true, processAlive: true });
    expect(result.errors?.[0]?.msg).toBe('Unable to resolve module X');
  });

  test('an Expo text bundle failure is fatal', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [
        { ts: since + 10, src: 'metro', event: 'expo_stderr', level: 'error', msg: 'iOS Bundling failed 893ms' },
        {
          ts: since + 11,
          src: 'metro',
          event: 'expo_stderr',
          level: 'error',
          msg: 'Unable to resolve module Missing from App.tsx',
        },
      ],
      readDeviceRecords: () => [],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: false, fatal: true, processAlive: true });
    expect(result.errors?.map((record) => record.msg)).toEqual([
      'iOS Bundling failed 893ms',
      'Unable to resolve module Missing from App.tsx',
    ]);
  });

  test('an unknown process state does not fail a verified bundle', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: clock.at(), event: 'bundle_build_done' }],
      readDeviceRecords: () => [],
      processAlive: () => null,
    });
    expect(result).toMatchObject({ verified: true, processAlive: null });
  });

  test('a process exit during the readiness window is fatal', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_done' }],
      readDeviceRecords: () => [],
      processAlive: () => false,
    });
    expect(result).toMatchObject({ verified: false, fatal: true, processAlive: false });
  });
});
