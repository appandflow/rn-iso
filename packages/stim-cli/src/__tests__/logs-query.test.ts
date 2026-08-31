import assert from 'node:assert';
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
} from '../logs-query.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-logsq-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, records: unknown[]) {
  writeFileSync(join(dir, name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

function readAll() {
  return readLogRecords(dir);
}

describe('parseSince', () => {
  test('accepts the documented units', () => {
    expect(parseSince('30s')).toEqual({ ms: 30000 });
    expect(parseSince('5m')).toEqual({ ms: 300000 });
    expect(parseSince('2h')).toEqual({ ms: 7200000 });
    expect(parseSince('0s')).toEqual({ ms: 0 });
  });

  test('tolerates surrounding whitespace and a capital unit', () => {
    expect(parseSince(' 5M ')).toEqual({ ms: 300000 });
  });

  test('rejects garbage with a message naming the input and the accepted forms', () => {
    for (const bad of ['soon', '5', '5x', '-3m', '', '  ', 'm', '1.5h', undefined, null, 12]) {
      const r = parseSince(bad);
      expect(r.ms).toBe(undefined);
      expect(typeof r.error).toBe('string');
      expect(r.error).toMatch(/30s|5m|2h/);
    }
    expect(parseSince('soon').error).toMatch(/soon/);
  });
});

describe('compileGrep', () => {
  test('compiles a pattern', () => {
    const { re } = compileGrep('fail(ed)?');
    assert(re);
    expect(re.test('this failed')).toBe(true);
    expect(re.test('nothing here')).toBe(false);
  });

  test('reports an invalid pattern instead of throwing', () => {
    const r = compileGrep('[unterminated');
    expect(r.re).toBe(undefined);
    expect(r.error).toMatch(/\[unterminated/);
  });
});

describe('markerWindow', () => {
  test('separates the launch marker from the bundle marker', () => {
    const records = [
      { ts: 1, src: 'metro', level: 'info', msg: 'bundle build done', marker: true },
      { ts: 9, src: 'build', level: 'info', msg: 'launched', marker: true },
      { ts: 11, src: 'metro', level: 'info', msg: 'bundle build done', marker: true },
      { ts: 5, src: 'client', level: 'error', msg: 'boom' },
    ];
    expect(markerWindow(records)).toEqual({ launchTs: 9, bundleTs: 11 });
  });

  test('each one is the highest of its own kind, not the last seen', () => {
    expect(
      markerWindow([
        { ts: 30, src: 'metro', level: 'info', msg: 'b2', marker: true },
        { ts: 10, src: 'metro', level: 'info', msg: 'b1', marker: true },
        { ts: 20, src: 'build', level: 'info', msg: 'launch', marker: true },
      ]),
    ).toEqual({ launchTs: 20, bundleTs: 30 });
  });

  test('returns nulls when nothing is marked', () => {
    expect(markerWindow([{ ts: 1, msg: 'a' }])).toEqual({ launchTs: null, bundleTs: null });
    expect(markerWindow([])).toEqual({ launchTs: null, bundleTs: null });
  });

  test('ignores a marker with no usable ts', () => {
    expect(markerWindow([{ src: 'metro', msg: 'a', marker: true }])).toEqual({ launchTs: null, bundleTs: null });
  });

  test('a marker from any source other than metro counts as a launch', () => {
    expect(markerWindow([{ ts: 4, src: 'device', level: 'info', msg: 'x', marker: true }])).toEqual({
      launchTs: 4,
      bundleTs: null,
    });
  });
});

describe('recordMatches', () => {
  const rec = { ts: 100, src: 'metro', level: 'warn', msg: 'bundle failed' };

  test('no criteria matches everything', () => {
    expect(recordMatches(rec, {})).toBe(true);
  });

  test('sources filters on the record src, not the file it came from', () => {
    expect(recordMatches(rec, { sources: ['metro'] })).toBe(true);
    expect(recordMatches(rec, { sources: ['client'] })).toBe(false);
    expect(recordMatches(rec, { sources: ['client', 'metro'] })).toBe(true);
  });

  test('minLevel is a floor, not an equality test', () => {
    expect(recordMatches(rec, { minLevel: 'debug' })).toBe(true);
    expect(recordMatches(rec, { minLevel: 'warn' })).toBe(true);
    expect(recordMatches(rec, { minLevel: 'error' })).toBe(false);
  });

  test('grep matches the message', () => {
    expect(recordMatches(rec, { grep: /failed/ })).toBe(true);
    expect(recordMatches(rec, { grep: /succeeded/ })).toBe(false);
  });

  test('sinceTs is inclusive', () => {
    expect(recordMatches(rec, { sinceTs: 100 })).toBe(true);
    expect(recordMatches(rec, { sinceTs: 101 })).toBe(false);
  });

  test('errorsOnly keeps error and fatal and nothing else', () => {
    expect(recordMatches(rec, { errorsOnly: true })).toBe(false);
    expect(recordMatches({ ...rec, level: 'error' }, { errorsOnly: true })).toBe(true);
    expect(recordMatches({ ...rec, level: 'fatal' }, { errorsOnly: true })).toBe(true);
  });

  test('errorsOnly with a marker window excludes anything at or before the marker', () => {
    const err = { ...rec, level: 'error' };
    expect(recordMatches(err, { errorsOnly: true, markerTs: 100 })).toBe(false);
    expect(recordMatches({ ...err, ts: 101 }, { errorsOnly: true, markerTs: 100 })).toBe(true);
  });

  test('errorsOnly with a bundle marker keeps a metro error at the exact marker ts', () => {
    const err = { ...rec, level: 'error' };
    expect(recordMatches({ ...err, ts: 99 }, { errorsOnly: true, bundleMarkerTs: 100 })).toBe(false);
    expect(recordMatches(err, { errorsOnly: true, bundleMarkerTs: 100 })).toBe(true);
    expect(recordMatches({ ...err, ts: 101 }, { errorsOnly: true, bundleMarkerTs: 100 })).toBe(true);
  });
});

describe('logFiles', () => {
  test('lists only .ndjson files, sorted, ignoring supervisor.log', () => {
    writeLog('metro.ndjson', []);
    writeLog('client.ndjson', []);
    writeFileSync(join(dir, 'supervisor.log'), 'raw stdio\n');
    mkdirSync(join(dir, 'nested.ndjson'));
    expect(logFiles(dir)).toEqual(['client.ndjson', 'metro.ndjson']);
  });

  test('a missing directory is not an error', () => {
    expect(logFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('queryLogs', () => {
  test('returns [] for a missing directory', () => {
    expect(queryLogs({ dir: join(dir, 'nope') })).toEqual([]);
  });

  test('returns [] for an empty directory', () => {
    expect(queryLogs({ dir })).toEqual([]);
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
    expect(queryLogs({ dir }).map((r) => r.msg)).toEqual(['m1', 'c2', 'b3', 'm5', 'c9']);
  });

  test('skips corrupt lines instead of failing the query', () => {
    writeFileSync(
      join(dir, 'metro.ndjson'),
      '{"ts":1,"src":"metro","level":"info","msg":"ok"}\nnot json\n{"ts":2,"src":"met',
    );
    expect(queryLogs({ dir }).map((r) => r.msg)).toEqual(['ok']);
  });

  test('sorts records with no usable ts last rather than crashing', () => {
    writeLog('metro.ndjson', [
      { src: 'metro', level: 'info', msg: 'no-ts' },
      { ts: 'nope', src: 'metro', level: 'info', msg: 'bad-ts' },
      { ts: 2, src: 'metro', level: 'info', msg: 'has-ts' },
    ]);
    expect(queryLogs({ dir }).map((r) => r.msg)).toEqual(['has-ts', 'no-ts', 'bad-ts']);
  });

  test('filters by source', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'm' }]);
    writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'info', msg: 'c' }]);
    expect(queryLogs({ dir, sources: ['client'] }).map((r) => r.msg)).toEqual(['c']);
  });

  test('filters by minimum level', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'debug', msg: 'd' },
      { ts: 2, src: 'metro', level: 'warn', msg: 'w' },
      { ts: 3, src: 'metro', level: 'fatal', msg: 'f' },
    ]);
    expect(queryLogs({ dir, minLevel: 'warn' }).map((r) => r.msg)).toEqual(['w', 'f']);
  });

  test('--since is relative to the injected now', () => {
    writeLog('metro.ndjson', [
      { ts: 1000, src: 'metro', level: 'info', msg: 'old' },
      { ts: 9000, src: 'metro', level: 'info', msg: 'recent' },
    ]);
    expect(queryLogs({ dir, since: '5s', now: 10000 }).map((r) => r.msg)).toEqual(['recent']);
  });

  test('an unparseable --since throws a structured error rather than returning nothing', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'a' }]);
    expect(() => queryLogs({ dir, since: 'soon' })).toThrow(/soon/);
  });

  test('filters by grep, accepting a string or a RegExp', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'info', msg: 'Unable to resolve module lodash' },
      { ts: 2, src: 'metro', level: 'info', msg: 'Bundling complete' },
    ]);
    expect(queryLogs({ dir, grep: 'resolve module' }).map((r) => r.ts)).toEqual([1]);
    expect(queryLogs({ dir, grep: /^Bundling/ }).map((r) => r.ts)).toEqual([2]);
  });

  test('tail keeps the LAST n records, still ascending', () => {
    writeLog(
      'metro.ndjson',
      [1, 2, 3, 4, 5].map((ts) => ({ ts, src: 'metro', level: 'info', msg: `m${ts}` })),
    );
    expect(queryLogs({ dir, tail: 2 }).map((r) => r.msg)).toEqual(['m4', 'm5']);
    expect(queryLogs({ dir, tail: 99 }).length).toEqual(5);
  });

  test('tail is applied after filtering, not before', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'error', msg: 'e1' },
      { ts: 2, src: 'metro', level: 'debug', msg: 'd' },
      { ts: 3, src: 'metro', level: 'error', msg: 'e2' },
    ]);
    expect(queryLogs({ dir, minLevel: 'error', tail: 2 }).map((r) => r.msg)).toEqual(['e1', 'e2']);
  });

  describe('errorsOnly', () => {
    test('with no marker anywhere, returns every error and fatal in the log', () => {
      writeLog('metro.ndjson', [
        { ts: 1, src: 'metro', level: 'warn', msg: 'w' },
        { ts: 2, src: 'metro', level: 'error', msg: 'e' },
        { ts: 3, src: 'metro', level: 'fatal', msg: 'f' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['e', 'f']);
    });

    test('returns [] when nothing failed -- the agent loop pass condition', () => {
      writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'ok', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a build marker resets the window for client errors too', () => {
      writeLog('client.ndjson', [
        { ts: 10, src: 'client', level: 'error', msg: 'stale redbox from the last run' },
        { ts: 30, src: 'client', level: 'error', msg: 'fresh redbox' },
      ]);
      writeLog('build-ios.ndjson', [{ ts: 20, src: 'build', level: 'info', msg: 'app launched', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['fresh redbox']);
    });

    test('the window is the LAST marker, not the first', () => {
      writeLog('metro.ndjson', [
        { ts: 1, src: 'metro', level: 'info', msg: 'build 1', marker: true },
        { ts: 2, src: 'metro', level: 'error', msg: 'error between builds' },
        { ts: 3, src: 'metro', level: 'info', msg: 'build 2', marker: true },
        { ts: 4, src: 'metro', level: 'error', msg: 'error after build 2' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['error after build 2']);
    });

    test('an error at the exact launch-marker ts belongs to the previous window', () => {
      writeLog('client.ndjson', [{ ts: 5, src: 'client', level: 'error', msg: 'same instant' }]);
      writeLog('build-ios.ndjson', [{ ts: 5, src: 'build', level: 'info', msg: 'launched', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a metro error at the exact bundle-marker ts belongs to the window the marker opens', () => {
      writeLog('metro.ndjson', [
        { ts: 4, src: 'metro', level: 'error', msg: 'previous attempt' },
        { ts: 5, src: 'metro', level: 'info', msg: 'bundle build failed (2)', marker: true },
        { ts: 5, src: 'metro', level: 'error', msg: 'Unable to resolve "./nope"' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['Unable to resolve "./nope"']);
    });

    test('combines with --source and --since', () => {
      writeLog('client.ndjson', [{ ts: 30, src: 'client', level: 'error', msg: 'client err' }]);
      writeLog('metro.ndjson', [
        { ts: 20, src: 'metro', level: 'info', msg: 'm', marker: true },
        { ts: 31, src: 'metro', level: 'error', msg: 'metro err' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true, sources: ['client'] }).map((r) => r.msg)).toEqual(['client err']);
      expect(queryLogs({ dir, errorsOnly: true, since: '5s', now: 33000 }).map((r) => r.msg)).toEqual([]);
    });
  });

  describe('errorsOnly, against the field capture', () => {
    const at = (sec: number, ms = 0) =>
      Date.parse(`2026-08-24T16:03:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`);

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

      const window = markerWindow(readAll());
      assert(window.bundleTs !== null);
      expect(window.bundleTs > at(54)).toBeTruthy();
      expect(window.launchTs).toBe(at(50));

      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['[Error: Exception in HostFunction]']);
    });

    test('a bundle marker still retires the metro error the rebuild fixed', () => {
      writeLog('metro.ndjson', [
        {
          ts: at(40),
          src: 'metro',
          level: 'error',
          msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"',
        },
        { ts: at(55), src: 'metro', level: 'info', msg: 'bundle build done (2)', marker: true },
      ]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a launch marker retires a client error that preceded it', () => {
      writeLog('client.ndjson', [{ ts: at(40), src: 'client', level: 'error', msg: 'last run redbox' }]);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a metro error before the launch marker is history too', () => {
      writeLog('metro.ndjson', [{ ts: at(40), src: 'metro', level: 'error', msg: 'stale bundling error' }]);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a bundling failure stored at info is not an error, but is still in the timeline', () => {
      writeLog('metro.ndjson', [
        {
          ts: at(40),
          src: 'metro',
          level: 'info',
          raw: true,
          msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"',
        },
      ]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
      expect(queryLogs({ dir }).length).toBe(1);
      writeLog('metro.ndjson', [
        {
          ts: at(40),
          src: 'metro',
          level: 'error',
          raw: true,
          msg: 'iOS Bundling failed 3122ms\nUnable to resolve "./tailwind.json" from "global.css"',
        },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).length).toBe(1);
    });
  });

  describe('errorsOnly, consecutive failed bundles', () => {
    test('bare mode: only the newest attempt is reported, and a success clears it', () => {
      writeLog('metro.ndjson', [
        {
          ts: 10,
          src: 'metro',
          level: 'info',
          msg: 'bundle build failed (1)',
          event: 'bundle_build_failed',
          marker: true,
        },
        { ts: 11, src: 'metro', level: 'error', msg: 'Unable to resolve "some-pkg" from "App.tsx"' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual([
        'Unable to resolve "some-pkg" from "App.tsx"',
      ]);

      writeLog('metro.ndjson', [
        {
          ts: 20,
          src: 'metro',
          level: 'info',
          msg: 'bundle build failed (2)',
          event: 'bundle_build_failed',
          marker: true,
        },
        { ts: 21, src: 'metro', level: 'error', msg: 'SyntaxError in App.tsx: Unexpected token' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual([
        'SyntaxError in App.tsx: Unexpected token',
      ]);

      writeLog('metro.ndjson', [
        { ts: 30, src: 'metro', level: 'info', msg: 'bundle build done (3)', event: 'bundle_build_done', marker: true },
      ]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('expo-child mode: the "Bundling failed" line is its own boundary and stays visible', () => {
      writeLog('metro.ndjson', [
        {
          ts: 10,
          src: 'metro',
          level: 'error',
          raw: true,
          msg: 'iOS Bundling failed 10178ms index.js (4309 modules)',
          marker: true,
        },
        { ts: 11, src: 'metro', level: 'error', raw: true, msg: 'Unable to resolve "some-pkg" from "App.tsx"' },
        {
          ts: 20,
          src: 'metro',
          level: 'error',
          raw: true,
          msg: 'iOS Bundling failed 893ms index.js (4173 modules)',
          marker: true,
        },
        { ts: 21, src: 'metro', level: 'error', raw: true, msg: 'ERROR  a different failure' },
      ]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual([
        'iOS Bundling failed 893ms index.js (4173 modules)',
        'ERROR  a different failure',
      ]);

      writeLog('metro.ndjson', [
        {
          ts: 30,
          src: 'metro',
          level: 'info',
          raw: true,
          msg: 'iOS Bundled 812ms index.js (4310 modules)',
          marker: true,
        },
      ]);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
    });

    test('a failed-bundle marker does not retire a client error', () => {
      writeLog('client.ndjson', [{ ts: 5, src: 'client', level: 'error', msg: 'redbox' }]);
      writeLog('metro.ndjson', [{ ts: 10, src: 'metro', level: 'info', msg: 'bundle build failed (1)', marker: true }]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['redbox']);
    });
  });

  describe('errorsOnly, scope', () => {
    test('ERROR_SOURCES is metro, client and build -- the app talking, not the OS', () => {
      expect(ERROR_SOURCES).toEqual(['metro', 'client', 'build']);
    });

    test('a device-only noise storm is zero errors', () => {
      const storm = [];
      for (let i = 0; i < 3004; i += 1) {
        storm.push({
          ts: 1000 + i,
          src: 'device',
          level: 'error',
          proc: 'MyApp',
          msg: `nw_socket_handle_socket_event [C${i}:1] Socket SO_ERROR [54: Connection reset by peer]`,
        });
      }
      writeLog('device.ndjson', storm);
      expect(queryLogs({ dir, errorsOnly: true })).toEqual([]);
      expect(queryLogs({ dir, errorsOnly: true, sources: ['device'] }).length).toBe(3004);
      expect(queryLogs({ dir }).length).toBe(3004);
    });

    test("the app's own error is still reported while the device is excluded", () => {
      writeLog('device.ndjson', [
        { ts: 1, src: 'device', level: 'fatal', msg: 'UIScene lifecycle will soon be required' },
      ]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: '[Error: Exception in HostFunction]' }]);
      expect(queryLogs({ dir, errorsOnly: true }).map((r) => r.msg)).toEqual(['[Error: Exception in HostFunction]']);
    });

    test('an explicit --source device (or all) opts back in', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'native crash' }]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: 'js crash' }]);
      expect(queryLogs({ dir, errorsOnly: true, sources: ['device'] }).map((r) => r.msg)).toEqual(['native crash']);
      expect(
        queryLogs({ dir, errorsOnly: true, sources: ['metro', 'client', 'device', 'build'] }).map((r) => r.msg),
      ).toEqual(['native crash', 'js crash']);
    });

    test('a plain query (no --errors) still shows every source', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'device line' }]);
      expect(queryLogs({ dir }).map((r) => r.msg)).toEqual(['device line']);
      expect(queryLogs({ dir, minLevel: 'error' }).map((r) => r.msg)).toEqual(['device line']);
    });
  });
});

describe('incremental tailing', () => {
  test('fileSizes reports a byte size per log file, and {} for a missing dir', () => {
    writeFileSync(join(dir, 'metro.ndjson'), 'abcde');
    expect(fileSizes(dir)).toEqual({ 'metro.ndjson': 5 });
    expect(fileSizes(join(dir, 'nope'))).toEqual({});
  });

  test('tailRead resumes from the previous offset', () => {
    expect(tailRead({ offset: 10, partial: 'x' }, 40)).toEqual({
      start: 10,
      prev: { offset: 10, partial: 'x' },
    });
  });

  test('tailRead restarts from zero when the file shrank', () => {
    expect(tailRead({ offset: 100, partial: 'x' }, 4)).toEqual({
      start: 0,
      prev: { offset: 0, partial: '' },
    });
  });

  test('tailRead treats a brand new file as starting at zero', () => {
    expect(tailRead(undefined, 12)).toEqual({ start: 0, prev: { offset: 0, partial: '' } });
  });

  test('advanceTail yields complete lines and holds the partial one back', () => {
    const chunk = '{"ts":1,"msg":"a"}\n{"ts":2,"ms';
    const r = advanceTail({ offset: 0, partial: '' }, chunk, chunk.length);
    expect(r.records.map((x) => x.msg)).toEqual(['a']);
    expect(r.state.partial).toBe('{"ts":2,"ms');
    expect(r.state.offset).toBe(chunk.length);
  });

  test('advanceTail completes a line split across two polls', () => {
    const first = advanceTail({ offset: 0, partial: '' }, '{"ts":2,"ms', 11);
    expect(first.records).toEqual([]);
    const second = advanceTail(first.state, 'g":"b"}\n', 19);
    expect(second.records.map((x) => x.msg)).toEqual(['b']);
    expect(second.state.partial).toBe('');
    expect(second.state.offset).toBe(19);
  });

  test('advanceTail skips a corrupt line without losing the next one', () => {
    const chunk = 'garbage\n{"ts":3,"msg":"c"}\n';
    const r = advanceTail({ offset: 0, partial: '' }, chunk, chunk.length);
    expect(r.records.map((x) => x.msg)).toEqual(['c']);
  });

  test('advanceTail on an empty chunk changes nothing but the offset', () => {
    const r = advanceTail({ offset: 7, partial: 'abc' }, '', 7);
    expect(r.records).toEqual([]);
    expect(r.state.partial).toBe('abc');
    expect(r.state.offset).toBe(7);
  });
});
