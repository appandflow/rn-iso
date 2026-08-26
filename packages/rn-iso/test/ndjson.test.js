// The NDJSON core: Contract 1 records in, one JSON object per line out.
//
// The load-bearing property here is that a logging failure must never reach
// the caller. The supervisor calls write() from inside a Metro reporter on
// every event; if a full disk or a deleted directory threw from there, a
// logging problem would take the dev server down with it. So every failure
// path is a counted drop, and close() is where the count surfaces.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNdjsonLine,
  parseNdjsonText,
  formatNdjsonLine,
  createNdjsonWriter,
  LEVELS,
  SOURCES,
  levelRank,
} from '../src/ndjson.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-iso-ndjson-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseNdjsonLine', () => {
  test('parses a Contract-1 record', () => {
    const r = parseNdjsonLine('{"ts":1,"src":"metro","level":"info","msg":"hi"}');
    assert.deepEqual(r, { ts: 1, src: 'metro', level: 'info', msg: 'hi' });
  });

  test('tolerates surrounding whitespace and carriage returns', () => {
    const r = parseNdjsonLine('  {"ts":2,"src":"client","level":"warn","msg":"x"}\r');
    assert.equal(r.msg, 'x');
  });

  test('returns null for a blank line', () => {
    assert.equal(parseNdjsonLine(''), null);
    assert.equal(parseNdjsonLine('   '), null);
  });

  // A half-written final line is the normal state of a file being appended to
  // by a live supervisor. Reading it must skip, never throw.
  test('returns null for a truncated or corrupt line', () => {
    assert.equal(parseNdjsonLine('{"ts":1,"src":"met'), null);
    assert.equal(parseNdjsonLine('not json at all'), null);
  });

  test('returns null for valid JSON that is not an object', () => {
    assert.equal(parseNdjsonLine('42'), null);
    assert.equal(parseNdjsonLine('"str"'), null);
    assert.equal(parseNdjsonLine('[1,2]'), null);
    assert.equal(parseNdjsonLine('null'), null);
  });

  test('returns null for a non-string input', () => {
    assert.equal(parseNdjsonLine(undefined), null);
    assert.equal(parseNdjsonLine(null), null);
  });
});

describe('parseNdjsonText', () => {
  test('parses every line and skips the corrupt ones', () => {
    const text = '{"ts":1,"msg":"a"}\ngarbage\n{"ts":2,"msg":"b"}\n';
    assert.deepEqual(parseNdjsonText(text).map((r) => r.msg), ['a', 'b']);
  });

  test('returns [] for empty or missing text', () => {
    assert.deepEqual(parseNdjsonText(''), []);
    assert.deepEqual(parseNdjsonText(undefined), []);
  });

  test('drops a trailing partial line rather than failing the whole read', () => {
    const text = '{"ts":1,"msg":"a"}\n{"ts":2,"ms';
    assert.deepEqual(parseNdjsonText(text).map((r) => r.msg), ['a']);
  });
});

describe('levels', () => {
  test('LEVELS is the Contract-1 order, lowest first', () => {
    assert.deepEqual(LEVELS, ['debug', 'info', 'warn', 'error', 'fatal']);
  });

  test('levelRank orders them and puts an unknown level at the bottom', () => {
    assert.ok(levelRank('fatal') > levelRank('error'));
    assert.ok(levelRank('error') > levelRank('warn'));
    assert.ok(levelRank('warn') > levelRank('info'));
    assert.ok(levelRank('info') > levelRank('debug'));
    assert.equal(levelRank('nonsense'), 0);
    assert.equal(levelRank(undefined), 0);
  });
});

describe('sources', () => {
  test('SOURCES is the Contract-1 set', () => {
    assert.deepEqual(SOURCES, ['metro', 'client', 'device', 'build']);
  });
});

describe('formatNdjsonLine', () => {
  test('emits one line, newline terminated, with no embedded newline', () => {
    const line = formatNdjsonLine({ ts: 1, src: 'metro', level: 'info', msg: 'a\nb' });
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.slice(0, -1).includes('\n'), false);
    assert.equal(parseNdjsonLine(line).msg, 'a\nb');
  });

  test('returns null for a record that cannot be serialized', () => {
    const circular = { ts: 1, msg: 'x' };
    circular.self = circular;
    assert.equal(formatNdjsonLine(circular), null);
  });
});

describe('createNdjsonWriter', () => {
  test('creates the parent directory on first write', () => {
    const file = join(dir, 'logs', 'metro.ndjson');
    assert.equal(existsSync(join(dir, 'logs')), false);
    const w = createNdjsonWriter(file);
    assert.equal(w.write({ src: 'metro', level: 'info', msg: 'hello' }), true);
    w.close();
    assert.equal(existsSync(file), true);
  });

  test('stamps ts when absent and keeps a caller-provided ts', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    const before = Date.now();
    w.write({ src: 'metro', level: 'info', msg: 'stamped' });
    w.write({ ts: 5, src: 'metro', level: 'info', msg: 'kept' });
    w.close();
    const records = parseNdjsonText(readFileSync(file, 'utf-8'));
    assert.equal(typeof records[0].ts, 'number');
    assert.ok(records[0].ts >= before);
    assert.equal(records[1].ts, 5);
  });

  test('appends rather than truncating, across writer instances', () => {
    const file = join(dir, 'metro.ndjson');
    const a = createNdjsonWriter(file);
    a.write({ src: 'metro', level: 'info', msg: 'first' });
    a.close();
    const b = createNdjsonWriter(file);
    b.write({ src: 'metro', level: 'info', msg: 'second' });
    b.close();
    const msgs = parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg);
    assert.deepEqual(msgs, ['first', 'second']);
  });

  test('counts writes and reports them from close()', () => {
    const w = createNdjsonWriter(join(dir, 'metro.ndjson'));
    w.write({ src: 'metro', level: 'info', msg: 'a' });
    w.write({ src: 'metro', level: 'info', msg: 'b' });
    const stats = w.close();
    assert.equal(stats.written, 2);
    assert.equal(stats.dropped, 0);
    assert.equal(stats.lastError, null);
    assert.equal(stats.file, join(dir, 'metro.ndjson'));
  });

  // A file where a directory should be is the cheap, real stand-in for the
  // whole family of fs failures (ENOSPC, EACCES, a raced rmdir).
  test('never throws when the path cannot be opened, and counts the drop', () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'i am a file, not a directory');
    const w = createNdjsonWriter(join(blocker, 'metro.ndjson'));
    assert.equal(w.write({ src: 'metro', level: 'error', msg: 'boom' }), false);
    assert.equal(w.write({ src: 'metro', level: 'error', msg: 'boom again' }), false);
    const stats = w.close();
    assert.equal(stats.written, 0);
    assert.equal(stats.dropped, 2);
    assert.ok(stats.lastError, 'the last fs error is kept for the caller to report');
  });

  test('exposes the running drop count without closing', () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'file');
    const w = createNdjsonWriter(join(blocker, 'metro.ndjson'));
    w.write({ src: 'metro', level: 'error', msg: 'boom' });
    assert.equal(w.dropped, 1);
    assert.equal(w.written, 0);
    w.close();
  });

  test('drops an unserializable record instead of throwing', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    const circular = { src: 'metro', level: 'info', msg: 'loop' };
    circular.self = circular;
    assert.equal(w.write(circular), false);
    w.write({ src: 'metro', level: 'info', msg: 'fine' });
    const stats = w.close();
    assert.equal(stats.written, 1);
    assert.equal(stats.dropped, 1);
    assert.deepEqual(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg), ['fine']);
  });

  // The supervisor keeps writing while a `worktree remove` or a stray rm -rf
  // takes the log directory out from under it. That must not throw either.
  test('keeps working when its directory is removed mid-run', () => {
    const file = join(dir, 'logs', 'metro.ndjson');
    const w = createNdjsonWriter(file);
    w.write({ src: 'metro', level: 'info', msg: 'before' });
    rmSync(join(dir, 'logs'), { recursive: true, force: true });
    assert.doesNotThrow(() => w.write({ src: 'metro', level: 'info', msg: 'after' }));
    assert.doesNotThrow(() => w.close());
  });

  test('close() is idempotent and writes after close are counted drops', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    w.write({ src: 'metro', level: 'info', msg: 'a' });
    const first = w.close();
    assert.equal(first.written, 1);
    assert.equal(w.write({ src: 'metro', level: 'info', msg: 'late' }), false);
    const second = w.close();
    assert.equal(second.written, 1);
    assert.equal(second.dropped, 1);
    assert.deepEqual(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg), ['a']);
  });

  test('round-trips optional Contract-1 fields', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    w.write({
      ts: 10,
      src: 'client',
      level: 'error',
      msg: 'redbox',
      event: 'client_log',
      stack: [{ file: 'App.js', line: 3, column: 7, fn: 'render' }],
      raw: true,
      marker: true,
    });
    w.close();
    const [r] = parseNdjsonText(readFileSync(file, 'utf-8'));
    assert.equal(r.event, 'client_log');
    assert.equal(r.marker, true);
    assert.equal(r.raw, true);
    assert.deepEqual(r.stack, [{ file: 'App.js', line: 3, column: 7, fn: 'render' }]);
  });
});
