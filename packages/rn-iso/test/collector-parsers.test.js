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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appNameFromBundleId,
  levelFromMessageType,
  logStreamArgs,
  parseLogStreamLine,
  procFromImagePath,
} from '../src/collector/ios.js';
import {
  levelFromLogcatLetter,
  logcatArgs,
  parseLogcatLine,
  parseLogcatTimestamp,
  parsePidof,
} from '../src/collector/android.js';
import { LEVELS, SOURCES } from '../src/ndjson.js';

function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf-8');
}

describe('ios: log stream ndjson', () => {
  const lines = fixture('ios-log-stream.ndjson').split('\n').filter(Boolean);

  test('the real capture yields Contract-1 records for the log events only', () => {
    const records = lines.map(l => parseLogStreamLine(l)).filter(Boolean);
    // 5 captured lines: the banner and the activityCreateEvent are dropped.
    assert.equal(lines.length, 5);
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.src, 'device');
      assert.ok(SOURCES.includes(record.src));
      assert.ok(LEVELS.includes(record.level));
      assert.equal(typeof record.msg, 'string');
      assert.ok(Number.isFinite(record.ts));
    }
  });

  // The very first thing a live `log stream` writes is not JSON. A parser
  // that threw here would take the collector down before it recorded a line.
  test('the real non-JSON banner line is skipped, not thrown on', () => {
    assert.match(lines[0], /^Filtering the log data using/);
    assert.equal(parseLogStreamLine(lines[0]), null);
  });

  // activityCreateEvent / activityTransitionEvent are tracing scaffolding
  // with no messageType; in the real capture they were a third of the volume.
  test('activity events are dropped: they carry a message but no level', () => {
    const activity = lines.find(l => l.includes('"activityCreateEvent"'));
    assert.ok(activity, 'the fixture must contain a real activity event');
    assert.equal(parseLogStreamLine(activity), null);
  });

  test('messageType maps onto Contract 1, with Fault as fatal', () => {
    const byLevel = Object.fromEntries(
      lines.map(l => parseLogStreamLine(l)).filter(Boolean).map(r => [r.level, r])
    );
    assert.ok(byLevel.info, 'the Default event becomes info');
    assert.ok(byLevel.error, 'the Error event becomes error');
    assert.ok(byLevel.fatal, 'the Fault event becomes fatal');
    assert.match(byLevel.fatal.msg, /LocationProvider/);
  });

  test('the record carries the executable name from processImagePath', () => {
    const records = lines.map(l => parseLogStreamLine(l)).filter(Boolean);
    assert.deepEqual(records.map(r => r.proc).sort(), ['gamecontrollerd', 'locationd', 'pairedsyncd']);
  });

  // Apple's stamp is "2026-08-25 13:18:05.196749-0400": a space separator and
  // six fractional digits. `now` is pinned to 0 so a fallback would be
  // obvious rather than plausible.
  test("Apple's timestamp is parsed rather than replaced by the read time", () => {
    const logEvent = lines.find(l => l.includes('"logEvent"'));
    const captured = JSON.parse(logEvent).timestamp;
    assert.match(captured, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[-+]\d{4}$/);
    assert.equal(parseLogStreamLine(logEvent, { now: () => 0 }).ts, Date.parse(captured));
  });

  test('levelFromMessageType covers the documented set and defaults to info', () => {
    assert.equal(levelFromMessageType('Debug'), 'debug');
    assert.equal(levelFromMessageType('Info'), 'info');
    assert.equal(levelFromMessageType('Default'), 'info');
    assert.equal(levelFromMessageType('Error'), 'error');
    assert.equal(levelFromMessageType('Fault'), 'fatal');
    // The unified log has no warning level at all, so warn is unreachable
    // here; inventing one from the message text would misclassify.
    assert.equal(levelFromMessageType('Warning'), 'info');
    assert.equal(levelFromMessageType(undefined), 'info');
  });

  test('procFromImagePath takes the executable, not the bundle directory', () => {
    assert.equal(
      procFromImagePath('/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/ABC/MyApp.app/MyApp'),
      'MyApp'
    );
    assert.equal(procFromImagePath(null), null);
  });

  test('an empty or whitespace-only eventMessage is not a record', () => {
    assert.equal(parseLogStreamLine('{"eventType":"logEvent","messageType":"Default","eventMessage":"   "}'), null);
  });

  test('logStreamArgs is the exact argv, with the predicate quoted for the device', () => {
    assert.deepEqual(logStreamArgs('U1', 'MyApp'), [
      'simctl', 'spawn', 'U1',
      'log', 'stream',
      '--style', 'ndjson',
      '--predicate', 'processImagePath CONTAINS[c] "MyApp"',
    ]);
  });

  test('appNameFromBundleId is the last segment, as a fallback for a caller with only a bundle id', () => {
    assert.equal(appNameFromBundleId('com.example.MyApp'), 'MyApp');
    assert.equal(appNameFromBundleId('MyApp'), 'MyApp');
  });
});

describe('android: logcat -v time', () => {
  const lines = fixture('android-logcat-time.txt').split('\n').filter(Boolean);

  test('every real level line parses into a Contract-1 record', () => {
    const records = lines.map(l => parseLogcatLine(l)).filter(Boolean);
    assert.equal(lines.length, 6);
    assert.equal(records.length, 5, 'the buffer banner is the one line that is not app output');
    for (const record of records) {
      assert.equal(record.src, 'device');
      assert.ok(LEVELS.includes(record.level));
      assert.ok(Number.isFinite(record.ts));
    }
  });

  test('the real buffer banner is skipped rather than recorded raw', () => {
    assert.equal(lines[0], '--------- beginning of system');
    assert.equal(parseLogcatLine(lines[0]), null);
  });

  test('the real V/D/I/W/E lines map onto Contract 1 levels', () => {
    const levels = lines.map(l => parseLogcatLine(l)).filter(Boolean).map(r => r.level);
    assert.deepEqual([...levels].sort(), ['debug', 'debug', 'error', 'info', 'warn']);
  });

  test('the tag and pid become proc, and the message keeps its own colons', () => {
    const record = parseLogcatLine('08-21 17:51:19.669 E/keystore2(  245): system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680');
    assert.equal(record.proc, 'keystore2(245)');
    assert.equal(record.level, 'error');
    assert.equal(record.msg, 'system/security/keystore2/src/error.rs:183 - system/security/keystore2/src/security_level.rs:680');
  });

  // SYNTHESIZED: the emulator's buffer held no F(atal) line at capture time.
  // The format is the same `-v time` layout documented in `man logcat`.
  test('a fatal line maps to fatal (synthesized: no F line was in the captured buffer)', () => {
    const record = parseLogcatLine('08-21 17:52:03.115 F/libc    ( 9182): Fatal signal 11 (SIGSEGV), code 1 in tid 9182 (com.example.app)');
    assert.equal(record.level, 'fatal');
    assert.match(record.msg, /SIGSEGV/);
  });

  test('levelFromLogcatLetter covers the priority letters and defaults to info', () => {
    assert.deepEqual(
      ['V', 'D', 'I', 'W', 'E', 'F', 'A'].map(levelFromLogcatLetter),
      ['debug', 'debug', 'info', 'warn', 'error', 'fatal', 'fatal']
    );
    assert.equal(levelFromLogcatLetter('?'), 'info');
  });

  // `-v time` carries no year. A December line read in January must not land
  // eleven months in the future, where it would sort to the end of the merged
  // timeline and be the first thing `logs` shows.
  test('the missing year comes from the reference clock, and a future stamp rolls back', () => {
    const jan = Date.parse('2027-01-02T10:00:00Z');
    const dec = parseLogcatTimestamp({ month: 12, day: 28, hour: 23, minute: 0, second: 0, millis: 0 }, jan);
    assert.ok(dec < jan, 'a December line read in January belongs to the previous year');
    assert.equal(new Date(dec).getFullYear(), 2026);

    const sameDay = parseLogcatTimestamp({ month: 1, day: 2, hour: 9, minute: 0, second: 0, millis: 0 }, jan);
    assert.equal(new Date(sameDay).getFullYear(), 2027);
  });

  test('logcatArgs is the exact argv', () => {
    assert.deepEqual(logcatArgs('emulator-5554', 3132), ['-s', 'emulator-5554', 'logcat', '--pid', '3132', '-v', 'time']);
  });

  // Captured from a live emulator: `adb shell pidof -s com.android.settings`
  // printed "3132" and exited 0; an unknown package printed nothing.
  test('parsePidof reads the single pid, and nothing from empty output', () => {
    assert.equal(parsePidof('3132\n'), 3132);
    assert.equal(parsePidof(''), null);
    assert.equal(parsePidof('\r\n'), null);
    assert.equal(parsePidof(null), null);
    // Without -s, pidof can print several; the first is still a real pid.
    assert.equal(parsePidof('3132 3155\n'), 3132);
  });
});
