// The NDJSON core: Contract 1 records in, one JSON object per line out.
//
// The load-bearing property here is that a logging failure must never reach
// the caller. The supervisor calls write() from inside a Metro reporter on
// every event; if a full disk or a deleted directory threw from there, a
// logging problem would take the dev server down with it. So every failure
// path is a counted drop, and close() is where the count surfaces.
import assert from 'node:assert';
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
} from '../ndjson.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rn-iso-ndjson-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseNdjsonLine', () => {
  test('parses a Contract-1 record', () => {
    const r = parseNdjsonLine('{"ts":1,"src":"metro","level":"info","msg":"hi"}');
    expect(r).toEqual({ ts: 1, src: 'metro', level: 'info', msg: 'hi' });
  });

  test('tolerates surrounding whitespace and carriage returns', () => {
    const r = parseNdjsonLine('  {"ts":2,"src":"client","level":"warn","msg":"x"}\r');
    expect(r!.msg).toBe('x');
  });

  test('returns null for a blank line', () => {
    expect(parseNdjsonLine('')).toBe(null);
    expect(parseNdjsonLine('   ')).toBe(null);
  });

  // A half-written final line is the normal state of a file being appended to
  // by a live supervisor. Reading it must skip, never throw.
  test('returns null for a truncated or corrupt line', () => {
    expect(parseNdjsonLine('{"ts":1,"src":"met')).toBe(null);
    expect(parseNdjsonLine('not json at all')).toBe(null);
  });

  test('returns null for valid JSON that is not an object', () => {
    expect(parseNdjsonLine('42')).toBe(null);
    expect(parseNdjsonLine('"str"')).toBe(null);
    expect(parseNdjsonLine('[1,2]')).toBe(null);
    expect(parseNdjsonLine('null')).toBe(null);
  });

  test('returns null for a non-string input', () => {
    expect(parseNdjsonLine(undefined)).toBe(null);
    expect(parseNdjsonLine(null)).toBe(null);
  });
});

describe('parseNdjsonText', () => {
  test('parses every line and skips the corrupt ones', () => {
    const text = '{"ts":1,"msg":"a"}\ngarbage\n{"ts":2,"msg":"b"}\n';
    expect(parseNdjsonText(text).map((r) => r.msg)).toEqual(['a', 'b']);
  });

  test('returns [] for empty or missing text', () => {
    expect(parseNdjsonText('')).toEqual([]);
    expect(parseNdjsonText(undefined)).toEqual([]);
  });

  test('drops a trailing partial line rather than failing the whole read', () => {
    const text = '{"ts":1,"msg":"a"}\n{"ts":2,"ms';
    expect(parseNdjsonText(text).map((r) => r.msg)).toEqual(['a']);
  });
});

describe('levels', () => {
  test('LEVELS is the Contract-1 order, lowest first', () => {
    expect(LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
  });

  test('levelRank orders them and puts an unknown level at the bottom', () => {
    expect(levelRank('fatal') > levelRank('error')).toBeTruthy();
    expect(levelRank('error') > levelRank('warn')).toBeTruthy();
    expect(levelRank('warn') > levelRank('info')).toBeTruthy();
    expect(levelRank('info') > levelRank('debug')).toBeTruthy();
    expect(levelRank('nonsense')).toBe(0);
    expect(levelRank(undefined)).toBe(0);
  });
});

describe('sources', () => {
  test('SOURCES is the Contract-1 set', () => {
    expect(SOURCES).toEqual(['metro', 'client', 'device', 'build']);
  });
});

describe('formatNdjsonLine', () => {
  test('emits one line, newline terminated, with no embedded newline', () => {
    const line = formatNdjsonLine({ ts: 1, src: 'metro', level: 'info', msg: 'a\nb' });
    expect(line!.endsWith('\n')).toBe(true);
    expect(line!.slice(0, -1).includes('\n')).toBe(false);
    expect(parseNdjsonLine(line!)!.msg).toBe('a\nb');
  });

  test('returns null for a record that cannot be serialized', () => {
    const circular: Record<string, unknown> = { ts: 1, msg: 'x' };
    circular.self = circular;
    expect(formatNdjsonLine(circular)).toBe(null);
  });
});

describe('createNdjsonWriter', () => {
  test('creates the parent directory on first write', () => {
    const file = join(dir, 'logs', 'metro.ndjson');
    expect(existsSync(join(dir, 'logs'))).toBe(false);
    const w = createNdjsonWriter(file);
    expect(w.write({ src: 'metro', level: 'info', msg: 'hello' })).toBe(true);
    w.close();
    expect(existsSync(file)).toBe(true);
  });

  test('stamps ts when absent and keeps a caller-provided ts', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    const before = Date.now();
    w.write({ src: 'metro', level: 'info', msg: 'stamped' });
    w.write({ ts: 5, src: 'metro', level: 'info', msg: 'kept' });
    w.close();
    const records = parseNdjsonText(readFileSync(file, 'utf-8'));
    const rec0 = records[0];
    const rec1 = records[1];
    assert(rec0);
    assert(rec1);
    expect(typeof rec0.ts).toBe('number');
    expect(rec0.ts! >= before).toBeTruthy();
    expect(rec1.ts).toBe(5);
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
    expect(msgs).toEqual(['first', 'second']);
  });

  // The build transcript's mode: a per-run file whose first error belongs to
  // THIS run. The multi-writer logs never pass truncate, which the append
  // test above pins.
  test('truncate: true starts the file over instead of appending to the previous run', () => {
    const file = join(dir, 'build-ios.ndjson');
    const a = createNdjsonWriter(file, { truncate: true });
    a.write({ src: 'build', level: 'error', msg: 'stale failure from an earlier run' });
    a.close();
    const b = createNdjsonWriter(file, { truncate: true });
    b.write({ src: 'build', level: 'info', msg: 'fresh run' });
    b.close();
    const msgs = parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg);
    expect(msgs).toEqual(['fresh run']);
  });

  test('a truncating writer truncates only on open, never between its own writes', () => {
    const file = join(dir, 'build-ios.ndjson');
    const w = createNdjsonWriter(file, { truncate: true });
    w.write({ src: 'build', level: 'info', msg: 'one' });
    w.write({ src: 'build', level: 'info', msg: 'two' });
    w.close();
    const msgs = parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg);
    expect(msgs).toEqual(['one', 'two']);
  });

  // Truncation rides the lazy open, not writer creation: `ios` creates the
  // writer before the Metro gate, and a run refused there must leave the
  // previous run's transcript intact rather than an empty file.
  test('truncation happens on the first write, not at writer creation', () => {
    const file = join(dir, 'build-ios.ndjson');
    const a = createNdjsonWriter(file);
    a.write({ src: 'build', level: 'info', msg: 'previous run' });
    a.close();
    const w = createNdjsonWriter(file, { truncate: true });
    expect(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg)).toEqual(['previous run']);
    w.write({ src: 'build', level: 'info', msg: 'new run' });
    w.close();
    expect(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg)).toEqual(['new run']);
  });

  test('counts writes and reports them from close()', () => {
    const w = createNdjsonWriter(join(dir, 'metro.ndjson'));
    w.write({ src: 'metro', level: 'info', msg: 'a' });
    w.write({ src: 'metro', level: 'info', msg: 'b' });
    const stats = w.close();
    expect(stats.written).toBe(2);
    expect(stats.dropped).toBe(0);
    expect(stats.lastError).toBe(null);
    expect(stats.file).toBe(join(dir, 'metro.ndjson'));
  });

  // A file where a directory should be is the cheap, real stand-in for the
  // whole family of fs failures (ENOSPC, EACCES, a raced rmdir).
  test('never throws when the path cannot be opened, and counts the drop', () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'i am a file, not a directory');
    const w = createNdjsonWriter(join(blocker, 'metro.ndjson'));
    expect(w.write({ src: 'metro', level: 'error', msg: 'boom' })).toBe(false);
    expect(w.write({ src: 'metro', level: 'error', msg: 'boom again' })).toBe(false);
    const stats = w.close();
    expect(stats.written).toBe(0);
    expect(stats.dropped).toBe(2);
    expect(stats.lastError, 'the last fs error is kept for the caller to report').toBeTruthy();
  });

  test('exposes the running drop count without closing', () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'file');
    const w = createNdjsonWriter(join(blocker, 'metro.ndjson'));
    w.write({ src: 'metro', level: 'error', msg: 'boom' });
    expect(w.dropped).toBe(1);
    expect(w.written).toBe(0);
    w.close();
  });

  test('drops an unserializable record instead of throwing', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    const circular: Record<string, unknown> = { src: 'metro', level: 'info', msg: 'loop' };
    circular.self = circular;
    expect(w.write(circular)).toBe(false);
    w.write({ src: 'metro', level: 'info', msg: 'fine' });
    const stats = w.close();
    expect(stats.written).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg)).toEqual(['fine']);
  });

  // The supervisor keeps writing while a `worktree remove` or a stray rm -rf
  // takes the log directory out from under it. That must not throw either.
  test('keeps working when its directory is removed mid-run', () => {
    const file = join(dir, 'logs', 'metro.ndjson');
    const w = createNdjsonWriter(file);
    w.write({ src: 'metro', level: 'info', msg: 'before' });
    rmSync(join(dir, 'logs'), { recursive: true, force: true });
    expect(() => w.write({ src: 'metro', level: 'info', msg: 'after' })).not.toThrow();
    expect(() => w.close()).not.toThrow();
  });

  test('close() is idempotent and writes after close are counted drops', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    w.write({ src: 'metro', level: 'info', msg: 'a' });
    const first = w.close();
    expect(first.written).toBe(1);
    expect(w.write({ src: 'metro', level: 'info', msg: 'late' })).toBe(false);
    const second = w.close();
    expect(second.written).toBe(1);
    expect(second.dropped).toBe(1);
    expect(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg)).toEqual(['a']);
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
    assert(r);
    expect(r.event).toBe('client_log');
    expect(r.marker).toBe(true);
    expect(r.raw).toBe(true);
    expect(r.stack).toEqual([{ file: 'App.js', line: 3, column: 7, fn: 'render' }]);
  });
});
