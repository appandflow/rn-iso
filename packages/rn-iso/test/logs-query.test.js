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
  lastMarkerTs,
  queryLogs,
  logFiles,
  fileSizes,
  tailRead,
  advanceTail,
} from '../src/logs-query.js';

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

describe('lastMarkerTs', () => {
  test('finds the highest marker ts across every source', () => {
    const records = [
      { ts: 1, src: 'metro', level: 'info', msg: 'a', marker: true },
      { ts: 9, src: 'build', level: 'info', msg: 'launched', marker: true },
      { ts: 5, src: 'client', level: 'error', msg: 'boom' },
    ];
    assert.equal(lastMarkerTs(records), 9);
  });

  test('returns null when nothing is marked', () => {
    assert.equal(lastMarkerTs([{ ts: 1, msg: 'a' }]), null);
    assert.equal(lastMarkerTs([]), null);
  });

  test('ignores a marker with no usable ts', () => {
    assert.equal(lastMarkerTs([{ src: 'metro', msg: 'a', marker: true }]), null);
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
