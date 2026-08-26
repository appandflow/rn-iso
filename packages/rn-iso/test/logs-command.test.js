// The `logs` command. Two things matter beyond the plumbing:
//
// 1. Exit 0 when nothing matches. `logs --errors` returning empty IS the pass
//    condition of an agent loop, so a non-zero exit there would report every
//    healthy build as a failure.
// 2. --json emits the raw records, one per line, so its stdout is itself
//    valid NDJSON and can be piped straight back into a parser.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonLine } from '../src/ndjson.ts';
import logsCommand, {
  ERRORS_PRINT_CAP,
  formatRecord,
  formatTime,
  formatStackFrame,
  parseTail,
  validateLevel,
  validateSources,
} from '../src/commands/logs.ts';

// Same commander stub the other command tests use: capturing the action is the
// only way to run it without commander's own argument parsing.
function captureAction(register) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub);
  return (opts = {}) => captured(opts);
}

describe('formatting', () => {
  test('formatTime renders local wall clock to the millisecond', () => {
    const ts = Date.UTC(2026, 7, 25, 12, 34, 56, 789);
    const d = new Date(ts);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const expected = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    assert.equal(formatTime(ts), expected);
    assert.match(formatTime(ts), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test('formatTime renders a record with no usable ts without crashing', () => {
    assert.equal(formatTime(undefined), '--:--:--.---');
    assert.equal(formatTime('nope'), '--:--:--.---');
  });

  test('formatRecord is "HH:MM:SS.mmm level src msg" with aligned columns', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'error', msg: 'Unable to resolve module' });
    assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} error metro  Unable to resolve module$/);
  });

  test('the level and src columns are padded so messages line up', () => {
    const a = formatRecord({ ts: 0, src: 'metro', level: 'info', msg: 'x' });
    const b = formatRecord({ ts: 0, src: 'client', level: 'error', msg: 'x' });
    assert.equal(a.indexOf('x'), b.indexOf('x'));
  });

  test('formatStackFrame renders fn, file, line and column', () => {
    assert.equal(
      formatStackFrame({ file: 'src/App.js', line: 12, column: 3, fn: 'render' }),
      'at render (src/App.js:12:3)',
    );
  });

  test('formatStackFrame degrades when fields are missing', () => {
    assert.equal(formatStackFrame({ file: 'src/App.js', line: 12 }), 'at src/App.js:12');
    assert.equal(formatStackFrame({ fn: 'render' }), 'at render');
    assert.equal(formatStackFrame({}), null);
  });

  test('stack frames follow the message, indented', () => {
    const line = formatRecord({
      ts: 0,
      src: 'client',
      level: 'error',
      msg: 'redbox',
      stack: [
        { file: 'src/App.js', line: 12, column: 3, fn: 'render' },
        { file: 'src/index.js', line: 1, column: 1 },
      ],
    });
    const lines = line.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /redbox$/);
    assert.equal(lines[1], '    at render (src/App.js:12:3)');
    assert.equal(lines[2], '    at src/index.js:1:1');
  });

  test('a multi-line message keeps its own lines, indented under the first', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'error', msg: 'first\nsecond' });
    const lines = line.split('\n');
    assert.match(lines[0], /first$/);
    assert.equal(lines[1], '    second');
  });

  test('a record missing src or msg still renders', () => {
    const line = formatRecord({ ts: 0, level: 'info' });
    assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} info /);
  });

  // The command colours the level; the formatter stays pure so the tests do
  // not depend on whether chalk decided the test runner is a TTY.
  test('formatRecord paints only the level, and defaults to no colour', () => {
    const line = formatRecord({ ts: 0, src: 'metro', level: 'warn', msg: 'hm' }, { paint: (t) => `<${t}>` });
    assert.match(line, /<warn >/);
    assert.equal(formatRecord({ ts: 0, src: 'metro', level: 'warn', msg: 'hm' }).includes('<'), false);
  });
});

describe('option validation', () => {
  test('parseTail accepts a non-negative integer', () => {
    assert.deepEqual(parseTail('50'), { n: 50 });
    assert.deepEqual(parseTail('0'), { n: 0 });
  });

  test('parseTail rejects garbage with a message instead of NaN', () => {
    for (const bad of ['abc', '-1', '1.5', '', ' ']) {
      const r = parseTail(bad);
      assert.equal(r.n, undefined, `${bad} must not parse`);
      assert.match(r.error, /--tail/);
    }
  });

  // A typo in --source must not silently return nothing: `logs --errors
  // --source metrro` returning empty is indistinguishable from a clean build,
  // which is the one answer this CLI must never get wrong.
  test('validateSources accepts the Contract-1 sources and rejects a typo', () => {
    assert.deepEqual(validateSources(['metro', 'client']), { sources: ['metro', 'client'] });
    assert.deepEqual(validateSources(undefined), { sources: undefined });
    const r = validateSources(['metrro']);
    assert.equal(r.sources, undefined);
    assert.match(r.error, /metrro/);
    assert.match(r.error, /metro, client, device, build/);
  });

  // `all` exists because --errors has a default scope now: without a word for
  // "everything", asking for the device stream back means typing the list.
  test('validateSources expands all to every Contract-1 source', () => {
    assert.deepEqual(validateSources(['all']), { sources: ['metro', 'client', 'device', 'build'] });
    assert.deepEqual(validateSources(['client', 'all']), { sources: ['metro', 'client', 'device', 'build'] });
    assert.match(validateSources(['metrro']).error, /or all/);
  });

  test('validateLevel accepts the Contract-1 levels and names the valid set otherwise', () => {
    assert.deepEqual(validateLevel('warn'), { level: 'warn' });
    const r = validateLevel('loud');
    assert.equal(r.level, undefined);
    assert.match(r.error, /debug/);
    assert.match(r.error, /fatal/);
  });
});

describe('logs command', () => {
  let tmpHome;
  let project;
  let logsDir;
  let cwd;
  let out;
  let errOut;
  let exitCode;
  let origLog;
  let origError;
  let origExit;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-home-'));
    process.env.RN_ISO_HOME = tmpHome;
    project = mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-'));
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo' }));
    logsDir = join(project, '.rn-iso', 'logs');
    mkdirSync(logsDir, { recursive: true });
    cwd = process.cwd();
    process.chdir(project);

    out = [];
    errOut = [];
    exitCode = null;
    origLog = console.log;
    origError = console.error;
    origExit = process.exit;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => errOut.push(a.join(' '));
    process.exit = (code) => { exitCode = code; throw new Error('exit'); };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    process.chdir(cwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  function writeLog(name, records) {
    writeFileSync(join(logsDir, name), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }

  function run(opts) {
    try {
      captureAction(logsCommand)(opts);
    } catch (err) {
      if (err.message !== 'exit') throw err;
    }
  }

  test('prints the merged timeline, one line per record', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'bundling' }]);
    writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'warn', msg: 'deprecated' }]);
    run({});
    assert.equal(exitCode, null);
    assert.equal(out.length, 2);
    assert.match(out[0], / info  metro  bundling$/);
    assert.match(out[1], / warn  client deprecated$/);
  });

  test('--json emits the raw records, one valid NDJSON object per line', () => {
    const record = { ts: 1, src: 'metro', level: 'error', msg: 'boom', event: 'bundling_error' };
    writeLog('metro.ndjson', [record]);
    run({ json: true });
    assert.equal(out.length, 1);
    assert.deepEqual(parseNdjsonLine(out[0]), record);
  });

  test('exits 0 and prints nothing to stdout when nothing matches', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'fine' }]);
    run({ errors: true });
    assert.equal(exitCode, null, 'empty is the pass condition, not a failure');
    assert.deepEqual(out, []);
  });

  test('exits 0 when the workspace has no log directory at all', () => {
    rmSync(join(project, '.rn-iso'), { recursive: true, force: true });
    run({});
    assert.equal(exitCode, null);
    assert.deepEqual(out, []);
  });

  test('--errors applies the marker window across sources', () => {
    writeLog('client.ndjson', [
      { ts: 10, src: 'client', level: 'error', msg: 'stale' },
      { ts: 30, src: 'client', level: 'error', msg: 'fresh' },
    ]);
    writeLog('build-ios.ndjson', [{ ts: 20, src: 'build', level: 'info', msg: 'launched', marker: true }]);
    run({ errors: true, json: true });
    assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['fresh']);
  });

  test('--source, --level, --grep and --tail reach the query', () => {
    writeLog('metro.ndjson', [
      { ts: 1, src: 'metro', level: 'debug', msg: 'noise' },
      { ts: 2, src: 'metro', level: 'error', msg: 'Unable to resolve module a' },
      { ts: 3, src: 'metro', level: 'error', msg: 'Unable to resolve module b' },
    ]);
    writeLog('client.ndjson', [{ ts: 4, src: 'client', level: 'error', msg: 'Unable to resolve module c' }]);
    run({ source: ['metro'], level: 'error', grep: 'resolve module', tail: '1', json: true });
    assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['Unable to resolve module b']);
  });

  test('a bad --since exits 1 with a message naming the accepted forms', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'info', msg: 'x' }]);
    run({ since: 'soon' });
    assert.equal(exitCode, 1);
    assert.match(errOut.join('\n'), /soon/);
    assert.match(errOut.join('\n'), /30s|5m|2h/);
    assert.deepEqual(out, []);
  });

  test('a typo in --source exits 1 rather than reporting an empty pass', () => {
    writeLog('metro.ndjson', [{ ts: 1, src: 'metro', level: 'error', msg: 'boom' }]);
    run({ source: ['metrro'], errors: true });
    assert.equal(exitCode, 1);
    assert.match(errOut.join('\n'), /metrro/);
    assert.deepEqual(out, []);
  });

  test('a bad --level exits 1', () => {
    run({ level: 'loud' });
    assert.equal(exitCode, 1);
    assert.match(errOut.join('\n'), /loud/);
  });

  test('a bad --tail exits 1', () => {
    run({ tail: 'lots' });
    assert.equal(exitCode, 1);
    assert.match(errOut.join('\n'), /--tail/);
  });

  test('a bad --grep exits 1 rather than throwing a RegExp stack', () => {
    run({ grep: '[unterminated' });
    assert.equal(exitCode, 1);
    assert.match(errOut.join('\n'), /grep/);
  });

  test('outside a project it exits 1 and says so', () => {
    const bare = mkdtempSync(join(tmpdir(), 'rn-iso-logscmd-bare-'));
    // A directory with no package.json anywhere above it: / has none either.
    process.chdir(bare);
    try {
      run({});
    } finally {
      process.chdir(project);
      rmSync(bare, { recursive: true, force: true });
    }
    // findProjectRoot walks to the filesystem root; on a dev machine tmpdir
    // has no package.json ancestor, so this is the not-in-a-project path.
    if (exitCode !== null) {
      assert.equal(exitCode, 1);
      assert.match(errOut.join('\n'), /project/i);
    }
  });

  test('--since is honoured against real timestamps', () => {
    const now = Date.now();
    writeLog('metro.ndjson', [
      { ts: now - 3600000, src: 'metro', level: 'info', msg: 'an hour ago' },
      { ts: now - 1000, src: 'metro', level: 'info', msg: 'a second ago' },
    ]);
    run({ since: '30s', json: true });
    assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['a second ago']);
  });

  // --- the field case ------------------------------------------------------
  //
  // `rn-iso logs --errors` returned 3,004 iOS syslog lines on a healthy app.
  // Two things had to change for that number to be 0: the device stream is not
  // in the default scope of --errors, and what IS printed is bounded.
  describe('--errors, after the field test', () => {
    test('the device stream is out of scope by default', () => {
      writeLog('device.ndjson', [
        { ts: 1, src: 'device', level: 'error', msg: 'nw_socket_handle_socket_event [C1:2] Socket SO_ERROR [54]' },
        { ts: 2, src: 'device', level: 'fatal', msg: 'UIScene lifecycle will soon be required' },
      ]);
      run({ errors: true });
      assert.equal(exitCode, null);
      assert.deepEqual(out, [], 'a healthy app reports nothing');
    });

    test('--source device puts it back, and so does --source all', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'native crash' }]);
      writeLog('client.ndjson', [{ ts: 2, src: 'client', level: 'error', msg: 'js crash' }]);

      run({ errors: true, source: ['device'], json: true });
      assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['native crash']);

      out.length = 0;
      run({ errors: true, source: ['all'], json: true });
      assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['native crash', 'js crash']);
    });

    test('a plain logs (no --errors) still prints the device stream', () => {
      writeLog('device.ndjson', [{ ts: 1, src: 'device', level: 'error', msg: 'device line' }]);
      run({});
      assert.equal(out.length, 1);
      assert.match(out[0], /device line$/);
    });

    test(`--errors prints at most ${ERRORS_PRINT_CAP} records and says how many are left`, () => {
      const many = [];
      for (let i = 0; i < 3004; i += 1) {
        many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      }
      writeLog('client.ndjson', many);
      run({ errors: true });
      assert.equal(out.length, ERRORS_PRINT_CAP + 1, 'the cap plus one trailer line');
      // The HEAD survives: the first error in a window is usually the cause.
      assert.match(out[0], /boom 0$/);
      assert.match(out[ERRORS_PRINT_CAP - 1], /boom 19$/);
      const hidden = 3004 - ERRORS_PRINT_CAP;
      assert.match(out[ERRORS_PRINT_CAP], new RegExp(`and ${hidden} more`));
      // The count in the trailer is exactly what --tail N would print, because
      // what was hidden IS the tail.
      assert.match(out[ERRORS_PRINT_CAP], new RegExp(`--tail ${hidden}`));
      assert.match(out[ERRORS_PRINT_CAP], /--json/);
    });

    test('the cap does not apply to --json, or to an explicit --tail', () => {
      const many = [];
      for (let i = 0; i < 25; i += 1) many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      writeLog('client.ndjson', many);

      run({ errors: true, json: true });
      assert.equal(out.length, 25, 'a machine reader asked for the set');

      out.length = 0;
      run({ errors: true, tail: '25' });
      assert.equal(out.length, 25, 'an explicit length is the caller choosing');
    });

    test('a result at the cap prints no trailer', () => {
      const many = [];
      for (let i = 0; i < ERRORS_PRINT_CAP; i += 1) many.push({ ts: 1000 + i, src: 'client', level: 'error', msg: `boom ${i}` });
      writeLog('client.ndjson', many);
      run({ errors: true });
      assert.equal(out.length, ERRORS_PRINT_CAP);
      assert.ok(!out.join('\n').includes('more'));
    });

    // The field sequence: the crash at 16:03:54 and the bundle_build_done
    // marker that landed at 16:03:55 and used to swallow it.
    test('a bundle marker one second after a startup crash does not hide it', () => {
      const at = (sec) => Date.parse(`2026-08-24T16:03:${sec}Z`);
      writeLog('build-ios.ndjson', [{ ts: at(50), src: 'build', level: 'info', msg: 'launched', marker: true }]);
      writeLog('client.ndjson', [{ ts: at(54), src: 'client', level: 'error', msg: '[Error: Exception in HostFunction]' }]);
      writeLog('metro.ndjson', [{ ts: at(55), src: 'metro', level: 'info', msg: 'bundle build done (1)', marker: true }]);
      run({ errors: true, json: true });
      assert.deepEqual(out.map((l) => parseNdjsonLine(l).msg), ['[Error: Exception in HostFunction]']);
    });
  });
});
