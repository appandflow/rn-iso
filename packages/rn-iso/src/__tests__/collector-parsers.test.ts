// The two device-log parsers, against REAL captured output.
//
// test/fixtures/ios-log-stream.ndjson was captured on 2026-08-25 from a
// simulator that was ALREADY booted, with the exact command this collector
// runs:
//   xcrun simctl spawn <udid> log stream --style ndjson \
//     --predicate 'processImagePath CONTAINS[c] "/"'
// (the predicate is widened to "/" only so that a sim with no app installed
// still produces events; the shape of every line is identical). It keeps the
// non-JSON banner `log stream` opens with, one activityCreateEvent, and one
// logEvent each of messageType Default, Fault and Error.
//
// test/fixtures/android-logcat-time.txt was captured the same day from a live
// emulator-5554 with `adb -s emulator-5554 logcat -v time -d`, and holds the
// real buffer banner plus one line each of V/D/I/W/E. There was no F(atal)
// line in that buffer, so the fatal case below is SYNTHESIZED in the same
// format (documented in `man logcat`) and marked as such.
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

function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf-8');
}

describe('ios: log stream ndjson', () => {
  const lines = fixture('ios-log-stream.ndjson').split('\n').filter(Boolean);

  test('the real capture yields Contract-1 records for the log events only', () => {
    const records = lines.map((l) => parseLogStreamLine(l)).filter(Boolean);
    // 5 captured lines: the banner and the activityCreateEvent are dropped.
    expect(lines.length).toBe(5);
    expect(records.length).toBe(3);
    for (const record of records) {
      expect(record.src).toBe('device');
      expect(SOURCES.includes(record.src)).toBeTruthy();
      expect(LEVELS.includes(record.level)).toBeTruthy();
      expect(typeof record.msg).toBe('string');
      expect(Number.isFinite(record.ts)).toBeTruthy();
    }
  });

  // The very first thing a live `log stream` writes is not JSON. A parser
  // that threw here would take the collector down before it recorded a line.
  test('the real non-JSON banner line is skipped, not thrown on', () => {
    expect(lines[0]).toMatch(/^Filtering the log data using/);
    expect(parseLogStreamLine(lines[0])).toBe(null);
  });

  // activityCreateEvent / activityTransitionEvent are tracing scaffolding
  // with no messageType; in the real capture they were a third of the volume.
  test('activity events are dropped: they carry a message but no level', () => {
    const activity = lines.find((l) => l.includes('"activityCreateEvent"'));
    expect(activity).toBeTruthy();
    expect(parseLogStreamLine(activity)).toBe(null);
  });

  test('messageType maps onto Contract 1, with Fault as fatal', () => {
    const byLevel = Object.fromEntries(
      lines
        .map((l) => parseLogStreamLine(l))
        .filter(Boolean)
        .map((r) => [r.level, r]),
    );
    expect(byLevel.info).toBeTruthy();
    expect(byLevel.error).toBeTruthy();
    expect(byLevel.fatal).toBeTruthy();
    expect(byLevel.fatal.msg).toMatch(/LocationProvider/);
  });

  test('the record carries the executable name from processImagePath', () => {
    const records = lines.map((l) => parseLogStreamLine(l)).filter(Boolean);
    expect(records.map((r) => r.proc).sort()).toEqual(['gamecontrollerd', 'locationd', 'pairedsyncd']);
  });

  // Apple's stamp is "2026-08-25 13:18:05.196749-0400": a space separator and
  // six fractional digits. `now` is pinned to 0 so a fallback would be
  // obvious rather than plausible.
  test("Apple's timestamp is parsed rather than replaced by the read time", () => {
    const logEvent = lines.find((l) => l.includes('"logEvent"'));
    const captured = JSON.parse(logEvent).timestamp;
    expect(captured).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[-+]\d{4}$/);
    expect(parseLogStreamLine(logEvent, { now: () => 0 }).ts).toBe(Date.parse(captured));
  });

  test('levelFromMessageType covers the documented set and defaults to info', () => {
    expect(levelFromMessageType('Debug')).toBe('debug');
    expect(levelFromMessageType('Info')).toBe('info');
    expect(levelFromMessageType('Default')).toBe('info');
    expect(levelFromMessageType('Error')).toBe('error');
    expect(levelFromMessageType('Fault')).toBe('fatal');
    // The unified log has no warning level at all, so warn is unreachable
    // here; inventing one from the message text would misclassify.
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

// --- the demotion list ---------------------------------------------------
//
// FIELD CASE. On a healthy Expo app on an iOS 26.5 simulator, `rn-iso logs
// --errors` returned 3,004 records and `status` said "3004 errors since the
// last marker". None of them were the app's: they were Apple's own frameworks
// logging at messageType Error from inside the app's process, plus the UIScene
// deprecation notice, which ships as a Fault and was therefore reported as
// FATAL on an app that was working.
//
// The events below are written in the log-stream ndjson shape, with the
// subsystem/category/message combinations the capture actually carried.
describe('ios: demoting device noise', () => {
  const app =
    '/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/ABC/MyApp.app/MyApp';
  const event = (over) => ({
    eventType: 'logEvent',
    messageType: 'Error',
    subsystem: '',
    category: '',
    processImagePath: app,
    timestamp: '2026-08-24 16:03:54.196749-0400',
    ...over,
  });

  // The flood: ~2/3 of the 3,004 lines. An RN app holds a websocket to Metro
  // and HTTP to the dev server, so com.apple.network never stops complaining.
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
      // The same emitter through CFNetwork's legacy path: no subsystem at all,
      // so there is nothing but the message to match on.
      event({
        eventMessage:
          'nw_connection_copy_connected_local_endpoint_block_invoke [C2] Client called nw_connection_copy_connected_local_endpoint on unconnected nw_connection',
      }),
      event({ eventMessage: 'nw_read_request_report [C3] Receive failed with error "Socket is not connected"' }),
    ];
    for (const e of flood) {
      const record = parseLogStreamLine(JSON.stringify(e));
      expect(record.level).toBe('info');
      // Captured, not dropped: `logs` still shows it, `--errors` does not.
      expect(record.msg).toBe(e.eventMessage);
      expect(record.src).toBe('device');
      expect(record.proc).toBe('MyApp');
    }
  });

  // The one record the field capture classified FATAL on a healthy app.
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
    expect(record.level).toBe('info');
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
    // Every rule in the list is exercised above or in the tests around it.
    const covered = new Set([
      ...cases.map(([id]) => id),
      'network',
      'network-default-subsystem',
      'uiscene-deprecation',
    ]);
    expect(NOISE_RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  // The direction that matters: the list is an allowlist for DEMOTION, not a
  // filter for what counts as an error. Anything not on it keeps its level.
  test("the app's own error is untouched, and so is an unlisted system one", () => {
    const own = event({ eventMessage: '[Error: Exception in HostFunction]' });
    expect(noiseRuleId(own)).toBe(null);
    expect(parseLogStreamLine(JSON.stringify(own)).level).toBe('error');

    // From the real fixture: pairedsync and locationd are not on the list.
    const unlisted = event({
      subsystem: 'com.apple.pairedsync',
      category: 'daemon',
      eventMessage: 'Fatal error: pairing store path was nil for PSDFileManager.',
    });
    expect(levelForEvent(unlisted)).toBe('error');
    expect(levelForEvent({ ...unlisted, messageType: 'Fault' })).toBe('fatal');
  });

  // A rule can only ever demote. A subsystem on the list that logs at Default
  // must not be pushed up, and a demotion must not change anything else.
  test('demotion never promotes, and never fires below error', () => {
    const chatty = event({
      messageType: 'Default',
      subsystem: 'com.apple.network',
      eventMessage: 'nw_socket ordinary chatter',
    });
    expect(levelForEvent(chatty)).toBe('info');
    expect(levelForEvent({ ...chatty, messageType: 'Debug' })).toBe('debug');
  });

  // A subsystem rule matches the subsystem and its children, not a prefix that
  // merely starts the same way -- com.apple.networkextension is a different
  // component and keeps its errors.
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
    const records = lines.map((l) => parseLogcatLine(l)).filter(Boolean);
    expect(lines.length).toBe(6);
    expect(records.length).toBe(5);
    for (const record of records) {
      expect(record.src).toBe('device');
      expect(LEVELS.includes(record.level)).toBeTruthy();
      expect(Number.isFinite(record.ts)).toBeTruthy();
    }
  });

  test('the real buffer banner is skipped rather than recorded raw', () => {
    expect(lines[0]).toBe('--------- beginning of system');
    expect(parseLogcatLine(lines[0])).toBe(null);
  });

  test('the real V/D/I/W/E lines map onto Contract 1 levels', () => {
    const levels = lines
      .map((l) => parseLogcatLine(l))
      .filter(Boolean)
      .map((r) => r.level);
    expect([...levels].sort()).toEqual(['debug', 'debug', 'error', 'info', 'warn']);
  });

  test('the tag and pid become proc, and the message keeps its own colons', () => {
    const record = parseLogcatLine(
      '08-21 17:51:19.669 E/keystore2(  245): system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680',
    );
    expect(record.proc).toBe('keystore2(245)');
    expect(record.level).toBe('error');
    expect(record.msg).toBe(
      'system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680',
    );
  });

  // SYNTHESIZED: the emulator's buffer held no F(atal) line at capture time.
  // The format is the same `-v time` layout documented in `man logcat`.
  test('a fatal line maps to fatal (synthesized: no F line was in the captured buffer)', () => {
    const record = parseLogcatLine(
      '08-21 17:52:03.115 F/libc    ( 9182): Fatal signal 11 (SIGSEGV), code 1 in tid 9182 (com.example.app)',
    );
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

  // `-v time` carries no year. A December line read in January must not land
  // eleven months in the future, where it would sort to the end of the merged
  // timeline and be the first thing `logs` shows.
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

  // Captured from a live emulator: `adb shell pidof -s com.android.settings`
  // printed "3132" and exited 0; an unknown package printed nothing.
  test('parsePidof reads the single pid, and nothing from empty output', () => {
    expect(parsePidof('3132\n')).toBe(3132);
    expect(parsePidof('')).toBe(null);
    expect(parsePidof('\r\n')).toBe(null);
    expect(parsePidof(null)).toBe(null);
    // Without -s, pidof can print several; the first is still a real pid.
    expect(parsePidof('3132 3155\n')).toBe(3132);
  });

  // Android never produced the iOS storm, because --pid already excludes the
  // system daemons. What it does let through is the system code running INSIDE
  // the app process: the emulator's graphics stack and the zip loader, at E,
  // on a launch that worked.
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
        expect(record.level).toBe('info');
        expect(record.msg.length > 0).toBeTruthy();
      }
    });

    test("an unlisted tag keeps its E, including the app's own", () => {
      expect(
        parseLogcatLine('08-21 17:51:19.669 E/ReactNativeJS( 9182): [Error: Exception in HostFunction]').level,
      ).toBe('error');
      // From the real fixture.
      expect(
        parseLogcatLine('08-21 17:51:19.669 E/keystore2(  245): system/security/keystore2/src/error.rs:183').level,
      ).toBe('error');
    });

    // There is no benign F inside an app process: it is libc reporting a
    // signal or ART aborting. A noisy tag does not buy an exemption from that.
    test('F is never demoted, even from a listed tag', () => {
      expect(levelForLogcat('F', 'libEGL')).toBe('fatal');
      expect(
        parseLogcatLine('08-21 17:52:03.115 F/libc    ( 9182): Fatal signal 11 (SIGSEGV), code 1 in tid 9182').level,
      ).toBe('fatal');
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

// --- watchAppPid: the app restart the collector used to sleep through ------
describe('watchAppPid', () => {
  // A hand-driven timer, so a 3-second poll costs nothing and every tick is
  // deliberate.
  function driver() {
    const queue = [];
    return {
      // A fake timer handle: watchAppPid only ever hands it back to clearTimer,
      // so a number stands in for Node's Timeout, cast once here.
      setTimer: (fn: () => void): ReturnType<typeof setTimeout> => {
        queue.push(fn);
        return queue.length as unknown as ReturnType<typeof setTimeout>;
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
    const seen = [];
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
    const seen = [];
    let answer = null;
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
    const seen = [];
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
    delete process.env.RN_ISO_PID_WATCH_MS;
    expect(pidWatchInterval()).toBe(3000);
    process.env.RN_ISO_PID_WATCH_MS = '100';
    expect(pidWatchInterval()).toBe(100);
    process.env.RN_ISO_PID_WATCH_MS = 'nonsense';
    expect(pidWatchInterval()).toBe(3000);
    delete process.env.RN_ISO_PID_WATCH_MS;
  });
});
