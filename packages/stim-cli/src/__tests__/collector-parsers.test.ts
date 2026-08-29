import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appNameFromBundleId,
  levelForEvent,
  levelFromMessageType,
  logStreamArgs,
  noiseRuleId,
  parseLogStreamLine,
  procFromImagePath,
  NOISE_RULES,
} from '../collector/ios.ts';
import {
  levelForLogcat,
  levelFromLogcatLetter,
  logcatArgs,
  parseLogcatLine,
  parseLogcatTimestamp,
  parsePidof,
  pidWatchInterval,
  watchAppPid,
  NOISE_TAGS,
} from '../collector/android.ts';
import { LEVELS, SOURCES } from '../ndjson.ts';

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function fixture(name: string) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf-8');
}

describe('ios: log stream ndjson', () => {
  const lines = fixture('ios-log-stream.ndjson').split('\n').filter(Boolean);

  test('the real capture yields Contract-1 records for the log events only', () => {
    const records = lines.map((l) => parseLogStreamLine(l)).filter(isNotNull);
    expect(lines.length).toBe(5);
    expect(records.length).toBe(3);
    for (const record of records) {
      assert(record.src);
      assert(record.level);
      expect(record.src).toBe('device');
      expect(SOURCES.includes(record.src)).toBeTruthy();
      expect(LEVELS.includes(record.level)).toBeTruthy();
      expect(typeof record.msg).toBe('string');
      expect(Number.isFinite(record.ts)).toBeTruthy();
    }
  });

  test('the real non-JSON banner line is skipped, not thrown on', () => {
    const banner = lines[0];
    assert(banner);
    expect(banner).toMatch(/^Filtering the log data using/);
    expect(parseLogStreamLine(banner)).toBe(null);
  });

  test('activity events are dropped: they carry a message but no level', () => {
    const activity = lines.find((l) => l.includes('"activityCreateEvent"'));
    expect(activity).toBeTruthy();
    assert(activity);
    expect(parseLogStreamLine(activity)).toBe(null);
  });

  test('messageType maps onto Contract 1, with Fault as fatal', () => {
    const byLevel = Object.fromEntries(
      lines
        .map((l) => parseLogStreamLine(l))
        .filter(isNotNull)
        .map((r) => [r.level, r]),
    );
    expect(byLevel.info).toBeTruthy();
    expect(byLevel.error).toBeTruthy();
    expect(byLevel.fatal).toBeTruthy();
    expect(byLevel.fatal.msg).toMatch(/LocationProvider/);
  });

  test('the record carries the executable name from processImagePath', () => {
    const records = lines.map((l) => parseLogStreamLine(l)).filter(isNotNull);
    expect(records.map((r) => r.proc).toSorted()).toEqual(['gamecontrollerd', 'locationd', 'pairedsyncd']);
  });

  test("Apple's timestamp is parsed rather than replaced by the read time", () => {
    const logEvent = lines.find((l) => l.includes('"logEvent"'));
    assert(logEvent);
    const captured = JSON.parse(logEvent).timestamp;
    expect(captured).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[-+]\d{4}$/);
    const parsed = parseLogStreamLine(logEvent, { now: () => 0 });
    assert(parsed);
    expect(parsed.ts).toBe(Date.parse(captured));
  });

  test('levelFromMessageType covers the documented set and defaults to info', () => {
    expect(levelFromMessageType('Debug')).toBe('debug');
    expect(levelFromMessageType('Info')).toBe('info');
    expect(levelFromMessageType('Default')).toBe('info');
    expect(levelFromMessageType('Error')).toBe('error');
    expect(levelFromMessageType('Fault')).toBe('fatal');
    expect(levelFromMessageType('Warning')).toBe('info');
    expect(levelFromMessageType(undefined)).toBe('info');
  });

  test('procFromImagePath takes the executable, not the bundle directory', () => {
    expect(
      procFromImagePath(
        '/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/ABC/MyApp.app/MyApp',
      ),
    ).toBe('MyApp');
    expect(procFromImagePath(null)).toBe(null);
  });

  test('an empty or whitespace-only eventMessage is not a record', () => {
    expect(parseLogStreamLine('{"eventType":"logEvent","messageType":"Default","eventMessage":"   "}')).toBe(null);
  });

  test('logStreamArgs is the exact argv, with the predicate quoted for the device', () => {
    expect(logStreamArgs('U1', 'MyApp')).toEqual([
      'simctl',
      'spawn',
      'U1',
      'log',
      'stream',
      '--style',
      'ndjson',
      '--predicate',
      'processImagePath CONTAINS[c] "MyApp"',
    ]);
  });

  test('appNameFromBundleId is the last segment, as a fallback for a caller with only a bundle id', () => {
    expect(appNameFromBundleId('com.example.MyApp')).toBe('MyApp');
    expect(appNameFromBundleId('MyApp')).toBe('MyApp');
  });
});

describe('ios: demoting device noise', () => {
  const app =
    '/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/ABC/MyApp.app/MyApp';
  const event = (over: Record<string, unknown>): Record<string, unknown> => ({
    eventType: 'logEvent',
    messageType: 'Error',
    subsystem: '',
    category: '',
    processImagePath: app,
    timestamp: '2026-08-24 16:03:54.196749-0400',
    ...over,
  });

  test('the nw_socket flood is captured at info, not reported as an error', () => {
    const flood = [
      event({
        subsystem: 'com.apple.network',
        category: 'connection',
        eventMessage: 'nw_socket_handle_socket_event [C1.1.1:2] Socket SO_ERROR [54: Connection reset by peer]',
      }),
      event({
        subsystem: 'com.apple.network',
        category: 'boringssl',
        eventMessage:
          'boringssl_context_handle_fatal_alert(1938) [C4.1.1:2][0x10c0a4b60] read alert, level: fatal, description: certificate unknown',
      }),
      event({
        eventMessage:
          'nw_connection_copy_connected_local_endpoint_block_invoke [C2] Client called nw_connection_copy_connected_local_endpoint on unconnected nw_connection',
      }),
      event({ eventMessage: 'nw_read_request_report [C3] Receive failed with error "Socket is not connected"' }),
    ];
    for (const e of flood) {
      const record = parseLogStreamLine(JSON.stringify(e));
      assert(record);
      expect(record.level).toBe('info');
      expect(record.msg).toBe(e.eventMessage);
      expect(record.src).toBe('device');
      expect(record.proc).toBe('MyApp');
    }
  });

  test('the UIScene deprecation notice is a notice, not a fatal', () => {
    const record = parseLogStreamLine(
      JSON.stringify(
        event({
          messageType: 'Fault',
          subsystem: 'com.apple.UIKit',
          category: 'lifecycle',
          eventMessage:
            'BUG IN CLIENT OF UIKIT: UIScene lifecycle will soon be required. Please update your app to adopt UIScene lifecycle.',
        }),
      ),
    );
    assert(record);
    expect(record.level).toBe('info');
    const simulatorRecord = parseLogStreamLine(
      JSON.stringify(
        event({
          messageType: 'Fault',
          eventMessage: '`UIScene` lifecycle will soon be required. Failure to adopt will result in an assert.',
        }),
      ),
    );
    assert(simulatorRecord);
    expect(simulatorRecord.level).toBe('info');
    expect(
      noiseRuleId(
        JSON.parse(JSON.stringify(event({ eventMessage: 'The app must migrate to UIScene lifecycle before iOS 27.' }))),
      ),
    ).toBe('uiscene-deprecation');
  });

  test('the rest of the proven offenders are demoted, each by its own rule', () => {
    const cases = [
      [
        'sectrust',
        event({ subsystem: 'com.apple.securityd', category: 'SecTrust', eventMessage: 'SecTrustEvaluateIfNecessary' }),
      ],
      [
        'sectrust-default-subsystem',
        event({ eventMessage: 'SecTrustReportNetworkingAnalytics: Failed to acquire the trust result' }),
      ],
      [
        'webkit',
        event({
          subsystem: 'com.apple.WebKit',
          category: 'Process',
          eventMessage: 'Failed to terminate process: Error Domain=com.apple.extensionKit.errorDomain Code=18',
        }),
      ],
      ['webkit-default-subsystem', event({ eventMessage: 'WebPrivacy: Failed to acquire the WebPrivacy resource' })],
      [
        'audio-factory',
        event({
          eventMessage:
            'AddInstanceForFactory: No factory registered for id <CFUUID 0x600000284840> F8BB1C28-BAE8-11D6-9C31-00039315CD46',
        }),
      ],
      [
        'coreui',
        event({
          subsystem: 'com.apple.coreui',
          category: 'default',
          eventMessage: 'Invalid asset name supplied: (null)',
        }),
      ],
      ['coreui-default-subsystem', event({ eventMessage: 'CUICatalog: Invalid asset name supplied: (null)' })],
    ];
    for (const [id, e] of cases) {
      expect(noiseRuleId(e)).toBe(id);
      expect(levelForEvent(e)).toBe('info');
    }
    const covered = new Set([
      ...cases.map(([id]) => id),
      'network',
      'network-default-subsystem',
      'uiscene-deprecation',
    ]);
    expect(NOISE_RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  test("the app's own error is untouched, and so is an unlisted system one", () => {
    const own = event({ eventMessage: '[Error: Exception in HostFunction]' });
    expect(noiseRuleId(own)).toBe(null);
    const ownRecord = parseLogStreamLine(JSON.stringify(own));
    assert(ownRecord);
    expect(ownRecord.level).toBe('error');

    const unlisted = event({
      subsystem: 'com.apple.pairedsync',
      category: 'daemon',
      eventMessage: 'Fatal error: pairing store path was nil for PSDFileManager.',
    });
    expect(levelForEvent(unlisted)).toBe('error');
    expect(levelForEvent({ ...unlisted, messageType: 'Fault' })).toBe('fatal');
  });

  test('demotion never promotes, and never fires below error', () => {
    const chatty = event({
      messageType: 'Default',
      subsystem: 'com.apple.network',
      eventMessage: 'nw_socket ordinary chatter',
    });
    expect(levelForEvent(chatty)).toBe('info');
    expect(levelForEvent({ ...chatty, messageType: 'Debug' })).toBe('debug');
  });

  test('a subsystem rule matches dotted children, not lookalike names', () => {
    expect(noiseRuleId(event({ subsystem: 'com.apple.network.tcp' }))).toBe('network');
    expect(
      noiseRuleId(event({ subsystem: 'com.apple.networkextension', eventMessage: 'provider failed to start' })),
    ).toBe(null);
  });

  test('an event with no subsystem, category or message at all is not noise', () => {
    expect(noiseRuleId({})).toBe(null);
    expect(noiseRuleId(null)).toBe(null);
  });
});

describe('android: logcat -v time', () => {
  const lines = fixture('android-logcat-time.txt').split('\n').filter(Boolean);

  test('every real level line parses into a Contract-1 record', () => {
    const records = lines.map((l) => parseLogcatLine(l)).filter(isNotNull);
    expect(lines.length).toBe(6);
    expect(records.length).toBe(5);
    for (const record of records) {
      assert(record.level);
      expect(record.src).toBe('device');
      expect(LEVELS.includes(record.level)).toBeTruthy();
      expect(Number.isFinite(record.ts)).toBeTruthy();
    }
  });

  test('the real buffer banner is skipped rather than recorded raw', () => {
    const banner = lines[0];
    assert(banner);
    expect(banner).toBe('--------- beginning of system');
    expect(parseLogcatLine(banner)).toBe(null);
  });

  test('the real V/D/I/W/E lines map onto Contract 1 levels', () => {
    const levels = lines
      .map((l) => parseLogcatLine(l))
      .filter(isNotNull)
      .map((r) => r.level);
    expect(levels.toSorted()).toEqual(['debug', 'debug', 'error', 'info', 'warn']);
  });

  test('the tag and pid become proc, and the message keeps its own colons', () => {
    const record = parseLogcatLine(
      '08-21 17:51:19.669 E/keystore2(  245): system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680',
    );
    assert(record);
    expect(record.proc).toBe('keystore2(245)');
    expect(record.level).toBe('error');
    expect(record.msg).toBe(
      'system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680',
    );
  });

  test('a fatal line maps to fatal (synthesized: no F line was in the captured buffer)', () => {
    const record = parseLogcatLine(
      '08-21 17:52:03.115 F/libc    ( 9182): Fatal signal 11 (SIGSEGV), code 1 in tid 9182 (com.example.app)',
    );
    assert(record);
    expect(record.level).toBe('fatal');
    expect(record.msg).toMatch(/SIGSEGV/);
  });

  test('levelFromLogcatLetter covers the priority letters and defaults to info', () => {
    expect(['V', 'D', 'I', 'W', 'E', 'F', 'A'].map(levelFromLogcatLetter)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'fatal',
    ]);
    expect(levelFromLogcatLetter('?')).toBe('info');
  });

  test('the missing year comes from the reference clock, and a future stamp rolls back', () => {
    const jan = Date.parse('2027-01-02T10:00:00Z');
    const dec = parseLogcatTimestamp({ month: 12, day: 28, hour: 23, minute: 0, second: 0, millis: 0 }, jan);
    expect(dec < jan).toBeTruthy();
    expect(new Date(dec).getFullYear()).toBe(2026);

    const sameDay = parseLogcatTimestamp({ month: 1, day: 2, hour: 9, minute: 0, second: 0, millis: 0 }, jan);
    expect(new Date(sameDay).getFullYear()).toBe(2027);
  });

  test('logcatArgs is the exact argv', () => {
    expect(logcatArgs('emulator-5554', 3132)).toEqual(['-s', 'emulator-5554', 'logcat', '--pid', '3132', '-v', 'time']);
  });

  test('parsePidof reads the single pid, and nothing from empty output', () => {
    expect(parsePidof('3132\n')).toBe(3132);
    expect(parsePidof('')).toBe(null);
    expect(parsePidof('\r\n')).toBe(null);
    expect(parsePidof(null)).toBe(null);
    expect(parsePidof('3132 3155\n')).toBe(3132);
  });

  describe('demoting device noise', () => {
    test('the emulator graphics and loader tags are captured at info', () => {
      const noisy = [
        '08-21 17:51:19.669 E/libEGL  ( 9182): called unimplemented OpenGL ES API',
        '08-21 17:51:19.669 E/EGL_emulation( 9182): tid 9182: eglSurfaceAttrib(1376): error 0x3009 (EGL_BAD_MATCH)',
        '08-21 17:51:19.669 E/eglCodecCommon( 9182): glUtilsParamSize: unknow param 0x00008cdf',
        '08-21 17:51:19.669 E/OpenGLRenderer( 9182): Unable to match the desired swap behavior.',
        "08-21 17:51:19.669 E/ziparchive( 9182): Unable to open '/data/app/~~x==/com.example.app-1/base.dm': No such file or directory",
        '08-21 17:51:19.669 E/vulkan  ( 9182): unknown gralloc4 metadata type',
      ];
      for (const line of noisy) {
        const record = parseLogcatLine(line);
        assert(record);
        assert(record.msg);
        expect(record.level).toBe('info');
        expect(record.msg.length > 0).toBeTruthy();
      }
    });

    test("an unlisted tag keeps its E, including the app's own", () => {
      const rnjs = parseLogcatLine('08-21 17:51:19.669 E/ReactNativeJS( 9182): [Error: Exception in HostFunction]');
      assert(rnjs);
      expect(rnjs.level).toBe('error');
      const keystore = parseLogcatLine(
        '08-21 17:51:19.669 E/keystore2(  245): system/security/keystore2/src/error.rs:183',
      );
      assert(keystore);
      expect(keystore.level).toBe('error');
    });

    test('F is never demoted, even from a listed tag', () => {
      expect(levelForLogcat('F', 'libEGL')).toBe('fatal');
      const libc = parseLogcatLine(
        '08-21 17:52:03.115 F/libc    ( 9182): Fatal signal 11 (SIGSEGV), code 1 in tid 9182',
      );
      assert(libc);
      expect(libc.level).toBe('fatal');
      expect(!NOISE_TAGS.has('libc')).toBeTruthy();
    });

    test('levelForLogcat leaves everything below error alone', () => {
      expect(levelForLogcat('W', 'libEGL')).toBe('warn');
      expect(levelForLogcat('I', 'libEGL')).toBe('info');
      expect(levelForLogcat('E', 'libEGL')).toBe('info');
      expect(levelForLogcat('E', 'MyApp')).toBe('error');
    });
  });
});

describe('watchAppPid', () => {
  function driver() {
    const queue: Array<() => void> = [];
    return {
      setTimer: (fn: () => void): ReturnType<typeof setTimeout> => {
        queue.push(fn);
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {
        queue.length = 0;
      },
      async tick() {
        const fn = queue.shift();
        if (fn) await fn();
      },
      get pending() {
        return queue.length;
      },
    };
  }

  test('a new pid is a restart; the same pid is not', async () => {
    const d = driver();
    const seen: number[] = [];
    let answer = 3132;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => answer,
      onChange: (pid) => {
        seen.push(pid);
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(seen).toEqual([]);
    answer = 4200;
    await d.tick();
    expect(seen).toEqual([4200]);
    await d.tick();
    expect(seen).toEqual([4200]);
    w.stop();
  });

  test('the app being GONE is not a restart -- the pid that comes back is', async () => {
    const d = driver();
    const seen: number[] = [];
    let answer: number | null = null;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => answer,
      onChange: (pid) => {
        seen.push(pid);
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(seen).toEqual([]);
    answer = 4200;
    await d.tick();
    expect(seen).toEqual([4200]);
    w.stop();
  });

  test('an adb that throws is a missed poll, not a dead watcher', async () => {
    const d = driver();
    const seen: number[] = [];
    let throwing = true;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => {
        if (throwing) throw new Error('device offline');
        return 4200;
      },
      onChange: (pid) => {
        seen.push(pid);
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(seen).toEqual([]);
    expect(d.pending).toBe(1);
    throwing = false;
    await d.tick();
    expect(seen).toEqual([4200]);
    w.stop();
    expect(d.pending).toBe(0);
  });

  test('an onChange that throws does not stop the watch either', async () => {
    const d = driver();
    let answer = 4200;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => answer,
      onChange: () => {
        throw new Error('reattach failed');
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(d.pending).toBe(1);
    w.stop();
  });

  test('stop() is what lets the collector process exit', async () => {
    const d = driver();
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => 3132,
      onChange: () => {},
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    expect(d.pending).toBe(1);
    w.stop();
    expect(d.pending).toBe(0);
    await d.tick();
    expect(d.pending).toBe(0);
  });

  test('the interval is 3s unless a test redirects it', () => {
    delete process.env.STIM_CLI_PID_WATCH_MS;
    expect(pidWatchInterval()).toBe(3000);
    process.env.STIM_CLI_PID_WATCH_MS = '100';
    expect(pidWatchInterval()).toBe(100);
    process.env.STIM_CLI_PID_WATCH_MS = 'nonsense';
    expect(pidWatchInterval()).toBe(3000);
    delete process.env.STIM_CLI_PID_WATCH_MS;
  });
});
