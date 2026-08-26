// Querying the merged timeline. The one query that has to be exactly right is
// --errors: it is what an agent loop polls after a build, and an empty result
// is its pass condition. Its window is "since the last marker across ALL
// sources", so a build launch marker written to build-ios.ndjson resets the
// window for client errors too -- otherwise the previous run's redbox reads as
// this run's failure forever.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSince,
  compileGrep,
  recordMatches,
  markerWindow,
  queryLogs,
  readLogRecords,
  ERROR_SOURCES,
  logFiles,
  fileSizes,
  tailRead,
  advanceTail,
} from '../src/logs-query.ts';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-iso-logsq-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name, records) {
  writeFileSync(join(dir, name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

function readAll() {
  return readLogRecords(dir);
}

describe('parseSince', () => {
  test('accepts the documented units', () => {
    assert.deepEqual(parseSince('30s'), { ms: 30000 });
    assert.deepEqual(parseSince('5m'), { ms: 300000 });
    assert.deepEqual(parseSince('2h'), { ms: 7200000 });
    assert.deepEqual(parseSince('0s'), { ms: 0 });
  });

  test('tolerates surrounding whitespace and a capital unit', () => {
    assert.deepEqual(parseSince(' 5M '), { ms: 300000 });
  });

  // The failure mode this replaces: parseInt('soon') is NaN, every comparison
  // against it is false, and the query silently returns nothing.
  test('rejects garbage with a message naming the input and the accepted forms', () => {
    for (const bad of ['soon', '5', '5x', '-3m', '', '  ', 'm', '1.5h', undefined, null, 12]) {
      const r = parseSince(bad);
      assert.equal(r.ms, undefined, `${String(bad)} must not parse`);
      assert.equal(typeof r.error, 'string');
      assert.match(r.error, /30s|5m|2h/, 'the error shows the accepted forms');
    }
    assert.match(parseSince('soon').error, /soon/);
  });
});

describe('compileGrep', () => {
  test('compiles a pattern', () => {
    const { re } = compileGrep('fail(ed)?');
    assert.equal(re.test('this failed'), true);
    assert.equal(re.test('nothing here'), false);
  });

  test('reports an invalid pattern instead of throwing', () => {
    const r = compileGrep('[unterminated');
    assert.equal(r.re, undefined);
    assert.match(r.error, /\[unterminated/);
  });
});

// A marker closes the window for the sources it can speak for, so the scan
// returns two numbers: the last LAUNCH (src build -- a new run of the app
// starts here, everything before it is history) and the last BUNDLE (src
// metro -- the bundler is happy, which says nothing about the app).
describe('markerWindow', () => {
  test('separates the launch marker from the bundle marker', () => {
    const records = [
      { ts: 1, src: 'metro', level: 'info', msg: 'bundle build done', marker: true },
      { ts: 9, src: 'build', level: 'info', msg: 'launched', marker: true },
      { ts: 11, src: 'metro', level: 'info', msg: 'bundle build done', marker: true },
      { ts: 5, src: 'client', level: 'error', msg: 'boom' },
    ];
    assert.deepEqual(markerWindow(records), { launchTs: 9, bundleTs: 11 });
  });

  test('each one is the highest of its own kind, not the last seen', () => {
    assert.deepEqual(markerWindow([
      { ts: 30, src: 'metro', level: 'info', msg: 'b2', marker: true },
      { ts: 10, src: 'metro', level: 'info', msg: 'b1', marker: true },
      { ts: 20, src: 'build', level: 'info', msg: 'launch', marker: true },
    ]), { launchTs: 20, bundleTs: 30 });
  });

  test('returns nulls when nothing is marked', () => {
    assert.deepEqual(markerWindow([{ ts: 1, msg: 'a' }]), { launchTs: null, bundleTs: null });
    assert.deepEqual(markerWindow([]), { launchTs: null, bundleTs: null });
  });

  test('ignores a marker with no usable ts', () => {
    assert.deepEqual(markerWindow([{ src: 'metro', msg: 'a', marker: true }]), { launchTs: null, bundleTs: null });
  });

  // Conservative on purpose: an unrecognised marker source resets EVERYTHING,
  // so a producer added later shows more rather than silently less.
  test('a marker from any source other than metro counts as a launch', () => {
    assert.deepEqual(markerWindow([{ ts: 4, src: 'device', level: 'info', msg: 'x', marker: true }]), { launchTs: 4, bundleTs: null });
  });
});

describe('recordMatches', () => {
  const rec = { ts: 100, src: 'metro', level: 'warn', msg: 'bundle failed' };

  test('no criteria matches everything', () => {
    assert.equal(recordMatches(rec, {}), true);
  });

  test('sources filters on the record src, not the file it came from', () => {
    assert.equal(recordMatches(rec, { sources: ['metro'] }), true);
    assert.equal(recordMatches(rec, { sources: ['client'] }), false);
    assert.equal(recordMatches(rec, { sources: ['client', 'metro'] }), true);
  });

  test('minLevel is a floor, not an equality test', () => {
    assert.equal(recordMatches(rec, { minLevel: 'debug' }), true);
    assert.equal(recordMatches(rec, { minLevel: 'warn' }), true);
    assert.equal(recordMatches(rec, { minLevel: 'error' }), false);
  });

  test('grep matches the message', () => {
    assert.equal(recordMatches(rec, { grep: /failed/ }), true);
    assert.equal(recordMatches(rec, { grep: /succeeded/ }), false);
  });

  test('sinceTs is inclusive', () => {
    assert.equal(recordMatches(rec, { sinceTs: 100 }), true);
    assert.equal(recordMatches(rec, { sinceTs: 101 }), false);
  });

  test('errorsOnly keeps error and fatal and nothing else', () => {
    assert.equal(recordMatches(rec, { errorsOnly: true }), false);
    assert.equal(recordMatches({ ...rec, level: 'error' }, { errorsOnly: true }), true);
    assert.equal(recordMatches({ ...rec, level: 'fatal' }, { errorsOnly: true }), true);
  });

  test('errorsOnly with a marker window excludes anything at or before the marker', () => {
    const err = { ...rec, level: 'error' };
    assert.equal(recordMatches(err, { errorsOnly: true, markerTs: 100 }), false);
    assert.equal(recordMatches({ ...err, ts: 101 }, { errorsOnly: true, markerTs: 100 }), true);
  });
});

describe('logFiles', () => {
  test('lists only .ndjson files, sorted, ignoring supervisor.log', () => {
    writeLog('metro.ndjson', []);
    writeLog('client.ndjson', []);
    writeFileSync(join(dir, 'supervisor.log'), 'raw stdio\n');
    mkdirSync(join(dir, 'nested.ndjson'));
    assert.deepEqual(logFiles(dir), ['client.ndjson', 'metro.ndjson']);
  });

  test('a missing directory is not an error', () => {
    assert.deepEqual(logFiles(join(dir, 'nope')), []);
  });
});

describe('queryLogs', () => {
  test('returns [] for a missing directory', () => {
    assert.deepEqual(queryLogs({ dir: join(dir, 'nope') }), []);
  });

  test('returns [] for an empty directory', () => {
    assert.deepEqual(queryLogs({ dir }), []);
  });

  test('k-way merges every file ascending by ts', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'info', msg: 'm1' },
      { ts: 5, src: 'metro', level: 'info', msg: 'm5' },
    ]);
    writeLog('client.ndjson', [
      { ts: 2, src: 'client', level: 'info', msg: 'c2' },
      { ts: 9, src: 'client', level: 'info', msg: 'c9' },
    ]);
    writeLog('build-ios.ndjson', [{ ts: 3, src: 'build', level: 'info', msg: 'b3' }]);
    assert.deepEqual(queryLogs({ dir }).map((r) => r.msg), ['m1', 'c2', 'b3', 'm5', 'c9']);
  });

  test('skips corrupt lines instead of failing the query', () => {
    writeFileSync(
      join(dir, 'metro.ndjson'),
      '{"ts":1,"src":"metro","level":"info","msg":"ok"}\nnot json\n{"ts":2,"src":"met',
    );
    assert.deepEqual(queryLogs({ dir }).map((r) => r.msg), ['ok']);
  });

  test('sorts records with no usable ts last rather than crashing', () => {
    writeLog('metro.ndjson', [
      { src: 'metro', level: 'info', msg: 'no-ts' },
      { ts: 'nope', src: 'metro', level: 'info', msg: 'bad-ts' },
      { ts: 2, src: 'metro', level: 'info', msg: 'has-ts' },
    ]);
    assert.deepEqual(queryLogs({ dir }).map((r) => r.msg), ['has-ts', 'no-ts', 'bad-ts']);
  });

  test('filters by source', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'm' }]);
    writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'info', msg: 'c' }]);
    assert.deepEqual(queryLogs({ dir, sources: ['client'] }).map((r) => r.msg), ['c']);
  });

  test('filters by minimum level', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'debug', msg: 'd' },
      { ts: 2, src: 'metro', level: 'warn', msg: 'w' },
      { ts: 3, src: 'metro', level: 'fatal', msg: 'f' },
    ]);
    assert.deepEqual(queryLogs({ dir, minLevel: 'warn' }).map((r) => r.msg), ['w', 'f']);
  });

  test('--since is relative to the injected now', () => {
    writeLog('metro.ndjson', [
      { ts: 1000, src: 'metro', level: 'info', msg: 'old' },
      { ts: 9000, src: 'metro', level: 'info', msg: 'recent' },
    ]);
    assert.deepEqual(queryLogs({ dir, since: '5s', now: 10000 }).map((r) => r.msg), ['recent']);
  });

  test('an unparseable --since throws a structured error rather than returning nothing', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'a' }]);
    assert.throws(() => queryLogs({ dir, since: 'soon' }), /soon/);
  });

  test('filters by grep, accepting a string or a RegExp', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'info', msg: 'Unable to resolve module lodash' },
      { ts: 2, src: 'metro', level: 'info', msg: 'Bundling complete' },
    ]);
    assert.deepEqual(queryLogs({ dir, grep: 'resolve module' }).map((r) => r.ts), [1]);
    assert.deepEqual(queryLogs({ dir, grep: /^Bundling/ }).map((r) => r.ts), [2]);
  });

  test('tail keeps the LAST n records, still ascending', () => {
    writeLog('metro.ndjson', [1, 2, 3, 4, 5].map((ts) => ({ ts, src: 'metro', level: 'info', msg: `m${ts}` })));
    assert.deepEqual(queryLogs({ dir, tail: 2 }).map((r) => r.msg), ['m4', 'm5']);
    assert.deepEqual(queryLogs({ dir, tail: 99 }).length, 5);
  });

  test('tail is applied after filtering, not before', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'error', msg: 'e1' },
      { ts: 2, src: 'metro', level: 'debug', msg: 'd' },
      { ts: 3, src: 'metro', level: 'error', msg: 'e2' },
    ]);
    assert.deepEqual(queryLogs({ dir, minLevel: 'error', tail: 2 }).map((r) => r.msg), ['e1', 'e2']);
  });

  describe('errorsOnly', () => {
    test('with no marker anywhere, returns every error and fatal in the log', () => {
      writeLog('metro.ndjson', [
        { ts: 1, src: 'metro', level: 'warn', msg: 'w' },
        { ts: 2, src: 'metro', level: 'error', msg: 'e' },
        { ts: 3, src: 'metro', level: 'fatal', msg: 'f' },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg), ['e', 'f']);
    });

    test('returns [] when nothing failed -- the agent loop pass condition', () => {
      writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'ok', marker: true }]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
    });

    // THE contract case: the marker lives in another file entirely.
    test('a build marker resets the window for client errors too', () => {
      writeLog('client.ndjson', [
        { ts: 10, src: 'client', level: 'error', msg: 'stale redbox from the last run' },
        { ts: 30, src: 'client', level: 'error', msg: 'fresh redbox' },
      ]);
      writeLog('build-ios.ndjson', [
        { ts: 20, src: 'build', level: 'info', msg: 'app launched', marker: true },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg), ['fresh redbox']);
    });

    test('the window is the LAST marker, not the first', () => {
      writeLog('metro.ndjson', [
        { ts: 1, src: 'metro', level: 'info', msg: 'build 1', marker: true },
        { ts: 2, src: 'metro', level: 'error', msg: 'error between builds' },
        { ts: 3, src: 'metro', level: 'info', msg: 'build 2', marker: true },
        { ts: 4, src: 'metro', level: 'error', msg: 'error after build 2' },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg), ['error after build 2']);
    });

    test('an error at the exact marker ts belongs to the previous window', () => {
      writeLog('metro.ndjson', [
        { ts: 5, src: 'metro', level: 'error', msg: 'same instant' },
        { ts: 5, src: 'metro', level: 'info', msg: 'marker', marker: true },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
    });

    test('combines with --source and --since', () => {
      writeLog('client.ndjson', [{ ts: 30, src: 'client', level: 'error', msg: 'client err' }]);
      writeLog('metro.ndjson', [
        { ts: 20, src: 'metro', level: 'info', msg: 'm', marker: true },
        { ts: 31, src: 'metro', level: 'error', msg: 'metro err' },
      ]);
      assert.deepEqual(
        queryLogs({ dir, errorsOnly: true, sources: ['client'] }).map((r) => r.msg),
        ['client err'],
      );
      assert.deepEqual(
        queryLogs({ dir, errorsOnly: true, since: '5s', now: 33000 }).map((r) => r.msg),
        [],
      );
    });
  });

  // --- the field sequences -------------------------------------------------
  //
  // Two real e2e runs against a real app produced these. They are written with
  // wall-clock timestamps because the ORDER and the GAP are the whole bug: one
  // second between a crash and the marker that swallowed it.
  describe('errorsOnly, against the field capture', () => {
    const at = (sec, ms = 0) => Date.parse(`2026-08-24T16:03:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);

    // THE bug. The app threw at 16:03:54 while evaluating the bundle; Metro
    // wrote bundle_build_done at 16:03:55, one second LATER, because the
    // bundler finishes accounting for a build after the client has already run
    // it. A single "last marker across all sources" cutoff read that marker as
    // "everything before me is history" and reported a healthy app.
    test('a bundle marker 1s after a startup crash does not hide it', () => {
      writeLog('build-ios.ndjson', [
        { ts: at(50), src: 'build', level: 'info', msg: 'launched com.example.app', marker: true },
      ]);
      writeLog('client.ndjson', [
        { ts: at(54), src: 'client', level: 'error', msg: '[Error: Exception in HostFunction]' },
      ]);
      writeLog('metro.ndjson', [
        { ts: at(55), src: 'metro', level: 'info', msg: 'bundle build done (1)', marker: true },
      ]);

      // The marker IS later than the error -- this is not a sorting accident.
      const window = markerWindow(readAll());
      assert.ok(window.bundleTs > at(54));
      assert.equal(window.launchTs, at(50));

      assert.deepEqual(
        queryLogs({ dir, errorsOnly: true }).map((r) => r.msg),
        ['[Error: Exception in HostFunction]'],
      );
    });

    // The other direction, which the same rule has to keep: a bundle marker is
    // exactly the right thing to retire a METRO error with, because a bundle
    // that built is proof the resolve failure was fixed.
    test('a bundle marker still retires the metro error the rebuild fixed', () => {
      writeLog('metro.ndjson', [
        { ts: at(40), src: 'metro', level: 'error', msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"' },
        { ts: at(55), src: 'metro', level: 'info', msg: 'bundle build done (2)', marker: true },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
    });

    // And a launch marker retires everything, which is what stops the previous
    // run's redbox from being reported forever.
    test('a launch marker retires a client error that preceded it', () => {
      writeLog('client.ndjson', [{ ts: at(40), src: 'client', level: 'error', msg: 'last run redbox' }]);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
    });

    // Metro errors clear both cutoffs: the later of the two wins, so a bundle
    // error from BEFORE this run's launch is history even with no rebuild.
    test('a metro error before the launch marker is history too', () => {
      writeLog('metro.ndjson', [{ ts: at(40), src: 'metro', level: 'error', msg: 'stale bundling error' }]);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
    });

    // The tailwind failure as it was ACTUALLY stored during the field test:
    // level info, because the supervisor's expo-child vocabulary did not know
    // "Bundling failed" / "Unable to resolve" yet (that fix is elsewhere).
    // Neither of this file's fixes invents it as an error, and neither hides
    // it from a plain query -- so whichever way that lands, this is correct.
    test('a bundling failure stored at info is not an error, but is still in the timeline', () => {
      writeLog('metro.ndjson', [
        { ts: at(40), src: 'metro', level: 'info', raw: true, msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"' },
      ]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), []);
      assert.equal(queryLogs({ dir }).length, 1);
      // ...and the moment its level is right, the window rule reports it.
      writeLog('metro.ndjson', [
        { ts: at(40), src: 'metro', level: 'error', raw: true, msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"' },
      ]);
      assert.equal(queryLogs({ dir, errorsOnly: true }).length, 1);
    });
  });

  // --- the default scope ---------------------------------------------------
  //
  // The same field run returned 3,004 records from `--errors`, every one of
  // them iOS syslog from inside the app's process. collector/ios.js demotes
  // the proven offenders; this is the other half, for the ones nobody has
  // curated yet: device is not in the default scope of --errors at all.
  describe('errorsOnly, scope', () => {
    test('ERROR_SOURCES is metro, client and build -- the app talking, not the OS', () => {
      assert.deepEqual(ERROR_SOURCES, ['metro', 'client', 'build']);
    });

    test('a device-only noise storm is zero errors', () => {
      const storm = [];
      for (let i = 0; i < 3004; i += 1) {
        storm.push({ ts: 1000 + i, src: 'device', level: 'error', proc: 'MyApp', msg: `nw_socket_handle_socket_event [C${i}:1] Socket SO_ERROR [54: Connection reset by peer]` });
      }
      writeLog('device.ndjson', storm);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }), [], 'this was the 3004');
      // Nothing was dropped from the capture: they are one flag away.
      assert.equal(queryLogs({ dir, errorsOnly: true, sources: ['device'] }).length, 3004);
      assert.equal(queryLogs({ dir }).length, 3004);
    });

    test('the app\'s own error is still reported while the device is excluded', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'fatal', msg: 'UIScene lifecycle will soon be required' }]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: '[Error: Exception in HostFunction]' }]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg), ['[Error: Exception in HostFunction]']);
    });

    test('an explicit --source device (or all) opts back in', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'native crash' }]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: 'js crash' }]);
      assert.deepEqual(queryLogs({ dir, errorsOnly: true, sources: ['device'] }).map((r) => r.msg), ['native crash']);
      assert.deepEqual(
        queryLogs({ dir, errorsOnly: true, sources: ['metro', 'client', 'device', 'build'] }).map((r) => r.msg),
        ['native crash', 'js crash'],
      );
    });

    test('a plain query (no --errors) still shows every source', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'device line' }]);
      assert.deepEqual(queryLogs({ dir }).map((r) => r.msg), ['device line']);
      assert.deepEqual(queryLogs({ dir, minLevel: 'error' }).map((r) => r.msg), ['device line']);
    });
  });
});

describe('incremental tailing', () => {
  test('fileSizes reports a byte size per log file, and {} for a missing dir', () => {
    writeFileSync(join(dir, 'metro.ndjson'), 'abcde');
    assert.deepEqual(fileSizes(dir), { 'metro.ndjson': 5 });
    assert.deepEqual(fileSizes(join(dir, 'nope')), {});
  });

  test('tailRead resumes from the previous offset', () => {
    assert.deepEqual(tailRead({ offset: 10, partial: 'x' }, 40), {
      start: 10,
      prev: { offset: 10, partial: 'x' },
    });
  });

  // A truncated file (a supervisor restart that rotated it) must not be read
  // from an offset past its end, which would silently stall the follower.
  test('tailRead restarts from zero when the file shrank', () => {
    assert.deepEqual(tailRead({ offset: 100, partial: 'x' }, 4), {
      start: 0,
      prev: { offset: 0, partial: '' },
    });
  });

  test('tailRead treats a brand new file as starting at zero', () => {
    assert.deepEqual(tailRead(undefined, 12), { start: 0, prev: { offset: 0, partial: '' } });
  });

  test('advanceTail yields complete lines and holds the partial one back', () => {
    const chunk = '{"ts":1,"msg":"a"}\n{"ts":2,"ms';
    const r = advanceTail({ offset: 0, partial: '' }, chunk, chunk.length);
    assert.deepEqual(r.records.map((x) => x.msg), ['a']);
    assert.equal(r.state.partial, '{"ts":2,"ms');
    assert.equal(r.state.offset, chunk.length);
  });

  test('advanceTail completes a line split across two polls', () => {
    const first = advanceTail({ offset: 0, partial: '' }, '{"ts":2,"ms', 11);
    assert.deepEqual(first.records, []);
    const second = advanceTail(first.state, 'g":"b"}\n', 19);
    assert.deepEqual(second.records.map((x) => x.msg), ['b']);
    assert.equal(second.state.partial, '');
    assert.equal(second.state.offset, 19);
  });

  test('advanceTail skips a corrupt line without losing the next one', () => {
    const chunk = 'garbage\n{"ts":3,"msg":"c"}\n';
    const r = advanceTail({ offset: 0, partial: '' }, chunk, chunk.length);
    assert.deepEqual(r.records.map((x) => x.msg), ['c']);
  });

  test('advanceTail on an empty chunk changes nothing but the offset', () => {
    const r = advanceTail({ offset: 7, partial: 'abc' }, '', 7);
    assert.deepEqual(r.records, []);
    assert.equal(r.state.partial, 'abc');
    assert.equal(r.state.offset, 7);
  });
});
